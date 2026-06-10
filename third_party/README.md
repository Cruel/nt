# Third-Party Dependencies

Third-party libraries used by NovelTea, managed through vcpkg (Linux desktop)
or SDK/system (Android, Web).

## Linux (vcpkg)

Dependencies are declared in `/vcpkg.json` at the project root and installed
automatically by CMake when the `VCPKG_ROOT` environment variable is set.

Current dependencies:
- **SDL3** - windowing, input, app lifecycle
- **bgfx** - rendering abstraction (desktop target)
- **Dear ImGui** - developer debug overlay (desktop target)
- **RmlUi** - runtime UI system; core scaffold is integrated, renderer backend is TODO
- **miniaudio** - future audio system (not yet integrated)
- **harfbuzz** - text shaping (for RmlUi)

## Android

For Android, SDL3 is consumed via an SDL3 AAR placed at
`android/app/libs/SDL3-3.4.10.aar`. The AAR provides:
- `org.libsdl.app.*` Java classes (SDLActivity and friends) through the AAR
  classes JAR
- `libSDL3.so` native library through Android Prefab

The app native library `libnoveltea-sandbox.so` is built from source via CMake
externalNativeBuild. bgfx is not enabled for Android yet.

## Web (Emscripten)

For Web, SDL3 is provided by Emscripten's `-sUSE_SDL=3` flag. The current
skeleton uses a browser main loop and a stub renderer; bgfx and other native
libraries still need explicit Emscripten builds before they can be enabled.
