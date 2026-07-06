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
constexpr const char* kBuiltinTitleLayoutId = "builtin:title";
constexpr const char* kBuiltinGameHudLayoutId = "builtin:runtime_game";
constexpr const char* kBuiltinPauseMenuLayoutId = "builtin:pause-menu";

std::string sanitize_document_id(std::string value)
{
    for (char& ch : value) {
        if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_') {
            ch = '_';
        }
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
    if (looks_like_asset_path(layout_id)) {
        return layout_id;
    }
    return "project:/layouts/" + layout_id + ".rml";
}

int layer_sort_key(RuntimeLayoutLayer layer) noexcept
{
    switch (layer) {
    case RuntimeLayoutLayer::Title:
        return 0;
    case RuntimeLayoutLayer::GameHud:
        return 10;
    case RuntimeLayoutLayer::MenuOverlay:
        return 20;
    case RuntimeLayoutLayer::Modal:
        return 30;
    case RuntimeLayoutLayer::Debug:
        return 40;
    }
    return 0;
}

void apply_default_document_ids(RuntimeLayoutMountRequest& request)
{
    if (request.builtin_document == RuntimeLayoutBuiltinDocument::Title) {
        if (request.layout_id.empty()) {
            request.layout_id = kBuiltinTitleLayoutId;
        }
        if (request.document_id.empty()) {
            request.document_id = kRuntimeTitleDocumentId;
        }
        request.layer = RuntimeLayoutLayer::Title;
        request.modal = true;
        request.blocks_game_input = true;
        request.pauses_gameplay = true;
        request.close_on_escape = false;
    } else if (request.builtin_document == RuntimeLayoutBuiltinDocument::GameHud) {
        if (request.layout_id.empty()) {
            request.layout_id = kBuiltinGameHudLayoutId;
        }
        if (request.document_id.empty()) {
            request.document_id = kRuntimeGameDocumentId;
        }
        request.layer = RuntimeLayoutLayer::GameHud;
        request.modal = false;
        request.blocks_game_input = false;
        request.pauses_gameplay = false;
        request.close_on_escape = false;
    } else if (request.builtin_document == RuntimeLayoutBuiltinDocument::PauseMenu) {
        if (request.layout_id.empty()) {
            request.layout_id = kBuiltinPauseMenuLayoutId;
        }
        if (request.document_id.empty()) {
            request.document_id = kRuntimePauseMenuDocumentId;
        }
        request.layer = RuntimeLayoutLayer::MenuOverlay;
        request.modal = true;
        request.blocks_game_input = true;
        request.pauses_gameplay = true;
        request.close_on_escape = true;
    }
    if (request.layout_id.empty()) {
        request.layout_id = request.document_id;
    }
    if (request.document_id.empty() && !request.layout_id.empty()) {
        request.document_id = "layout_" + sanitize_document_id(request.layout_id);
    }
}

} // namespace

void RuntimeLayoutManager::bind_runtime_ui(RuntimeUI* ui) noexcept { m_ui = ui; }

RuntimeLayoutInstanceId RuntimeLayoutManager::mount(RuntimeLayoutMountRequest request)
{
    if (!m_ui) {
        return 0;
    }
    apply_default_document_ids(request);
    if (request.document_id.empty()) {
        return 0;
    }
    if (!request.z_index) {
        request.z_index = next_z_index(request.layer);
    }

    (void)unmount_document(request.document_id);

    bool loaded = false;
    switch (request.builtin_document) {
    case RuntimeLayoutBuiltinDocument::Title:
        loaded = m_ui->load_title_document();
        break;
    case RuntimeLayoutBuiltinDocument::GameHud:
        loaded = m_ui->load_runtime_document();
        break;
    case RuntimeLayoutBuiltinDocument::PauseMenu:
        loaded = m_ui->load_pause_menu_document();
        break;
    case RuntimeLayoutBuiltinDocument::None:
        if (!request.asset_path.empty()) {
            loaded = m_ui->load_document(request.document_id, request.asset_path, request.visible);
        }
        break;
    }

    if (!loaded) {
        return 0;
    }
    if (request.visible) {
        (void)m_ui->show_document(request.document_id);
    } else {
        (void)m_ui->hide_document(request.document_id);
    }

    RuntimeMountedLayout mounted;
    mounted.instance_id = m_next_instance_id++;
    mounted.layout_id = std::move(request.layout_id);
    mounted.document_id = std::move(request.document_id);
    mounted.layer = request.layer;
    mounted.z_index = *request.z_index;
    mounted.visible = request.visible;
    mounted.modal = request.modal;
    mounted.blocks_game_input = request.blocks_game_input;
    mounted.pauses_gameplay = request.pauses_gameplay;
    mounted.close_on_escape = request.close_on_escape;
    m_mounted_layouts.push_back(std::move(mounted));
    enforce_layer_order();
    return m_mounted_layouts.back().instance_id;
}

