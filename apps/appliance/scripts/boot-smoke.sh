#!/usr/bin/env bash
# Boot-smokes a built appliance qcow2: boots it under QEMU with a throwaway
# NoCloud seed — per-run SSH key and test VIGIL_* config, mirroring how
# build.sh uses throwaway credentials — and asserts the deployment contract
# on the first boot: the collector unit is active, UDP :2550 is bound, the
# seeded env file reached the running service, and /ingest refuses
# unauthenticated requests while accepting the seeded token.
#
# Usage: boot-smoke.sh <vigil-appliance-VERSION.qcow2>
#
# Two deliberate choices:
#  - The smoke boots an overlay of the artifact, never the artifact itself,
#    so what the release attaches stays byte-identical to what build.sh made.
#  - VIGIL_S3_ENDPOINT points at a dead address on purpose: an unreachable
#    sink is the appliance's normal degraded state (segments park until the
#    upload succeeds), so the smoke also proves the service survives it.

set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: $0 <vigil-appliance-VERSION.qcow2>" >&2
  exit 1
fi
IMAGE=$(realpath "$1")

for cmd in qemu-system-x86_64 qemu-img cloud-localds ssh ssh-keygen curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "boot-smoke: missing dependency: $cmd" >&2
    exit 1
  fi
done

