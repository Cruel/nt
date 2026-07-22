#include "noveltea/presentation/runtime_layout_manager.hpp"

#include <algorithm>
#include <limits>
#include <optional>
#include <utility>

namespace noveltea::presentation {
namespace {

constexpr const char* kBuiltinTitleLayoutId = "builtin-title";
constexpr const char* kBuiltinGameHudLayoutId = "builtin-runtime-game";
constexpr const char* kBuiltinPauseMenuLayoutId = "builtin-pause-menu";
constexpr const char* kBuiltinSaveMenuLayoutId = "builtin-save-menu";
constexpr const char* kBuiltinLoadMenuLayoutId = "builtin-load-menu";
constexpr const char* kBuiltinSettingsMenuLayoutId = "builtin-settings-menu";
constexpr const char* kBuiltinTextLogLayoutId = "builtin-text-log";
constexpr const char* kBuiltinModalLayoutId = "builtin-modal";

core::Diagnostics failure(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

bool looks_like_asset_path(const std::string& layout_id)
{
    return layout_id.find(":/") != std::string::npos || layout_id.find('|') != std::string::npos ||
           (layout_id.size() >= 4 && layout_id.substr(layout_id.size() - 4) == ".rml");
}

std::string layout_asset_path(const std::string& layout_id)
{
    return looks_like_asset_path(layout_id) ? layout_id : "project:/layouts/" + layout_id + ".rml";
}

void apply_builtin_defaults(RuntimeLayoutMountRequest& request,
                            RuntimeLayoutBuiltinDocument document)
{
    switch (document) {
    case RuntimeLayoutBuiltinDocument::Title:
        request.layout_id = kBuiltinTitleLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::MenuOverlay,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::Modal,
                          .gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::GameHud:
        request.layout_id = kBuiltinGameHudLayoutId;
        request.owner = core::MountedLayoutOwner::Gameplay;
        request.policy = {.plane = core::PresentationPlane::GameUi,
                          .clock = core::LayoutClockDomain::Gameplay,
                          .input = core::LayoutInputMode::Normal,
                          .gameplay_pause = core::GameplayPausePolicy::Continue,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::PauseMenu:
        request.layout_id = kBuiltinPauseMenuLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::MenuOverlay,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::Modal,
                          .gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Dismiss,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::SaveMenu:
        request.layout_id = kBuiltinSaveMenuLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::MenuOverlay,
                          .local_order = 220,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::Modal,
                          .gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Dismiss,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::LoadMenu:
        request.layout_id = kBuiltinLoadMenuLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::MenuOverlay,
                          .local_order = 220,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::Modal,
                          .gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Dismiss,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::SettingsMenu:
        request.layout_id = kBuiltinSettingsMenuLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::MenuOverlay,
                          .local_order = 200,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::Modal,
                          .gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Dismiss,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::TextLog:
        request.layout_id = kBuiltinTextLogLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::MenuOverlay,
                          .local_order = 180,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::BlockGameplay,
                          .gameplay_pause = core::GameplayPausePolicy::Continue,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Dismiss,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::Modal:
        request.layout_id = kBuiltinModalLayoutId;
        request.owner = core::MountedLayoutOwner::Shell;
        request.policy = {.plane = core::PresentationPlane::Modal,
                          .clock = core::LayoutClockDomain::UnscaledPresentation,
                          .input = core::LayoutInputMode::Modal,
                          .gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible,
                          .visibility = core::LayoutVisibility::Visible,
                          .escape_dismissal = core::EscapeDismissalPolicy::Dismiss,
                          .entrance_operation = std::nullopt,
                          .exit_operation = std::nullopt};
        break;
    case RuntimeLayoutBuiltinDocument::None:
        break;
    }
}

bool ordered_before(const RuntimeMountedLayout& lhs, const RuntimeMountedLayout& rhs)
{
    if (lhs.mounted.policy.plane != rhs.mounted.policy.plane)
        return lhs.mounted.policy.plane < rhs.mounted.policy.plane;
    if (lhs.mounted.policy.local_order != rhs.mounted.policy.local_order)
        return lhs.mounted.policy.local_order < rhs.mounted.policy.local_order;
    return lhs.mounted.instance < rhs.mounted.instance;
}

int input_strength(core::LayoutInputMode mode) { return static_cast<int>(mode); }

} // namespace

RuntimeLayoutManager::RuntimeLayoutManager(std::uint64_t maximum_instance_id) noexcept
    : m_maximum_instance_id(maximum_instance_id)
{
}

RuntimeLayoutManager::~RuntimeLayoutManager() = default;

void RuntimeLayoutManager::bind_document_host(RuntimeLayoutDocumentHost* host) noexcept
{
    m_host = host;
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount(RuntimeLayoutMountRequest request)
{
    if (!m_host)
        return MountResult::failure(
            failure("layout.host_unavailable", "Layout realization host is unavailable"));

    const auto requested_visibility = request.policy.visibility;
    if (const auto* builtin = std::get_if<RuntimeLayoutBuiltinSource>(&request.source);
        builtin && builtin->document != RuntimeLayoutBuiltinDocument::None &&
        request.layout_id.empty()) {
        apply_builtin_defaults(request, builtin->document);
        request.policy.visibility = requested_visibility;
    }

    auto layout = core::LayoutId::create(request.layout_id);
    if (!layout)
        return MountResult::failure(layout.error());
    if (m_next_instance_id == 0 || m_next_instance_id > m_maximum_instance_id)
        return MountResult::failure(
            failure("layout.instance_exhausted", "Mounted Layout instance identity is exhausted"));

    const auto instance = core::MountedLayoutInstanceId::from_number(m_next_instance_id);
    auto candidate = m_mounted_layouts;
    candidate.push_back(RuntimeMountedLayout{
        .mounted = {.instance = instance,
                    .layout = *layout.value_if(),
                    .owner = request.owner,
                    .policy = std::move(request.policy),
                    .scale_overrides = std::move(request.scale_overrides)},
        .source = std::move(request.source),
        .composition_group = request.composition_group,
        .publication_revision = request.publication_revision,
    });
    auto reconciled = reconcile_candidate(candidate);
    if (!reconciled)
        return MountResult::failure(std::move(reconciled).error());

    m_mounted_layouts = std::move(candidate);
    m_next_instance_id = m_next_instance_id == std::numeric_limits<std::uint64_t>::max()
                             ? 0
                             : m_next_instance_id + 1;
    return MountResult::success(instance);
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount_builtin_title(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.source = RuntimeLayoutBuiltinSource{RuntimeLayoutBuiltinDocument::Title};
    request.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return mount(std::move(request));
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount_builtin_game_hud(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.source = RuntimeLayoutBuiltinSource{RuntimeLayoutBuiltinDocument::GameHud};
    request.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return mount(std::move(request));
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount_builtin_pause_menu(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.source = RuntimeLayoutBuiltinSource{RuntimeLayoutBuiltinDocument::PauseMenu};
    request.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return mount(std::move(request));
}

RuntimeLayoutManager::MountResult
RuntimeLayoutManager::mount_game_hud_layout(std::string layout_id,
                                            std::optional<std::int32_t> local_order, bool visible)
{
    RuntimeLayoutMountRequest request;
    request.layout_id = std::move(layout_id);
    request.source = RuntimeLayoutAssetSource{layout_asset_path(request.layout_id)};
    request.policy.local_order = local_order.value_or(0);
    request.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return mount(std::move(request));
}

bool RuntimeLayoutManager::replace_policy(core::MountedLayoutInstanceId id,
                                          core::MountedLayoutPolicy policy)
{
    if (!m_host)
        return false;
    auto candidate = m_mounted_layouts;
    const auto it = std::find_if(candidate.begin(), candidate.end(),
                                 [id](const auto& value) { return value.mounted.instance == id; });
    if (it == candidate.end())
        return false;
    it->mounted.policy = std::move(policy);
    if (!reconcile_candidate(candidate))
        return false;
    m_mounted_layouts = std::move(candidate);
    return true;
}

bool RuntimeLayoutManager::show(core::MountedLayoutInstanceId id)
{
    const auto* existing = find(id);
    if (!existing)
        return false;
    auto policy = existing->mounted.policy;
    policy.visibility = core::LayoutVisibility::Visible;
    return replace_policy(id, std::move(policy));
}

bool RuntimeLayoutManager::hide(core::MountedLayoutInstanceId id)
{
    const auto* existing = find(id);
    if (!existing)
        return false;
    auto policy = existing->mounted.policy;
    policy.visibility = core::LayoutVisibility::Hidden;
    return replace_policy(id, std::move(policy));
}

bool RuntimeLayoutManager::unmount(core::MountedLayoutInstanceId id)
{
    if (!m_host)
        return false;
    auto candidate = m_mounted_layouts;
    const auto it = std::find_if(candidate.begin(), candidate.end(),
                                 [id](const auto& value) { return value.mounted.instance == id; });
    if (it == candidate.end())
        return false;
    candidate.erase(it);
    if (!reconcile_candidate(candidate))
        return false;
    m_mounted_layouts = std::move(candidate);
    return true;
}

void RuntimeLayoutManager::reset()
{
    if (m_host) {
        const std::vector<RuntimeMountedLayout> empty;
        (void)m_host->reconcile_layouts(empty);
    }
    m_mounted_layouts.clear();
}

const RuntimeMountedLayout* RuntimeLayoutManager::find(core::MountedLayoutInstanceId id) const
{
    const auto it = std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                                 [id](const auto& value) { return value.mounted.instance == id; });
    return it == m_mounted_layouts.end() ? nullptr : &*it;
}

RuntimeLayoutInputPolicyEvaluation RuntimeLayoutManager::evaluate_input_policy() const noexcept
{
    const RuntimeMountedLayout* governing = nullptr;
    for (const auto& layout : m_mounted_layouts) {
        const auto& policy = layout.mounted.policy;
        if (policy.visibility != core::LayoutVisibility::Visible ||
            policy.input == core::LayoutInputMode::None)
            continue;
        if (!governing ||
            input_strength(policy.input) > input_strength(governing->mounted.policy.input) ||
            (policy.input == governing->mounted.policy.input && ordered_before(*governing, layout)))
            governing = &layout;
    }
    if (!governing)
        return {};
    const auto mode = governing->mounted.policy.input;
    return {.gameplay = mode == core::LayoutInputMode::Normal
                            ? GameplayInputDisposition::Eligible
                            : GameplayInputDisposition::BlockedByLayout,
            .governing_instance = governing->mounted.instance,
            .governing_mode = mode};
}

std::optional<RuntimeLayoutDismissal> RuntimeLayoutManager::escape_dismissal_target() const noexcept
{
    for (auto it = m_mounted_layouts.rbegin(); it != m_mounted_layouts.rend(); ++it) {
        const auto& mounted = it->mounted;
        if (mounted.policy.visibility != core::LayoutVisibility::Visible)
            continue;
        if (mounted.policy.escape_dismissal == core::EscapeDismissalPolicy::Dismiss)
            return RuntimeLayoutDismissal{.instance = mounted.instance, .owner = mounted.owner};
        if (mounted.policy.input == core::LayoutInputMode::Modal)
            return std::nullopt;
    }
    return std::nullopt;
}

bool RuntimeLayoutManager::dismiss_escape_target(const RuntimeLayoutDismissal& dismissal)
{
    const auto* layout = find(dismissal.instance);
    return layout && layout->mounted.owner == dismissal.owner && unmount(dismissal.instance);
}

core::Result<void, core::Diagnostics>
RuntimeLayoutManager::reconcile_candidate(std::vector<RuntimeMountedLayout>& candidate)
{
    if (!m_host)
        return core::Result<void, core::Diagnostics>::failure(
            failure("layout.host_unavailable", "Layout realization host is unavailable"));
    std::sort(candidate.begin(), candidate.end(), ordered_before);
    return m_host->reconcile_layouts(candidate);
}

} // namespace noveltea::presentation