RuntimeLayoutInstanceId RuntimeLayoutManager::mount_builtin_title(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.builtin_document = RuntimeLayoutBuiltinDocument::Title;
    request.z_index = 0;
    request.visible = visible;
    return mount(std::move(request));
}

RuntimeLayoutInstanceId RuntimeLayoutManager::mount_builtin_game_hud(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.builtin_document = RuntimeLayoutBuiltinDocument::GameHud;
    request.z_index = 0;
    request.visible = visible;
    return mount(std::move(request));
}

RuntimeLayoutInstanceId RuntimeLayoutManager::mount_builtin_pause_menu(bool visible)
{
    RuntimeLayoutMountRequest request;
    request.builtin_document = RuntimeLayoutBuiltinDocument::PauseMenu;
    request.z_index = 0;
    request.visible = visible;
    return mount(std::move(request));
}

RuntimeLayoutInstanceId RuntimeLayoutManager::mount_game_hud_layout(std::string layout_id,
                                                                    std::optional<int> z_index)
{
    if (layout_id.empty()) {
        return 0;
    }
    RuntimeLayoutMountRequest request;
    request.layout_id = std::move(layout_id);
    request.document_id = "layout_" + sanitize_document_id(request.layout_id);
    request.asset_path = layout_asset_path(request.layout_id);
    request.layer = RuntimeLayoutLayer::GameHud;
    request.z_index = z_index;
    request.visible = true;
    request.modal = false;
    request.blocks_game_input = false;
    request.pauses_gameplay = false;
    request.close_on_escape = false;
    return mount(std::move(request));
}

bool RuntimeLayoutManager::show(RuntimeLayoutInstanceId instance_id)
{
    if (!m_ui) {
        return false;
    }
    auto it = find_mutable(instance_id);
    if (it == m_mounted_layouts.end()) {
        return false;
    }
    if (!m_ui->show_document(it->document_id)) {
        return false;
    }
    it->visible = true;
    enforce_layer_order();
    return true;
}

bool RuntimeLayoutManager::hide(RuntimeLayoutInstanceId instance_id)
{
    if (!m_ui) {
        return false;
    }
    auto it = find_mutable(instance_id);
    if (it == m_mounted_layouts.end()) {
        return false;
    }
    if (!m_ui->hide_document(it->document_id)) {
        return false;
    }
    it->visible = false;
    enforce_layer_order();
    return true;
}

bool RuntimeLayoutManager::unmount(RuntimeLayoutInstanceId instance_id)
{
    auto it = find_mutable(instance_id);
    if (it == m_mounted_layouts.end()) {
        return false;
    }
    const std::string document_id = it->document_id;
    m_mounted_layouts.erase(it);
    return m_ui ? m_ui->unload_document(document_id) : true;
}

bool RuntimeLayoutManager::unmount_document(const std::string& document_id)
{
    auto it = find_document_mutable(document_id);
    if (it == m_mounted_layouts.end()) {
        return false;
    }
    const std::string existing_document_id = it->document_id;
    m_mounted_layouts.erase(it);
    return m_ui ? m_ui->unload_document(existing_document_id) : true;
}

bool RuntimeLayoutManager::unmount_layer(RuntimeLayoutLayer layer)
{
    bool changed = false;
    for (auto it = m_mounted_layouts.begin(); it != m_mounted_layouts.end();) {
        if (it->layer != layer) {
            ++it;
            continue;
        }
        const std::string document_id = it->document_id;
        it = m_mounted_layouts.erase(it);
        if (m_ui) {
            (void)m_ui->unload_document(document_id);
        }
        changed = true;
    }
    return changed;
}

void RuntimeLayoutManager::reset()
{
    if (m_ui) {
        for (const auto& mounted : m_mounted_layouts) {
            (void)m_ui->unload_document(mounted.document_id);
        }
    }
    m_mounted_layouts.clear();
    m_next_instance_id = 1;
}

const RuntimeMountedLayout* RuntimeLayoutManager::find(RuntimeLayoutInstanceId instance_id) const
{
    const auto it = std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                                 [instance_id](const RuntimeMountedLayout& mounted) {
                                     return mounted.instance_id == instance_id;
                                 });
    return it == m_mounted_layouts.end() ? nullptr : &*it;
}

