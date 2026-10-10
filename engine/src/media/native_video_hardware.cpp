#include "media/native_video_hardware.hpp"

#if defined(__linux__) && !defined(__ANDROID__) && !defined(__EMSCRIPTEN__)
#include <SDL3/SDL_loadso.h>
#include <va/va.h>
#include <vpx/vpx_codec.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>

// Pinned libvpx quantizer tables are shared by its decoder and the VA picture adapter.
extern "C" int16_t vp9_dc_quant(int, int, vpx_bit_depth_t);
extern "C" int16_t vp9_ac_quant(int, int, vpx_bit_depth_t);

namespace noveltea::media {
namespace {

class Bits {
public:
    explicit Bits(std::span<const std::uint8_t> bytes) : bytes(bytes) {}
    unsigned read(unsigned count)
    {
        unsigned value = 0;
        for (unsigned bit = 0; bit < count; ++bit) {
            if (position >= bytes.size() * 8) {
                valid = false;
                return 0;
            }
            value = (value << 1) | ((bytes[position / 8] >> (7 - position % 8)) & 1);
            ++position;
        }
        return value;
    }
    int signed_value(unsigned count)
    {
        const auto value = read(count);
        return read(1) ? -static_cast<int>(value) : static_cast<int>(value);
    }
    int delta() { return read(1) ? signed_value(4) : 0; }
    std::span<const std::uint8_t> bytes;
    std::size_t position = 0;
    bool valid = true;
};

struct Header {
    VADecPictureParameterBufferVP9 picture{};
    VASliceParameterBufferVP9 slice{};
    unsigned refresh = 0;
    int existing = -1;
    bool full_range = false;
    bool bt709 = false;
};

static_assert(sizeof(Header) <= 512);

class Headers {
public:
    bool parse(std::span<const std::uint8_t> encoded, unsigned width, unsigned height,
               Header& header)
    {
        Bits bits(encoded);
        if (bits.read(2) != 2)
            return false;
        const auto profile_low = bits.read(1);
        const auto profile = profile_low | (bits.read(1) << 1);
        if (profile != 0)
            return false;
        if (bits.read(1)) {
            header.existing = static_cast<int>(bits.read(3));
            header.full_range = full_range;
            header.bt709 = bt709;
            return bits.valid;
        }
        auto& picture = header.picture;
        auto& fields = picture.pic_fields.bits;
        picture.profile = 0;
        picture.bit_depth = 8;
        picture.frame_width = width;
        picture.frame_height = height;
        fields.subsampling_x = fields.subsampling_y = 1;
        fields.frame_type = bits.read(1);
        fields.show_frame = bits.read(1);
        fields.error_resilient_mode = bits.read(1);
        if (!fields.show_frame)
            return false;
        const auto read_size = [&] {
            const auto w = bits.read(16) + 1;
            const auto h = bits.read(16) + 1;
            return w == width && h == height;
        };
        const auto read_render_size = [&] {
            if (bits.read(1)) {
                bits.read(16);
                bits.read(16);
            }
        };
        if (!fields.frame_type) {
            if (bits.read(24) != 0x498342)
                return false;
            const auto color_space = bits.read(3);
            if (color_space == 7 || color_space == 5 || color_space == 6)
                return false;
            full_range = bits.read(1);
            bt709 = color_space == 2;
            if (!read_size())
                return false;
            read_render_size();
            header.refresh = 255;
        } else {
            if (!fields.error_resilient_mode)
                fields.reset_frame_context = bits.read(2);
            header.refresh = bits.read(8);
            fields.last_ref_frame = bits.read(3);
            fields.last_ref_frame_sign_bias = bits.read(1);
            fields.golden_ref_frame = bits.read(3);
            fields.golden_ref_frame_sign_bias = bits.read(1);
            fields.alt_ref_frame = bits.read(3);
            fields.alt_ref_frame_sign_bias = bits.read(1);
            bool reference_size = false;
            for (unsigned ref = 0; ref < 3; ++ref)
                if (bits.read(1)) {
                    reference_size = true;
                    break;
                }
            if (!reference_size && !read_size())
                return false;
            read_render_size();
            fields.allow_high_precision_mv = bits.read(1);
            if (bits.read(1))
                fields.mcomp_filter_type = 4;
            else {
                const std::array<unsigned, 4> filters{1, 0, 2, 3};
                fields.mcomp_filter_type = filters[bits.read(2)];
            }
        }
        if (fields.error_resilient_mode)
            fields.frame_parallel_decoding_mode = 1;
        else {
            fields.refresh_frame_context = bits.read(1);
            fields.frame_parallel_decoding_mode = bits.read(1);
        }
        fields.frame_context_idx = bits.read(2);
        if (!fields.frame_type || fields.error_resilient_mode) {
            ref_delta = {1, 0, -1, -1};
            mode_delta = {0, 0};
        }
        picture.filter_level = bits.read(6);
        picture.sharpness_level = bits.read(3);
        const bool delta_enabled = bits.read(1);
        if (delta_enabled && bits.read(1)) {
            for (auto& delta : ref_delta)
                if (bits.read(1))
                    delta = bits.signed_value(6);
            for (auto& delta : mode_delta)
                if (bits.read(1))
                    delta = bits.signed_value(6);
        }
        const int quantizer = bits.read(8);
        const auto y_dc = bits.delta();
        const auto uv_dc = bits.delta();
        const auto uv_ac = bits.delta();
        fields.lossless_flag = quantizer == 0 && y_dc == 0 && uv_dc == 0 && uv_ac == 0;
        // Segmented streams remain fully supported by the software decoder. Preflight every
        // packet before selecting VA so the backend never changes midway through an occurrence.
        if (bits.read(1))
            return false;
        auto& segment = header.slice.seg_param[0];
        for (unsigned ref = 0; ref < 4; ++ref)
            for (unsigned mode = 0; mode < 2; ++mode) {
                const int scale = 1 << (picture.filter_level >> 5);
                const auto level =
                    picture.filter_level +
                    (delta_enabled ? ref_delta[ref] * scale + (ref ? mode_delta[mode] * scale : 0)
                                   : 0);
                segment.filter_level[ref][mode] = std::clamp(level, 0, 63);
            }
        segment.luma_ac_quant_scale = vp9_ac_quant(quantizer, 0, VPX_BITS_8);
        segment.luma_dc_quant_scale = vp9_dc_quant(quantizer, y_dc, VPX_BITS_8);
        segment.chroma_ac_quant_scale = vp9_ac_quant(quantizer, uv_ac, VPX_BITS_8);
        segment.chroma_dc_quant_scale = vp9_dc_quant(quantizer, uv_dc, VPX_BITS_8);
        const auto columns = (width + 63) / 64;
        unsigned minimum = 0;
        while ((64u << minimum) < columns)
            ++minimum;
        unsigned maximum = 0;
        while ((columns >> (maximum + 1)) >= 4)
            ++maximum;
        picture.log2_tile_columns = minimum;
        while (picture.log2_tile_columns < maximum && bits.read(1))
            ++picture.log2_tile_columns;
        picture.log2_tile_rows = bits.read(1);
        if (picture.log2_tile_rows)
            picture.log2_tile_rows += bits.read(1);
        picture.first_partition_size = bits.read(16);
        picture.frame_header_length_in_bytes = (bits.position + 7) / 8;
        header.slice.slice_data_size = encoded.size();
        header.slice.slice_data_flag = VA_SLICE_DATA_FLAG_ALL;
        header.full_range = full_range;
        header.bt709 = bt709;
        return bits.valid && picture.first_partition_size &&
               picture.frame_header_length_in_bytes + picture.first_partition_size <=
                   encoded.size();
    }

private:
    std::array<int, 4> ref_delta{1, 0, -1, -1};
    std::array<int, 2> mode_delta{};
    bool full_range = false;
    bool bt709 = false;
};

struct Va {
    Va() : library(SDL_LoadObject("libva.so.2")), drm(SDL_LoadObject("libva-drm.so.2")) {}
    ~Va()
    {
        if (drm)
            SDL_UnloadObject(drm);
        if (library)
            SDL_UnloadObject(library);
    }
    template<class T> T symbol(const char* name)
    {
        return reinterpret_cast<T>(library ? SDL_LoadFunction(library, name) : nullptr);
    }
    SDL_SharedObject* library;
    SDL_SharedObject* drm;
    using GetDisplay = VADisplay (*)(int);
    GetDisplay get_display =
        reinterpret_cast<GetDisplay>(drm ? SDL_LoadFunction(drm, "vaGetDisplayDRM") : nullptr);
    decltype(&vaInitialize) initialize = symbol<decltype(&vaInitialize)>("vaInitialize");
    decltype(&vaTerminate) terminate = symbol<decltype(&vaTerminate)>("vaTerminate");
    decltype(&vaGetConfigAttributes) attributes =
        symbol<decltype(&vaGetConfigAttributes)>("vaGetConfigAttributes");
    decltype(&vaCreateConfig) create_config = symbol<decltype(&vaCreateConfig)>("vaCreateConfig");
    decltype(&vaDestroyConfig) destroy_config =
        symbol<decltype(&vaDestroyConfig)>("vaDestroyConfig");
    decltype(&vaCreateSurfaces) create_surfaces =
        symbol<decltype(&vaCreateSurfaces)>("vaCreateSurfaces");
    decltype(&vaDestroySurfaces) destroy_surfaces =
        symbol<decltype(&vaDestroySurfaces)>("vaDestroySurfaces");
    decltype(&vaCreateContext) create_context =
        symbol<decltype(&vaCreateContext)>("vaCreateContext");
    decltype(&vaDestroyContext) destroy_context =
        symbol<decltype(&vaDestroyContext)>("vaDestroyContext");
    decltype(&vaCreateBuffer) create_buffer = symbol<decltype(&vaCreateBuffer)>("vaCreateBuffer");
    decltype(&vaDestroyBuffer) destroy_buffer =
        symbol<decltype(&vaDestroyBuffer)>("vaDestroyBuffer");
    decltype(&vaBeginPicture) begin = symbol<decltype(&vaBeginPicture)>("vaBeginPicture");
    decltype(&vaRenderPicture) render = symbol<decltype(&vaRenderPicture)>("vaRenderPicture");
    decltype(&vaEndPicture) end = symbol<decltype(&vaEndPicture)>("vaEndPicture");
    decltype(&vaSyncSurface) sync = symbol<decltype(&vaSyncSurface)>("vaSyncSurface");
    decltype(&vaDeriveImage) derive = symbol<decltype(&vaDeriveImage)>("vaDeriveImage");
    decltype(&vaDestroyImage) destroy_image = symbol<decltype(&vaDestroyImage)>("vaDestroyImage");
    decltype(&vaMapBuffer) map = symbol<decltype(&vaMapBuffer)>("vaMapBuffer");
    decltype(&vaUnmapBuffer) unmap = symbol<decltype(&vaUnmapBuffer)>("vaUnmapBuffer");
    bool available() const
    {
        return get_display && initialize && terminate && attributes && create_config &&
               destroy_config && create_surfaces && destroy_surfaces && create_context &&
               destroy_context && create_buffer && destroy_buffer && begin && render && end &&
               sync && derive && destroy_image && map && unmap;
    }
};

class VaDecoder final : public NativeVideoHardwareDecoder {
public:
    explicit VaDecoder(std::shared_ptr<const NativeVideoSource> source) : source(std::move(source))
    {
        surfaces.fill(VA_INVALID_SURFACE);
        references.fill(VA_INVALID_SURFACE);
    }
    ~VaDecoder() override
    {
        if (context != VA_INVALID_ID)
            va.destroy_context(display, context);
        if (surfaces[0] != VA_INVALID_SURFACE)
            va.destroy_surfaces(display, surfaces.data(), surfaces.size());
        if (config != VA_INVALID_ID)
            va.destroy_config(display, config);
        if (initialized)
            va.terminate(display);
        if (fd >= 0)
            close(fd);
    }
    bool open()
    {
        if (!va.available())
            return false;
        if (source->packets().size() * sizeof(Header) >
            NativeVideoDecoder::memory_budget(source->width(), source->height()) / 4)
            return false;
        Headers parser;
        headers.resize(source->packets().size());
        for (std::size_t index = 0; index < headers.size(); ++index)
            if (!parser.parse(source->packet(index), source->width(), source->height(),
                              headers[index]))
                return false;
        for (unsigned node = 128; node < 144; ++node) {
            const auto path = "/dev/dri/renderD" + std::to_string(node);
            fd = ::open(path.c_str(), O_RDWR | O_CLOEXEC);
            if (fd < 0)
                continue;
            display = va.get_display(fd);
            int major = 0, minor = 0;
            if (display && va.initialize(display, &major, &minor) == VA_STATUS_SUCCESS) {
                initialized = true;
                break;
            }
            close(fd);
            fd = -1;
        }
        if (!initialized)
            return false;
        VAConfigAttrib attribute{VAConfigAttribRTFormat, 0};
        if (va.attributes(display, VAProfileVP9Profile0, VAEntrypointVLD, &attribute, 1) !=
                VA_STATUS_SUCCESS ||
            !(attribute.value & VA_RT_FORMAT_YUV420))
            return false;
        attribute.value = VA_RT_FORMAT_YUV420;
        if (va.create_config(display, VAProfileVP9Profile0, VAEntrypointVLD, &attribute, 1,
                             &config) != VA_STATUS_SUCCESS)
            return false;
        VASurfaceAttrib format{};
        format.type = VASurfaceAttribPixelFormat;
        format.flags = VA_SURFACE_ATTRIB_SETTABLE;
        format.value.type = VAGenericValueTypeInteger;
        format.value.value.i = VA_FOURCC_NV12;
        if (va.create_surfaces(display, VA_RT_FORMAT_YUV420, source->width(), source->height(),
                               surfaces.data(), surfaces.size(), &format, 1) != VA_STATUS_SUCCESS)
            return false;
        if (va.create_context(display, config, source->width(), source->height(), VA_PROGRESSIVE,
                              surfaces.data(), surfaces.size(), &context) != VA_STATUS_SUCCESS)
            return false;
        // Require a mappable NV12 surface up front, not merely an advertised codec profile.
        VAImage image{};
        if (va.derive(display, surfaces[0], &image) != VA_STATUS_SUCCESS)
            return false;
        const bool nv12 = image.format.fourcc == VA_FOURCC_NV12;
        va.destroy_image(display, image.image_id);
        return nv12;
    }
    const char* backend() const noexcept override { return "va-api-vp9"; }
    std::uint64_t extra_cpu_bytes() const noexcept override
    {
        return headers.capacity() * sizeof(Header);
    }
    core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    decode(std::size_t index) override
    {
        using Frame = std::shared_ptr<const NativeVideoFrame>;
        const auto failure = [] {
            return core::Result<Frame, core::Diagnostics>::failure(
                {{.code = "assets.native_video.hardware_failed",
                  .message = "VA-API VP9 sample realization failed."}});
        };
        auto header = headers[index];
        VASurfaceID surface = VA_INVALID_SURFACE;
        if (header.existing >= 0)
            surface = references[header.existing];
        else {
            for (auto candidate : surfaces)
                if (std::ranges::find(references, candidate) == references.end()) {
                    surface = candidate;
                    break;
                }
            if (surface == VA_INVALID_SURFACE)
                return failure();
            std::copy(references.begin(), references.end(), header.picture.reference_frames);
            const auto packet = source->packet(index);
            std::array<VABufferID, 3> buffers{VA_INVALID_ID, VA_INVALID_ID, VA_INVALID_ID};
            const auto destroy_buffers = [&] {
                for (auto buffer : buffers)
                    if (buffer != VA_INVALID_ID)
                        va.destroy_buffer(display, buffer);
            };
            if (va.create_buffer(display, context, VAPictureParameterBufferType,
                                 sizeof(header.picture), 1, &header.picture,
                                 &buffers[0]) != VA_STATUS_SUCCESS ||
                va.create_buffer(display, context, VASliceParameterBufferType, sizeof(header.slice),
                                 1, &header.slice, &buffers[1]) != VA_STATUS_SUCCESS ||
                va.create_buffer(display, context, VASliceDataBufferType, packet.size(), 1,
                                 const_cast<std::uint8_t*>(packet.data()),
                                 &buffers[2]) != VA_STATUS_SUCCESS) {
                destroy_buffers();
                return failure();
            }
            const bool submitted =
                va.begin(display, context, surface) == VA_STATUS_SUCCESS &&
                va.render(display, context, buffers.data(), buffers.size()) == VA_STATUS_SUCCESS &&
                va.end(display, context) == VA_STATUS_SUCCESS;
            destroy_buffers();
            if (!submitted)
                return failure();
            for (unsigned ref = 0; ref < references.size(); ++ref)
                if (header.refresh & (1u << ref))
                    references[ref] = surface;
        }
        if (surface == VA_INVALID_SURFACE || va.sync(display, surface) != VA_STATUS_SUCCESS)
            return failure();
        VAImage image{};
        if (va.derive(display, surface, &image) != VA_STATUS_SUCCESS)
            return failure();
        void* mapped = nullptr;
        if (image.format.fourcc != VA_FOURCC_NV12 || image.num_planes != 2 ||
            image.width < source->width() || image.height < source->height() ||
            va.map(display, image.buf, &mapped) != VA_STATUS_SUCCESS) {
            va.destroy_image(display, image.image_id);
            return failure();
        }
        auto frame = std::make_shared<NativeVideoFrame>();
        frame->width = source->width();
        frame->height = source->height();
        frame->time_ns = source->packets()[index].time_ns;
        frame->full_range = header.full_range;
        frame->bt709 = header.bt709;
        frame->y.resize(static_cast<std::size_t>(frame->width) * frame->height);
        const auto cw = (frame->width + 1u) / 2, ch = (frame->height + 1u) / 2;
        frame->u.resize(cw * ch);
        frame->v.resize(cw * ch);
        const auto* bytes = static_cast<const std::uint8_t*>(mapped);
        for (unsigned row = 0; row < frame->height; ++row)
            std::memcpy(frame->y.data() + row * frame->width,
                        bytes + image.offsets[0] + row * image.pitches[0], frame->width);
        for (unsigned row = 0; row < ch; ++row)
            for (unsigned column = 0; column < cw; ++column) {
                frame->u[row * cw + column] =
                    bytes[image.offsets[1] + row * image.pitches[1] + column * 2];
                frame->v[row * cw + column] =
                    bytes[image.offsets[1] + row * image.pitches[1] + column * 2 + 1];
            }
        va.unmap(display, image.buf);
        va.destroy_image(display, image.image_id);
        return core::Result<Frame, core::Diagnostics>::success(std::move(frame));
    }

private:
    std::shared_ptr<const NativeVideoSource> source;
    Va va;
    int fd = -1;
    VADisplay display = nullptr;
    bool initialized = false;
    VAConfigID config = VA_INVALID_ID;
    VAContextID context = VA_INVALID_ID;
    std::array<VASurfaceID, 12> surfaces;
    std::array<VASurfaceID, 8> references;
    std::vector<Header> headers;
};

} // namespace
std::unique_ptr<NativeVideoHardwareDecoder>
try_native_video_hardware(std::shared_ptr<const NativeVideoSource> source)
{
    auto decoder = std::make_unique<VaDecoder>(std::move(source));
    return decoder->open() ? std::move(decoder) : nullptr;
}
} // namespace noveltea::media
#elif defined(__ANDROID__)
namespace noveltea::media {
std::unique_ptr<NativeVideoHardwareDecoder>
    try_mediacodec_video(std::shared_ptr<const NativeVideoSource>);
std::unique_ptr<NativeVideoHardwareDecoder>
try_native_video_hardware(std::shared_ptr<const NativeVideoSource> source)
{
    return try_mediacodec_video(std::move(source));
}
} // namespace noveltea::media
#elif defined(_WIN32)
namespace noveltea::media {
std::unique_ptr<NativeVideoHardwareDecoder>
    try_mediafoundation_video(std::shared_ptr<const NativeVideoSource>);
std::unique_ptr<NativeVideoHardwareDecoder>
try_native_video_hardware(std::shared_ptr<const NativeVideoSource> source)
{
    return try_mediafoundation_video(std::move(source));
}
} // namespace noveltea::media
#elif defined(__APPLE__)
namespace noveltea::media {
std::unique_ptr<NativeVideoHardwareDecoder>
    try_videotoolbox_video(std::shared_ptr<const NativeVideoSource>);
std::unique_ptr<NativeVideoHardwareDecoder>
try_native_video_hardware(std::shared_ptr<const NativeVideoSource> source)
{
    return try_videotoolbox_video(std::move(source));
}
} // namespace noveltea::media
#else
namespace noveltea::media {
std::unique_ptr<NativeVideoHardwareDecoder>
try_native_video_hardware(std::shared_ptr<const NativeVideoSource>)
{
    return nullptr;
}
} // namespace noveltea::media
#endif
