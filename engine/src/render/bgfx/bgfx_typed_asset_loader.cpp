#include "render/bgfx/bgfx_typed_asset_loader.hpp"

#include "render/bgfx/bgfx_material_binder.hpp"

#include <bimg/bimg.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <algorithm>
#include <array>
#include <limits>
#include <span>
#include <utility>
#include <vector>

namespace noveltea::bgfx_backend {
namespace {

template<class T> assets::AssetLoadResult<T> fail(std::string error)
{
    return {std::nullopt, std::move(error)};
}

[[nodiscard]] std::string texture_cache_key(const assets::TextureAssetRequest& request)
{
    return request.path + "|" + std::string(to_string(request.sampler));
}

} // namespace

bool texture_sampler_uses_linear_filtering(MaterialTextureSampler sampler) noexcept
{
    return sampler == MaterialTextureSampler::ClampLinear ||
           sampler == MaterialTextureSampler::RepeatLinear;
}

Rgba8MipChain build_rgba8_mip_chain(std::span<const std::uint8_t> base_level, std::uint16_t width,
                                    std::uint16_t height)
{
    Rgba8MipChain result;
    const std::size_t base_size = static_cast<std::size_t>(width) * height * 4u;
    if (width == 0 || height == 0 || base_level.size() != base_size)
        return result;

    result.bytes.assign(base_level.begin(), base_level.end());
    result.mip_count = 1;
    std::vector<std::uint8_t> previous(base_level.begin(), base_level.end());
    std::uint16_t previous_width = width;
    std::uint16_t previous_height = height;
    while (previous_width > 1 || previous_height > 1) {
        const std::uint16_t next_width = std::max<std::uint16_t>(1, previous_width / 2);
        const std::uint16_t next_height = std::max<std::uint16_t>(1, previous_height / 2);
        std::vector<std::uint8_t> next(static_cast<std::size_t>(next_width) * next_height * 4u);
        for (std::uint16_t y = 0; y < next_height; ++y) {
            const std::uint16_t source_y_begin = static_cast<std::uint16_t>(
                static_cast<std::uint32_t>(y) * previous_height / next_height);
            const std::uint16_t source_y_end = static_cast<std::uint16_t>(
                static_cast<std::uint32_t>(y + 1) * previous_height / next_height);
            for (std::uint16_t x = 0; x < next_width; ++x) {
                const std::uint16_t source_x_begin = static_cast<std::uint16_t>(
                    static_cast<std::uint32_t>(x) * previous_width / next_width);
                const std::uint16_t source_x_end = static_cast<std::uint16_t>(
                    static_cast<std::uint32_t>(x + 1) * previous_width / next_width);
                for (std::size_t channel = 0; channel < 4; ++channel) {
                    std::uint32_t sum = 0;
                    std::uint32_t samples = 0;
                    for (std::uint16_t sample_y = source_y_begin; sample_y < source_y_end;
                         ++sample_y) {
                        for (std::uint16_t sample_x = source_x_begin; sample_x < source_x_end;
                             ++sample_x) {
                            const std::size_t source_index =
                                (static_cast<std::size_t>(sample_y) * previous_width + sample_x) *
                                    4u +
                                channel;
                            sum += previous[source_index];
                            ++samples;
                        }
                    }
                    const std::size_t destination_index =
                        (static_cast<std::size_t>(y) * next_width + x) * 4u + channel;
                    next[destination_index] =
                        static_cast<std::uint8_t>((sum + samples / 2u) / samples);
                }
            }
        }
        result.bytes.insert(result.bytes.end(), next.begin(), next.end());
        previous = std::move(next);
        previous_width = next_width;
        previous_height = next_height;
        ++result.mip_count;
    }
    return result;
}

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

assets::AssetLoadResult<assets::TextureAsset>
BgfxTypedAssetLoader::load_texture(const assets::TextureAssetRequest& request)
{
    if (request.path.empty()) {
        if (!bgfx::isValid(m_fallback_texture)) {
            return fail<assets::TextureAsset>(
                "empty texture path and no fallback texture available");
        }
        return {assets::TextureAsset{.handle = m_fallback_texture.idx,
                                     .path = "<fallback>",
                                     .sampler = request.sampler},
                {}};
    }
    return load_decoded_texture(request);
}

assets::AssetLoadResult<assets::TextureAsset>
BgfxTypedAssetLoader::load_decoded_texture(const assets::TextureAssetRequest& request)
{
    const std::string key = texture_cache_key(request);
    if (const auto found = m_textures.find(key); found != m_textures.end()) {
        return {assets::TextureAsset{.handle = found->second.handle.idx,
                                     .path = request.path,
                                     .width = found->second.width,
                                     .height = found->second.height,
                                     .sampler = request.sampler,
                                     .mip_count = found->second.mip_count},
                {}};
    }

    const auto bytes = m_assets.read_binary(request.path);
    if (!bytes) {
        return fail<assets::TextureAsset>("failed to read texture '" + request.path +
                                          "': " + bytes.error.message);
    }

    bx::DefaultAllocator allocator;
    bimg::ImageContainer* image = bimg::imageParse(&allocator, bytes.value->bytes.data(),
                                                   static_cast<uint32_t>(bytes.value->bytes.size()),
                                                   bimg::TextureFormat::RGBA8);
    if (!image) {
        return fail<assets::TextureAsset>("bimg could not decode texture '" + request.path + "'");
    }

    bimg::ImageMip base_mip;
    const bool valid_base =
        image->m_width > 0 && image->m_height > 0 && image->m_width <= UINT16_MAX &&
        image->m_height <= UINT16_MAX && image->m_numLayers == 1 && image->m_depth == 1 &&
        bimg::imageGetRawData(*image, 0, 0, image->m_data, image->m_size, base_mip) &&
        base_mip.m_format == bimg::TextureFormat::RGBA8;
    if (!valid_base) {
        bimg::imageFree(image);
        return fail<assets::TextureAsset>("decoded texture is not a supported RGBA8 2D image '" +
                                          request.path + "'");
    }
    const auto base_bytes = std::span<const std::uint8_t>(
        base_mip.m_data, static_cast<std::size_t>(base_mip.m_width) * base_mip.m_height * 4u);
    Rgba8MipChain upload;
    if (texture_sampler_uses_linear_filtering(request.sampler))
        upload = build_rgba8_mip_chain(base_bytes, static_cast<std::uint16_t>(base_mip.m_width),
                                       static_cast<std::uint16_t>(base_mip.m_height));
    else {
        upload.bytes.assign(base_bytes.begin(), base_bytes.end());
        upload.mip_count = 1;
    }
    if (upload.bytes.empty() || upload.mip_count == 0) {
        bimg::imageFree(image);
        return fail<assets::TextureAsset>("failed to build texture upload data '" + request.path +
                                          "'");
    }
    if (upload.bytes.size() > std::numeric_limits<std::uint32_t>::max()) {
        bimg::imageFree(image);
        return fail<assets::TextureAsset>("texture upload exceeds bgfx memory limits '" +
                                          request.path + "'");
    }
    const bgfx::TextureHandle handle = bgfx::createTexture2D(
        static_cast<uint16_t>(image->m_width), static_cast<uint16_t>(image->m_height),
        upload.mip_count > 1, 1, bgfx::TextureFormat::RGBA8, bgfx_sampler_flags(request.sampler),
        bgfx::copy(upload.bytes.data(), static_cast<std::uint32_t>(upload.bytes.size())));
    const uint16_t width = static_cast<uint16_t>(image->m_width);
    const uint16_t height = static_cast<uint16_t>(image->m_height);
    bimg::imageFree(image);

    if (!bgfx::isValid(handle)) {
        return fail<assets::TextureAsset>("bgfx failed to create decoded texture '" + request.path +
                                          "'");
    }

    m_textures.emplace(key, CachedTexture{.handle = handle,
                                          .width = width,
                                          .height = height,
                                          .mip_count = upload.mip_count});
    return {assets::TextureAsset{.handle = handle.idx,
                                 .path = request.path,
                                 .width = width,
                                 .height = height,
                                 .sampler = request.sampler,
                                 .mip_count = upload.mip_count},
            {}};
}

assets::AssetLoadResult<assets::ShaderProgramAsset>
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

assets::AssetLoadResult<assets::MaterialAsset>
BgfxTypedAssetLoader::load_material(const assets::MaterialAssetRequest& request)
{
    if (!m_shader_materials) {
        return fail<assets::MaterialAsset>(
            "no shader material project bound to typed material loader");
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
