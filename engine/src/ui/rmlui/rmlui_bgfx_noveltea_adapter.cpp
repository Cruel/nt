#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#include "noveltea/render/material.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"

#include <RmlUi/Core/Core.h>
#include <RmlUi/Core/SystemInterface.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace noveltea::ui::rmlui {

namespace {

constexpr std::string_view kDrawTextureSource = "$draw.texture";

[[nodiscard]] bgfx_backend::SystemShader to_noveltea_shader(rmlui_bgfx::SystemProgram program)
{
    switch (program) {
    case rmlui_bgfx::SystemProgram::RmlUi:
        return bgfx_backend::SystemShader::RmlUi;
    case rmlui_bgfx::SystemProgram::Composite:
        return bgfx_backend::SystemShader::RmlUiComposite;
    case rmlui_bgfx::SystemProgram::CompositeFilter:
        return bgfx_backend::SystemShader::RmlUiCompositeFilter;
    case rmlui_bgfx::SystemProgram::Copy:
        return bgfx_backend::SystemShader::RmlUiCopy;
    case rmlui_bgfx::SystemProgram::Opacity:
        return bgfx_backend::SystemShader::RmlUiOpacity;
    case rmlui_bgfx::SystemProgram::ColorMatrix:
        return bgfx_backend::SystemShader::RmlUiColorMatrix;
    case rmlui_bgfx::SystemProgram::MaskMultiply:
        return bgfx_backend::SystemShader::RmlUiMaskMultiply;
    case rmlui_bgfx::SystemProgram::Blur:
        return bgfx_backend::SystemShader::RmlUiBlur;
    case rmlui_bgfx::SystemProgram::DropShadow:
        return bgfx_backend::SystemShader::RmlUiDropShadow;
    case rmlui_bgfx::SystemProgram::Gradient:
        return bgfx_backend::SystemShader::RmlUiGradient;
    }
    return bgfx_backend::SystemShader::RmlUi;
}

[[nodiscard]] const MaterialUniformAssignment*
find_uniform_assignment(const MaterialDefinition& material, std::string_view name)
{
    const auto found = std::find_if(
        material.uniforms.begin(), material.uniforms.end(),
        [name](const MaterialUniformAssignment& assignment) { return assignment.name == name; });
    return found == material.uniforms.end() ? nullptr : &*found;
}

[[nodiscard]] const MaterialTextureAssignment*
find_texture_assignment(const MaterialDefinition& material, std::string_view name)
{
    const auto found = std::find_if(
        material.textures.begin(), material.textures.end(),
        [name](const MaterialTextureAssignment& assignment) { return assignment.sampler == name; });
    return found == material.textures.end() ? nullptr : &*found;
}

[[nodiscard]] bool env_flag_enabled(const char* name)
{
    const char* value = std::getenv(name);
    return value && (value[0] == '1' || value[0] == 't' || value[0] == 'T' || value[0] == 'y' ||
                     value[0] == 'Y' || value[0] == 'o' || value[0] == 'O');
}

[[nodiscard]] rmlui_bgfx::RenderPath render_path_from_env()
{
    const char* value = std::getenv("RMLUI_BGFX_RENDER_PATH");
    if (!value) {
        return rmlui_bgfx::RenderPath::Optimized;
    }

    const std::string_view mode(value);
    if (mode == "optimized" || mode == "bounded" || mode == "fast") {
        return rmlui_bgfx::RenderPath::Optimized;
    }
    if (mode == "reference" || mode == "ref" || mode == "gl3" || mode == "gl3-compatible" ||
        mode == "compatible" || mode == "compat") {
        return rmlui_bgfx::RenderPath::Reference;
    }

    std::fprintf(stderr, "[rmlui-bgfx] unknown RMLUI_BGFX_RENDER_PATH='%s'; using optimized\n",
                 value);
    return rmlui_bgfx::RenderPath::Optimized;
}

[[nodiscard]] bool starts_with(std::string_view value, std::string_view prefix) noexcept
{
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

void premultiply_rgba(std::vector<std::uint8_t>& rgba)
{
    for (std::size_t i = 0; i + 3 < rgba.size(); i += 4) {
        const std::uint32_t alpha = rgba[i + 3];
        rgba[i + 0] = static_cast<std::uint8_t>((std::uint32_t(rgba[i + 0]) * alpha + 127u) / 255u);
        rgba[i + 1] = static_cast<std::uint8_t>((std::uint32_t(rgba[i + 1]) * alpha + 127u) / 255u);
        rgba[i + 2] = static_cast<std::uint8_t>((std::uint32_t(rgba[i + 2]) * alpha + 127u) / 255u);
    }
}

void log_program_diagnostic(std::string_view prefix, const ShaderProgramDiagnostic& diagnostic)
{
    std::fprintf(stderr, "[rmlui] %.*s: %s: %s\n", int(prefix.size()), prefix.data(),
                 diagnostic.context.c_str(), diagnostic.message.c_str());
}

[[nodiscard]] std::array<float, 4>
bound_uniform_value(const ShaderUniformDeclaration& uniform,
                    const MaterialUniformAssignment* assignment,
                    const rmlui_bgfx::RmlUiMaterialShaderDrawContext& context)
{
    if (uniform.binding) {
        switch (*uniform.binding) {
        case ShaderInputSemantic::EngineTime: {
            Rml::SystemInterface* system = Rml::GetSystemInterface();
            return {system ? static_cast<float>(system->GetElapsedTime()) : 0.0f, 0.0f, 0.0f, 0.0f};
        }
        case ShaderInputSemantic::EnginePaintDimensions:
        case ShaderInputSemantic::RmlUiPaintDimensions:
            return {context.paint_dimensions.x, context.paint_dimensions.y, 0.0f, 0.0f};
        case ShaderInputSemantic::EngineDpiScale:
        case ShaderInputSemantic::RmlUiDpiScale:
            return {context.dpi_scale, 0.0f, 0.0f, 0.0f};
        case ShaderInputSemantic::EnginePointerPosition:
            return {0.0f, 0.0f, 0.0f, 0.0f};
        case ShaderInputSemantic::EnginePointerValid:
            return {0.0f, 0.0f, 0.0f, 0.0f};
        }
    }

    const ShaderUniformValue* value =
        assignment != nullptr ? &assignment->value : &uniform.default_value;
    const auto packed = bgfx_backend::pack_material_uniform(*value);
    return packed.supported ? packed.value : std::array<float, 4>{};
}

} // namespace

struct BgfxRenderInterface::Adapter final : rmlui_bgfx::ShaderProvider,
                                            rmlui_bgfx::TextureLoader,
                                            rmlui_bgfx::Diagnostics,
                                            rmlui_bgfx::PerfLogger,
                                            rmlui_bgfx::MaterialShaderProvider {
    explicit Adapter(const assets::AssetManager& asset_manager,
                     const ShaderMaterialProject* shader_material_project)
        : assets(asset_manager), shader_materials(shader_material_project),
          program_cache(asset_manager)
    {
    }

    ~Adapter() override { clear_material_resources(); }

    bgfx::ProgramHandle load_program(rmlui_bgfx::SystemProgram program) override
    {
        return bgfx_backend::BgfxShaderLoader(assets).load_program(to_noveltea_shader(program));
    }

    bool load_rgba8(const char* source, rmlui_bgfx::LoadedTexture& out,
                    std::string* error_message) override
    {
        out = {};
        const std::string logical = resolve_asset_path(assets, source ? source : "");
        auto bytes = assets.read_binary(logical);
        if (!bytes || bytes.value->bytes.empty()) {
            if (error_message) {
                *error_message = logical;
                if (!bytes.error.empty()) {
                    *error_message += ": ";
                    *error_message += bytes.error;
                }
            }
            return false;
        }

        bx::DefaultAllocator allocator;
        bimg::ImageContainer* image =
            bimg::imageParse(&allocator, bytes.value->bytes.data(),
                             uint32_t(bytes.value->bytes.size()), bimg::TextureFormat::RGBA8);
        if (!image || image->m_width <= 0 || image->m_height <= 0 || !image->m_data ||
            image->m_format != bimg::TextureFormat::RGBA8 || image->m_numLayers != 1 ||
            image->m_depth != 1 || image->m_numMips != 1 ||
            image->m_size != image->m_width * image->m_height * 4u) {
            if (image)
                bimg::imageFree(image);
            if (error_message) {
                *error_message = logical;
                *error_message += ": image decode failed";
            }
            return false;
        }

        out.width = int(image->m_width);
        out.height = int(image->m_height);
        out.rgba8.assign(static_cast<const std::uint8_t*>(image->m_data),
                         static_cast<const std::uint8_t*>(image->m_data) + image->m_size);
        bimg::imageFree(image);
        return true;
    }

    void warning(std::string_view message) override
    {
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }

    void error(std::string_view message) override
    {
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }

    void log_perf_line(std::string_view message) override
    {
        std::fprintf(stderr, "%.*s\n", int(message.size()), message.data());
    }

    rmlui_bgfx::RmlUiMaterialShaderHandle
    compile_decorator_shader(const rmlui_bgfx::RmlUiMaterialShaderRequest& request) override
    {
        if (!shader_materials) {
            warning(
                "shader() decorator requested but no NovelTea shader/material project is bound");
            return {};
        }

        const auto parsed_id = parse_material_id(request.value);
        if (!parsed_id.id) {
            for (const MaterialDiagnostic& diagnostic : parsed_id.diagnostics) {
                std::fprintf(stderr, "[rmlui] invalid shader() material id '%.*s': %s\n",
                             int(request.value.size()), request.value.data(),
                             diagnostic.message.c_str());
            }
            return {};
        }

        const MaterialDefinition* material = find_material(*shader_materials, *parsed_id.id);
        if (!material) {
            std::fprintf(stderr, "[rmlui] unknown shader() material id '%s'\n",
                         parsed_id.id->value().c_str());
            return {};
        }
        if (material->role != ShaderRole::RmlUiDecorator) {
            std::fprintf(
                stderr,
                "[rmlui] shader() material '%s' has role '%.*s', expected 'rmlui-decorator'\n",
                parsed_id.id->value().c_str(), int(to_string(material->role).size()),
                to_string(material->role).data());
            return {};
        }

        const auto resolved = resolve_material_shader_program(*shader_materials, *parsed_id.id,
                                                              program_cache.active_variant());
        if (!resolved.program) {
            for (const auto& diagnostic : resolved.diagnostics)
                log_program_diagnostic("shader() material resolution failed", diagnostic);
            return {};
        }

        const std::uint64_t id = ++next_material_shader_id;
        material_shader_records.emplace(
            id, MaterialShaderRecord{*parsed_id.id, request.paint_dimensions});
        return rmlui_bgfx::RmlUiMaterialShaderHandle{id};
    }

    void release_decorator_shader(rmlui_bgfx::RmlUiMaterialShaderHandle shader) override
    {
        material_shader_records.erase(shader.id);
    }

    bool submit_decorator_shader(rmlui_bgfx::RmlUiMaterialShaderHandle shader,
                                 const rmlui_bgfx::RmlUiMaterialShaderDrawContext& context) override
    {
        const auto record_it = material_shader_records.find(shader.id);
        if (record_it == material_shader_records.end() || !shader_materials)
            return false;

        const MaterialDefinition* material =
            find_material(*shader_materials, record_it->second.material_id);
        if (!material || material->role != ShaderRole::RmlUiDecorator)
            return false;

        const auto resolved = resolve_material_shader_program(
            *shader_materials, record_it->second.material_id, program_cache.active_variant());
        if (!resolved.program) {
            for (const auto& diagnostic : resolved.diagnostics)
                log_program_diagnostic("shader() material resolution failed", diagnostic);
            return false;
        }

        std::vector<ShaderProgramDiagnostic> diagnostics;
        const bgfx::ProgramHandle program =
            program_cache.load_program(*resolved.program, &diagnostics);
        for (const auto& diagnostic : diagnostics)
            log_program_diagnostic("shader() material program load failed", diagnostic);
        if (!bgfx::isValid(program))
            return false;

        if (context.scissor_enabled) {
            const Rml::Rectanglei scissor = context.local_scissor;
            if (scissor.Width() <= 0 || scissor.Height() <= 0)
                return false;
            bgfx::setScissor(uint16_t(scissor.Left()), uint16_t(scissor.Top()),
                             uint16_t(scissor.Width()), uint16_t(scissor.Height()));
        }

        bgfx::setVertexBuffer(0, context.vertex_buffer);
        bgfx::setIndexBuffer(context.index_buffer, 0, context.index_count);
        bgfx::setUniform(context.projection_uniform, context.projection);
        bgfx::setUniform(context.transform_uniform, context.transform);
        const float translate[4] = {context.translation.x, context.translation.y, 0.0f, 0.0f};
        bgfx::setUniform(context.translate_uniform, translate);

        for (const auto& uniform : resolved.program->uniforms) {
            const MaterialUniformAssignment* assignment =
                find_uniform_assignment(*material, uniform.name);
            const std::array<float, 4> value = bound_uniform_value(uniform, assignment, context);
            bgfx::setUniform(uniform_handle(uniform.name), value.data());
        }

        uint8_t stage = 0;
        for (const auto& sampler : resolved.program->samplers) {
            const MaterialTextureAssignment* assignment =
                find_texture_assignment(*material, sampler.name);
            if (!assignment)
                continue;
            const bgfx::TextureHandle texture = texture_for_assignment(*assignment, context);
            if (!bgfx::isValid(texture))
                continue;
            bgfx::setTexture(stage++, sampler_handle(sampler.name), texture,
                             bgfx_backend::bgfx_sampler_flags(assignment->filtering));
        }

        bgfx::setState(context.premultiplied_blend_state);
        if (context.clip_mask_enabled)
            bgfx::setStencil(context.stencil_state);
        bgfx::submit(context.view, program);
        return true;
    }

    bgfx::UniformHandle uniform_handle(std::string_view name)
    {
        const std::string key(name);
        if (const auto found = uniforms.find(key); found != uniforms.end())
            return found->second;
        const bgfx::UniformHandle handle =
            bgfx::createUniform(key.c_str(), bgfx::UniformType::Vec4);
        uniforms.emplace(key, handle);
        return handle;
    }

    bgfx::UniformHandle sampler_handle(std::string_view name)
    {
        const std::string key(name);
        if (const auto found = samplers.find(key); found != samplers.end())
            return found->second;
        const bgfx::UniformHandle handle =
            bgfx::createUniform(key.c_str(), bgfx::UniformType::Sampler);
        samplers.emplace(key, handle);
        return handle;
    }

    bgfx::TextureHandle
    texture_for_assignment(const MaterialTextureAssignment& assignment,
                           const rmlui_bgfx::RmlUiMaterialShaderDrawContext& context)
    {
        if (assignment.source == kDrawTextureSource) {
            return bgfx::isValid(context.texture) ? context.texture : context.white_texture;
        }
        if (!starts_with(assignment.source, "project:/") &&
            !starts_with(assignment.source, "system:/")) {
            std::fprintf(stderr, "[rmlui] unsupported material texture source '%s'\n",
                         assignment.source.c_str());
            return context.white_texture;
        }

        const std::string key =
            assignment.source + "|" + std::string(to_string(assignment.filtering));
        if (const auto found = textures.find(key); found != textures.end())
            return found->second;

        rmlui_bgfx::LoadedTexture loaded;
        std::string error_message;
        if (!load_rgba8(assignment.source.c_str(), loaded, &error_message)) {
            std::fprintf(stderr, "[rmlui] material texture load failed: %s\n",
                         error_message.c_str());
            return context.white_texture;
        }
        premultiply_rgba(loaded.rgba8);
        const bgfx::TextureHandle texture = bgfx::createTexture2D(
            uint16_t(loaded.width), uint16_t(loaded.height), false, 1, bgfx::TextureFormat::RGBA8,
            bgfx_backend::bgfx_sampler_flags(assignment.filtering),
            bgfx::copy(loaded.rgba8.data(), uint32_t(loaded.rgba8.size())));
        if (!bgfx::isValid(texture))
            return context.white_texture;
        textures.emplace(key, texture);
        return texture;
    }

    void clear_material_resources()
    {
        for (auto& [_, texture] : textures) {
            if (bgfx::isValid(texture))
                bgfx::destroy(texture);
        }
        textures.clear();
        for (auto& [_, sampler] : samplers) {
            if (bgfx::isValid(sampler))
                bgfx::destroy(sampler);
        }
        samplers.clear();
        for (auto& [_, uniform] : uniforms) {
            if (bgfx::isValid(uniform))
                bgfx::destroy(uniform);
        }
        uniforms.clear();
        material_shader_records.clear();
    }

    struct MaterialShaderRecord {
        MaterialId material_id;
        Rml::Vector2f paint_dimensions;
    };

    const assets::AssetManager& assets;
    const ShaderMaterialProject* shader_materials = nullptr;
    bgfx_backend::BgfxShaderProgramCache program_cache;
    std::uint64_t next_material_shader_id = 0;
    std::unordered_map<std::uint64_t, MaterialShaderRecord> material_shader_records;
    std::unordered_map<std::string, bgfx::UniformHandle> uniforms;
    std::unordered_map<std::string, bgfx::UniformHandle> samplers;
    std::unordered_map<std::string, bgfx::TextureHandle> textures;
};

rmlui_bgfx::SurfaceMetrics to_rmlui_bgfx_surface(const SurfaceMetrics& surface)
{
    return rmlui_bgfx::SurfaceMetrics{surface.logical_width,     surface.logical_height,
                                      surface.framebuffer_width, surface.framebuffer_height,
                                      surface.scale_x,           surface.scale_y};
}

rmlui_bgfx::ViewRange rmlui_bgfx_runtime_view_range()
{
    return rmlui_bgfx::ViewRange{bgfx_backend::ViewRuntimeUIBegin, bgfx_backend::ViewRuntimeUIEnd};
}

rmlui_bgfx::ViewRange rmlui_bgfx_plane_view_range(core::PresentationPlane plane)
{
    switch (plane) {
    case core::PresentationPlane::WorldBackground:
        return {6, 9};
    case core::PresentationPlane::WorldContent:
        return {10, 15};
    case core::PresentationPlane::WorldOverlay:
        return {16, 31};
    case core::PresentationPlane::GameUi:
        return {bgfx_backend::ViewRuntimeUIBegin, 126};
    case core::PresentationPlane::MenuOverlay:
        return {128, 190};
    case core::PresentationPlane::Modal:
        return {191, bgfx_backend::ViewRuntimeUIEnd};
    case core::PresentationPlane::Transition:
        return {226, 237};
    case core::PresentationPlane::Debug:
        return {238, 249};
    }
    return {bgfx_backend::ViewRuntimeUIBegin, 126};
}

BgfxRenderInterface::BgfxRenderInterface(const PresentationMetrics& presentation,
                                         const assets::AssetManager& assets,
                                         const ShaderMaterialProject* shader_materials)
    : BgfxRenderInterface(presentation, assets, rmlui_bgfx_runtime_view_range(), shader_materials)
{
}

BgfxRenderInterface::BgfxRenderInterface(const PresentationMetrics& presentation,
                                         const assets::AssetManager& assets,
                                         rmlui_bgfx::ViewRange views,
                                         const ShaderMaterialProject* shader_materials)
    : m_adapter(std::make_unique<Adapter>(assets, shader_materials))
{
    rmlui_bgfx::RendererConfig config;
    config.surface = to_rmlui_bgfx_surface(presentation.game_surface);
    config.viewport = {presentation.host_framebuffer_viewport.x,
                       presentation.host_framebuffer_viewport.y,
                       presentation.host_framebuffer_viewport.width,
                       presentation.host_framebuffer_viewport.height};
    config.views = views;
    config.shaders = m_adapter.get();
    config.textures = m_adapter.get();
    config.diagnostics = m_adapter.get();
    config.perf_logger = m_adapter.get();
    config.material_shaders = m_adapter.get();
    config.render_path = render_path_from_env();
    config.trace_filter_pipeline = env_flag_enabled("RMLUI_BGFX_FILTER_TRACE");
    config.preserve_backbuffer = true;
    m_core = std::make_unique<rmlui_bgfx::RenderInterface>(config);
}

BgfxRenderInterface::~BgfxRenderInterface() = default;

BgfxRenderInterface::operator bool() const { return m_core && static_cast<bool>(*m_core); }

void BgfxRenderInterface::resize(const PresentationMetrics& presentation)
{
    m_core->resize(to_rmlui_bgfx_surface(presentation.game_surface),
                   {presentation.host_framebuffer_viewport.x,
                    presentation.host_framebuffer_viewport.y,
                    presentation.host_framebuffer_viewport.width,
                    presentation.host_framebuffer_viewport.height});
}

void BgfxRenderInterface::begin_frame() { m_core->begin_frame(); }
void BgfxRenderInterface::end_frame() { m_core->end_frame(); }
void BgfxRenderInterface::set_perf_logging_enabled(bool enabled)
{
    m_core->set_perf_logging_enabled(enabled);
}
void BgfxRenderInterface::set_base_direct_compatibility(bool enabled)
{
    m_core->set_base_direct_compatibility(enabled);
}

Rml::CompiledGeometryHandle
BgfxRenderInterface::CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                     Rml::Span<const int> indices)
{
    return m_core->CompileGeometry(vertices, indices);
}

