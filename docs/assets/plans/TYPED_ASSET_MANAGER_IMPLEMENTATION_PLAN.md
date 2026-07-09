# Typed AssetManager Implementation Plan

Date: 2026-06-28

## Purpose

Make `AssetManager` the public service/facade for prepared runtime assets, not only a logical-path byte reader. Engine/UI/rendering consumers should ask `AssetManager` for a font, texture, audio clip, material, shader program descriptor, or other typed asset and receive the prepared object/handle they need. Type-specific resolution details still exist, but they are implementation details behind `AssetManager` and specialized loader/resolver backends.

The first concrete target is fonts, because ActiveText and the text stack currently expose too much font policy at call sites. The long-term pattern should generalize to images, audio, materials, shaders, package assets, and editor preview resources.

## Current State

Relevant existing files and systems:

- `engine/include/noveltea/assets/asset_manager.hpp`
  - Owns logical namespace mounts and exposes `open`, `read_binary`, `read_text`, `exists`, and mount description.
  - Does not expose typed prepared assets.
- `engine/src/assets/asset_manager.cpp`
  - Mounts directories and legacy packages.
  - Maps legacy package entries into logical paths, including fonts under `project:/fonts/`.
- `engine/include/noveltea/text/font.hpp`
  - Defines `FontHandle`, `FontFamilyHandle`, `FontDesc`, `FontFamilyDesc`, and `ResolvedFont`.
  - Carries system font constants such as `sys`, `project:/rmlui/LiberationSans.ttf`, and `system:/fonts/LiberationSans.ttf`.
- `engine/src/text/text_engine.hpp/.cpp`
  - Owns FreeType/HarfBuzz state, concrete face loading, font family registration, default-family selection, alias resolution, synthetic style fallback, shaping, measuring, and rasterization.
  - `TextEngine` already uses `AssetManager::read_binary` internally for low-level font bytes.
- `engine/src/ui_runtime_rmlui.cpp`
  - Creates a `TextEngine` and registers `sys` from project/system Liberation Sans fallback paths.
  - ActiveText currently uses this local `TextEngine` and a default font alias, rather than a project-wide typed asset request.
- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
  - Owns another `TextEngine` inside the bgfx text renderer and exposes renderer-level `load_font` and text drawing.
- `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md`
  - Existing font-focused plan assumes direct font resolver work. This new plan supersedes the public API direction: callers should ask `AssetManager` for typed prepared assets; font resolver behavior lives behind the AssetManager typed-font loader.

## Desired Architecture

`AssetManager` remains the canonical runtime asset entry point.

Public callers should prefer typed asset requests:

```cpp
assets::FontAsset font = assets.load_font(FontAssetRequest{.alias = "body", .style = TextFontBold});
assets::TextureAsset texture = assets.load_texture(TextureAssetRequest{.path = "project:/ui/button.png"});
assets::AudioAsset audio = assets.load_audio(AudioAssetRequest{.path = "project:/audio/click.ogg"});
assets::MaterialAsset material = assets.load_material(MaterialAssetRequest{.id = "demo/active_text_glow"});
```

The exact names can change, but the ownership principle should not: consumers ask `AssetManager` for a typed prepared asset; type-specific policy and caches live behind it.

Internally:

```text
AssetManager
  ├── byte/text/open namespace sources
  ├── FontAssetLoader / FontResolver / TextEngine bridge
  ├── TextureAssetLoader / image decoder / renderer upload bridge
  ├── AudioAssetLoader / miniaudio decode/cache bridge
  ├── MaterialAssetLoader / material manifest resolver
  └── ShaderAssetLoader / platform variant resolver
```

Fonts need special attention because one author request may resolve through aliases, `fontDefault`, `sys`, real style faces, synthetic style bits, language fallback, and cached loaded faces. That complexity should be hidden from ActiveText, RmlUi bridge code, render code, and eventually editor preview.

## Ownership Boundary

`AssetManager` should own asset identity, logical path resolution, project defaults, type-specific loader registration, typed caches, and diagnostics.

`TextEngine` should own FreeType/HarfBuzz operations: turning loaded font bytes into concrete font faces, shaping, measuring, rasterizing, and resolving a registered family once the family has been registered.

`Renderer` should own GPU resources and upload lifetimes: bgfx textures, shader programs, material binding resources, and text atlas pages.

For typed assets that produce renderer-owned handles, `AssetManager` may need a loader backend supplied by the renderer. Avoid making core `AssetManager` depend directly on bgfx/miniaudio/FreeType types unless those are already engine-level abstractions.

## Core Design

### Typed asset request/result types

