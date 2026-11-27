#!/usr/bin/env bash
# Keep package-mirror stalls off the CI critical path. Never retry application
# compilation or tests; this helper installs host prerequisites and exact
# local DEBs for installer certification.
set -euo pipefail

if (( $# == 0 )); then
  echo 'Usage: install-apt-packages.sh <package> [package...] | --local-deb <file.deb>' >&2
  exit 2
fi

missing=()
install_options=(--no-download)
if [[ "$1" == --local-deb ]]; then
  # Keep the actual local artifact in the APT transaction so its declared
  # dependency resolution and maintainer scripts are independently tested.
  # Never substitute a repository package or skip the installer as present.
  if (( $# != 2 )) || [[ "$2" != *.deb || ! -f "$2" ]]; then
    echo 'Expected exactly one existing local .deb file.' >&2
    exit 2
  fi
  missing+=("$(realpath -e -- "$2")")
  # APT --no-download mishandles local archive paths (even after
  # --download-only). Allow the local file acquisition in the single
  # bounded install transaction; previously downloaded dependencies remain
  # cached and use the same signed sources if acquisition is necessary.
  install_options=()
else
  for package in "$@"; do
    if [[ ! "$package" =~ ^[a-z0-9][a-z0-9.+-]*(:[a-z0-9-]+)?$ ]]; then
      echo "Invalid apt package name: $package" >&2
      exit 2
    fi
    if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)" != installed ]]; then
      missing+=("$package")
    fi
  done
fi
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

# Hosted Ubuntu's cloud-region mirror can remain slow for every retry. Use
# two independent HTTPS archives, retaining Ubuntu's archive signature and
# freshness checks. Scope source selection to this invocation, not the host.
mirrors=(default default)
if [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux &&
      "${RUNNER_ARCH:-}" == X64 ]] &&
   grep -qx 'ID=ubuntu' /etc/os-release &&
   grep -qx 'VERSION_CODENAME=noble' /etc/os-release &&
   [[ "$(dpkg --print-architecture)" == amd64 ]]; then
  mirrors=(https://archive.ubuntu.com/ubuntu https://mirrors.mit.edu/ubuntu)
  sources_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/noveltea-apt-sources.XXXXXXXX")"
  trap 'rm -rf "$sources_dir"' EXIT
  chmod 755 "$sources_dir"
fi

# Each attempt selects a mirror for both indexes and downloads. APT's socket
# timeouts alone cannot bound a slow transfer; allow realistic download time
# for graphics/Electron dependencies but cap each complete transaction.
for attempt in 1 2; do
  mirror="${mirrors[attempt-1]}"
  source_options=()
  if [[ "$mirror" != default ]]; then
    source_file="$sources_dir/attempt-$attempt.sources"
    cat > "$source_file" <<EOF
Types: deb
URIs: $mirror
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
    chmod 644 "$source_file"
    source_options=(-o "Dir::Etc::sourcelist=$source_file" -o Dir::Etc::sourceparts=-)
  fi
  echo "Refreshing apt indexes via $mirror (attempt $attempt/2; 120s deadline)."
  if "${root[@]}" timeout --kill-after=10s 120s apt-get "${apt_options[@]}" \
    "${source_options[@]}" -o APT::Update::Error-Mode=any update; then
    echo "Downloading missing apt packages via $mirror (attempt $attempt/2; 360s deadline)."
    if "${root[@]}" timeout --kill-after=10s 360s env DEBIAN_FRONTEND=noninteractive \
      apt-get "${apt_options[@]}" "${source_options[@]}" install -y --download-only "${missing[@]}"; then
      break
    else
      status=$?
      phase=download
    fi
  else
    status=$?
    phase=index
  fi
  if (( attempt == 2 )); then
    echo "APT $phase failed after two bounded attempts (exit $status)." >&2
    exit "$status"
  fi
  echo "APT $phase failed on $mirror (exit $status); trying the next mirror." >&2
  sleep 5
done

# Download separately so a failed mirror cannot interrupt dpkg. Installation
# uses the same verified index configuration. Named prerequisites install
# offline; local DEBs require APT's normal local archive acquisition.
"${root[@]}" timeout --kill-after=10s 180s env DEBIAN_FRONTEND=noninteractive \
  apt-get "${apt_options[@]}" "${source_options[@]}" install -y "${install_options[@]}" "${missing[@]}"
