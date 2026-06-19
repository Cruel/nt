# Build and Verify

## Purpose

Collect the supported local build, test, smoke, and packaging verification commands for NovelTea.

## Initial Command Set

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

Run Android verification when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```