const RuntimeMountedLayout*
RuntimeLayoutManager::find_document(const std::string& document_id) const
{
    const auto it = std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                                 [&document_id](const RuntimeMountedLayout& mounted) {
                                     return mounted.document_id == document_id;
                                 });
    return it == m_mounted_layouts.end() ? nullptr : &*it;
}

bool RuntimeLayoutManager::has_visible_layer(RuntimeLayoutLayer layer) const noexcept
{
    return std::any_of(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                       [layer](const RuntimeMountedLayout& mounted) {
                           return mounted.layer == layer && mounted.visible;
                       });
}

bool RuntimeLayoutManager::blocks_game_input() const noexcept
{
    return std::any_of(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                       [](const RuntimeMountedLayout& mounted) {
                           return mounted.visible && mounted.blocks_game_input;
                       });
}

bool RuntimeLayoutManager::pauses_gameplay() const noexcept
{
    return std::any_of(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                       [](const RuntimeMountedLayout& mounted) {
                           return mounted.visible && mounted.pauses_gameplay;
                       });
}

bool RuntimeLayoutManager::close_top_escape_layout()
{
    auto it =
        std::max_element(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                         [](const RuntimeMountedLayout& lhs, const RuntimeMountedLayout& rhs) {
                             if (lhs.visible != rhs.visible) {
                                 return !lhs.visible && rhs.visible;
                             }
                             if (lhs.close_on_escape != rhs.close_on_escape) {
                                 return !lhs.close_on_escape && rhs.close_on_escape;
                             }
                             if (lhs.layer != rhs.layer) {
                                 return layer_sort_key(lhs.layer) < layer_sort_key(rhs.layer);
                             }
                             if (lhs.z_index != rhs.z_index) {
                                 return lhs.z_index < rhs.z_index;
                             }
                             return lhs.instance_id < rhs.instance_id;
                         });
    if (it == m_mounted_layouts.end() || !it->visible || !it->close_on_escape) {
        return false;
    }
    return unmount(it->instance_id);
}

int RuntimeLayoutManager::next_z_index(RuntimeLayoutLayer layer) const noexcept
{
    int next = 0;
    for (const auto& mounted : m_mounted_layouts) {
        if (mounted.layer == layer) {
            next = std::max(next, mounted.z_index + 1);
        }
    }
    return next;
}

std::vector<RuntimeMountedLayout>::iterator
RuntimeLayoutManager::find_mutable(RuntimeLayoutInstanceId instance_id)
{
    return std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                        [instance_id](const RuntimeMountedLayout& mounted) {
                            return mounted.instance_id == instance_id;
                        });
}

std::vector<RuntimeMountedLayout>::iterator
RuntimeLayoutManager::find_document_mutable(const std::string& document_id)
{
    return std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                        [&document_id](const RuntimeMountedLayout& mounted) {
                            return mounted.document_id == document_id;
                        });
}

void RuntimeLayoutManager::enforce_layer_order()
{
    if (!m_ui) {
        return;
    }
    std::vector<RuntimeMountedLayout*> ordered;
    ordered.reserve(m_mounted_layouts.size());
    for (auto& mounted : m_mounted_layouts) {
        ordered.push_back(&mounted);
    }
    std::stable_sort(ordered.begin(), ordered.end(),
                     [](const RuntimeMountedLayout* lhs, const RuntimeMountedLayout* rhs) {
                         if (lhs->layer != rhs->layer) {
                             return layer_sort_key(lhs->layer) < layer_sort_key(rhs->layer);
                         }
                         if (lhs->z_index != rhs->z_index) {
                             return lhs->z_index < rhs->z_index;
                         }
                         return lhs->instance_id < rhs->instance_id;
                     });
    for (const auto* mounted : ordered) {
        if (mounted->visible) {
            (void)m_ui->show_document(mounted->document_id);
        } else {
            (void)m_ui->hide_document(mounted->document_id);
        }
    }
}

const char* to_string(RuntimeLayoutLayer layer) noexcept
{
    switch (layer) {
    case RuntimeLayoutLayer::Title:
        return "title";
    case RuntimeLayoutLayer::GameHud:
        return "game-hud";
    case RuntimeLayoutLayer::MenuOverlay:
        return "menu-overlay";
    case RuntimeLayoutLayer::Modal:
        return "modal";
    case RuntimeLayoutLayer::Debug:
        return "debug";
    }
    return "unknown";
}

} // namespace noveltea
