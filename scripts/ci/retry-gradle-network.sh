#!/usr/bin/env bash
# Bounded retry for transient Maven throttling and Gradle wrapper download
# transport failures. Compilation, linking, validation, and test failures
# must fail immediately.
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

  # Exact Maven 429 signatures, or an entire resolved plugin classpath
  # disappearing from all repositories. A single missing coordinate (such as
  # a typo or intentionally withdrawn dependency) is never retryable.
  missing_count="$(grep -Ec '^[[:space:]]*> Could not find [[:alnum:]._-]+:[[:alnum:]._-]+:[[:alnum:]._-]+\.' "$log" || true)"
  network_missing=false
  if grep -Fq "Could not resolve all artifacts for configuration ':classpath'" "$log" &&
     (( missing_count >= 5 )) &&
     grep -Fq 'https://repo.maven.apache.org/maven2/' "$log" &&
     grep -Fq 'https://dl.google.com/dl/android/maven2/' "$log"; then
    network_missing=true
  fi
  maven_retryable=false
  if grep -Eiq '(Received status code 429|HTTP (status |response code: )?429|429 Too Many Requests|status[ =:]429)' "$log" ||
     [[ "$network_missing" == true ]]; then
    maven_retryable=true
  fi
  # This failure is confined to GradleWrapperMain downloading its pinned
  # distribution, before Gradle executes any task. Repeating a compilation
  # or test failure is forbidden, even if its log mentions network errors.
  wrapper_retryable=false
  if grep -Fq 'Downloading https://services.gradle.org/distributions/gradle-' "$log" &&
     grep -Fq 'java.net.SocketException: Connection reset' "$log" &&
     grep -Fq 'org.gradle.wrapper.Download.download' "$log" &&
     grep -Fq 'org.gradle.wrapper.GradleWrapperMain' "$log" &&
     ! grep -Eq '(^> Task |^BUILD FAILED|^FAILURE: Build failed|^BUILD SUCCESSFUL)' "$log"; then
    wrapper_retryable=true
  fi
  if [[ "$wrapper_retryable" != true && "$maven_retryable" != true ]]; then
    echo "Gradle failed with a non-retryable error (exit $result); no retry." >&2
    exit "$result"
  fi
  if (( attempt == attempts )); then
    echo "Gradle network download failure persisted after $attempts attempts." >&2
    exit "$result"
  fi
  delay=$(( backoff * attempt ))
  if [[ "$wrapper_retryable" == true ]]; then
    echo "Transient Gradle wrapper download (attempt $attempt/$attempts); retrying after ${delay}s." >&2
  else
    echo "Transient Maven dependency resolution (attempt $attempt/$attempts); retrying after ${delay}s." >&2
    # Do not borrow a negative Maven metadata cache from the failed attempt.
    if (( attempt == 1 )); then set -- "$@" --refresh-dependencies; fi
  fi
  sleep "$delay"
done