void BgfxRenderInterface::RenderGeometry(Rml::CompiledGeometryHandle geometry,
                                         Rml::Vector2f translation, Rml::TextureHandle texture)
{
    m_core->RenderGeometry(geometry, translation, texture);
}

void BgfxRenderInterface::ReleaseGeometry(Rml::CompiledGeometryHandle geometry)
{
    m_core->ReleaseGeometry(geometry);
}

Rml::TextureHandle BgfxRenderInterface::LoadTexture(Rml::Vector2i& texture_dimensions,
                                                    const Rml::String& source)
{
    return m_core->LoadTexture(texture_dimensions, source);
}

Rml::TextureHandle BgfxRenderInterface::GenerateTexture(Rml::Span<const Rml::byte> source,
                                                        Rml::Vector2i source_dimensions)
{
    return m_core->GenerateTexture(source, source_dimensions);
}

void BgfxRenderInterface::ReleaseTexture(Rml::TextureHandle texture)
{
    m_core->ReleaseTexture(texture);
}

void BgfxRenderInterface::EnableScissorRegion(bool enable) { m_core->EnableScissorRegion(enable); }
void BgfxRenderInterface::SetScissorRegion(Rml::Rectanglei region)
{
    m_core->SetScissorRegion(region);
}
void BgfxRenderInterface::SetTransform(const Rml::Matrix4f* transform)
{
    m_core->SetTransform(transform);
}

