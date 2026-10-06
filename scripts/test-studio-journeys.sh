#!/usr/bin/env bash
# Run every offscreen Studio UX journey with synthetic data.
# Uses the native shell when dist/desktop/recording-studio exists, otherwise the
# PySide6 runner (set FALATRACE_QML_PYTHON to an interpreter with PySide6).
# Exit 77 when neither runtime is available. Output: one folder per journey.
set -uo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_root="${1:-$(mktemp -d /tmp/falatrace-journeys-XXXXXX)}"
mkdir -p "$output_root"
journeys=(settings-ux process-ux agent-ux desktop-ui local-ux scope-ux planner-ux heavy-ux)
failed=0
for journey in "${journeys[@]}"; do
  script="$repo_dir/scripts/test-$journey.py"
  [ -f "$script" ] || continue
  rm -rf "${output_root:?}/$journey"
  if python3 "$script" "$output_root/$journey" > "$output_root/$journey.log" 2>&1; then
    printf 'pass  %-12s %s\n' "$journey" "$(tail -n 1 "$output_root/$journey.log" | cut -c1-160)"
  else
    code=$?
    if [ "$code" -eq 77 ]; then
      printf 'skip  %-12s %s\n' "$journey" "no Studio runtime"
      exit 77
    fi
    failed=1
    printf 'FAIL  %-12s see %s\n' "$journey" "$output_root/$journey.log"
    tail -n 20 "$output_root/$journey.log" | cut -c1-400
  fi
done
echo "Journey output: $output_root"
exit "$failed"
