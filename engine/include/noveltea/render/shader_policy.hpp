#pragma once

// Shader/material resolution policy — deferred stub.
//
// Phase 11 of the migration plan identifies shader/material resolution as a
// required concern. The existing ShaderId type (render/shader.hpp) is already
// preserved in RichTextDocument effect spans and ActiveText metadata so that
// visual effects can reference shaders by id without parsing property strings.
//
// When this policy is implemented it should define:
//   - a MaterialId type
//   - mapping from project property keys (e.g. "shader", "material") to
//     ShaderId / MaterialId values
//   - a ShaderPolicy class that resolves ShaderId -> bgfx ProgramHandle at
//     runtime, with platform-aware shader variant selection
//   - a bind() path on QuadCommand for per-command shader/material override
//
// ActiveText effects, map overlays, per-object materials, and per-room
// background shaders all depend on this resolution step. See PLAN.md
// Phase 11 deferred items.

namespace noveltea {

// Placeholder for future MaterialId. Currently unused; shader references are
// passed through as ShaderId (render/shader.hpp).
struct MaterialId {
    uint16_t index = UINT16_MAX;

    [[nodiscard]] bool valid() const { return index != UINT16_MAX; }
};

} // namespace noveltea
