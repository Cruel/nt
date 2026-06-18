#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: .github/package-release.sh <desktop-sandbox|web|android|desktop-editor|checksums> <tag>" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmake -DNOVELTEA_PACKAGE_KIND="$1" -DNOVELTEA_RELEASE_TAG="$2" -P "$root/cmake/PackageNovelTeaRelease.cmake"
