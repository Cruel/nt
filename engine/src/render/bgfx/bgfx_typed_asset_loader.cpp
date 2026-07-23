#include "render/bgfx/bgfx_typed_asset_loader.hpp"

#include "assets/asset_preparation_io.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"

#include <bimg/bimg.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
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

[[nodiscard]] std::uint64_t saturating_add(std::uint64_t lhs, std::uint64_t rhs) noexcept
{
    return rhs > std::numeric_limits<std::uint64_t>::max() - lhs
               ? std::numeric_limits<std::uint64_t>::max()
               : lhs + rhs;
}

[[nodiscard]] std::uint64_t saturating_multiply(std::uint64_t value,
                                                std::uint64_t multiplier) noexcept
{
    if (value == 0 || multiplier == 0)
        return 0;
    return value > std::numeric_limits<std::uint64_t>::max() / multiplier
               ? std::numeric_limits<std::uint64_t>::max()
               : value * multiplier;
}

struct EncodedImageDimensions {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

[[nodiscard]] std::uint16_t big_u16(std::span<const std::uint8_t> bytes,
                                    std::size_t offset) noexcept
{
    return static_cast<std::uint16_t>((static_cast<std::uint16_t>(bytes[offset]) << 8u) |
                                      bytes[offset + 1u]);
}

[[nodiscard]] std::uint32_t big_u32(std::span<const std::uint8_t> bytes,
                                    std::size_t offset) noexcept
{
    return (static_cast<std::uint32_t>(bytes[offset]) << 24u) |
           (static_cast<std::uint32_t>(bytes[offset + 1u]) << 16u) |
           (static_cast<std::uint32_t>(bytes[offset + 2u]) << 8u) |
           static_cast<std::uint32_t>(bytes[offset + 3u]);
}

[[nodiscard]] std::uint16_t little_u16(std::span<const std::uint8_t> bytes,
                                       std::size_t offset) noexcept
{
    return static_cast<std::uint16_t>(bytes[offset]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[offset + 1u]) << 8u);
}

[[nodiscard]] std::uint32_t little_u24(std::span<const std::uint8_t> bytes,
                                       std::size_t offset) noexcept
{
    return static_cast<std::uint32_t>(bytes[offset]) |
           (static_cast<std::uint32_t>(bytes[offset + 1u]) << 8u) |
           (static_cast<std::uint32_t>(bytes[offset + 2u]) << 16u);
}

[[nodiscard]] std::uint32_t little_u32(std::span<const std::uint8_t> bytes,
                                       std::size_t offset) noexcept
{
    return little_u24(bytes, offset) | (static_cast<std::uint32_t>(bytes[offset + 3u]) << 24u);
}

[[nodiscard]] bool jpeg_sof_marker(std::uint8_t marker) noexcept
{
    switch (marker) {
    case 0xc0:
    case 0xc1:
    case 0xc2:
    case 0xc3:
    case 0xc5:
    case 0xc6:
    case 0xc7:
    case 0xc9:
    case 0xca:
    case 0xcb:
    case 0xcd:
    case 0xce:
    case 0xcf:
        return true;
    default:
        return false;
    }
}

