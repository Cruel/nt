#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string_view>

namespace noveltea {

struct ShaderId {
    uint16_t index = UINT16_MAX;

    [[nodiscard]] bool valid() const { return index != UINT16_MAX; }
};

// Runtime shader handle with uniform-setting capabilities.
// Shader compilation is deferred — uniform methods are stubs that print a
// diagnostic message and return without action.
class Shader {
public:
    explicit Shader(ShaderId id) : m_id(id) {}

    [[nodiscard]] ShaderId id() const { return m_id; }
    [[nodiscard]] bool valid() const { return m_id.valid(); }

    void setUniform(std::string_view name, const float* data, std::size_t count)
    {
        std::fprintf(stderr,
                     "[shader] setUniform(\"%.*s\", %zu floats) deferred - "
                     "runtime shader compilation not yet implemented\n",
                     static_cast<int>(name.size()), name.data(), count);
        (void)data;
    }

    void setTextureUnit(std::string_view name, uint8_t unit)
    {
        std::fprintf(stderr,
                     "[shader] setTextureUnit(\"%.*s\", %u) deferred - "
                     "runtime shader compilation not yet implemented\n",
                     static_cast<int>(name.size()), name.data(), unit);
    }

private:
    ShaderId m_id;
};

} // namespace noveltea
