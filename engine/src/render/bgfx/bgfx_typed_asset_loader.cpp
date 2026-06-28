#include "render/bgfx/bgfx_typed_asset_loader.hpp"

#include "render/bgfx/bgfx_material_binder.hpp"

#include <bimg/bimg.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <algorithm>
#include <utility>
#include <vector>

namespace noveltea::bgfx_backend {
namespace {

template<class T> assets::AssetResult<T> fail(std::string error)
{
    return {std::nullopt, std::move(error)};
}

[[nodiscard]] std::string texture_cache_key(const assets::TextureAssetRequest& request)
{
    return request.path + "|" + std::string(to_string(request.sampler));
}

} // namespace

BgfxTypedAssetLoader::BgfxTypedAssetLoader(const assets::AssetManager& assets,
                                           BgfxShaderProgramCache& programs)
    : m_assets(assets), m_programs(programs)
{
}

BgfxTypedAssetLoader::~BgfxTypedAssetLoader() { clear_textures(); }

void BgfxTypedAssetLoader::set_shader_material_project(const ShaderMaterialProject* project)
{
    m_shader_materials = project;
}

void BgfxTypedAssetLoader::set_fallback_texture(bgfx::TextureHandle texture)
{
    m_fallback_texture = texture;
}

void BgfxTypedAssetLoader::clear_textures()
{
    for (auto& [key, texture] : m_textures) {
        if (bgfx::isValid(texture.handle)) {
            bgfx::destroy(texture.handle);
        }
    }
    m_textures.clear();
}

assets::AssetResult<assets::TextureAsset>
BgfxTypedAssetLoader::load_texture(const assets::TextureAssetRequest& request)
{
    if (request.path.empty()) {
        if (!bgfx::isValid(m_fallback_texture)) {
            return fail<assets::TextureAsset>(
                "empty texture path and no fallback texture available");
        }
        return {assets::TextureAsset{.handle = m_fallback_texture.idx, .path = "<fallback>"}, {}};
    }
    return load_decoded_texture(request);
}

assets::AssetResult<assets::TextureAsset>
BgfxTypedAssetLoader::load_decoded_texture(const assets::TextureAssetRequest& request)
{
    const std::string key = texture_cache_key(request);
    if (const auto found = m_textures.find(key); found != m_textures.end()) {
        return {assets::TextureAsset{.handle = found->second.handle.idx,
                                     .path = request.path,
                                     .width = found->second.width,
                                     .height = found->second.height},
                {}};
    }

    const auto bytes = m_assets.read_binary(request.path);
    if (!bytes) {
        return fail<assets::TextureAsset>("failed to read texture '" + request.path +
                                          "': " + bytes.error);
    }

    bx::DefaultAllocator allocator;
    bimg::ImageContainer* image =
        bimg::imageParse(&allocator, bytes.value->bytes.data(),
                         static_cast<uint32_t>(bytes.value->bytes.size()),
                         bimg::TextureFormat::RGBA8);
    if (!image) {
        return fail<assets::TextureAsset>("bimg could not decode texture '" + request.path + "'");
    }

    const uint32_t size =
        image->m_size > 0 ? image->m_size : image->m_width * image->m_height * 4u;
    const bgfx::TextureHandle handle = bgfx::createTexture2D(
        static_cast<uint16_t>(image->m_width), static_cast<uint16_t>(image->m_height), false, 1,
        bgfx::TextureFormat::RGBA8, bgfx_sampler_flags(request.sampler),
        bgfx::copy(static_cast<const uint8_t*>(image->m_data) + image->m_offset, size));
    const uint16_t width = static_cast<uint16_t>(image->m_width);
    const uint16_t height = static_cast<uint16_t>(image->m_height);
    bimg::imageFree(image);

    if (!bgfx::isValid(handle)) {
        return fail<assets::TextureAsset>("bgfx failed to create decoded texture '" + request.path +
                                          "'");
    }

    m_textures.emplace(key, CachedTexture{.handle = handle, .width = width, .height = height});
    return {assets::TextureAsset{
                .handle = handle.idx, .path = request.path, .width = width, .height = height},
            {}};
}

assets::AssetResult<assets::ShaderProgramAsset>
BgfxTypedAssetLoader::load_shader_program(const assets::ShaderProgramAssetRequest& request)
{
    std::vector<ShaderProgramDiagnostic> diagnostics;
    const auto handle = m_programs.load_program(request.resolution, &diagnostics);
    if (!bgfx::isValid(handle)) {
        std::string message = "failed to load shader program";
        if (!diagnostics.empty()) {
            message += ": " + diagnostics.front().message;
        }
        return fail<assets::ShaderProgramAsset>(std::move(message));
    }
    return {assets::ShaderProgramAsset{.handle = handle.idx, .key = request.resolution.key}, {}};
}

assets::AssetResult<assets::MaterialAsset>
BgfxTypedAssetLoader::load_material(const assets::MaterialAssetRequest& request)
{
    if (!m_shader_materials) {
        return fail<assets::MaterialAsset>("no shader material project bound to typed material loader");
    }
    auto parsed = parse_material_id(request.id);
    if (!parsed.id) {
        return fail<assets::MaterialAsset>("invalid material id '" + request.id + "'");
    }
    const MaterialDefinition* material = find_material(*m_shader_materials, *parsed.id);
    if (!material) {
        return fail<assets::MaterialAsset>("unknown material id '" + request.id + "'");
    }
    return {assets::MaterialAsset{.definition = material, .id = request.id}, {}};
}

} // namespace noveltea::bgfx_backend
