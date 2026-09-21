#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::tooling::daemon {

inline constexpr std::uint32_t protocol_version = 1;
inline constexpr std::size_t max_frame_bytes = 1024 * 1024;
inline constexpr std::uint64_t default_project_session_idle_ms = 5 * 60 * 1000;
inline constexpr std::uint64_t default_daemon_idle_ms = 10 * 60 * 1000;

class FrameDecoder {
public:
    [[nodiscard]] bool feed(std::span<const std::uint8_t> bytes);
    [[nodiscard]] const std::vector<std::string>& frames() const noexcept;
    [[nodiscard]] std::string_view error() const noexcept;
    void clear_frames();

private:
    std::vector<std::uint8_t> buffer_;
    std::vector<std::string> frames_;
    std::string error_;
};

[[nodiscard]] std::vector<std::uint8_t> encode_frame(std::string_view payload);
[[nodiscard]] std::string endpoint_identity(std::string_view build_identity,
                                            std::uint32_t daemon_protocol_version);

/**
 * Resolve a scheduler Project nomination to its canonical physical root.
 * Implicit cwd nominations search upward for the nearest project.json; explicit --project
 * nominations remain exact so scheduler admission preserves the public discovery contract.
 */
[[nodiscard]] std::string canonical_project_owner_root(std::string_view project_root,
                                                       bool search_upwards);

[[nodiscard]] std::string result_event_json(std::string_view request_id, bool ok,
                                            std::string_view result_json,
                                            std::string_view error = {});
[[nodiscard]] std::string text_event_json(std::string_view type, std::string_view request_id,
                                          std::string_view text);
[[nodiscard]] std::string progress_event_json(std::string_view request_id, std::string_view message,
                                              std::uint64_t completed, std::uint64_t total);
[[nodiscard]] std::string cancellation_event_json(std::string_view request_id);

} // namespace noveltea::tooling::daemon