Add small request/result records under `engine/include/noveltea/assets/typed_assets.hpp` or adjacent headers. Initial font records might look like:

```cpp
namespace noveltea::assets {

struct FontAssetRequest {
    std::string alias;          // empty means project fontDefault
    uint32_t style = TextFontRegular;
    std::string language = "und";
    float size = 0.0f;          // optional caller hint, not part of logical identity unless needed
};

struct FontAsset {
    FontHandle face{};
    FontFamilyHandle family{};
    std::string resolved_alias;
    uint32_t requested_style = TextFontRegular;
    uint32_t synthetic_style = TextFontRegular;
};

} // namespace noveltea::assets
```

If `FontHandle` stays in the root `noveltea` namespace, the typed asset header can include `noveltea/text/font.hpp`.

The result should carry enough information for text shaping/rasterization to render correctly while keeping selection policy out of callers.

### Loader backend interfaces

`AssetManager` can stay lightweight by delegating typed work to registered loader interfaces:

```cpp
class FontAssetLoader {
public:
    virtual ~FontAssetLoader() = default;
    virtual AssetResult<FontAsset> load_font(const FontAssetRequest& request) = 0;
    virtual AssetResult<FontFamilyAsset> register_font_family(const FontFamilyAssetDesc& desc) = 0;
};
```

Then `AssetManager` exposes:

```cpp
void bind_font_loader(FontAssetLoader* loader);
AssetResult<FontAsset> load_font(const FontAssetRequest& request) const;
```

This avoids coupling `AssetManager` directly to `TextEngine` internals, while preserving the public API direction.

A simpler first slice may store a non-owning pointer to a `TextEngine`-backed adapter:

```cpp
assets.bind_font_loader(text_engine_asset_adapter);
```

The important rule: consumers call `AssetManager`, not `TextEngine`, for policy-level font resolution.

### Project font configuration

`AssetManager` should be able to ingest project-level font metadata when a runtime project is loaded. Current project documents include `fontDefault` and font alias mappings. The typed font loader should support at least:

- `fontDefault` string, defaulting to `sys` for new/legacy projects.
- `sys` system font alias.
- `sysIcon` system icon font alias.
- project font alias to logical font path mapping.
- optional family variants: regular, bold, italic, bold_italic.

If the current project schema only has alias-to-file mappings, support that first as regular-only family records with synthetic style fallback.

## Implementation Slices

### Slice 1: Typed asset facade scaffolding

Likely files:

- `engine/include/noveltea/assets/typed_assets.hpp`
- `engine/include/noveltea/assets/asset_manager.hpp`
- `engine/src/assets/asset_manager.cpp`
- `tests/assets/asset_manager_tests.cpp`
- `engine/CMakeLists.txt` if new sources are needed

Tasks:

1. Add typed request/result records for font assets first.
2. Add a `FontAssetLoader` interface or minimal adapter interface.
3. Add `AssetManager::bind_font_loader()` and `AssetManager::load_font(const FontAssetRequest&)`.
4. Return a structured `AssetResult<FontAsset>` error when no font loader is bound.
5. Add tests for unbound loader diagnostics and successful forwarding to a fake loader.

Acceptance:

- Existing raw `read_binary/read_text/open` APIs remain unchanged.
- No renderer/text code has to change yet.
- Asset tests prove `AssetManager` is now the facade for typed font requests.

### Slice 2: TextEngine-backed font loader adapter

Likely files:

- new `engine/include/noveltea/text/text_asset_loader.hpp`
- new `engine/src/text/text_asset_loader.cpp`
- `engine/src/text/text_engine.hpp/.cpp` if additional hooks are needed
- tests under `tests/text` or `tests/assets`

Tasks:

1. Implement a `TextFontAssetLoader` that adapts `TextEngine` to the `AssetManager` font loader interface.
2. Move current `sys` registration logic into this adapter or a helper invoked by it.
3. Support project/system fallback order for the engine system font:
   - prefer `project:/rmlui/LiberationSans.ttf` while it remains a sandbox compatibility asset;
   - fallback to `system:/fonts/LiberationSans.ttf`;
   - report a clear diagnostic if neither exists.
4. Register regular-only families with synthetic style enabled by default.
5. Map aliases `sys`, `Liberation Sans`, and existing runtime compatibility aliases to the same system family.
6. Preserve `TextEngine::load_font()` as the low-level concrete-face API.
7. Add tests for `sys`, empty alias via default, explicit alias, unknown alias fallback, and synthetic bold/italic fallback.

Acceptance:

- Font family policy is reachable through `AssetManager::load_font()`.
- Direct callers no longer need to know whether a font request used a real style face or synthetic bits.

