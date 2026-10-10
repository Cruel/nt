#include "media/native_video_hardware.hpp"

#ifdef __APPLE__
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>
#include <array>
#include <atomic>
#include <cstring>

namespace noveltea::media {
namespace {
class VideoToolboxDecoder final : public NativeVideoHardwareDecoder {
public:
    explicit VideoToolboxDecoder(std::shared_ptr<const NativeVideoSource> source)
        : m_source(std::move(source))
    {
    }
    ~VideoToolboxDecoder() override
    {
        if (m_session) {
            VTDecompressionSessionWaitForAsynchronousFrames(m_session);
            VTDecompressionSessionInvalidate(m_session);
            CFRelease(m_session);
        }
        if (m_format)
            CFRelease(m_format);
    }
    bool open()
    {
        constexpr CMVideoCodecType vp9 = 0x76703039;
        const auto first = m_source->packet(0);
        if (first.size() < 10 || (first[0] & 0xfc) != 0x80 || first[1] != 0x49 ||
            first[2] != 0x83 || first[3] != 0x42 || !VTIsHardwareDecodeSupported(vp9))
            return false;
        m_full_range = (first[4] & 0x10) != 0;
        m_bt709 = (first[4] >> 5) == 2;
        const std::array<std::uint8_t, 12> config{
            1,
            0,
            0,
            0,
            0,
            static_cast<std::uint8_t>(m_source->width() <= 4096 ? 41 : 62),
            static_cast<std::uint8_t>(0x82 | (m_full_range ? 1 : 0)),
            static_cast<std::uint8_t>(m_bt709 ? 1 : 6),
            static_cast<std::uint8_t>(m_bt709 ? 1 : 6),
            static_cast<std::uint8_t>(m_bt709 ? 1 : 6),
            0,
            0};
        auto data = CFDataCreate(kCFAllocatorDefault, config.data(), config.size());
        if (!data)
            return false;
        const void* atom_key = CFSTR("vpcC");
        const void* atom_value = data;
        auto atoms =
            CFDictionaryCreate(kCFAllocatorDefault, &atom_key, &atom_value, 1,
                               &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        const void* extension_key = kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms;
        const void* extension_value = atoms;
        auto extensions =
            atoms ? CFDictionaryCreate(kCFAllocatorDefault, &extension_key, &extension_value, 1,
                                       &kCFTypeDictionaryKeyCallBacks,
                                       &kCFTypeDictionaryValueCallBacks)
                  : nullptr;
        const auto format_status =
            extensions ? CMVideoFormatDescriptionCreate(kCFAllocatorDefault, vp9, m_source->width(),
                                                        m_source->height(), extensions, &m_format)
                       : -1;
        if (extensions)
            CFRelease(extensions);
        if (atoms)
            CFRelease(atoms);
        CFRelease(data);
        if (format_status != noErr)
            return false;
        const void* hardware_key =
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder;
        const void* hardware_value = kCFBooleanTrue;
        auto specification =
            CFDictionaryCreate(kCFAllocatorDefault, &hardware_key, &hardware_value, 1,
                               &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        const auto pixel_format = static_cast<std::int32_t>(
            m_full_range ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                         : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
        auto number = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pixel_format);
        const void* pixel_key = kCVPixelBufferPixelFormatTypeKey;
        const void* pixel_value = number;
        auto attributes = number ? CFDictionaryCreate(kCFAllocatorDefault, &pixel_key, &pixel_value,
                                                      1, &kCFTypeDictionaryKeyCallBacks,
                                                      &kCFTypeDictionaryValueCallBacks)
                                 : nullptr;
        VTDecompressionOutputCallbackRecord callback{output, this};
        const auto status =
            specification && attributes
                ? VTDecompressionSessionCreate(kCFAllocatorDefault, m_format, specification,
                                               attributes, &callback, &m_session)
                : -1;
        if (specification)
            CFRelease(specification);
        if (attributes)
            CFRelease(attributes);
        if (number)
            CFRelease(number);
        if (status != noErr || !m_session)
            return false;
        CFTypeRef using_hardware = nullptr;
        const auto property = VTSessionCopyProperty(
            m_session, kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
            kCFAllocatorDefault, &using_hardware);
        const bool hardware =
            property == noErr && using_hardware && CFEqual(using_hardware, kCFBooleanTrue);
        if (using_hardware)
            CFRelease(using_hardware);
        return hardware;
    }
    const char* backend() const noexcept override { return "videotoolbox-vp9"; }
    core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    decode(std::size_t index) override
    {
        using Frame = std::shared_ptr<const NativeVideoFrame>;
        const auto fail = [] {
            return core::Result<Frame, core::Diagnostics>::failure(
                {{.code = "assets.native_video.hardware_failed",
                  .message = "VideoToolbox VP9 sample realization failed."}});
        };
        const auto packet = m_source->packet(index);
        CMBlockBufferRef block = nullptr;
        if (CMBlockBufferCreateWithMemoryBlock(
                kCFAllocatorDefault, const_cast<std::uint8_t*>(packet.data()), packet.size(),
                kCFAllocatorNull, nullptr, 0, packet.size(), 0, &block) != noErr)
            return fail();
        m_time = m_source->packets()[index].time_ns;
        const CMSampleTimingInfo timing{kCMTimeInvalid, CMTimeMake(m_time, 1000000000),
                                        kCMTimeInvalid};
        const auto size = packet.size();
        CMSampleBufferRef sample = nullptr;
        const auto created = CMSampleBufferCreateReady(kCFAllocatorDefault, block, m_format, 1, 1,
                                                       &timing, 1, &size, &sample);
        CFRelease(block);
        if (created != noErr)
            return fail();
        m_output.reset();
        m_status.store(0, std::memory_order_relaxed);
        const auto decoded =
            VTDecompressionSessionDecodeFrame(m_session, sample, 0, nullptr, nullptr);
        CFRelease(sample);
        if (decoded != noErr ||
            VTDecompressionSessionWaitForAsynchronousFrames(m_session) != noErr ||
            m_status.load(std::memory_order_acquire) != 1)
            return fail();
        return core::Result<Frame, core::Diagnostics>::success(m_output);
    }

private:
    static void output(void* ref, void*, OSStatus status, VTDecodeInfoFlags, CVImageBufferRef image,
                       CMTime, CMTime)
    {
        auto& self = *static_cast<VideoToolboxDecoder*>(ref);
        if (status != noErr || !image ||
            (CVPixelBufferGetPixelFormatType(image) !=
                 kCVPixelFormatType_420YpCbCr8BiPlanarFullRange &&
             CVPixelBufferGetPixelFormatType(image) !=
                 kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) ||
            CVPixelBufferGetPlaneCount(image) != 2 ||
            CVPixelBufferGetWidth(image) != self.m_source->width() ||
            CVPixelBufferGetHeight(image) != self.m_source->height() ||
            CVPixelBufferLockBaseAddress(image, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
            self.m_status.store(-1, std::memory_order_release);
            return;
        }
        auto frame = std::make_shared<NativeVideoFrame>();
        frame->width = self.m_source->width();
        frame->height = self.m_source->height();
        frame->time_ns = self.m_time;
        frame->full_range = self.m_full_range;
        frame->bt709 = self.m_bt709;
        frame->y.resize(static_cast<std::size_t>(frame->width) * frame->height);
        const auto cw = (frame->width + 1u) / 2, ch = (frame->height + 1u) / 2;
        frame->u.resize(cw * ch);
        frame->v.resize(cw * ch);
        const auto* y =
            static_cast<const std::uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(image, 0));
        const auto* uv =
            static_cast<const std::uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(image, 1));
        const auto y_stride = CVPixelBufferGetBytesPerRowOfPlane(image, 0);
        const auto uv_stride = CVPixelBufferGetBytesPerRowOfPlane(image, 1);
        if (!y || !uv || y_stride < frame->width || uv_stride < cw * 2) {
            CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
            self.m_status.store(-1, std::memory_order_release);
            return;
        }
        for (unsigned row = 0; row < frame->height; ++row)
            std::memcpy(frame->y.data() + row * frame->width, y + row * y_stride, frame->width);
        for (unsigned row = 0; row < ch; ++row)
            for (unsigned column = 0; column < cw; ++column) {
                frame->u[row * cw + column] = uv[row * uv_stride + column * 2];
                frame->v[row * cw + column] = uv[row * uv_stride + column * 2 + 1];
            }
        CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
        self.m_output = std::move(frame);
        self.m_status.store(1, std::memory_order_release);
    }
    std::shared_ptr<const NativeVideoSource> m_source;
    CMVideoFormatDescriptionRef m_format = nullptr;
    VTDecompressionSessionRef m_session = nullptr;
    std::atomic<int> m_status{0};
    std::shared_ptr<const NativeVideoFrame> m_output;
    std::uint64_t m_time = 0;
    bool m_full_range = false;
    bool m_bt709 = false;
};
} // namespace
std::unique_ptr<NativeVideoHardwareDecoder>
try_videotoolbox_video(std::shared_ptr<const NativeVideoSource> source)
{
    auto decoder = std::make_unique<VideoToolboxDecoder>(std::move(source));
    return decoder->open() ? std::move(decoder) : nullptr;
}
} // namespace noveltea::media
#endif
