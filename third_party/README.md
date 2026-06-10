# Third-Party Dependencies

Third-party libraries used by NovelTea, managed through vcpkg (Linux desktop)
or SDK/system (Android, Web).

## Linux (vcpkg)

Dependencies are declared in `/vcpkg.json` at the project root and installed
automatically by CMake when the `VCPKG_ROOT` environment variable is set.

Current dependencies:
- **SDL3** — windowing, input, app lifecycle
- **bgfx** — rendering abstraction (desktop target)
- **Dear ImGui** — developer debug overlay (desktop target)
- **RmlUi** — future UI system (not yet integrated)
- **miniaudio** — future audio system (not yet integrated)
- **harfbuzz** — text shaping (for RmlUi)

## Android

For Android, native libraries (SDL3, bgfx) must be cross-compiled via the NDK.
This is handled through the Gradle project's `externalNativeBuild` CMake
integration. See `/android/README.md` for details.

## Web (Emscripten)

For Web, dependencies are provided by Emscripten's `-sUSE_SDL=3` flag.
bgfx and other native libs would need to be compiled for the Emscripten target.
See `/web/README.md` for details.