[[nodiscard]] std::optional<EncodedImageDimensions>
probe_encoded_image_dimensions(std::span<const std::uint8_t> bytes) noexcept
{
    constexpr std::array png_signature = {
        std::uint8_t{0x89}, std::uint8_t{'P'},  std::uint8_t{'N'},  std::uint8_t{'G'},
        std::uint8_t{0x0d}, std::uint8_t{0x0a}, std::uint8_t{0x1a}, std::uint8_t{0x0a}};
    if (bytes.size() >= 24u &&
        std::equal(png_signature.begin(), png_signature.end(), bytes.begin()) &&
        std::equal(bytes.begin() + 12, bytes.begin() + 16, "IHDR")) {
        return EncodedImageDimensions{.width = big_u32(bytes, 16), .height = big_u32(bytes, 20)};
    }

    if (bytes.size() >= 10u && bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F') {
        return EncodedImageDimensions{.width = little_u16(bytes, 6),
                                      .height = little_u16(bytes, 8)};
    }

    if (bytes.size() >= 26u && bytes[0] == 'B' && bytes[1] == 'M') {
        const std::uint32_t width = little_u32(bytes, 18);
        const std::int32_t signed_height = static_cast<std::int32_t>(little_u32(bytes, 22));
        const std::uint32_t height = signed_height < 0
                                         ? static_cast<std::uint32_t>(-(signed_height + 1)) + 1u
                                         : static_cast<std::uint32_t>(signed_height);
        return EncodedImageDimensions{.width = width, .height = height};
    }

    if (bytes.size() >= 30u && std::equal(bytes.begin(), bytes.begin() + 4, "RIFF") &&
        std::equal(bytes.begin() + 8, bytes.begin() + 12, "WEBP")) {
        if (std::equal(bytes.begin() + 12, bytes.begin() + 16, "VP8X")) {
            return EncodedImageDimensions{.width = little_u24(bytes, 24) + 1u,
                                          .height = little_u24(bytes, 27) + 1u};
        }
        if (bytes.size() >= 25u && std::equal(bytes.begin() + 12, bytes.begin() + 16, "VP8L") &&
            bytes[20] == 0x2fu) {
            const std::uint32_t width = 1u + static_cast<std::uint32_t>(bytes[21]) +
                                        ((static_cast<std::uint32_t>(bytes[22]) & 0x3fu) << 8u);
            const std::uint32_t height = 1u + (static_cast<std::uint32_t>(bytes[22]) >> 6u) +
                                         (static_cast<std::uint32_t>(bytes[23]) << 2u) +
                                         ((static_cast<std::uint32_t>(bytes[24]) & 0x0fu) << 10u);
            return EncodedImageDimensions{.width = width, .height = height};
        }
        if (bytes.size() >= 30u && std::equal(bytes.begin() + 12, bytes.begin() + 16, "VP8 ") &&
            bytes[23] == 0x9du && bytes[24] == 0x01u && bytes[25] == 0x2au) {
            return EncodedImageDimensions{.width = little_u16(bytes, 26) & 0x3fffu,
                                          .height = little_u16(bytes, 28) & 0x3fffu};
        }
    }

    if (bytes.size() >= 4u && bytes[0] == 0xffu && bytes[1] == 0xd8u) {
        std::size_t offset = 2u;
        while (offset + 4u <= bytes.size()) {
            while (offset < bytes.size() && bytes[offset] == 0xffu)
                ++offset;
            if (offset >= bytes.size())
                break;
            const std::uint8_t marker = bytes[offset++];
            if (marker == 0xd8u || marker == 0xd9u || marker == 0x01u ||
                (marker >= 0xd0u && marker <= 0xd7u)) {
                continue;
            }
            if (offset + 2u > bytes.size())
                break;
            const std::uint16_t segment_size = big_u16(bytes, offset);
            if (segment_size < 2u || segment_size > bytes.size() - offset)
                break;
            if (jpeg_sof_marker(marker) && segment_size >= 7u) {
                return EncodedImageDimensions{.width = big_u16(bytes, offset + 5u),
                                              .height = big_u16(bytes, offset + 3u)};
            }
            offset += segment_size;
        }
    }
    return std::nullopt;
}

[[nodiscard]] std::uint64_t rgba8_mip_chain_bytes(std::uint32_t width, std::uint32_t height,
                                                  bool mipmapped) noexcept
{
    std::uint64_t total = saturating_multiply(saturating_multiply(width, height), 4u);
    if (!mipmapped)
        return total;
    while (width > 1u || height > 1u) {
        width = std::max<std::uint32_t>(1u, width / 2u);
        height = std::max<std::uint32_t>(1u, height / 2u);
        total = saturating_add(total, saturating_multiply(saturating_multiply(width, height), 4u));
    }
    return total;
}

[[nodiscard]] std::vector<std::uint8_t> build_next_rgba8_mip(std::span<const std::uint8_t> previous,
                                                             std::uint16_t previous_width,
                                                             std::uint16_t previous_height)
{
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
                for (std::uint16_t sample_y = source_y_begin; sample_y < source_y_end; ++sample_y) {
                    for (std::uint16_t sample_x = source_x_begin; sample_x < source_x_end;
                         ++sample_x) {
                        const std::size_t source_index =
                            (static_cast<std::size_t>(sample_y) * previous_width + sample_x) * 4u +
                            channel;
                        sum += previous[source_index];
                        ++samples;
                    }
                }
                const std::size_t destination_index =
                    (static_cast<std::size_t>(y) * next_width + x) * 4u + channel;
                next[destination_index] = static_cast<std::uint8_t>((sum + samples / 2u) / samples);
            }
        }
    }
    return next;
}

