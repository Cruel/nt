#!/usr/bin/env bash
set -euo pipefail

# CTest commands and GCC's coverage notes embed absolute paths. Only restore
# into the original checkout layout, from the exact workflow run and source.
mode="${1:?pack or restore}"
artifact="${2:?artifact directory}"
build=build/linux-debug
identity() {
  # A rerun of failed consumers may use a successful producer from an
  # earlier attempt of this same run. The caller selects its exact artifact ID.
  printf '%s\n' "$(pwd -P)" "$GITHUB_SHA" "$GITHUB_RUN_ID"
}

case "$mode" in
  pack)
    mkdir -p "$artifact"
    grep -qx 'NOVELTEA_ENABLE_COVERAGE:BOOL=ON' "$build/CMakeCache.txt"
    test -s "$build/CTestTestfile.cmake"
    test -n "$(find "$build" -name '*.gcno' -print -quit)"
    test -x "$build/tools/editor_tool/native-cli/noveltea"
    # Only test inputs, not the compiler/linker inputs or previous counters.
    # Preserve file modes and symlinks (artifact ZIP alone cannot do this).
    # Keep generated CTest metadata, assets, gcno, compile_commands, headers
    # and dependency data. No consumer invokes the native build again.
    tar -I 'zstd -T4 -1' -cf "$artifact/native-test-build.tar.zst" \
      --exclude='*.o' --exclude='*.obj' --exclude='*.a' \
      --exclude='*.pch' --exclude='*.gch' --exclude='*.gcda' \
      --exclude='*/.git' --exclude='*/_deps/*-subbuild' \
      --exclude='*/Testing' \
      "$build" build/prebuilt-shader-assets build/prebuilt-shaderc-toolchain \
      editor/dist-electron
    identity > "$artifact/identity.txt"
    (cd "$artifact" && sha256sum native-test-build.tar.zst identity.txt > SHA256SUMS)
    du -h "$artifact/native-test-build.tar.zst"
    ;;
  restore)
    (cd "$artifact" && sha256sum -c SHA256SUMS)
    diff -u "$artifact/identity.txt" <(identity)
    # Never overlay another configured or instrumented build.
    test ! -e "$build"
    tar -I zstd -xf "$artifact/native-test-build.tar.zst"
    grep -qx 'NOVELTEA_ENABLE_COVERAGE:BOOL=ON' "$build/CMakeCache.txt"
    test -s "$build/CTestTestfile.cmake"
    test -n "$(find "$build" -name '*.gcno' -print -quit)"
    test -x "$build/tools/editor_tool/native-cli/noveltea"
    ;;
  *)
    echo "Expected pack or restore, got $mode" >&2
    exit 2
    ;;
esac
