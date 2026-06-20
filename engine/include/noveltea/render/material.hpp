#pragma once

#include "noveltea/render/shader.hpp"

#include <cstdint>
#include <cstdio>

namespace noveltea {

struct MaterialId {
    ShaderId shader{};
};

// Material program resolution is deferred — runtime shader compilation is not
// yet implemented (see PLAN.md Phase 11 deferred items).
//
// When implemented, this section will provide:
//   - a material registry mapping MaterialId -> bgfx ProgramHandle
//   - platform-aware shader variant selection
//   - uniform default storage and override support
//   - a bind() path on QuadCommand for per-command material override
//
// ActiveText effects, map overlays, per-object materials, and per-room
// background shaders all depend on this resolution step.

inline void material_resolve_program(MaterialId)
{
    std::fprintf(stderr, "[material] material program resolution not yet implemented "
                         "- runtime shader compilation deferred\n");
}

} // namespace noveltea