void BgfxRenderInterface::EnableClipMask(bool enable) { m_core->EnableClipMask(enable); }
void BgfxRenderInterface::RenderToClipMask(Rml::ClipMaskOperation operation,
                                           Rml::CompiledGeometryHandle geometry,
                                           Rml::Vector2f translation)
{
    m_core->RenderToClipMask(operation, geometry, translation);
}

Rml::LayerHandle BgfxRenderInterface::PushLayer() { return m_core->PushLayer(); }

void BgfxRenderInterface::CompositeLayers(Rml::LayerHandle source, Rml::LayerHandle destination,
                                          Rml::BlendMode blend_mode,
                                          Rml::Span<const Rml::CompiledFilterHandle> filters)
{
    m_core->CompositeLayers(source, destination, blend_mode, filters);
}

void BgfxRenderInterface::PopLayer() { m_core->PopLayer(); }
Rml::TextureHandle BgfxRenderInterface::SaveLayerAsTexture()
{
    return m_core->SaveLayerAsTexture();
}
Rml::CompiledFilterHandle BgfxRenderInterface::SaveLayerAsMaskImage()
{
    return m_core->SaveLayerAsMaskImage();
}
Rml::CompiledFilterHandle BgfxRenderInterface::CompileFilter(const Rml::String& name,
                                                             const Rml::Dictionary& parameters)
{
    return m_core->CompileFilter(name, parameters);
}
void BgfxRenderInterface::ReleaseFilter(Rml::CompiledFilterHandle filter)
{
    m_core->ReleaseFilter(filter);
}
Rml::CompiledShaderHandle BgfxRenderInterface::CompileShader(const Rml::String& name,
                                                             const Rml::Dictionary& parameters)
{
    return m_core->CompileShader(name, parameters);
}
void BgfxRenderInterface::RenderShader(Rml::CompiledShaderHandle shader,
                                       Rml::CompiledGeometryHandle geometry,
                                       Rml::Vector2f translation, Rml::TextureHandle texture)
{
    m_core->RenderShader(shader, geometry, translation, texture);
}
void BgfxRenderInterface::ReleaseShader(Rml::CompiledShaderHandle shader)
{
    m_core->ReleaseShader(shader);
}

} // namespace noveltea::ui::rmlui
