#!/usr/bin/env bash
# Bounded retry for transient Maven repository throttling only. Compilation,
# native linker, validation, and test failures must fail immediately.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo 'Usage: retry-gradle-network.sh <command> [arguments...]' >&2
  exit 2
fi

attempts="${NOVELTEA_GRADLE_NETWORK_ATTEMPTS:-3}"
backoff="${NOVELTEA_GRADLE_NETWORK_BACKOFF_SECONDS:-20}"
if [[ ! "$attempts" =~ ^[1-9][0-9]*$ || ! "$backoff" =~ ^[0-9]+$ ]] ||
   (( attempts > 4 || backoff > 120 )); then
  echo 'Invalid retry budget; attempts must be 1-4 and backoff 0-120 seconds.' >&2
  exit 2
fi

log="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/noveltea-gradle-network-XXXXXX")"
trap 'rm -f "$log"' EXIT

for ((attempt=1; attempt<=attempts; attempt++)); do
  : > "$log"
  if "$@" 2>&1 | tee "$log"; then
    exit 0
  else
    result=$?
  fi

  # Exact response signatures from Maven repositories: never retry a C++
  # compilation failure, an unrelated Gradle error, or an arbitrary 5xx.
  if ! grep -Eiq '(Received status code 429|HTTP (status |response code: )?429|429 Too Many Requests|status[ =:]429)' "$log"; then
    echo "Gradle failed with a non-throttling error (exit $result); no retry." >&2
    exit "$result"
  fi
  if (( attempt == attempts )); then
    echo "Maven repository throttling persisted after $attempts attempts." >&2
    exit "$result"
  fi
  delay=$(( backoff * attempt ))
  echo "Maven HTTP 429 (attempt $attempt/$attempts); retrying after ${delay}s." >&2
  sleep "$delay"
done