# Same autodetection as build.sh: KVM when usable, TCG otherwise.
accel=tcg
if [[ -e /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]; then
  accel=kvm
fi
echo "boot-smoke: accelerator=$accel image=$IMAGE"

SMOKE_TOKEN=vigil-appliance-smoke-ingest-token
SMOKE_BUCKET=vigil-appliance-smoke

workdir=$(mktemp -d)
qemu_pid=
cleanup() {
  if [[ -n "$qemu_pid" ]] && kill -0 "$qemu_pid" 2>/dev/null; then
    kill "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

# Throwaway smoke credentials: a fresh keypair per run, rendered into the
# seed and gone with the temp dir. The image ships no such user — harden.sh
# removed the build-boot one — so the seed creates its own.
ssh-keygen -t ed25519 -N '' -C vigil-appliance-smoke -f "$workdir/smoke_key" -q

cat > "$workdir/user-data" <<USER_DATA
#cloud-config
hostname: vigil-appliance-smoke
users:
  - name: smoke
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$workdir/smoke_key.pub")
ssh_pwauth: false
write_files:
  - path: /etc/vigil-appliance/appliance.env
    permissions: '0600'
    owner: root:root
    content: |
      VIGIL_LISTEN_UDP_PORT=2550
      VIGIL_INGEST_TCP_PORT=2551
      VIGIL_INGEST_TOKEN=$SMOKE_TOKEN
      VIGIL_S3_ENDPOINT=http://127.0.0.1:8333
      VIGIL_S3_BUCKET=$SMOKE_BUCKET
      VIGIL_S3_PREFIX=smoke
      VIGIL_S3_ACCESS_KEY=smoke-access-key
      VIGIL_S3_SECRET_KEY=smoke-secret-key
USER_DATA

cat > "$workdir/meta-data" <<'META_DATA'
instance-id: iid-vigil-appliance-smoke
local-hostname: vigil-appliance-smoke
META_DATA

# NoCloud seed ISO labeled "cidata" — the same datasource contract as the
# build boot's Packer-generated seed (cloud-localds sets that label).
cloud-localds "$workdir/seed.iso" "$workdir/user-data" "$workdir/meta-data"
qemu-img create -f qcow2 -b "$IMAGE" -F qcow2 "$workdir/overlay.qcow2" >/dev/null

qemu-system-x86_64 \
  -machine "pc,accel=$accel" \
  -m 2048 -smp 2 \
  -drive file="$workdir/overlay.qcow2",if=virtio,format=qcow2 \
  -drive file="$workdir/seed.iso",media=cdrom,readonly=on \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:2551-:2551 \
  -device virtio-net-pci,netdev=n0 \
  -display none \
  -serial "file:$workdir/serial.log" \
  -pidfile "$workdir/qemu.pid" \
  -daemonize
qemu_pid=$(cat "$workdir/qemu.pid")

ssh_opts=(
  -i "$workdir/smoke_key" -p 2222
  -o BatchMode=yes
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=5
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=8
)
run_ssh() {
  # The contract is one literal remote-command string; the one deliberate
  # client-side expansion injects the smoke config via `env` in the caller.
  # shellcheck disable=SC2029
  ssh "${ssh_opts[@]}" smoke@127.0.0.1 "$@"
}

# First boot under TCG: QEMU, kernel, and cloud-init can take many minutes.
echo "boot-smoke: waiting for SSH (up to 30 minutes)..."
ready=no
for _ in $(seq 1 60); do
  if run_ssh 'echo ready' 2>/dev/null | grep -q ready; then
    ready=yes
    break
  fi
  sleep 30
done
if [[ $ready != yes ]]; then
  echo "::error::boot-smoke: SSH never came up" >&2
  tail -n 100 "$workdir/serial.log" >&2 || true
  exit 1
fi

# The unit is enabled, so its first starts race cloud-init's write_files for
# the env file and may bounce (Restart=on-failure) until the config appears.
# Let cloud-init finish, then assert against the settled system.
echo "boot-smoke: waiting for cloud-init to finish first-boot configuration..."
run_ssh 'sudo cloud-init status --wait' \
  || echo "::warning::boot-smoke: cloud-init did not report a clean finish; asserting anyway"

# All guest-side assertions in one SSH round-trip. The smoke config rides in
# as environment so the assertions check the seed's actual values.
set +e
run_ssh "env VIGIL_SMOKE_BUCKET='$SMOKE_BUCKET' bash -s" <<'GUEST' >"$workdir/guest.log" 2>&1
set -euo pipefail

echo "== assert: vigil-appliance unit is active =="
systemctl is-active vigil-appliance

pid=$(systemctl show -p MainPID --value vigil-appliance)
if [[ -z "$pid" || "$pid" == "0" ]]; then
  echo "no MainPID for vigil-appliance" >&2
  exit 1
fi

echo "== assert: UDP :2550 is bound =="
ss -lun | grep -E ':2550(\s|$)'

echo "== assert: the env file was applied to the service process =="
sudo cat "/proc/$pid/environ" | tr '\0' '\n' | grep -qx "VIGIL_S3_BUCKET=$VIGIL_SMOKE_BUCKET"

echo "== assert: the build-boot builder account is gone =="
# The image must not carry build-boot accounts; harden.sh defers their
# deletion to this first boot, so their absence is asserted here.
! id builder >/dev/null 2>&1
GUEST
guest_rc=$?
set -e
cat "$workdir/guest.log"
if [[ $guest_rc -ne 0 ]]; then
  echo "::error::boot-smoke: guest assertions failed" >&2
  run_ssh 'systemctl status vigil-appliance --no-pager || true; sudo journalctl -u vigil-appliance --no-pager | tail -n 50' >&2 \
    || true
  tail -n 200 "$workdir/serial.log" >&2 || true
  exit 1
fi

# Ingest is asserted from the host through the forwarded port: it proves the
# endpoint is reachable as a deployment would reach it, not just loopback.
echo "== assert: POST /ingest without a token returns 401 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/x-ndjson' \
  --data '{"columns":{"name":"smoke"}}' \
  http://127.0.0.1:2551/ingest)
if [[ $code != 401 ]]; then
  echo "boot-smoke: expected 401 for an unauthenticated ingest, got $code" >&2
  exit 1
fi

echo "== assert: POST /ingest with the seeded token returns 202 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/x-ndjson' \
  -H "authorization: Bearer $SMOKE_TOKEN" \
  --data '{"name":"smoke","timestamp":"2026-01-01T00:00:00Z","columns":{"name":"bash","remote_address":"10.0.0.1","remote_port":"443","local_address":"192.168.1.20","local_port":"52000","protocol":"6"}}' \
  http://127.0.0.1:2551/ingest)
if [[ $code != 202 ]]; then
  echo "boot-smoke: expected 202 for an authenticated ingest, got $code" >&2
  exit 1
fi

echo "boot-smoke: all assertions passed"
