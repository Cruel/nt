#pragma once

#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/result.hpp"

#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

class RuntimeUI;

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

struct RuntimeLayoutDocumentState {
    std::string document_id;
    core::LayoutVisibility visibility = core::LayoutVisibility::Hidden;
    core::MountedLayoutPolicy policy;
};

class RuntimeLayoutDocumentHost {
public:
    virtual ~RuntimeLayoutDocumentHost() = default;
    [[nodiscard]] virtual bool load_builtin(RuntimeLayoutBuiltinDocument document,
                                            const core::MountedLayoutPolicy& policy) = 0;
    [[nodiscard]] virtual bool load_document(const std::string& document_id,
                                             const std::string& asset_path, bool visible,
                                             const core::MountedLayoutPolicy& policy) = 0;
    [[nodiscard]] virtual bool
    apply_layout_state(const std::vector<RuntimeLayoutDocumentState>& ordered_state) = 0;
    [[nodiscard]] virtual bool unload_document(const std::string& document_id) = 0;
};

struct RuntimeMountedLayout {
    core::MountedLayoutInstance mounted;
    std::string document_id;
};

struct RuntimeLayoutMountRequest {
    std::string layout_id;
    std::string document_id;
    std::string asset_path;
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
    RuntimeLayoutBuiltinDocument builtin_document = RuntimeLayoutBuiltinDocument::None;
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

    void bind_runtime_ui(RuntimeUI* ui) noexcept;
    void bind_document_host(RuntimeLayoutDocumentHost* host) noexcept;
    [[nodiscard]] RuntimeUI* runtime_ui() const noexcept { return m_ui; }

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
    [[nodiscard]] bool unmount_document(const std::string& document_id);
    void reset();

    [[nodiscard]] const std::vector<RuntimeMountedLayout>& mounted_layouts() const noexcept
    {
        return m_mounted_layouts;
    }
    [[nodiscard]] const RuntimeMountedLayout* find(core::MountedLayoutInstanceId instance_id) const;
    [[nodiscard]] const RuntimeMountedLayout* find_document(const std::string& document_id) const;
    [[nodiscard]] RuntimeLayoutInputPolicyEvaluation evaluate_input_policy() const noexcept;
    [[nodiscard]] std::optional<RuntimeLayoutDismissal> escape_dismissal_target() const noexcept;
    [[nodiscard]] bool dismiss_escape_target(const RuntimeLayoutDismissal& dismissal);

private:
    class RuntimeUiDocumentHost;
    [[nodiscard]] std::vector<RuntimeMountedLayout>::iterator
    find_mutable(core::MountedLayoutInstanceId instance_id);
    [[nodiscard]] bool apply_layout_state();

    RuntimeUI* m_ui = nullptr;
    std::unique_ptr<RuntimeUiDocumentHost> m_ui_host;
    RuntimeLayoutDocumentHost* m_host = nullptr;
    std::uint64_t m_next_instance_id = 1;
    std::uint64_t m_maximum_instance_id;
    std::vector<RuntimeMountedLayout> m_mounted_layouts;
};

} // namespace noveltea