### Slice 3: Project fontDefault and font alias ingestion

Likely files:

- `engine/src/assets/asset_manager.cpp`
- project loading code in `engine/src/engine.cpp` or project document conversion code
- `engine/include/noveltea/core/project_document.hpp` if richer font records are needed
- tests under `tests/core` and `tests/assets`

Tasks:

1. Add an API for applying project font configuration to the typed asset layer, for example:

```cpp
assets.configure_fonts(ProjectFontConfig{.default_alias = "body", .families = ...});
```

2. Derive initial config from current project schema:
   - `fontDefault`;
   - existing font alias mappings under the project root if available.
3. Treat each alias/path mapping as a regular-only family until richer variants exist.
4. Validate at load/configure time that each family has at least a regular/base face.
5. Record missing font diagnostics without crashing runtime project load unless the system fallback is also unavailable.
6. Add tests showing empty alias resolves to `fontDefault`, not hardcoded `sys`.

Acceptance:

- Project `fontDefault` is the source of default text alias resolution.
- `sys` remains a fallback, not the implicit policy everywhere.

### Slice 4: Route ActiveText through AssetManager typed fonts

Likely files:

- `engine/src/ui_runtime_rmlui.cpp`
- `engine/src/active_text_layout.cpp`
- `engine/include/noveltea/active_text_layout.hpp`
- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
- `tests/ui/active_text_layout_tests.cpp`

Tasks:

1. Replace ad hoc ActiveText system-font registration in `RuntimeUI` with typed `AssetManager::load_font()` calls.
2. Ensure `ActiveTextLayoutOptions` carries logical default font alias only; it should not force one concrete font.
3. In shaped ActiveText, resolve each run/span through `AssetManager`/TextEngine styled shaping rather than passing one `FontHandle` for every glyph.
4. Keep object hit rects, effect metadata, prompt metadata, and playback alpha unchanged.
5. Ensure material/direct shader batches still receive correct glyph visuals and alpha.
6. Add tests where `fontDefault = body` and empty rich-text font alias resolves to `body`, while `[font id=sys]` resolves to system fallback.

Acceptance:

- ActiveText no longer hardcodes Liberation Sans or `sys` outside typed asset/font configuration.
- ActiveText callers ask for fonts through `AssetManager` or a `TextEngine` path that was configured by `AssetManager`.

### Slice 5: Generalize the typed asset facade beyond fonts

Status: initial texture, shader-program, and material facade implemented. Audio remains deferred until the audio subsystem has prepared clip/stream ownership.

Implemented asset records/loaders:

- `TextureAssetRequest` / `TextureAsset`
- `ShaderProgramAssetRequest` / `ShaderProgramAsset`
- `MaterialAssetRequest` / `MaterialAsset`
- `TextureAssetLoader`, `ShaderProgramAssetLoader`, and `MaterialAssetLoader`

Tasks:

1. Define typed request/result records for each asset type, but keep implementation thin until a real caller needs it. Done for texture, shader-program, and material assets.
2. Keep renderer/audio backend ownership clean:
   - renderer owns bgfx handles;
   - audio backend owns decoded/streaming clip handles;
   - AssetManager owns logical identity, cache keys, and loader forwarding.
3. Migrate one existing texture path or material path to the typed facade as proof-of-pattern. The bgfx renderer now registers `BgfxTypedAssetLoader` for prepared texture/shader/material requests.
4. Document how new typed asset loaders should be registered at engine initialization.

Remaining follow-up tasks:

1. Route `BgfxMaterialBinder` texture dependency loading through `AssetManager::load_texture()` instead of its local PPM helper. Done.
2. Route direct shader/material consumers through `AssetManager::load_shader_program()` / `load_material()` where that improves ownership clarity. Done for `BgfxMaterialBinder`, with a direct unit-test fallback when no typed material loader is bound.
3. Add richer image decoding beyond the current PPM path when the runtime image decoder strategy is selected. Done for the typed bgfx texture loader using `bimg::imageParse`; the old runtime PPM parser/fallback has been removed.
4. Add audio typed asset records/loaders after the audio subsystem has prepared clip/stream ownership.

Acceptance:

- New asset consumers have a clear API pattern.
- No subsystem directly reimplements namespace/path/cache policy.

### Slice 6: Docs/status cleanup and old plan consolidation

Likely files:

- `docs/architecture/ENGINE_ARCHITECTURE.md`
- `docs/rendering/TEXT_IMPLEMENTATION.md`
- `docs/rendering/plans/TEXT_FONT_STYLE_PLAN.md`
- `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md`
- `docs/migration/STATUS.md`

Tasks:

