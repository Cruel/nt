#!/usr/bin/env bash
set -euo pipefail

mode="${1:?pack or restore}"
artifact="${2:?artifact directory}"
profile="${3:-ctest}"
build=build/linux-debug
cli="$build/tools/editor_tool/native-cli"
runner="$build/tools/editor_tool/noveltea-ui-test-runner"
case "$profile" in
  ctest) paths=("$build" build/prebuilt-shader-assets build/prebuilt-shaderc-toolchain editor/dist-electron) ;;
  feature-lab) paths=("$cli" "$build/runtime-assets" build/prebuilt-shader-assets build/prebuilt-shaderc-toolchain) ;;
  *) echo "Unknown native test artifact profile: $profile" >&2; exit 2 ;;
esac
identity() {
  # Failed-consumer reruns can reuse a successful producer in this same run.
  # The workflow passes its exact artifact ID, never a mutable artifact name.
  printf '%s\n' "linux-debug-test-build/$profile" "$(pwd -P)" "$GITHUB_REPOSITORY" "$GITHUB_WORKFLOW" "$GITHUB_SHA" "$GITHUB_RUN_ID" "$(uname -m)"
}
verify_feature_lab() {
  test -x "$cli/noveltea"
  test -x "$cli/noveltea-ui-test-runner"
  test -d "$cli/assets/system"
  test -d "$build/runtime-assets/system"
}
verify_build() {
  for path in "${paths[@]}"; do
    test -d "$path" && test ! -L "$path" || return 1
  done
  verify_feature_lab
  if [[ "$profile" == ctest ]]; then
    grep -qx 'NOVELTEA_ENABLE_COVERAGE:BOOL=OFF' "$build/CMakeCache.txt"
    grep -qx 'CMAKE_BUILD_TYPE:STRING=Debug' "$build/CMakeCache.txt"
    test -s "$build/CTestTestfile.cmake"
    test -s "$build/ci-native-shards.json"
    test -s "$build/compile_commands.json"
    test -x "$build/tools/editor_tool/noveltea-cli-native-certify"
    test -x "$runner"
    cmp -s "$runner" "$cli/noveltea-ui-test-runner"
  fi
}

case "$mode" in
  pack)
    # Prove both profiles originate from a configured noninstrumented Debug
    # build. CMake stages a byte-identical runner beside the installed CLI.
    grep -qx 'NOVELTEA_ENABLE_COVERAGE:BOOL=OFF' "$build/CMakeCache.txt"
    grep -qx 'CMAKE_BUILD_TYPE:STRING=Debug' "$build/CMakeCache.txt"
    verify_build
    cmp -s "$runner" "$cli/noveltea-ui-test-runner"
    mkdir -p "$artifact"
    excludes=()
    if [[ "$profile" == ctest ]]; then
      # Restore the redundant CMake-staged runner as a separate file, not a
      # hardlink; tests must not acquire new writable aliasing semantics.
      excludes+=("--exclude=$cli/noveltea-ui-test-runner")
    fi
    time tar -I 'zstd -T4 -1' -cf "$artifact/native-test-build.tar.zst" \
      --exclude='*.o' --exclude='*.obj' --exclude='*.a' \
      --exclude='*.pch' --exclude='*.gch' --exclude='*.gcno' --exclude='*.gcda' \
      --exclude='*/.git' --exclude='*/_deps/*-subbuild' --exclude='*/Testing' \
      "${excludes[@]}" "${paths[@]}"
    identity > "$artifact/identity.txt"
    [[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
    printf '%s\n' "$GITHUB_RUN_ATTEMPT" > "$artifact/producer-attempt.txt"
    (cd "$artifact" && sha256sum native-test-build.tar.zst identity.txt producer-attempt.txt > SHA256SUMS)
    du -h "$artifact/native-test-build.tar.zst"
    ;;
  restore)
    (cd "$artifact" && sha256sum --strict -c SHA256SUMS)
    diff -u "$artifact/identity.txt" <(identity)
    producer_attempt=$(cat "$artifact/producer-attempt.txt")
    [[ "$producer_attempt" =~ ^[1-9][0-9]*$ && "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
    (( producer_attempt <= GITHUB_RUN_ATTEMPT ))
    for path in "${paths[@]}"; do
      test ! -e "$path" && test ! -L "$path" || {
        echo "Refusing to overlay $path" >&2
        exit 1
      }
    done
    time tar -I zstd -xf "$artifact/native-test-build.tar.zst"
    if [[ "$profile" == ctest ]]; then
      test ! -e "$cli/noveltea-ui-test-runner" && test ! -L "$cli/noveltea-ui-test-runner"
      cp -p "$runner" "$cli/noveltea-ui-test-runner"
    fi
    verify_build
    ;;
  *)
    echo "Expected pack or restore, got $mode" >&2
    exit 2
    ;;
esac
