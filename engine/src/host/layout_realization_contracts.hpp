#pragma once

#include "host/host_lifecycle_contracts.hpp"

#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/runtime_layout_manager.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>

namespace noveltea::host {

using ProjectLayoutRealizationSource = RuntimeLayoutProjectSource;
using BuiltinLayoutRealizationSource = RuntimeLayoutBuiltinSource;
using AssetLayoutRealizationSource = RuntimeLayoutAssetSource;
using FragmentLayoutRealizationSource = RuntimeLayoutFragmentSource;
using MemoryLayoutRealizationSource = RuntimeLayoutMemorySource;
using LayoutRealizationSource = RuntimeLayoutSource;

struct RealizeLayoutRequest {
    HostGeneration host_generation;
    core::PresentationSnapshotRevision publication_revision;
    core::MountedLayoutInstance mounted;
    core::PresentationCompositionGroup composition_group =
        core::PresentationCompositionGroup::Interface;
    LayoutRealizationSource source;
};

struct RemoveLayoutRealizationRequest {
    HostGeneration host_generation;
    core::MountedLayoutInstanceId instance;
};

struct RecreateLayoutRealizationsRequest {
    HostGeneration host_generation;
    BackendGeneration backend_generation;
};

using LayoutRealizationRequest = std::variant<RealizeLayoutRequest, RemoveLayoutRealizationRequest,
                                              RecreateLayoutRealizationsRequest>;

enum class LayoutRealizationDisposition : std::uint8_t {
    Created,
    Replaced,
    Updated,
    Removed,
    Recreated,
    Unchanged,
    RejectedStale,
    Failed,
};

struct LayoutRealizationResult {
    LayoutRealizationDisposition disposition = LayoutRealizationDisposition::Failed;
    std::optional<core::MountedLayoutInstanceId> instance;
    std::string document_id;
    std::size_t affected_count = 0;
    core::Diagnostics diagnostics;

    [[nodiscard]] bool succeeded() const noexcept
    {
        return disposition != LayoutRealizationDisposition::RejectedStale &&
               disposition != LayoutRealizationDisposition::Failed;
    }
};

class LayoutRealizationSink {
public:
    virtual ~LayoutRealizationSink() = default;

    [[nodiscard]] virtual LayoutRealizationResult
    apply_layout_realization(LayoutRealizationRequest request) = 0;
};

} // namespace noveltea::host
