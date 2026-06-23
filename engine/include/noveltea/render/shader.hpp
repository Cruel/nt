#pragma once

#include <string>

namespace noveltea {

// Authoring-time shader source reference used by .ntmat material assets.
// Runtime bgfx programs are resolved later from compiled shader binaries;
// this type intentionally does not represent a live GPU shader object.
struct ShaderSourceRef {
    std::string path;

    [[nodiscard]] bool empty() const noexcept { return path.empty(); }
};

} // namespace noveltea
