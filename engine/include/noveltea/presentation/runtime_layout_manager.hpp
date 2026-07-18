#pragma once

#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/result.hpp"

#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::presentation {

enum class RuntimeLayoutBuiltinDocument : std::uint8_t {
    None,
    Title,
    GameHud,
    PauseMenu,
    SaveMenu,
    LoadMenu,
    SettingsMenu,
    TextLog,
    Modal,
};

struct RuntimeLayoutProjectSource {
    auto operator<=>(const RuntimeLayoutProjectSource&) const = default;
};

struct RuntimeLayoutBuiltinSource {
    RuntimeLayoutBuiltinDocument document = RuntimeLayoutBuiltinDocument::None;
    auto operator<=>(const RuntimeLayoutBuiltinSource&) const = default;
};

struct RuntimeLayoutAssetSource {
    std::string logical_path;
    auto operator<=>(const RuntimeLayoutAssetSource&) const = default;
};

struct RuntimeLayoutFragmentSource {
    std::string source_url;
    std::string fragment_rml;
    std::string host_rml;
    auto operator<=>(const RuntimeLayoutFragmentSource&) const = default;
};

struct RuntimeLayoutMemorySource {
    std::string source_url;
    std::string rml;
    auto operator<=>(const RuntimeLayoutMemorySource&) const = default;
};

using RuntimeLayoutSource =
    std::variant<RuntimeLayoutProjectSource, RuntimeLayoutBuiltinSource, RuntimeLayoutAssetSource,
                 RuntimeLayoutFragmentSource, RuntimeLayoutMemorySource>;

struct RuntimeMountedLayout {
    core::MountedLayoutInstance mounted;
    RuntimeLayoutSource source = RuntimeLayoutProjectSource{};
    core::PresentationCompositionGroup composition_group =
        core::PresentationCompositionGroup::Interface;
    core::PresentationSnapshotRevision publication_revision =
        core::PresentationSnapshotRevision::from_number(0);
};

class RuntimeLayoutDocumentHost {
public:
    virtual ~RuntimeLayoutDocumentHost() = default;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    reconcile_layouts(const std::vector<RuntimeMountedLayout>& desired) = 0;
};

struct RuntimeLayoutMountRequest {
    std::string layout_id;
    core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
    core::MountedLayoutPolicy policy{
        .plane = core::PresentationPlane::GameUi,
        .clock = core::LayoutClockDomain::Gameplay,
        .input = core::LayoutInputMode::Normal,
        .gameplay_pause = core::GameplayPausePolicy::Continue,
        .visibility = core::LayoutVisibility::Visible,
        .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
        .entrance_operation = std::nullopt,
        .exit_operation = std::nullopt,
    };
    RuntimeLayoutSource source = RuntimeLayoutProjectSource{};
    core::PresentationCompositionGroup composition_group =
        core::PresentationCompositionGroup::Interface;
    core::PresentationSnapshotRevision publication_revision =
        core::PresentationSnapshotRevision::from_number(0);
};

enum class GameplayInputDisposition : std::uint8_t {
    Eligible,
    BlockedByLayout,
};

struct RuntimeLayoutInputPolicyEvaluation {
    GameplayInputDisposition gameplay = GameplayInputDisposition::Eligible;
    std::optional<core::MountedLayoutInstanceId> governing_instance;
    core::LayoutInputMode governing_mode = core::LayoutInputMode::None;
};

struct RuntimeLayoutDismissal {
    core::MountedLayoutInstanceId instance;
    core::MountedLayoutOwner owner;
};

class RuntimeLayoutManager {
public:
    explicit RuntimeLayoutManager(
        std::uint64_t maximum_instance_id = std::numeric_limits<std::uint64_t>::max()) noexcept;
    ~RuntimeLayoutManager();

    void bind_document_host(RuntimeLayoutDocumentHost* host) noexcept;

    using MountResult = core::Result<core::MountedLayoutInstanceId, core::Diagnostics>;
    [[nodiscard]] MountResult mount(RuntimeLayoutMountRequest request);
    [[nodiscard]] MountResult mount_builtin_title(bool visible = true);
    [[nodiscard]] MountResult mount_builtin_game_hud(bool visible = true);
    [[nodiscard]] MountResult mount_builtin_pause_menu(bool visible = true);
    [[nodiscard]] MountResult
    mount_game_hud_layout(std::string layout_id,
                          std::optional<std::int32_t> local_order = std::nullopt,
                          bool visible = true);

    [[nodiscard]] bool replace_policy(core::MountedLayoutInstanceId instance_id,
                                      core::MountedLayoutPolicy policy);
    [[nodiscard]] bool show(core::MountedLayoutInstanceId instance_id);
    [[nodiscard]] bool hide(core::MountedLayoutInstanceId instance_id);
    [[nodiscard]] bool unmount(core::MountedLayoutInstanceId instance_id);
    void reset();

    [[nodiscard]] const std::vector<RuntimeMountedLayout>& mounted_layouts() const noexcept
    {
        return m_mounted_layouts;
    }
    [[nodiscard]] const RuntimeMountedLayout* find(core::MountedLayoutInstanceId instance_id) const;
    [[nodiscard]] RuntimeLayoutInputPolicyEvaluation evaluate_input_policy() const noexcept;
    [[nodiscard]] std::optional<RuntimeLayoutDismissal> escape_dismissal_target() const noexcept;
    [[nodiscard]] bool dismiss_escape_target(const RuntimeLayoutDismissal& dismissal);

private:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_candidate(std::vector<RuntimeMountedLayout>& candidate);

    RuntimeLayoutDocumentHost* m_host = nullptr;
    std::uint64_t m_next_instance_id = 1;
    std::uint64_t m_maximum_instance_id;
    std::vector<RuntimeMountedLayout> m_mounted_layouts;
};

} // namespace noveltea::presentation