1. Document `AssetManager` as both raw logical asset source and typed prepared asset facade.
2. Update ActiveText/text docs to say font policy is owned by typed assets/font loader, not by call sites.
3. Mark the old ActiveText font resolver plan as superseded or revise it to point to this typed AssetManager plan.
4. Update migration status when ActiveText font resolution is wired.
5. Remove this plan once all intended slices are complete.

## Testing Strategy

Focused tests while developing:

```sh
cmake --build build/linux-debug --target noveltea_core_tests noveltea_text_tests noveltea_ui_tests -j1
./build/linux-debug/tests/noveltea_core_tests --reporter compact
./build/linux-debug/tests/noveltea_text_tests --reporter compact
./build/linux-debug/tests/noveltea_ui_tests --reporter compact
```

If renderer text or material paths are touched:

```sh
cmake --build build/linux-debug --target noveltea-shaders noveltea_render_tests -j1
./build/linux-debug/tests/noveltea_render_tests --reporter compact
```

Runtime smoke:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox \
  --demo none \
  --runtime-project project:/projects/runtime_phase8.json \
  --frames 120 \
  --screenshot /tmp/noveltea-typed-assets-fonts-smoke.ppm \
  --no-imgui
```

Formatting:

```sh
cmake --build build/linux-debug --target format-check -j1
```

## Risks and Mitigations

Risk: `AssetManager` becomes a god object with backend-specific dependencies.

Mitigation: expose typed facade methods, but delegate to registered backend loader interfaces. Keep bgfx/miniaudio/FreeType ownership in renderer/audio/text subsystems.

Risk: font handles are renderer/text-engine-local and cannot safely be cached globally.

Mitigation: make typed font assets scoped to the bound text loader. Document that a `FontHandle` is valid only for that text engine/renderer context unless a stronger handle identity is introduced.

Risk: typed assets conflict with raw asset reads used by scripts/package tools.

Mitigation: keep raw APIs unchanged. Typed APIs are additive and intended for prepared runtime assets.

Risk: project font metadata is incomplete for real families.

Mitigation: support regular-only alias mappings first with synthetic fallback, then extend schema/import/export for variants.

Risk: ActiveText and renderer still maintain separate `TextEngine` instances.

Mitigation: first centralize policy through `AssetManager`; later consider unifying or explicitly scoping text engines per renderer/runtime context.

## Suggested Implementation Prompt

```text
@dev nt We are continuing NovelTea asset/font architecture work.

Repo: /home/thomas/dev/nt
Follow AGENTS.md. Do not touch untracked rmlui-bgfx/.
Read and implement docs/assets/plans/TYPED_ASSET_MANAGER_IMPLEMENTATION_PLAN.md.

Goal: make AssetManager the public typed prepared-asset facade, starting with fonts. Consumers should ask AssetManager for a prepared font asset and not care whether it came from project fontDefault, sys fallback, a real style face, or synthetic fallback. Keep raw read_binary/read_text/open APIs unchanged. Keep backend ownership clean: AssetManager delegates to typed loaders; TextEngine owns FreeType/HarfBuzz font operations; renderer owns GPU handles.

Start with Slice 1 and Slice 2: typed font request/result records, AssetManager font loader interface/binding, tests with a fake loader, then a TextEngine-backed loader adapter that handles sys/default alias and synthetic style fallback. If time allows, start Slice 3 by wiring project fontDefault into the typed font config.

Verification:
- cmake --build build/linux-debug --target format-check -j1
- cmake --build build/linux-debug --target noveltea_core_tests noveltea_text_tests noveltea_ui_tests -j1
- ./build/linux-debug/tests/noveltea_core_tests --reporter compact
- ./build/linux-debug/tests/noveltea_text_tests --reporter compact
- ./build/linux-debug/tests/noveltea_ui_tests --reporter compact
- If renderer text paths are touched: cmake --build build/linux-debug --target noveltea-shaders noveltea_render_tests -j1 && ./build/linux-debug/tests/noveltea_render_tests --reporter compact

Stage only relevant files. Leave rmlui-bgfx/ untouched.
```

## Exit Criteria

This plan is complete when:

- `AssetManager` exposes typed font loading/resolution through a stable public API.
- Font policy, including `fontDefault`, `sys`, aliases, style-face selection, and synthetic fallback, lives behind the typed asset layer.
- ActiveText requests fonts through the typed asset facade or a text engine configured exclusively through that facade.
- Raw logical asset APIs remain intact and tested.
- At least one additional asset category has a documented typed facade pattern, even if implementation remains thin.
- Docs and migration status explain the new AssetManager role and remaining backend-specific responsibilities.
