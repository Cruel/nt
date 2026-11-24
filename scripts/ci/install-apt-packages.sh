#!/usr/bin/env bash
# Keep package-mirror stalls off the CI critical path. Never retry application
# compilation or tests; this helper only installs host prerequisites.
set -euo pipefail

if (( $# == 0 )); then
  echo 'Usage: install-apt-packages.sh <package> [package...]' >&2
  exit 2
fi

missing=()
for package in "$@"; do
  if [[ ! "$package" =~ ^[a-z0-9][a-z0-9.+-]*(:[a-z0-9-]+)?$ ]]; then
    echo "Invalid apt package name: $package" >&2
    exit 2
  fi
  if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" != installed ]]; then
    missing+=("$package")
  fi
done
if (( ${#missing[@]} == 0 )); then
  echo 'All requested apt packages are already installed; skipping network access.'
  exit 0
fi

root=()
if [[ "$(id -u)" != 0 ]]; then
  root=(sudo -n)
fi
apt_options=(
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o Acquire::Retries=1
  -o Acquire::Languages=none
  -o DPkg::Lock::Timeout=30
)

# APT's socket timeouts do not bound the entire transaction (e.g. a slow
# mirror can keep delivering small amounts of data). Enforce a wall limit too.
for attempt in 1 2; do
  echo "Refreshing apt indexes (attempt $attempt/2; 120s deadline)."
  if "${root[@]}" timeout --kill-after=10s 120s apt-get "${apt_options[@]}" \
    -o APT::Update::Error-Mode=any update; then
    break
  else
    status=$?
  fi
  if (( attempt == 2 )); then
    echo "APT index refresh failed after two bounded attempts (exit $status)." >&2
    exit "$status"
  fi
  sleep 5
done

# Download separately so retrying a network stall cannot interrupt dpkg.
for attempt in 1 2; do
  echo "Downloading missing apt packages (attempt $attempt/2; 180s deadline)."
  if "${root[@]}" timeout --kill-after=10s 180s env DEBIAN_FRONTEND=noninteractive \
    apt-get "${apt_options[@]}" install -y --download-only "${missing[@]}"; then
    break
  else
    status=$?
  fi
  if (( attempt == 2 )); then
    echo "APT package download failed after two bounded attempts (exit $status)." >&2
    exit "$status"
  fi
  sleep 5
done

# Do not retry dpkg/configuration failures. No network is needed at this point.
"${root[@]}" timeout --kill-after=10s 180s env DEBIAN_FRONTEND=noninteractive \
  apt-get "${apt_options[@]}" install -y --no-download "${missing[@]}"
