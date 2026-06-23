#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"

#include <bgfx/bgfx.h>

#include <cstddef>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::bgfx_backend {

class BgfxShaderProgramCache {
public:
    explicit BgfxShaderProgramCache(const assets::AssetManager& assets);
    ~BgfxShaderProgramCache();

    BgfxShaderProgramCache(const BgfxShaderProgramCache&) = delete;
    BgfxShaderProgramCache& operator=(const BgfxShaderProgramCache&) = delete;

    [[nodiscard]] bgfx::ProgramHandle
    load_program(const ShaderProgramResolution& resolution,
                 std::vector<ShaderProgramDiagnostic>* diagnostics = nullptr);

    void clear();

    [[nodiscard]] std::size_t size() const noexcept { return m_programs.size(); }
    [[nodiscard]] const char* active_variant() const { return m_loader.shader_variant(); }

private:
    BgfxShaderLoader m_loader;
    std::unordered_map<std::string, bgfx::ProgramHandle> m_programs;
};

} // namespace noveltea::bgfx_backend
