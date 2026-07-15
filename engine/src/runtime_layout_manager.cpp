#include "noveltea/runtime_layout_manager.hpp"

#include "noveltea/ui_runtime.hpp"

#include <algorithm>
#include <cctype>
#include <utility>

namespace noveltea {
namespace {

constexpr const char* kRuntimeTitleDocumentId = "runtime_title";
constexpr const char* kRuntimeGameDocumentId = "runtime_game";
constexpr const char* kRuntimePauseMenuDocumentId = "runtime_pause_menu";
constexpr const char* kBuiltinTitleLayoutId = "builtin-title";
constexpr const char* kBuiltinGameHudLayoutId = "builtin-runtime-game";
constexpr const char* kBuiltinPauseMenuLayoutId = "builtin-pause-menu";

core::Diagnostics failure(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::string sanitize_document_id(std::string value)
{
    for (char& ch : value) {
        if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_')
            ch = '_';
    }
    return value;
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

void apply_builtin_defaults(RuntimeLayoutMountRequest& request)
{
    switch (request.builtin_document) {
    case RuntimeLayoutBuiltinDocument::Title:
        request.layout_id = kBuiltinTitleLayoutId;
        request.document_id = kRuntimeTitleDocumentId;
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
        request.document_id = kRuntimeGameDocumentId;
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
        request.document_id = kRuntimePauseMenuDocumentId;
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

} // namespace

class RuntimeLayoutManager::RuntimeUiDocumentHost final : public RuntimeLayoutDocumentHost {
public:
    explicit RuntimeUiDocumentHost(RuntimeUI& ui) : m_ui(ui) {}
    bool load_builtin(RuntimeLayoutBuiltinDocument document) override
    {
        switch (document) {
        case RuntimeLayoutBuiltinDocument::Title:
            return m_ui.load_title_document();
        case RuntimeLayoutBuiltinDocument::GameHud:
            return m_ui.load_runtime_document();
        case RuntimeLayoutBuiltinDocument::PauseMenu:
            return m_ui.load_pause_menu_document();
        case RuntimeLayoutBuiltinDocument::None:
            return false;
        }
        return false;
    }
    bool load_document(const std::string& id, const std::string& path, bool visible) override
    {
        return m_ui.load_document(id, path, visible);
    }
    bool apply_layout_state(const std::vector<RuntimeLayoutDocumentState>& ordered_state) override
    {
        for (const auto& state : ordered_state) {
            if (!m_ui.document(state.document_id))
                return false;
        }
        for (const auto& state : ordered_state) {
            const bool applied = state.visibility == core::LayoutVisibility::Visible
                                     ? m_ui.show_document(state.document_id)
                                     : m_ui.hide_document(state.document_id);
            if (!applied)
                return false;
        }
        return true;
    }
    bool unload_document(const std::string& id) override { return m_ui.unload_document(id); }

private:
    RuntimeUI& m_ui;
};

RuntimeLayoutManager::RuntimeLayoutManager(std::uint64_t maximum_instance_id) noexcept
    : m_maximum_instance_id(maximum_instance_id)
{
}

RuntimeLayoutManager::~RuntimeLayoutManager() = default;

void RuntimeLayoutManager::bind_runtime_ui(RuntimeUI* ui) noexcept
{
    m_ui = ui;
    m_ui_host.reset();
    if (ui)
        m_ui_host = std::make_unique<RuntimeUiDocumentHost>(*ui);
    m_host = m_ui_host.get();
}

void RuntimeLayoutManager::bind_document_host(RuntimeLayoutDocumentHost* host) noexcept
{
    m_ui = nullptr;
    m_ui_host.reset();
    m_host = host;
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount(RuntimeLayoutMountRequest request)
{
    if (!m_host)
        return MountResult::failure(
            failure("layout.host_unavailable", "Layout document host is unavailable"));
    const auto requested_visibility = request.policy.visibility;
    apply_builtin_defaults(request);
    if (request.builtin_document != RuntimeLayoutBuiltinDocument::None)
        request.policy.visibility = requested_visibility;
    if (request.document_id.empty() && !request.layout_id.empty())
        request.document_id = "layout_" + sanitize_document_id(request.layout_id);
    if (request.document_id.empty())
        return MountResult::failure(
            failure("layout.invalid_document", "Mounted Layout requires a document ID"));
    if (find_document(request.document_id))
        return MountResult::failure(
            failure("layout.document_conflict", "Document is already owned by a mounted Layout"));
    auto layout = core::LayoutId::create(request.layout_id);
    if (!layout)
        return MountResult::failure(layout.error());
    if (m_next_instance_id == 0 || m_next_instance_id > m_maximum_instance_id)
        return MountResult::failure(
            failure("layout.instance_exhausted", "Mounted Layout instance identity is exhausted"));

    const bool loaded =
        request.builtin_document == RuntimeLayoutBuiltinDocument::None
            ? (!request.asset_path.empty() &&
               m_host->load_document(request.document_id, request.asset_path, false))
            : m_host->load_builtin(request.builtin_document);
    if (!loaded)
        return MountResult::failure(
            failure("layout.load_failed", "Layout document failed to load"));

    const auto instance = core::MountedLayoutInstanceId::from_number(m_next_instance_id);
    m_mounted_layouts.push_back(RuntimeMountedLayout{
        .mounted = {.instance = instance,
                    .layout = *layout.value_if(),
                    .owner = request.owner,
                    .policy = std::move(request.policy)},
        .document_id = std::move(request.document_id),
    });
    std::sort(m_mounted_layouts.begin(), m_mounted_layouts.end(), ordered_before);
    if (!apply_layout_state()) {
        const auto failed = find_mutable(instance);
        const auto document_id =
            failed == m_mounted_layouts.end() ? std::string{} : failed->document_id;
        if (failed != m_mounted_layouts.end())
            m_mounted_layouts.erase(failed);
        if (!document_id.empty())
            (void)m_host->unload_document(document_id);
        return MountResult::failure(
            failure("layout.realization_failed", "Mounted Layout state failed to apply"));
    }
    m_next_instance_id = m_next_instance_id == std::numeric_limits<std::uint64_t>::max()
                             ? 0
                             : m_next_instance_id + 1;
    return MountResult::success(instance);
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount_builtin_title(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.builtin_document = RuntimeLayoutBuiltinDocument::Title;
    request.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return mount(std::move(request));
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount_builtin_game_hud(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.builtin_document = RuntimeLayoutBuiltinDocument::GameHud;
    request.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return mount(std::move(request));
}

RuntimeLayoutManager::MountResult RuntimeLayoutManager::mount_builtin_pause_menu(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.builtin_document = RuntimeLayoutBuiltinDocument::PauseMenu;
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
    request.document_id = "layout_" + sanitize_document_id(request.layout_id);
    request.asset_path = layout_asset_path(request.layout_id);
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
    auto it = find_mutable(id);
    if (it == m_mounted_layouts.end())
        return false;
    const auto previous_policy = it->mounted.policy;
    it->mounted.policy = std::move(policy);
    std::sort(m_mounted_layouts.begin(), m_mounted_layouts.end(), ordered_before);
    if (!apply_layout_state()) {
        auto rollback = find_mutable(id);
        if (rollback != m_mounted_layouts.end())
            rollback->mounted.policy = previous_policy;
        std::sort(m_mounted_layouts.begin(), m_mounted_layouts.end(), ordered_before);
        return false;
    }
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
    auto it = find_mutable(id);
    if (it == m_mounted_layouts.end())
        return false;
    const auto document_id = it->document_id;
    if (m_host && !m_host->unload_document(document_id))
        return false;
    m_mounted_layouts.erase(it);
    return true;
}

bool RuntimeLayoutManager::unmount_document(const std::string& document_id)
{
    const auto* mounted = find_document(document_id);
    return mounted && unmount(mounted->mounted.instance);
}

void RuntimeLayoutManager::reset()
{
    if (m_host) {
        for (const auto& mounted : m_mounted_layouts)
            (void)m_host->unload_document(mounted.document_id);
    }
    m_mounted_layouts.clear();
}

const RuntimeMountedLayout* RuntimeLayoutManager::find(core::MountedLayoutInstanceId id) const
{
    const auto it = std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                                 [id](const auto& value) { return value.mounted.instance == id; });
    return it == m_mounted_layouts.end() ? nullptr : &*it;
}

const RuntimeMountedLayout* RuntimeLayoutManager::find_document(const std::string& id) const
{
    const auto it = std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                                 [&id](const auto& value) { return value.document_id == id; });
    return it == m_mounted_layouts.end() ? nullptr : &*it;
}

std::vector<RuntimeMountedLayout>::iterator
RuntimeLayoutManager::find_mutable(core::MountedLayoutInstanceId id)
{
    return std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                        [id](const auto& value) { return value.mounted.instance == id; });
}

bool RuntimeLayoutManager::apply_layout_state()
{
    if (!m_host)
        return false;
    std::vector<RuntimeLayoutDocumentState> state;
    state.reserve(m_mounted_layouts.size());
    for (const auto& mounted : m_mounted_layouts)
        state.push_back({mounted.document_id, mounted.mounted.policy.visibility});
    return m_host->apply_layout_state(state);
}

} // namespace noveltea
