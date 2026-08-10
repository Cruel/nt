# Assets, Shaders, and Materials

Asset records preserve their complete current import/provenance metadata; do not discard fields merely because they look machine-generated. Asset source paths are explicit and are not renamed simply because an Asset record ID changes.

Shaders and Materials are ordinary authoring records. Use `noveltea shaders compile` when native shader compilation is required. Do not invoke or distribute a separate shaderc executable for NovelTea workflows; raw bgfx-compatible forwarding is available as `noveltea shaderc ...`.