[[nodiscard]] std::uint64_t material_prepared_size(const MaterialDefinition& material) noexcept
{
    std::uint64_t total = sizeof(MaterialDefinition);
    total = saturating_add(total, material.id.string().size());
    total = saturating_add(total, material.shader.string().size());
    total = saturating_add(total, material.display_name.size());
    total = saturating_add(
        total, saturating_multiply(material.uniforms.size(), sizeof(MaterialUniformAssignment)));
    for (const auto& uniform : material.uniforms)
        total = saturating_add(total, uniform.name.size());
    total = saturating_add(
        total, saturating_multiply(material.textures.size(), sizeof(MaterialTextureAssignment)));
    for (const auto& texture : material.textures) {
        total = saturating_add(total, texture.sampler.size());
        total = saturating_add(total, texture.source.size());
    }
    return total;
}

template<class T>
[[nodiscard]] core::Result<assets::PreparedAsset<T>, core::Diagnostics>
preparation_failure(std::string code, std::string message)
{
    return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::failure(
        {{.code = std::move(code), .message = std::move(message)}});
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
        auto next = build_next_rgba8_mip(previous, previous_width, previous_height);
        result.bytes.insert(result.bytes.end(), next.begin(), next.end());
        previous = std::move(next);
        previous_width = next_width;
        previous_height = next_height;
        ++result.mip_count;
    }
    return result;
}

struct TexturePreparationTask::Impl {
    enum class Stage : std::uint8_t {
        Reading,
        Sizing,
        AwaitingReservation,
        Decoding,
        Mipmaps,
        Ready,
    };

    Impl(const assets::AssetManager& configured_assets, TexturePreparationOwner& configured_owner,
         assets::TextureAssetRequest configured_request)
        : assets(configured_assets), owner(configured_owner), request(std::move(configured_request))
    {
        if (request.path.empty()) {
            stage = Stage::Ready;
            return;
        }
        const std::uint64_t source_size =
            assets::detail::estimated_source_size(assets, request.path);
        const std::uint64_t estimated_pixels = saturating_multiply(source_size, 4);
        estimate.gpu_bytes = estimated_pixels;
        estimate.temporary_bytes =
            saturating_add(source_size, saturating_multiply(estimated_pixels, 2));
        read = std::make_unique<assets::detail::IncrementalAssetRead>(assets, request.path,
                                                                      "assets.texture_preparation");
    }

    const assets::AssetManager& assets;
    TexturePreparationOwner& owner;
    assets::TextureAssetRequest request;
    std::unique_ptr<assets::detail::IncrementalAssetRead> read;
    assets::AssetBytes source_bytes;
    std::vector<std::uint8_t> current_mip;
    PreparedTextureUpload prepared;
    assets::ResidencyCost estimate;
    Stage stage = Stage::Reading;
    std::uint16_t current_width = 0;
    std::uint16_t current_height = 0;
    std::uint64_t compressed_bytes = 0;
    std::uint64_t uncompressed_bytes = 0;
    bool finalized = false;
    bool awaiting_reservation_update = false;
};

TexturePreparationTask::TexturePreparationTask(const assets::AssetManager& assets,
                                               TexturePreparationOwner& owner,
                                               assets::TextureAssetRequest request)
    : m_impl(std::make_unique<Impl>(assets, owner, std::move(request)))
{
}

TexturePreparationTask::~TexturePreparationTask() = default;

assets::ResidencyCost TexturePreparationTask::estimated_cost_on_owner() const noexcept
{
    return m_impl->estimate;
}

bool TexturePreparationTask::reservation_update_required_on_owner() const noexcept
{
    return m_impl->awaiting_reservation_update;
}

void TexturePreparationTask::reservation_update_granted_on_owner() noexcept
{
    if (!m_impl->awaiting_reservation_update)
        return;
    m_impl->awaiting_reservation_update = false;
    m_impl->stage = Impl::Stage::Decoding;
}

assets::AssetCacheState TexturePreparationTask::cache_state_for_next_step() const noexcept
{
    return m_impl->stage == Impl::Stage::Reading ? assets::AssetCacheState::Reading
                                                 : assets::AssetCacheState::Preparing;
}

assets::AssetPreparationTelemetry TexturePreparationTask::telemetry_on_owner() const noexcept
{
    return {.compressed_bytes = m_impl->compressed_bytes,
            .uncompressed_bytes = m_impl->uncompressed_bytes};
}

