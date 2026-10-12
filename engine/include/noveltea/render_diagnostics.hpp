#pragma once

#include <initializer_list>
#include <string>
#include <string_view>

namespace noveltea {

struct RendererDeviceDiagnostics {
    std::string vendor;
    std::string device;
    std::string acceleration = "unknown";
};

struct VideoHardwareDiagnostics {
    std::string backend;
    std::string status = "not-probed";
    std::string reason;
};

struct VideoOccurrenceDiagnostics {
    std::string identity;
    std::string backend;
    std::string mode;
    std::string fallback_reason;
};

[[nodiscard]] inline std::string renderer_acceleration(std::string_view vendor,
                                                       std::string_view device)
{
    for (const auto software : {"llvmpipe", "softpipe", "Software Rasterizer", "SwiftShader",
                                "Microsoft Basic Render", "GDI Generic"})
        if (device.find(software) != std::string_view::npos)
            return "software";
    for (const auto hardware : {"NVIDIA", "AMD", "ATI", "Intel", "Apple", "Adreno", "Mali"})
        if (vendor.find(hardware) != std::string_view::npos ||
            device.find(hardware) != std::string_view::npos)
            return "hardware";
    return "unknown";
}

[[nodiscard]] inline std::string video_decode_mode(std::string_view backend)
{
    if (backend == "va-api-vp9" || backend == "videotoolbox-vp9" ||
        backend == "mediafoundation-vp9" || backend == "mediacodec-vp9")
        return "hardware";
    if (backend == "libvpx-vp9")
        return "software";
    if (backend == "pending")
        return "pending";
    if (backend == "browser-media")
        return "browser-managed";
    return "unknown";
}

} // namespace noveltea
