#include "media/native_video_hardware.hpp"

#if defined(__linux__) && !defined(__ANDROID__) && !defined(__EMSCRIPTEN__)

#include <SDL3/SDL_loadso.h>
#include <ffnvcodec/dynlink_cuda.h>
#include <ffnvcodec/dynlink_nvcuvid.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <utility>
#include <vector>

namespace noveltea::media {
namespace {

// Only the driver's CUDA/NVDEC entrypoints are required at runtime; the SDK is headers-only.
struct Nvidia {
    SDL_SharedObject* cuda = SDL_LoadObject("libcuda.so.1");
    SDL_SharedObject* cuvid = SDL_LoadObject("libnvcuvid.so.1");

    ~Nvidia()
    {
        if (cuvid)
            SDL_UnloadObject(cuvid);
        if (cuda)
            SDL_UnloadObject(cuda);
    }
    template<class T> T load(SDL_SharedObject* lib, const char* name)
    {
        return reinterpret_cast<T>(lib ? SDL_LoadFunction(lib, name) : nullptr);
    }
    tcuInit* init = load<tcuInit*>(cuda, "cuInit");
    tcuDeviceGetCount* device_count = load<tcuDeviceGetCount*>(cuda, "cuDeviceGetCount");
    tcuDeviceGet* device_get = load<tcuDeviceGet*>(cuda, "cuDeviceGet");
    tcuDevicePrimaryCtxRetain* context_retain =
        load<tcuDevicePrimaryCtxRetain*>(cuda, "cuDevicePrimaryCtxRetain");
    tcuDevicePrimaryCtxRelease* context_release =
        load<tcuDevicePrimaryCtxRelease*>(cuda, "cuDevicePrimaryCtxRelease");
    tcuCtxPushCurrent_v2* context_push = load<tcuCtxPushCurrent_v2*>(cuda, "cuCtxPushCurrent_v2");
    tcuCtxPopCurrent_v2* context_pop = load<tcuCtxPopCurrent_v2*>(cuda, "cuCtxPopCurrent_v2");
    tcuMemcpy2D_v2* copy_2d = load<tcuMemcpy2D_v2*>(cuda, "cuMemcpy2D_v2");
    tcuvidGetDecoderCaps* capabilities = load<tcuvidGetDecoderCaps*>(cuvid, "cuvidGetDecoderCaps");
    tcuvidCreateDecoder* decoder_create = load<tcuvidCreateDecoder*>(cuvid, "cuvidCreateDecoder");
    tcuvidDestroyDecoder* decoder_destroy =
        load<tcuvidDestroyDecoder*>(cuvid, "cuvidDestroyDecoder");
    tcuvidDecodePicture* decode_picture = load<tcuvidDecodePicture*>(cuvid, "cuvidDecodePicture");
    tcuvidMapVideoFrame* map = load<tcuvidMapVideoFrame*>(cuvid, "cuvidMapVideoFrame64");
    tcuvidUnmapVideoFrame* unmap = load<tcuvidUnmapVideoFrame*>(cuvid, "cuvidUnmapVideoFrame64");
    tcuvidCreateVideoParser* parser_create =
        load<tcuvidCreateVideoParser*>(cuvid, "cuvidCreateVideoParser");
    tcuvidDestroyVideoParser* parser_destroy =
        load<tcuvidDestroyVideoParser*>(cuvid, "cuvidDestroyVideoParser");
    tcuvidParseVideoData* parse = load<tcuvidParseVideoData*>(cuvid, "cuvidParseVideoData");

    bool ready() const
    {
        return init && device_count && device_get && context_retain && context_release &&
               context_push && context_pop && copy_2d && capabilities && decoder_create &&
               decoder_destroy && decode_picture && map && unmap && parser_create &&
               parser_destroy && parse;
    }
};

struct CurrentContext {
    Nvidia& api;
    bool active = false;
    CurrentContext(Nvidia& api, CUcontext context) : api(api)
    {
        active = context && api.context_push(context) == CUDA_SUCCESS;
    }
    ~CurrentContext()
    {
        if (active) {
            CUcontext previous = nullptr;
            (void)api.context_pop(&previous);
        }
    }
    explicit operator bool() const { return active; }
};

class NvdecDecoder final : public NativeVideoHardwareDecoder {
public:
    explicit NvdecDecoder(std::shared_ptr<const NativeVideoSource> input) : source(std::move(input))
    {
    }
    ~NvdecDecoder() override
    {
        if (context) {
            {
                CurrentContext current(api, context);
                if (current) {
                    if (parser)
                        (void)api.parser_destroy(parser);
                    if (decoder)
                        (void)api.decoder_destroy(decoder);
                }
            }
            (void)api.context_release(device);
        }
    }

