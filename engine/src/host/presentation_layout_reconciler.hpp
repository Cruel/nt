#pragma once

#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"
#include "noveltea/presentation/runtime_layout_manager.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea {

class WorldPresentationBackend;
class WorldTransitionBackend;

namespace core {
class CompiledProject;
}

namespace host {

class LayoutRealizer;

class PresentationLayoutReconciler final {
public:
    PresentationLayoutReconciler(presentation::RuntimeLayoutManager& layouts,
                                 LayoutRealizer& realizer) noexcept;
    ~PresentationLayoutReconciler() = default;

    PresentationLayoutReconciler(const PresentationLayoutReconciler&) = delete;
    PresentationLayoutReconciler& operator=(const PresentationLayoutReconciler&) = delete;
    PresentationLayoutReconciler(PresentationLayoutReconciler&&) = delete;
    PresentationLayoutReconciler& operator=(PresentationLayoutReconciler&&) = delete;

    void bind_project(const core::CompiledProject& project) noexcept;
    void clear_session() noexcept;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile(const core::RuntimePresentationSnapshot& snapshot);
    void apply_transition_state(const WorldTransitionBackend& transitions,
                                WorldPresentationBackend& world);

    [[nodiscard]] std::optional<core::PresentationSnapshotRevision>
    current_revision() const noexcept
    {
        return m_current_revision;
    }

private:
    struct MountedPresentationLayout {
        std::optional<core::MountedLayoutPresentationKey> key;
        core::MountedLayoutInstanceId instance;
        core::LayoutId layout;
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
        core::MountedLayoutPolicy policy;
        core::LayoutScaleOverrides scale_overrides{};
        core::PresentationCompositionGroup composition_group =
            core::PresentationCompositionGroup::Interface;
        core::PresentationSnapshotRevision revision =
            core::PresentationSnapshotRevision::from_number(0);
    };

    void release_retained(const WorldTransitionBackend& transitions,
                          WorldPresentationBackend& world);

    presentation::RuntimeLayoutManager& m_layouts;
    LayoutRealizer& m_realizer;
    const core::CompiledProject* m_project = nullptr;
    std::unordered_map<std::string, MountedPresentationLayout> m_current;
    std::unordered_map<std::uint64_t, std::vector<MountedPresentationLayout>> m_retained;
    std::optional<core::PresentationSnapshotRevision> m_current_revision;
};

} // namespace host
} // namespace noveltea
