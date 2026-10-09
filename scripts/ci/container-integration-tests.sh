#!/usr/bin/env bash
# The root integration suite inside CI's distro containers: this shell is
# already root, systemd is PID 1, and VIGIL_LINUX_INTEGRATION=1 is passed by
# the workflow. One file at a time, in sorted order — Vitest would reorder
# them, and the flow test assumes the setup test (which sorts ahead of it)
# installed osquery and fapolicyd first. The same loop ci.yml's ubuntu job
# runs under sudo on the runner itself.
set -eu

mapfile -t files < <(find apps packages -path '*/node_modules' -prune -o -path '*/src/*' -name '*.integration.test.ts' -print | sort)
if [ ${#files[@]} -eq 0 ]; then
  echo "No Linux integration tests yet."
  exit 0
fi
printf 'Running %s\n' "${files[@]}"
for f in "${files[@]}"; do
  echo "::group::$f"
  VIGIL_LINUX_INTEGRATION=1 pnpm vitest run "$f"
  echo "::endgroup::"
done