jobs::JobStepOutcome TexturePreparationTask::step(jobs::JobContext& context) noexcept
{
    if (context.cancellation_requested())
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};

    switch (m_impl->stage) {
    case Impl::Stage::Reading: {
        auto outcome = m_impl->read->step(context);
        if (outcome.status == jobs::JobStepStatus::Failed)
            return outcome;
        if (!m_impl->read->ready())
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        m_impl->compressed_bytes = m_impl->read->compressed_bytes();
        m_impl->uncompressed_bytes = m_impl->read->uncompressed_bytes();
        m_impl->source_bytes = m_impl->read->take_bytes();
        m_impl->read.reset();
        m_impl->stage = Impl::Stage::Sizing;
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }
    case Impl::Stage::Sizing: {
        const auto dimensions = probe_encoded_image_dimensions(m_impl->source_bytes);
        if (!dimensions || dimensions->width == 0 || dimensions->height == 0 ||
            dimensions->width > UINT16_MAX || dimensions->height > UINT16_MAX) {
            return {
                .status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "assets.texture_preparation.invalid_dimensions",
                                 .message = "texture dimensions are unavailable or unsupported '" +
                                            m_impl->request.path + "'"}}};
        }
        const bool mipmapped = texture_sampler_uses_linear_filtering(m_impl->request.sampler) &&
                               (dimensions->width > 1u || dimensions->height > 1u);
        const std::uint64_t base_bytes =
            saturating_multiply(saturating_multiply(dimensions->width, dimensions->height), 4u);
        const std::uint64_t mip_bytes =
            rgba8_mip_chain_bytes(dimensions->width, dimensions->height, mipmapped);
        const std::uint64_t next_mip_bytes =
            mipmapped
                ? saturating_multiply(
                      saturating_multiply(std::max<std::uint32_t>(1u, dimensions->width / 2u),
                                          std::max<std::uint32_t>(1u, dimensions->height / 2u)),
                      4u)
                : 0u;
        std::uint64_t peak = m_impl->source_bytes.size();
        peak = saturating_add(peak, saturating_multiply(base_bytes, 2u));
        peak = saturating_add(peak, saturating_multiply(mip_bytes, 2u));
        peak = saturating_add(peak, next_mip_bytes);
        if (peak == std::numeric_limits<std::uint64_t>::max() ||
            mip_bytes > std::numeric_limits<std::size_t>::max()) {
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = {{.code = "assets.texture_preparation.size_overflow",
                                     .message = "texture decoded size exceeds supported limits '" +
                                                m_impl->request.path + "'"}}};
        }
        m_impl->estimate.gpu_bytes = mip_bytes;
        m_impl->estimate.temporary_bytes = peak;
        m_impl->awaiting_reservation_update = true;
        m_impl->stage = Impl::Stage::AwaitingReservation;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    case Impl::Stage::AwaitingReservation:
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = {
                    {.code = "assets.texture_preparation.reservation_not_updated",
                     .message = "texture decoding resumed before memory reservation update"}}};
    case Impl::Stage::Decoding: {
        if (m_impl->source_bytes.size() > std::numeric_limits<std::uint32_t>::max()) {
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = {{.code = "assets.texture_preparation.source_too_large",
                                     .message = "texture source exceeds bimg decode limits '" +
                                                m_impl->request.path + "'"}}};
        }
        bx::DefaultAllocator allocator;
        bimg::ImageContainer* image = bimg::imageParse(
            &allocator, m_impl->source_bytes.data(),
            static_cast<uint32_t>(m_impl->source_bytes.size()), bimg::TextureFormat::RGBA8);
        if (!image) {
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = {{.code = "assets.texture_preparation.decode_failed",
                                     .message = "bimg could not decode texture '" +
                                                m_impl->request.path + "'"}}};
        }

        bimg::ImageMip base_mip;
        const bool valid_base =
            image->m_width > 0 && image->m_height > 0 && image->m_width <= UINT16_MAX &&
            image->m_height <= UINT16_MAX && image->m_numLayers == 1 && image->m_depth == 1 &&
            bimg::imageGetRawData(*image, 0, 0, image->m_data, image->m_size, base_mip) &&
            base_mip.m_format == bimg::TextureFormat::RGBA8;
        if (!valid_base) {
            bimg::imageFree(image);
            return {
                .status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "assets.texture_preparation.unsupported_image",
                                 .message = "decoded texture is not a supported RGBA8 2D image '" +
                                            m_impl->request.path + "'"}}};
        }

        const auto base_bytes = std::span<const std::uint8_t>(
            base_mip.m_data, static_cast<std::size_t>(base_mip.m_width) * base_mip.m_height * 4u);
        m_impl->prepared.request = m_impl->request;
        m_impl->prepared.width = static_cast<std::uint16_t>(base_mip.m_width);
        m_impl->prepared.height = static_cast<std::uint16_t>(base_mip.m_height);
        m_impl->prepared.mip_count = 1;
        m_impl->prepared.bytes.assign(base_bytes.begin(), base_bytes.end());
        m_impl->current_mip.assign(base_bytes.begin(), base_bytes.end());
        m_impl->current_width = m_impl->prepared.width;
        m_impl->current_height = m_impl->prepared.height;
        bimg::imageFree(image);
        m_impl->source_bytes.clear();
        m_impl->source_bytes.shrink_to_fit();

        if (texture_sampler_uses_linear_filtering(m_impl->request.sampler) &&
            (m_impl->current_width > 1 || m_impl->current_height > 1)) {
            m_impl->stage = Impl::Stage::Mipmaps;
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        m_impl->stage = Impl::Stage::Ready;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    case Impl::Stage::Mipmaps: {
        auto next = build_next_rgba8_mip(m_impl->current_mip, m_impl->current_width,
                                         m_impl->current_height);
        m_impl->prepared.bytes.insert(m_impl->prepared.bytes.end(), next.begin(), next.end());
        m_impl->current_mip = std::move(next);
        m_impl->current_width = std::max<std::uint16_t>(1, m_impl->current_width / 2);
        m_impl->current_height = std::max<std::uint16_t>(1, m_impl->current_height / 2);
        ++m_impl->prepared.mip_count;
        if (m_impl->current_width == 1 && m_impl->current_height == 1) {
            m_impl->current_mip.clear();
            m_impl->stage = Impl::Stage::Ready;
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }
    case Impl::Stage::Ready:
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    return {.status = jobs::JobStepStatus::Failed,
            .diagnostics = {{.code = "assets.texture_preparation.invalid_state",
                             .message = "texture preparation entered an invalid state"}}};
}

core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>
TexturePreparationTask::finalize_on_owner() noexcept
{
    if (m_impl->stage != Impl::Stage::Ready || m_impl->finalized) {
        return preparation_failure<assets::TextureAsset>(
            "assets.texture_preparation.not_ready",
            "texture preparation was finalized before it was ready");
    }
    m_impl->finalized = true;
    if (m_impl->request.path.empty())
        m_impl->prepared.request = m_impl->request;
    return m_impl->owner.finalize_texture_on_owner(std::move(m_impl->prepared));
}

struct ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::Impl {
    enum class Stage : std::uint8_t {
        Vertex,
        Fragment,
        Ready,
    };

    Impl(const assets::AssetManager& assets, ShaderMaterialPreparationOwner& configured_owner,
         assets::ShaderProgramAssetRequest configured_request)
        : owner(configured_owner), request(std::move(configured_request)),
          vertex(assets, request.resolution.vertex.path, "assets.shader_preparation.vertex"),
          fragment(assets, request.resolution.fragment.path, "assets.shader_preparation.fragment")
    {
        const std::uint64_t vertex_size =
            assets::detail::estimated_source_size(assets, request.resolution.vertex.path);
        const std::uint64_t fragment_size =
            assets::detail::estimated_source_size(assets, request.resolution.fragment.path);
        const std::uint64_t total = saturating_add(vertex_size, fragment_size);
        estimate.gpu_bytes = total;
        estimate.temporary_bytes = total;
    }

    ShaderMaterialPreparationOwner& owner;
    assets::ShaderProgramAssetRequest request;
    assets::detail::IncrementalAssetRead vertex;
    assets::detail::IncrementalAssetRead fragment;
    PreparedShaderProgram prepared;
    assets::ResidencyCost estimate;
    Stage stage = Stage::Vertex;
    bool finalized = false;
};

ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::ShaderMaterialPreparationTask(
    const assets::AssetManager& assets, ShaderMaterialPreparationOwner& owner,
    assets::ShaderProgramAssetRequest request)
    : m_impl(std::make_unique<Impl>(assets, owner, std::move(request)))
{
}

ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::~ShaderMaterialPreparationTask() =
    default;

assets::ResidencyCost
ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::estimated_cost_on_owner() const noexcept
{
    return m_impl->estimate;
}

assets::AssetCacheState
ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::cache_state_for_next_step()
    const noexcept
{
    return m_impl->stage == Impl::Stage::Ready ? assets::AssetCacheState::Preparing
                                               : assets::AssetCacheState::Reading;
}

assets::AssetPreparationTelemetry
ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::telemetry_on_owner() const noexcept
{
    return {.compressed_bytes =
                m_impl->vertex.compressed_bytes() + m_impl->fragment.compressed_bytes(),
            .uncompressed_bytes =
                m_impl->vertex.uncompressed_bytes() + m_impl->fragment.uncompressed_bytes()};
}

jobs::JobStepOutcome
ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::step(jobs::JobContext& context) noexcept
{
    if (context.cancellation_requested())
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    if (m_impl->stage == Impl::Stage::Vertex) {
        auto outcome = m_impl->vertex.step(context);
        if (outcome.status == jobs::JobStepStatus::Failed)
            return outcome;
        if (!m_impl->vertex.ready())
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        m_impl->prepared.vertex_bytes = m_impl->vertex.take_bytes();
        m_impl->stage = Impl::Stage::Fragment;
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }
    if (m_impl->stage == Impl::Stage::Fragment) {
        auto outcome = m_impl->fragment.step(context);
        if (outcome.status == jobs::JobStepStatus::Failed)
            return outcome;
        if (!m_impl->fragment.ready())
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        m_impl->prepared.fragment_bytes = m_impl->fragment.take_bytes();
        m_impl->prepared.request = m_impl->request;
        m_impl->stage = Impl::Stage::Ready;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
}

core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>
ShaderMaterialPreparationTask<assets::ShaderProgramAsset>::finalize_on_owner() noexcept
{
    if (m_impl->stage != Impl::Stage::Ready || m_impl->finalized) {
        return preparation_failure<assets::ShaderProgramAsset>(
            "assets.shader_preparation.not_ready",
            "shader program preparation was finalized before it was ready");
    }
    m_impl->finalized = true;
    return m_impl->owner.finalize_shader_program_on_owner(std::move(m_impl->prepared));
}

struct ShaderMaterialPreparationTask<assets::MaterialAsset>::Impl {
    Impl(ShaderMaterialPreparationOwner& configured_owner,
         assets::MaterialAssetRequest configured_request,
         std::optional<MaterialDefinition> configured_material, std::string configured_error)
        : owner(configured_owner), request(std::move(configured_request)),
          material(std::move(configured_material)), error(std::move(configured_error))
    {
        if (material)
            prepared_cpu_bytes = material_prepared_size(*material);
    }

    ShaderMaterialPreparationOwner& owner;
    assets::MaterialAssetRequest request;
    std::optional<MaterialDefinition> material;
    std::string error;
    std::uint64_t prepared_cpu_bytes = 0;
    std::size_t uniform_index = 0;
    std::size_t texture_index = 0;
    bool ready = false;
    bool finalized = false;
};

ShaderMaterialPreparationTask<assets::MaterialAsset>::ShaderMaterialPreparationTask(
    ShaderMaterialPreparationOwner& owner, assets::MaterialAssetRequest request,
    std::optional<MaterialDefinition> material, std::string preparation_error)
    : m_impl(std::make_unique<Impl>(owner, std::move(request), std::move(material),
                                    std::move(preparation_error)))
{
}

ShaderMaterialPreparationTask<assets::MaterialAsset>::~ShaderMaterialPreparationTask() = default;

assets::ResidencyCost
ShaderMaterialPreparationTask<assets::MaterialAsset>::estimated_cost_on_owner() const noexcept
{
    return {.prepared_cpu_bytes = m_impl->prepared_cpu_bytes,
            .temporary_bytes = m_impl->prepared_cpu_bytes};
}

jobs::JobStepOutcome
ShaderMaterialPreparationTask<assets::MaterialAsset>::step(jobs::JobContext& context) noexcept
{
    if (context.cancellation_requested())
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    if (!m_impl->error.empty() || !m_impl->material) {
        return {
            .status = jobs::JobStepStatus::Failed,
            .diagnostics = {{.code = "assets.material_preparation.lookup_failed",
                             .message = m_impl->error.empty() ? "material definition is unavailable"
                                                              : m_impl->error}}};
    }
    if (m_impl->uniform_index < m_impl->material->uniforms.size()) {
        const auto& uniform = m_impl->material->uniforms[m_impl->uniform_index++];
        if (uniform.name.empty()) {
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = {{.code = "assets.material_preparation.invalid_uniform",
                                     .message = "material '" + m_impl->request.id +
                                                "' has an unnamed uniform assignment"}}};
        }
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }
    if (m_impl->texture_index < m_impl->material->textures.size()) {
        const auto& texture = m_impl->material->textures[m_impl->texture_index++];
        if (texture.sampler.empty() || texture.source.empty()) {
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = {{.code = "assets.material_preparation.invalid_texture",
                                     .message = "material '" + m_impl->request.id +
                                                "' has an incomplete texture assignment"}}};
        }
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }
    m_impl->ready = true;
    return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
}

