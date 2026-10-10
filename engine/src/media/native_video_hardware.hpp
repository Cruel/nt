#pragma once

#include "media/native_video_decoder.hpp"

namespace noveltea::media {

class NativeVideoHardwareDecoder {
public:
    virtual ~NativeVideoHardwareDecoder() = default;
    [[nodiscard]] virtual core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    decode(std::size_t packet_index) = 0;
    [[nodiscard]] virtual const char* backend() const noexcept = 0;
    [[nodiscard]] virtual std::uint64_t extra_cpu_bytes() const noexcept { return 0; }
};

// A null result means no compatible hardware path; terminal errors after selection are typed
// failures.
[[nodiscard]] std::unique_ptr<NativeVideoHardwareDecoder>
try_native_video_hardware(std::shared_ptr<const NativeVideoSource> source);

} // namespace noveltea::media
