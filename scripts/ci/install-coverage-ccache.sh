#!/usr/bin/env bash
# Install and prove a pinned ccache that supports GCC atomic coverage counters.
set -euo pipefail
version=4.14.3
archive="ccache-${version}-linux-x86_64-musl-static.tar.xz"
digest=d553fac006ed93a37342cee9228cf4e13dd66690fa1a8075c54c7bace9b72ae6
root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/noveltea-coverage-ccache-${version}"
mkdir -p "$root"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/noveltea-ccache-probe.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 --max-time 90 \
  "https://github.com/ccache/ccache/releases/download/v${version}/${archive}" \
  -o "$work/$archive"
printf '%s  %s\n' "$digest" "$work/$archive" | sha256sum --check
tar -xJf "$work/$archive" --strip-components=1 -C "$root" \
  "ccache-${version}-linux-x86_64-musl-static/ccache"
compiler_cache="$root/ccache"
"$compiler_cache" --version
(
  cd "$work"
  export CCACHE_DIR="$work/cache"
  unset CCACHE_BASEDIR CCACHE_MAXSIZE CCACHE_CONFIGPATH
  printf 'int f(int x) { return x + 1; }\n' > probe.cpp
  "$compiler_cache" g++ --coverage -fprofile-update=atomic -Og -g -c probe.cpp -o probe.o
  sha256sum probe.o probe.gcno > expected.sha256
  rm probe.o probe.gcno
  "$compiler_cache" g++ --coverage -fprofile-update=atomic -Og -g -c probe.cpp -o probe.o
  sha256sum --check expected.sha256
  "$compiler_cache" --print-stats | awk '
    $1 == "cache_miss" { misses = $2 }
    $1 == "direct_cache_hit" || $1 == "preprocessed_cache_hit" { hits += $2 }
    END { if (hits != 1 || misses != 1) exit 1 }
  '
  "$compiler_cache" --show-stats
)
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$root" >> "$GITHUB_PATH"
fi
printf 'Verified coverage-compatible ccache: %s\n' "$compiler_cache"
