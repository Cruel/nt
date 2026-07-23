#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/job_executor.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::assets::detail {

inline constexpr std::size_t asset_preparation_read_chunk_bytes = 256u * 1024u;

class IncrementalAssetRead {
public:
    IncrementalAssetRead(const AssetManager& assets, std::string path,
                         std::string diagnostic_prefix)
        : m_assets(assets), m_path(std::move(path)),
          m_diagnostic_prefix(std::move(diagnostic_prefix))
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        if (m_failed)
            return {.status = jobs::JobStepStatus::Failed, .diagnostics = m_diagnostics};
        if (m_ready)
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};

        if (m_reader == nullptr) {
            auto opened = m_assets.open(m_path);
            if (!opened) {
                return fail("open_failed",
                            "failed to open '" + m_path + "': " + opened.error.message);
            }
            m_reader = std::move(*opened.value);
            auto size = m_reader->size();
            if (!size) {
                return fail("size_failed",
                            "failed to determine size of '" + m_path + "': " + size.error.message);
            }
            if (*size.value > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
                return fail("too_large",
                            "asset exceeds addressable preparation memory: '" + m_path + "'");
            }
            m_bytes.resize(static_cast<std::size_t>(*size.value));
            m_total = *size.value;
            context.report_progress({.completed_units = 0, .total_units = m_total});
            if (m_bytes.empty()) {
                m_ready = true;
                m_reader.reset();
                return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
            }
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }

        const std::size_t remaining = m_bytes.size() - m_offset;
        const std::size_t requested = std::min(remaining, asset_preparation_read_chunk_bytes);
        auto read = m_reader->read(m_bytes.data() + m_offset, requested);
        if (!read) {
            return fail("read_failed", "failed to read '" + m_path + "': " + read.error.message);
        }
        if (*read.value == 0 && requested != 0) {
            return fail("short_read", "unexpected end of asset while preparing '" + m_path + "'");
        }
        m_offset += *read.value;
        context.report_progress(
            {.completed_units = static_cast<std::uint64_t>(m_offset), .total_units = m_total});
        if (m_offset == m_bytes.size()) {
            m_ready = true;
            m_reader.reset();
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }

    [[nodiscard]] bool ready() const noexcept { return m_ready; }
    [[nodiscard]] std::uint64_t total_bytes() const noexcept { return m_total; }
    [[nodiscard]] const AssetBytes& bytes() const noexcept { return m_bytes; }
    [[nodiscard]] AssetBytes take_bytes() noexcept { return std::move(m_bytes); }
    [[nodiscard]] const std::string& path() const noexcept { return m_path; }

private:
    [[nodiscard]] jobs::JobStepOutcome fail(std::string_view suffix, std::string message) noexcept
    {
        m_failed = true;
        m_reader.reset();
        m_diagnostics = {{.code = m_diagnostic_prefix + "." + std::string(suffix),
                          .message = std::move(message)}};
        return {.status = jobs::JobStepStatus::Failed, .diagnostics = m_diagnostics};
    }

    const AssetManager& m_assets;
    std::string m_path;
    std::string m_diagnostic_prefix;
    AssetReaderPtr m_reader;
    AssetBytes m_bytes;
    core::Diagnostics m_diagnostics;
    std::size_t m_offset = 0;
    std::uint64_t m_total = 0;
    bool m_ready = false;
    bool m_failed = false;
};

[[nodiscard]] inline std::uint64_t estimated_source_size(const AssetManager& assets,
                                                         std::string_view path) noexcept
{
    const auto metadata = assets.stat(path);
    return metadata ? metadata.value->uncompressed_size : 0;
}

} // namespace noveltea::assets::detail
