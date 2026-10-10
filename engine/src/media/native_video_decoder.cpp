#include "media/native_video_decoder.hpp"
#include "media/native_video_hardware.hpp"

#ifndef __EMSCRIPTEN__
#include <mkvparser/mkvparser.h>
#include <vpx/vp8dx.h>
#include <vpx/vpx_decoder.h>
#include <vpx/vpx_frame_buffer.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>

namespace noveltea::media {
namespace {

template<class T> core::Result<T, core::Diagnostics> fail(std::string code, std::string message)
{
    return core::Result<T, core::Diagnostics>::failure(
        {{.code = "assets.native_video." + code, .message = std::move(message)}});
}

class MemoryReader final : public mkvparser::IMkvReader {
public:
    explicit MemoryReader(std::span<const std::uint8_t> bytes) : m_bytes(bytes) {}
    int Read(long long position, long length, unsigned char* output) override
    {
        if (++m_reads > 250000 || position < 0 || length < 0 || !output ||
            static_cast<std::uint64_t>(position) > m_bytes.size() ||
            static_cast<std::uint64_t>(length) >
                m_bytes.size() - static_cast<std::size_t>(position))
            return -1;
        std::memcpy(output, m_bytes.data() + position, static_cast<std::size_t>(length));
        return 0;
    }
    int Length(long long* total, long long* available) override
    {
        if (total)
            *total = static_cast<long long>(m_bytes.size());
        if (available)
            *available = static_cast<long long>(m_bytes.size());
        return 0;
    }

private:
    std::span<const std::uint8_t> m_bytes;
    std::size_t m_reads = 0;
};

} // namespace

core::Result<std::shared_ptr<const NativeVideoSource>, core::Diagnostics>
NativeVideoSource::open(std::vector<std::uint8_t> bytes, std::uint16_t width, std::uint16_t height)
{
    using Source = std::shared_ptr<const NativeVideoSource>;
    if (bytes.empty() || bytes.size() > 128u * 1024u * 1024u || width == 0 || height == 0 ||
        width > 8192 || height > 8192)
        return fail<Source>("invalid_source",
                            "Prepared VP9 WebM exceeds the bounded media envelope.");
    auto source = std::make_shared<NativeVideoSource>();
    source->m_bytes = std::move(bytes);
    source->m_width = width;
    source->m_height = height;
    MemoryReader reader(source->m_bytes);
    mkvparser::EBMLHeader header;
    long long position = 0;
    if (header.Parse(&reader, position) != 0 || !header.m_docType ||
        std::strcmp(header.m_docType, "webm") != 0)
        return fail<Source>("invalid_container", "Prepared media is not a valid WebM container.");
    mkvparser::Segment* raw = nullptr;
    if (mkvparser::Segment::CreateInstance(&reader, position, raw) != 0 || !raw)
        return fail<Source>("invalid_container", "Cannot open prepared WebM segment.");
    std::unique_ptr<mkvparser::Segment> segment(raw);
    if (segment->Load() != 0 || !segment->GetTracks())
        return fail<Source>("invalid_container",
                            "Prepared WebM segment is truncated or malformed.");
    const auto* tracks = segment->GetTracks();
    if (tracks->GetTracksCount() != 1)
        return fail<Source>(
            "unsupported_stream",
            "Prepared Animation must contain exactly one video track and no audio.");
    const auto* track = tracks->GetTrackByIndex(0);
    if (!track || track->GetType() != 1 || !track->GetCodecId() ||
        std::strcmp(track->GetCodecId(), "V_VP9") != 0)
        return fail<Source>("unsupported_codec",
                            "Native prepared representation must contain VP9 video.");
    const auto* video = static_cast<const mkvparser::VideoTrack*>(track);
    if (video->GetWidth() != width || video->GetHeight() != height)
        return fail<Source>("dimensions_mismatch",
                            "Prepared WebM dimensions do not match its manifest.");
    const mkvparser::BlockEntry* entry = nullptr;
    if (track->GetFirst(entry) < 0)
        return fail<Source>("invalid_packet", "Cannot read the first WebM packet.");
    while (entry && !entry->EOS()) {
        const auto* block = entry->GetBlock();
        if (!block || block->GetFrameCount() != 1 || block->IsInvisible())
            return fail<Source>("unsupported_packet",
                                "Prepared VP9 requires visible, unlaced packets.");
        const auto time = block->GetTime(entry->GetCluster());
        const auto& frame = block->GetFrame(0);
        if (time < 0 || frame.pos < 0 || frame.len <= 0 || frame.len > 32 * 1024 * 1024 ||
            static_cast<std::uint64_t>(frame.pos) > source->m_bytes.size() ||
            static_cast<std::uint64_t>(frame.len) >
                source->m_bytes.size() - static_cast<std::size_t>(frame.pos) ||
            (!source->m_packets.empty() &&
             static_cast<std::uint64_t>(time) <= source->m_packets.back().time_ns) ||
            source->m_packets.size() >= 65536)
            return fail<Source>("invalid_packet",
                                "Invalid VP9 packet bounds or presentation timestamps.");
        source->m_packets.push_back({static_cast<std::size_t>(frame.pos),
                                     static_cast<std::size_t>(frame.len),
                                     static_cast<std::uint64_t>(time), block->IsKey()});
        const mkvparser::BlockEntry* next = nullptr;
        if (track->GetNext(entry, next) < 0)
            return fail<Source>("invalid_packet", "Cannot advance prepared WebM packets.");
        entry = next;
    }
    if (source->m_packets.empty() || !source->m_packets.front().keyframe ||
        source->m_packets.front().time_ns != 0)
        return fail<Source>("invalid_timeline",
                            "Prepared VP9 must begin with a keyframe at time zero.");
    return core::Result<Source, core::Diagnostics>::success(std::move(source));
}

std::span<const std::uint8_t> NativeVideoSource::packet(std::size_t index) const noexcept
{
    const auto& packet = m_packets[index];
    return std::span(m_bytes).subspan(packet.offset, packet.size);
}

std::uint64_t NativeVideoSource::resident_bytes() const noexcept
{
    return m_bytes.capacity() + m_packets.capacity() * sizeof(VideoPacket);
}

struct NativeVideoDecoder::Impl {
    explicit Impl(std::shared_ptr<const NativeVideoSource> source) : source(std::move(source)) {}
    ~Impl()
    {
        if (initialized)
            vpx_codec_destroy(&codec);
    }
    struct Buffer {
        std::vector<std::uint8_t> bytes;
        bool used = false;
    };
    static int get_buffer(void* user, std::size_t size, vpx_codec_frame_buffer_t* output)
    {
        auto& self = *static_cast<Impl*>(user);
        if (size > self.buffer_limit)
            return -1;
        for (auto& buffer : self.buffers) {
            if (buffer.used)
                continue;
            buffer.bytes.resize(size);
            buffer.used = true;
            output->data = buffer.bytes.data();
            output->size = buffer.bytes.size();
            output->priv = &buffer;
            return 0;
        }
        return -1;
    }
    static int release_buffer(void*, vpx_codec_frame_buffer_t* buffer)
    {
        if (buffer->priv)
            static_cast<Buffer*>(buffer->priv)->used = false;
        return 0;
    }
    bool reset()
    {
        if (!selected) {
            hardware = try_native_video_hardware(source);
            selected = true;
            hardware_selected = hardware != nullptr;
            selected_backend = hardware ? hardware->backend() : "libvpx-vp9";
        } else if (hardware_selected) {
            hardware.reset();
            hardware = try_native_video_hardware(source);
        }
        if (hardware_selected) {
            opened = hardware != nullptr;
            return opened;
        }
        if (initialized)
            vpx_codec_destroy(&codec);
        initialized = false;
        for (auto& buffer : buffers)
            buffer.used = false;
        vpx_codec_dec_cfg_t config{.threads = 1, .w = source->width(), .h = source->height()};
        if (vpx_codec_dec_init(&codec, vpx_codec_vp9_dx(), &config, 0) != VPX_CODEC_OK)
            return false;
        initialized = true;
        opened = true;
        buffer_limit = (static_cast<std::uint64_t>(source->width()) + 256) *
                       (static_cast<std::uint64_t>(source->height()) + 256) * 3;
        return vpx_codec_set_frame_buffer_functions(&codec, get_buffer, release_buffer, this) ==
               VPX_CODEC_OK;
    }
    std::shared_ptr<const NativeVideoSource> source;
    vpx_codec_ctx_t codec{};
    std::array<Buffer, 12> buffers;
    std::uint64_t buffer_limit = 0;
    bool initialized = false;
    bool opened = false;
    bool selected = false;
    bool hardware_selected = false;
    const char* selected_backend = "pending";
    std::unique_ptr<NativeVideoHardwareDecoder> hardware;
    bool failed = false;
    std::size_t next = 0;
    std::size_t current_index = std::numeric_limits<std::size_t>::max();
    std::shared_ptr<const NativeVideoFrame> current;
};

NativeVideoDecoder::NativeVideoDecoder(std::shared_ptr<const NativeVideoSource> source)
    : m_impl(std::make_unique<Impl>(std::move(source)))
{
}
NativeVideoDecoder::~NativeVideoDecoder() = default;

const char* NativeVideoDecoder::backend() const noexcept { return m_impl->selected_backend; }

std::uint64_t NativeVideoDecoder::resident_budget() const noexcept
{
    return memory_budget(m_impl->source->width(), m_impl->source->height()) - 32u * 1024u * 1024u +
           (m_impl->hardware ? m_impl->hardware->extra_cpu_bytes() : 0);
}

std::uint64_t NativeVideoDecoder::memory_budget(std::uint16_t width, std::uint16_t height)
{
    // Reference buffers, scratch, copied I420, and at most 65536 hardware packet headers.
    return (static_cast<std::uint64_t>(width) + 256) * (static_cast<std::uint64_t>(height) + 256) *
               64 +
           34u * 1024u * 1024u;
}

core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
NativeVideoDecoder::step(double time_ms)
{
    using Frame = std::shared_ptr<const NativeVideoFrame>;
    auto& self = *m_impl;
    const auto fail_decoder = [&](std::string code, std::string message) {
        self.failed = true;
        return fail<Frame>(std::move(code), std::move(message));
    };
    if (self.failed || !std::isfinite(time_ms) || time_ms < 0 || time_ms > 1e12)
        return fail_decoder("invalid_seek",
                            "Decoder is failed or the requested video time is invalid.");
    const auto time_ns = static_cast<std::uint64_t>(time_ms * 1000000.0);
    const auto& packets = self.source->packets();
    const auto after = std::upper_bound(
        packets.begin(), packets.end(), time_ns,
        [](std::uint64_t time, const VideoPacket& packet) { return time < packet.time_ns; });
    const auto target =
        after == packets.begin() ? 0u : static_cast<std::size_t>(after - packets.begin() - 1);
    if (target == self.current_index)
        return core::Result<Frame, core::Diagnostics>::success(self.current);
    if (!self.opened || target < self.next) {
        if (!self.reset())
            return fail_decoder("decoder_unavailable",
                                "Could not initialize the selected bounded VP9 decoder.");
        self.next = target;
        while (self.next > 0 && !packets[self.next].keyframe)
            --self.next;
    }
    // Skip complete stale GOPs without decoding them when semantic time advances far ahead.
    for (std::size_t index = target; index > self.next; --index) {
        if (packets[index].keyframe) {
            self.next = index;
            break;
        }
    }
    const auto index = self.next;
    const auto encoded = self.source->packet(index);
    vpx_codec_stream_info_t info{};
    info.sz = sizeof(info);
    if ((encoded[0] & 0x30) != 0 ||
        vpx_codec_peek_stream_info(vpx_codec_vp9_dx(), encoded.data(),
                                   static_cast<unsigned>(encoded.size()), &info) != VPX_CODEC_OK)
        return fail_decoder("decode_failed",
                            "Prepared VP9 packet is malformed or is not profile 0.");
    if ((info.w && info.w != self.source->width()) || (info.h && info.h != self.source->height()))
        return fail_decoder("dimensions_mismatch",
                            "VP9 packet dimensions exceed the admitted media envelope.");
    if (self.hardware) {
        auto frame = self.hardware->decode(index);
        if (!frame) {
            if (!self.current) {
                self.hardware.reset();
                self.hardware_selected = false;
                self.opened = false;
                self.next = 0;
                self.selected_backend = "libvpx-vp9";
                return core::Result<Frame, core::Diagnostics>::success(nullptr);
            }
            self.failed = true;
            return frame;
        }
        ++self.next;
        if (index != target)
            return core::Result<Frame, core::Diagnostics>::success(nullptr);
        self.current_index = index;
        self.current = std::move(frame).value();
        return core::Result<Frame, core::Diagnostics>::success(self.current);
    }
    if (vpx_codec_decode(&self.codec, encoded.data(), static_cast<unsigned>(encoded.size()),
                         nullptr, 0) != VPX_CODEC_OK)
        return fail_decoder("decode_failed", "libvpx rejected a prepared VP9 packet.");
    ++self.next;
    vpx_codec_iter_t iterator = nullptr;
    auto* image = vpx_codec_get_frame(&self.codec, &iterator);
    if (!image || image->fmt != VPX_IMG_FMT_I420 || image->d_w != self.source->width() ||
        image->d_h != self.source->height() || image->bit_depth != 8 ||
        vpx_codec_get_frame(&self.codec, &iterator))
        return fail_decoder("unsupported_output",
                            "Prepared VP9 did not yield one admitted 8-bit I420 sample.");
    if (index != target)
        return core::Result<Frame, core::Diagnostics>::success(nullptr);
    auto frame = std::make_shared<NativeVideoFrame>();
    frame->time_ns = packets[index].time_ns;
    frame->width = self.source->width();
    frame->height = self.source->height();
    frame->full_range = image->range == VPX_CR_FULL_RANGE;
    frame->bt709 = image->cs == VPX_CS_BT_709;
    const auto copy_plane = [&](std::vector<std::uint8_t>& output, int plane, unsigned width,
                                unsigned height) {
        output.resize(static_cast<std::size_t>(width) * height);
        for (unsigned row = 0; row < height; ++row)
            std::memcpy(output.data() + row * width,
                        image->planes[plane] + row * image->stride[plane], width);
    };
    copy_plane(frame->y, 0, frame->width, frame->height);
    copy_plane(frame->u, 1, (frame->width + 1) / 2, (frame->height + 1) / 2);
    copy_plane(frame->v, 2, (frame->width + 1) / 2, (frame->height + 1) / 2);
    self.current_index = index;
    self.current = std::move(frame);
    return core::Result<Frame, core::Diagnostics>::success(self.current);
}

} // namespace noveltea::media
#endif
