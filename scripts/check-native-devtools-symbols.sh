#!/usr/bin/env bash
set -euo pipefail

binary_path="${1:-}"
expected_mode="${2:-}"
if [[ -z "$binary_path" || ("$expected_mode" != "on" && "$expected_mode" != "off") ]]; then
  echo "usage: bash scripts/check-native-devtools-symbols.sh <binary> <on|off>" >&2
  exit 2
fi

if ! inspection="$(
  nm -C "$binary_path" 2>/dev/null | awk '
    index($0, "Rml::Debugger::") { found_rml = 1 }
    index($0, "ImGui::Begin(char const*, bool*, int)") { found_imgui = 1 }
    END { printf "%d %d\n", found_rml, found_imgui }
  '
)"; then
  echo "failed to inspect native symbols for $binary_path" >&2
  exit 1
fi
read -r has_rmlui_debugger has_imgui <<<"$inspection"

mismatches=()
if [[ "$expected_mode" == "on" ]]; then
  [[ "$has_rmlui_debugger" == "1" ]] || mismatches+=("RmlUi Debugger")
  [[ "$has_imgui" == "1" ]] || mismatches+=("Dear ImGui frontend")
else
  [[ "$has_rmlui_debugger" == "0" ]] || mismatches+=("RmlUi Debugger")
  [[ "$has_imgui" == "0" ]] || mismatches+=("Dear ImGui frontend")
fi

if ((${#mismatches[@]} > 0)); then
  if [[ "$expected_mode" == "on" ]]; then
    expectation="missing"
  else
    expectation="unexpectedly linked"
  fi
  joined="$(IFS=', '; echo "${mismatches[*]}")"
  echo "native devtools $expected_mode: $expectation: $joined" >&2
  exit 1
fi

echo "native devtools $expected_mode: verified 2 linked developer components"