    bool open()
    {
        if (!api.ready() || api.init(0) != CUDA_SUCCESS)
            return false;
        // The current representation uses NV12 and has no cropped/10-bit frame envelope.
        if ((source->width() & 1u) || (source->height() & 1u))
            return false;

        int count = 0;
        if (api.device_count(&count) != CUDA_SUCCESS || count < 1)
            return false;
        for (int ordinal = 0; ordinal < count; ++ordinal) {
            if (api.device_get(&device, ordinal) != CUDA_SUCCESS ||
                api.context_retain(&context, device) != CUDA_SUCCESS)
                continue;
            // A shared primary context avoids one costly CUDA allocation per occurrence.
            // Context push/pop is thread-local, since the decoder may migrate between workers.
            bool selected = false;
            {
                CurrentContext current(api, context);
                if (current) {
                    CUVIDDECODECAPS caps{};
                    caps.eCodecType = cudaVideoCodec_VP9;
                    caps.eChromaFormat = cudaVideoChromaFormat_420;
                    if (api.capabilities(&caps) == CUDA_SUCCESS && caps.bIsSupported &&
                        (caps.nOutputFormatMask & (1u << cudaVideoSurfaceFormat_NV12)) &&
                        source->width() >= caps.nMinWidth && source->height() >= caps.nMinHeight &&
                        source->width() <= caps.nMaxWidth && source->height() <= caps.nMaxHeight &&
                        (static_cast<std::uint64_t>(source->width()) * source->height() + 255) /
                                256 <=
                            caps.nMaxMBCount) {
                        CUVIDPARSERPARAMS params{};
                        params.CodecType = cudaVideoCodec_VP9;
                        params.ulMaxNumDecodeSurfaces = 12;
                        params.ulMaxDisplayDelay = 0;
                        params.pUserData = this;
                        params.pfnSequenceCallback = &NvdecDecoder::sequence_callback;
                        params.pfnDecodePicture = &NvdecDecoder::picture_callback;
                        params.pfnDisplayPicture = &NvdecDecoder::display_callback;
                        selected = api.parser_create(&parser, &params) == CUDA_SUCCESS;
                        if (!selected && parser) {
                            (void)api.parser_destroy(parser);
                            parser = nullptr;
                        }
                    }
                }
            }
            if (selected)
                return true;
            (void)api.context_release(device);
            context = nullptr;
        }
        return false;
    }

    const char* backend() const noexcept override { return "nvdec-vp9"; }

    core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    decode(std::size_t index) override
    {
        using Frame = std::shared_ptr<const NativeVideoFrame>;
        const auto failure = [] {
            return core::Result<Frame, core::Diagnostics>::failure(
                {{.code = "assets.native_video.hardware_failed",
                  .message = "NVIDIA NVDEC VP9 sample realization failed."}});
        };
        if (!parser || index >= source->packets().size())
            return failure();
        CurrentContext current(api, context);
        if (!current)
            return failure();
        current_index = index;
        completed.reset();
        callback_failed = false;
        const auto bytes = source->packet(index);
        if (bytes.size() > std::numeric_limits<unsigned long>::max())
            return failure();
        CUVIDSOURCEDATAPACKET packet{};
        packet.flags = CUVID_PKT_TIMESTAMP | CUVID_PKT_ENDOFPICTURE;
        packet.payload = bytes.data();
        packet.payload_size = static_cast<unsigned long>(bytes.size());
        // A unique presentation token; the actual timeline comes from NativeVideoSource.
        packet.timestamp = static_cast<CUvideotimestamp>(index);
        if (api.parse(parser, &packet) != CUDA_SUCCESS || callback_failed || !completed)
            return failure();
        return core::Result<Frame, core::Diagnostics>::success(std::move(completed));
    }

private:
    static int CUDAAPI sequence_callback(void* user, CUVIDEOFORMAT* format)
    {
        return static_cast<NvdecDecoder*>(user)->sequence(*format);
    }
    static int CUDAAPI picture_callback(void* user, CUVIDPICPARAMS* picture)
    {
        auto& self = *static_cast<NvdecDecoder*>(user);
        if (!self.decoder || self.api.decode_picture(self.decoder, picture) != CUDA_SUCCESS) {
            self.callback_failed = true;
            return 0;
        }
        return 1;
    }
    static int CUDAAPI display_callback(void* user, CUVIDPARSERDISPINFO* display)
    {
        return static_cast<NvdecDecoder*>(user)->display(*display);
    }

