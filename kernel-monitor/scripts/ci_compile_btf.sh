#!/usr/bin/env bash
# Compile the CO-RE object against a Debian suite's stock kernel BTF.
#
# Usage: ci_compile_btf.sh <suite> <expected-major.minor>
#
# Pulls the current linux-image-*-amd64 package for the suite from
# deb.debian.org (main, updates, and security — the newest ABI wins),
# extracts vmlinuz, decompresses the embedded vmlinux, and compiles
# bpf/vigil.bpf.o against the BTF dumped from it, proving the object
# CO-RE-relocates on that kernel.
set -euo pipefail

suite="${1:?usage: ci_compile_btf.sh <suite> <major.minor>}"
expected="${2:?usage: ci_compile_btf.sh <suite> <major.minor>}"
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

idx_all="$work/Packages.all"
: > "$idx_all"
for entry in \
	"https://deb.debian.org/debian/dists/$suite/main/binary-amd64/Packages.gz|gzip" \
	"https://deb.debian.org/debian/dists/$suite-updates/main/binary-amd64/Packages.gz|gzip" \
	"https://deb.debian.org/debian-security/dists/$suite-security/main/binary-amd64/Packages.xz|xz"; do
	url="${entry%|*}"
	comp="${entry##*|}"
	# decompress to a scratch file first: a truncated stream discards the
	# whole index rather than splicing a half stanza into the parse
	if curl -fsSL "$url" -o "$work/idx.$comp" 2>/dev/null; then
		case "$comp" in
			gzip) gzip -dc "$work/idx.$comp" >> "$idx_all" 2>/dev/null || true ;;
			xz)   xz -dc "$work/idx.$comp"   >> "$idx_all" 2>/dev/null || true ;;
		esac
	fi
done
[[ -s "$idx_all" ]] || { echo "no package index reachable for $suite" >&2; exit 1; }

# Highest-versioned plain amd64 image whose series matches the requested
# version: bookworm names carry an ABI segment (linux-image-6.1.0-53-amd64),
# trixie embeds the version (linux-image-6.12.107+deb13-amd64); exclude
# -dbg/-unsigned/-rt/-cloud flavors. The series is anchored with a literal
# dot — "6.1" must match 6.1.0-53 but NOT bookworm's newer 6.12 series —
# and expected's dots are escaped so they cannot act as regex wildcards.
# Paragraph records with FS='\n' so field 1 is the Package line.
pkg=$(awk -v RS= -v FS='\n' -v expected="$expected" '
	BEGIN {
		esc = expected
		gsub(/\./, "\\.", esc)
		pat = "^Package: linux-image-" esc "[.][.0-9+~a-z-]+-amd64$"
	}
	$1 ~ pat &&
	    $1 !~ /-rt-/ && $1 !~ /-cloud-/ && $1 !~ /-dbg$/ && $1 !~ /-unsigned$/ {
		ver = ""; file = ""
		for (i = 2; i <= NF; i++) {
			if ($i ~ /^Version: /)  ver = substr($i, 10)
			if ($i ~ /^Filename: /) file = substr($i, 11)
		}
		if (file != "" && ver != "") printf "%s\t%s\n", ver, file
	}' "$idx_all" | sort -Vr | head -1 | cut -f2)
[[ -n "${pkg:-}" ]] || { echo "no linux-image package found for $suite" >&2; exit 1; }
echo "ci_compile_btf.sh: $suite kernel package: $pkg"

# Filenames from -updates/-security indexes resolve under the debian-security
# pool root; main indexes resolve under /debian. Try both.
dl=""
for root in "https://deb.debian.org/debian" "https://deb.debian.org/debian-security"; do
	if curl -fsSL "$root/$pkg" -o "$work/image.deb"; then
		dl="$root"
		break
	fi
done
[[ -n "$dl" ]] || { echo "cannot download $pkg" >&2; exit 1; }
ar x "$work/image.deb" --output="$work" data.tar.xz 2>/dev/null ||
	ar x "$work/image.deb" data.tar.xz 2>/dev/null ||
	tar -xf "$work/image.deb" -C "$work" data.tar.xz
tar -xf "$work/data.tar.xz" -C "$work" --wildcards './boot/vmlinuz-*' 2>/dev/null ||
	tar -xf "$work/data.tar.xz" -C "$work" --wildcards 'boot/vmlinuz-*'
vmlinuz=$(find "$work/boot" -name 'vmlinuz-*' | head -1)
[[ -n "$vmlinuz" ]] || { echo "no vmlinuz in package" >&2; exit 1; }

# Decompress the embedded vmlinux: scan for known compression magics and try
# every occurrence of each (the kernel's own extract-vmlinux approach — the
# first hit can be the decompressor stub's own bytes, not the payload). The
# compressor changed across Debian releases — bookworm (6.1) is xz, trixie
# (6.12) is zstd — so all candidates are tried.
vmlinux="$work/vmlinux"
python3 - "$vmlinuz" "$vmlinux" <<'PY'
import os, subprocess, sys, tempfile

src, dst = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
magics = (
    (b'\x1f\x8b\x08',  'gzip'),
    (b'\xfd7zXZ',      'xz'),
    (b'\x28\xb5\x2f\xfd', 'zstd'),
    (b'BZh',           'bzip2'),
)


def try_cli(tool, blob):
    """Decompress blob, tolerating trailing garbage; None on failure."""
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(blob)
        name = tmp.name
    try:
        r = subprocess.run([tool, '-dc', name], capture_output=True)
    except FileNotFoundError:
        print(f"decompressor '{tool}' not installed, skipping", file=sys.stderr)
        return None
    finally:
        os.unlink(name)
    return r.stdout if r.stdout[:4] == b'\x7fELF' else None


for magic, tool in magics:
    start = 0
    while True:
        i = data.find(magic, start)
        if i < 0:
            break
        start = i + 1
        out = try_cli(tool, data[i:])
        if out is not None:
            open(dst, 'wb').write(out)
            sys.exit(0)
print("no decompressor yielded an ELF vmlinux", file=sys.stderr)
sys.exit(1)
PY
echo "ci_compile_btf.sh: extracted vmlinux ($(stat -c%s "$vmlinux") bytes)"

BTF_SOURCE="$vmlinux" ./scripts/gen_vmlinux.sh src/vmlinux.h
rm -f bpf/vigil.bpf.o src/vigil.skel.h
make bpf/vigil.bpf.o
echo "ci_compile_btf.sh: OK - object compiles against $suite kernel $expected BTF"
