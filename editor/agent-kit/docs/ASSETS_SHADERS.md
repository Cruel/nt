# Assets, Shaders, and Materials

Add files with `noveltea asset import <path>...`; files already under `assets/` are registered in place. Use `noveltea asset audit` to list unregistered files there. Asset records preserve their complete current import/provenance metadata; do not discard fields merely because they look machine-generated. Asset source paths are explicit and are not renamed simply because an Asset record ID changes.

Materials are semantic authoring records rooted in engine-provided Material Presets or another Material. Shader code is source under `shaders/`, not a Shader record or Asset. Preset-backed Materials need no project shader files; use **Customize Shader** when project-owned source is needed, and reuse shader logic through source composition such as `#include`. Use `noveltea shaders compile` when native shader compilation is required. Do not invoke or distribute a separate shaderc executable for NovelTea workflows; raw bgfx-compatible forwarding is available as `noveltea shaderc ...`.

Material roles define renderer-owned inputs and pipeline behavior. In particular, NovelTea Material fragment outputs are premultiplied RGBA unless the role explicitly documents otherwise. When a custom shader has a straight-alpha color, include `noveltea_shader.sc` and write `noveltea_premultiply_alpha(color)` to `gl_FragColor` rather than returning straight RGBA. The helper computes `vec4(rgb * a, a)`.

Do not premultiply values that are already premultiplied. `engine.postprocess_source` is a premultiplied composition texture, so postprocess shaders should normally transform it in premultiplied space and return it directly. Renderer-owned samplers and other reserved inputs come from the selected Material role; do not replace their sources in authoring data.
