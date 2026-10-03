#!/usr/bin/env bash
set -euo pipefail
# Synthetic environments only; no credentials, real capture, services or remote transfer.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bun_binary="$(command -v bun)"
test_root="$(mktemp -d /tmp/recording-offline-XXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root"/{home,config,state,data,runtime,cache,tmp,bin}
qa_nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s' "$qa_nonce" > "$test_root/.falatrace-qa"
chmod 600 "$test_root/.falatrace-qa"
for blocked_command in ssh sshfs systemctl systemd-run gdbus pactl pw-dump obs obs-cli notify-send flatpak gpu-screen-recorder wf-recorder aws rclone; do
  printf '#!/bin/sh\nexit 97\n' > "$test_root/bin/$blocked_command"
  chmod 755 "$test_root/bin/$blocked_command"
done
cat > "$test_root/bin/rsync" <<'PY'
#!/usr/bin/python3
import os,sys
from pathlib import Path
for value in sys.argv[1:]:
    if value.startswith('-'): continue
    if ':' in value or not Path(value).resolve().is_relative_to(Path('/tmp')):
        sys.exit('blocked nonlocal rsync')
os.execv('/usr/bin/rsync',['rsync',*sys.argv[1:]])
PY
chmod 755 "$test_root/bin/rsync"
cd "$repo_dir"
qa_test_args=("$@")
if [ ${#qa_test_args[@]} -eq 0 ]; then qa_test_args=("$repo_dir"); fi
# General regression fixtures have no live detector; explicit pause override only in this test shell.
# Admission tests inject their own policies/activity and still exercise pause/recovery.
env -i FALATRACE_QA_ISOLATED=1 FALATRACE_QA_ROOT="$test_root" FALATRACE_QA_NONCE="$qa_nonce" FALATRACE_HEAVY_PAUSE=off HOME="$test_root/home" XDG_CONFIG_HOME="$test_root/config" XDG_STATE_HOME="$test_root/state" XDG_DATA_HOME="$test_root/data" XDG_RUNTIME_DIR="$test_root/runtime" XDG_CACHE_HOME="$test_root/cache" TMPDIR="$test_root/tmp" PATH="$test_root/bin:$(dirname "$bun_binary"):/usr/bin:/bin" /usr/bin/python3 -I "$repo_dir/scripts/qa-run.py" "$bun_binary" test --preload "$repo_dir/scripts/offline-network.ts" "${qa_test_args[@]}"