core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>
ShaderMaterialPreparationTask<assets::MaterialAsset>::finalize_on_owner() noexcept
{
    if (!m_impl->ready || m_impl->finalized || !m_impl->material) {
        return preparation_failure<assets::MaterialAsset>(
            "assets.material_preparation.not_ready",
            "material preparation was finalized before it was ready");
    }
    m_impl->finalized = true;
    return m_impl->owner.finalize_material_on_owner(
        std::move(m_impl->request), std::move(*m_impl->material), m_impl->prepared_cpu_bytes);
}

BgfxTypedAssetLoader::BgfxTypedAssetLoader(const assets::AssetManager& assets,
                                           BgfxShaderProgramCache& programs)
    : m_assets(assets), m_programs(programs)
{
}

BgfxTypedAssetLoader::~BgfxTypedAssetLoader()
{
    m_assets.bind_texture_loader(nullptr);
    m_assets.bind_shader_program_loader(nullptr);
    m_assets.bind_material_loader(nullptr);
    clear_textures();
}

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

std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
BgfxTypedAssetLoader::create_texture_preparation_task(const assets::TextureAssetRequest& request)
{
    auto& owner = static_cast<TexturePreparationOwner&>(*this);
    return std::make_unique<TexturePreparationTask>(m_assets, owner, request);
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

std::unique_ptr<assets::AssetPreparationTask<assets::ShaderProgramAsset>>
BgfxTypedAssetLoader::create_shader_program_preparation_task(
    const assets::ShaderProgramAssetRequest& request)
{
    auto& owner = static_cast<ShaderMaterialPreparationOwner&>(*this);
    return std::make_unique<ShaderMaterialPreparationTask<assets::ShaderProgramAsset>>(
        m_assets, owner, request);
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

std::unique_ptr<assets::AssetPreparationTask<assets::MaterialAsset>>
BgfxTypedAssetLoader::create_material_preparation_task(const assets::MaterialAssetRequest& request)
{
    auto& owner = static_cast<ShaderMaterialPreparationOwner&>(*this);
    if (!m_shader_materials) {
        return std::make_unique<ShaderMaterialPreparationTask<assets::MaterialAsset>>(
            owner, request, std::nullopt,
            "no shader material project bound to typed material loader");
    }
    auto parsed = parse_material_id(request.id);
    if (!parsed.id) {
        return std::make_unique<ShaderMaterialPreparationTask<assets::MaterialAsset>>(
            owner, request, std::nullopt, "invalid material id '" + request.id + "'");
    }
    const MaterialDefinition* material = find_material(*m_shader_materials, *parsed.id);
    if (!material) {
        return std::make_unique<ShaderMaterialPreparationTask<assets::MaterialAsset>>(
            owner, request, std::nullopt, "unknown material id '" + request.id + "'");
    }
    return std::make_unique<ShaderMaterialPreparationTask<assets::MaterialAsset>>(owner, request,
                                                                                  *material);
}

core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>
BgfxTypedAssetLoader::finalize_texture_on_owner(PreparedTextureUpload prepared) noexcept
{
    if (prepared.request.path.empty()) {
        if (!bgfx::isValid(m_fallback_texture)) {
            return preparation_failure<assets::TextureAsset>(
                "assets.texture_preparation.no_fallback",
                "empty texture path and no fallback texture is available");
        }
        return core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>::
            success({.asset = assets::TextureAsset{.handle = m_fallback_texture.idx,
                                                   .path = "<fallback>",
                                                   .sampler = prepared.request.sampler},
                     .cost = {},
                     .destroy_on_owner = {}});
    }
    if (prepared.bytes.empty() || prepared.mip_count == 0 || prepared.width == 0 ||
        prepared.height == 0 || prepared.bytes.size() > std::numeric_limits<std::uint32_t>::max()) {
        return preparation_failure<assets::TextureAsset>(
            "assets.texture_preparation.invalid_upload",
            "prepared texture upload is invalid for '" + prepared.request.path + "'");
    }

    const std::uint64_t gpu_bytes = prepared.bytes.size();
    const bgfx::TextureHandle handle = bgfx::createTexture2D(
        prepared.width, prepared.height, prepared.mip_count > 1, 1, bgfx::TextureFormat::RGBA8,
        bgfx_sampler_flags(prepared.request.sampler),
        bgfx::copy(prepared.bytes.data(), static_cast<std::uint32_t>(prepared.bytes.size())));
    if (!bgfx::isValid(handle)) {
        return preparation_failure<assets::TextureAsset>(
            "assets.texture_preparation.bgfx_create_failed",
            "bgfx failed to create prepared texture '" + prepared.request.path + "'");
    }

    return core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>::success(
        {.asset = assets::TextureAsset{.handle = handle.idx,
                                       .path = std::move(prepared.request.path),
                                       .width = prepared.width,
                                       .height = prepared.height,
                                       .sampler = prepared.request.sampler,
                                       .mip_count = prepared.mip_count},
         .cost = {.gpu_bytes = gpu_bytes},
         .destroy_on_owner = [](assets::TextureAsset& asset) {
             const bgfx::TextureHandle resident{asset.handle};
             if (bgfx::isValid(resident))
                 bgfx::destroy(resident);
             asset.handle = assets::invalid_typed_asset_handle;
         }});
}

core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>
BgfxTypedAssetLoader::finalize_shader_program_on_owner(PreparedShaderProgram prepared) noexcept
{
    if (prepared.vertex_bytes.empty() || prepared.fragment_bytes.empty() ||
        prepared.vertex_bytes.size() > std::numeric_limits<std::uint32_t>::max() ||
        prepared.fragment_bytes.size() > std::numeric_limits<std::uint32_t>::max()) {
        return preparation_failure<assets::ShaderProgramAsset>(
            "assets.shader_preparation.invalid_binary",
            "prepared shader program contains an empty or oversized compiled binary");
    }

    const bgfx::ShaderHandle vertex = bgfx::createShader(bgfx::copy(
        prepared.vertex_bytes.data(), static_cast<std::uint32_t>(prepared.vertex_bytes.size())));
    if (!bgfx::isValid(vertex)) {
        return preparation_failure<assets::ShaderProgramAsset>(
            "assets.shader_preparation.vertex_create_failed",
            "bgfx failed to create vertex shader '" + prepared.request.resolution.vertex.path +
                "'");
    }
    const bgfx::ShaderHandle fragment =
        bgfx::createShader(bgfx::copy(prepared.fragment_bytes.data(),
                                      static_cast<std::uint32_t>(prepared.fragment_bytes.size())));
    if (!bgfx::isValid(fragment)) {
        bgfx::destroy(vertex);
        return preparation_failure<assets::ShaderProgramAsset>(
            "assets.shader_preparation.fragment_create_failed",
            "bgfx failed to create fragment shader '" + prepared.request.resolution.fragment.path +
                "'");
    }
    const bgfx::ProgramHandle program = bgfx::createProgram(vertex, fragment, true);
    if (!bgfx::isValid(program)) {
        bgfx::destroy(vertex);
        bgfx::destroy(fragment);
        return preparation_failure<assets::ShaderProgramAsset>(
            "assets.shader_preparation.program_create_failed",
            "bgfx failed to create prepared shader program");
    }

    const std::uint64_t gpu_bytes =
        saturating_add(prepared.vertex_bytes.size(), prepared.fragment_bytes.size());
    return core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>::
        success(
            {.asset = assets::ShaderProgramAsset{.handle = program.idx,
                                                 .key = std::move(prepared.request.resolution.key)},
             .cost = {.gpu_bytes = gpu_bytes},
             .destroy_on_owner = [](assets::ShaderProgramAsset& asset) {
                 const bgfx::ProgramHandle resident{asset.handle};
                 if (bgfx::isValid(resident))
                     bgfx::destroy(resident);
                 asset.handle = assets::invalid_typed_asset_handle;
             }});
}

core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>
BgfxTypedAssetLoader::finalize_material_on_owner(assets::MaterialAssetRequest request,
                                                 MaterialDefinition material,
                                                 std::uint64_t prepared_cpu_bytes) noexcept
{
    auto owned = std::make_unique<MaterialDefinition>(std::move(material));
    MaterialDefinition* definition = owned.release();
    return core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>::success(
        {.asset = assets::MaterialAsset{.definition = definition, .id = std::move(request.id)},
         .cost = {.prepared_cpu_bytes = prepared_cpu_bytes},
         .destroy_on_owner = [](assets::MaterialAsset& asset) {
             delete asset.definition;
             asset.definition = nullptr;
         }});
}

} // namespace noveltea::bgfx_backend