    int sequence(const CUVIDEOFORMAT& format)
    {
        if (decoder || format.codec != cudaVideoCodec_VP9 ||
            format.chroma_format != cudaVideoChromaFormat_420 || format.bit_depth_luma_minus8 ||
            format.bit_depth_chroma_minus8 || !format.progressive_sequence ||
            format.coded_width != source->width() || format.coded_height != source->height() ||
            format.min_num_decode_surfaces > 24) {
            callback_failed = true;
            return 0;
        }
        CUVIDDECODECREATEINFO settings{};
        settings.ulWidth = settings.ulTargetWidth = source->width();
        settings.ulHeight = settings.ulTargetHeight = source->height();
        settings.ulMaxWidth = source->width();
        settings.ulMaxHeight = source->height();
        settings.ulNumDecodeSurfaces =
            std::max(12u, static_cast<unsigned>(format.min_num_decode_surfaces));
        settings.ulNumOutputSurfaces = 1;
        settings.CodecType = cudaVideoCodec_VP9;
        settings.ChromaFormat = cudaVideoChromaFormat_420;
        settings.OutputFormat = cudaVideoSurfaceFormat_NV12;
        settings.DeinterlaceMode = cudaVideoDeinterlaceMode_Weave;
        settings.ulCreationFlags = cudaVideoCreate_PreferCUVID;
        full_range = format.video_signal_description.video_full_range_flag;
        bt709 = format.video_signal_description.matrix_coefficients == 1;
        if (api.decoder_create(&decoder, &settings) != CUDA_SUCCESS) {
            callback_failed = true;
            return 0;
        }
        return static_cast<int>(settings.ulNumDecodeSurfaces);
    }

    int display(const CUVIDPARSERDISPINFO& info)
    {
        if (!decoder || info.timestamp != static_cast<CUvideotimestamp>(current_index) ||
            completed || !info.progressive_frame) {
            callback_failed = true;
            return 0;
        }
        CUVIDPROCPARAMS params{};
        params.progressive_frame = 1;
        CUdeviceptr pixels = 0;
        unsigned int pitch = 0;
        if (api.map(decoder, info.picture_index, &pixels, &pitch, &params) != CUDA_SUCCESS) {
            callback_failed = true;
            return 0;
        }
        auto frame = std::make_shared<NativeVideoFrame>();
        frame->width = source->width();
        frame->height = source->height();
        frame->time_ns = source->packets()[current_index].time_ns;
        frame->full_range = full_range;
        frame->bt709 = bt709;
        const auto w = static_cast<std::size_t>(frame->width);
        const auto h = static_cast<std::size_t>(frame->height);
        frame->y.resize(w * h);
        std::vector<std::uint8_t> uv(w * (h / 2));
        CUDA_MEMCPY2D transfer{};
        transfer.srcMemoryType = CU_MEMORYTYPE_DEVICE;
        transfer.dstMemoryType = CU_MEMORYTYPE_HOST;
        transfer.srcDevice = pixels;
        transfer.srcPitch = pitch;
        transfer.dstHost = frame->y.data();
        transfer.dstPitch = w;
        transfer.WidthInBytes = w;
        transfer.Height = h;
        const bool y_ok = api.copy_2d(&transfer) == CUDA_SUCCESS;
        transfer.srcDevice = pixels + static_cast<CUdeviceptr>(pitch) * h;
        transfer.dstHost = uv.data();
        transfer.Height = h / 2;
        const bool uv_ok = y_ok && api.copy_2d(&transfer) == CUDA_SUCCESS;
        const bool unmapped = api.unmap(decoder, pixels) == CUDA_SUCCESS;
        if (!uv_ok || !unmapped) {
            callback_failed = true;
            return 0;
        }
        frame->u.resize((w / 2) * (h / 2));
        frame->v.resize(frame->u.size());
        for (std::size_t i = 0; i < frame->u.size(); ++i) {
            frame->u[i] = uv[2 * i];
            frame->v[i] = uv[2 * i + 1];
        }
        completed = std::move(frame);
        return 1;
    }

    std::shared_ptr<const NativeVideoSource> source;
    Nvidia api;
    CUcontext context = nullptr;
    CUdevice device = 0;
    CUvideoparser parser = nullptr;
    CUvideodecoder decoder = nullptr;
    std::size_t current_index = 0;
    std::shared_ptr<const NativeVideoFrame> completed;
    bool callback_failed = false;
    bool full_range = false;
    bool bt709 = false;
};

} // namespace

bool nvdec_driver_available()
{
    // Devtools queries can run repeatedly; avoid reopening driver libraries each time.
    static const bool present = Nvidia{}.ready();
    return present;
}

std::unique_ptr<NativeVideoHardwareDecoder>
try_nvdec_video(std::shared_ptr<const NativeVideoSource> source)
{
    auto decoder = std::make_unique<NvdecDecoder>(std::move(source));
    return decoder->open() ? std::move(decoder) : nullptr;
}

} // namespace noveltea::media
#endif
