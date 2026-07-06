#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

class RuntimeUI;

using RuntimeLayoutInstanceId = std::uint64_t;

enum class RuntimeLayoutLayer {
    Title,
    GameHud,
    MenuOverlay,
    Modal,
    Debug,
};

enum class RuntimeLayoutBuiltinDocument {
    None,
    Title,
    GameHud,
};

struct RuntimeMountedLayout {
    RuntimeLayoutInstanceId instance_id = 0;
    std::string layout_id;
    std::string document_id;
    RuntimeLayoutLayer layer = RuntimeLayoutLayer::GameHud;
    int z_index = 0;
    bool visible = false;
    bool modal = false;
    bool blocks_game_input = false;
    bool pauses_gameplay = false;
    bool close_on_escape = false;
};

struct RuntimeLayoutMountRequest {
    std::string layout_id;
    std::string document_id;
    std::string asset_path;
    RuntimeLayoutLayer layer = RuntimeLayoutLayer::GameHud;
    RuntimeLayoutBuiltinDocument builtin_document = RuntimeLayoutBuiltinDocument::None;
    std::optional<int> z_index;
    bool visible = true;
    bool modal = false;
    bool blocks_game_input = false;
    bool pauses_gameplay = false;
    bool close_on_escape = false;
};

class RuntimeLayoutManager {
public:
    void bind_runtime_ui(RuntimeUI* ui) noexcept;
    [[nodiscard]] RuntimeUI* runtime_ui() const noexcept { return m_ui; }

    [[nodiscard]] RuntimeLayoutInstanceId mount(RuntimeLayoutMountRequest request);
    [[nodiscard]] RuntimeLayoutInstanceId mount_builtin_title(bool visible = true);
    [[nodiscard]] RuntimeLayoutInstanceId mount_builtin_game_hud(bool visible = true);
    [[nodiscard]] RuntimeLayoutInstanceId
    mount_game_hud_layout(std::string layout_id, std::optional<int> z_index = std::nullopt);

    [[nodiscard]] bool show(RuntimeLayoutInstanceId instance_id);
    [[nodiscard]] bool hide(RuntimeLayoutInstanceId instance_id);
    [[nodiscard]] bool unmount(RuntimeLayoutInstanceId instance_id);
    [[nodiscard]] bool unmount_document(const std::string& document_id);
    [[nodiscard]] bool unmount_layer(RuntimeLayoutLayer layer);
    void reset();

    [[nodiscard]] const std::vector<RuntimeMountedLayout>& mounted_layouts() const noexcept
    {
        return m_mounted_layouts;
    }
    [[nodiscard]] const RuntimeMountedLayout* find(RuntimeLayoutInstanceId instance_id) const;
    [[nodiscard]] const RuntimeMountedLayout* find_document(const std::string& document_id) const;
    [[nodiscard]] bool has_visible_layer(RuntimeLayoutLayer layer) const noexcept;
    [[nodiscard]] bool blocks_game_input() const noexcept;
    [[nodiscard]] bool pauses_gameplay() const noexcept;
    [[nodiscard]] bool close_top_escape_layout();

private:
    [[nodiscard]] int next_z_index(RuntimeLayoutLayer layer) const noexcept;
    [[nodiscard]] std::vector<RuntimeMountedLayout>::iterator
    find_mutable(RuntimeLayoutInstanceId instance_id);
    [[nodiscard]] std::vector<RuntimeMountedLayout>::iterator
    find_document_mutable(const std::string& document_id);
    void enforce_layer_order();

    RuntimeUI* m_ui = nullptr;
    RuntimeLayoutInstanceId m_next_instance_id = 1;
    std::vector<RuntimeMountedLayout> m_mounted_layouts;
};

[[nodiscard]] const char* to_string(RuntimeLayoutLayer layer) noexcept;

} // namespace noveltea
