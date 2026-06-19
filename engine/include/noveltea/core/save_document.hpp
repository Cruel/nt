#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>

namespace noveltea::core {

struct DocumentError {
    std::string path;
    std::string message;
};

class SaveDocument {
public:
    SaveDocument();
    explicit SaveDocument(nlohmann::json root);

    [[nodiscard]] static SaveDocument new_save();
    [[nodiscard]] static std::optional<SaveDocument> parse_json_text(std::string_view text,
                                                                     std::vector<DocumentError>& errors);

    [[nodiscard]] const nlohmann::json& root() const noexcept { return m_root; }
    [[nodiscard]] nlohmann::json& root() noexcept { return m_root; }

    [[nodiscard]] bool validate(std::vector<DocumentError>& errors) const;

    [[nodiscard]] double play_time() const;
    [[nodiscard]] bool navigation_enabled() const;
    [[nodiscard]] bool map_enabled() const;
    [[nodiscard]] std::optional<EntityRef> entrypoint() const;
    [[nodiscard]] std::string current_map_id() const;

    [[nodiscard]] std::string dump() const;

private:
    nlohmann::json m_root;
};

struct Profile {
    std::string name;
};

class SettingsDocument {
public:
    SettingsDocument();
    explicit SettingsDocument(nlohmann::json root);

    [[nodiscard]] static SettingsDocument defaults();
    [[nodiscard]] static std::optional<SettingsDocument> parse_json_text(std::string_view text,
                                                                         std::vector<DocumentError>& errors);

    [[nodiscard]] const nlohmann::json& root() const noexcept { return m_root; }
    [[nodiscard]] nlohmann::json& root() noexcept { return m_root; }

    [[nodiscard]] bool validate(std::vector<DocumentError>& errors) const;

    [[nodiscard]] double font_size_multiplier() const;
    [[nodiscard]] int active_profile_index() const;
    [[nodiscard]] std::vector<Profile> profiles() const;

    [[nodiscard]] std::string dump() const;

private:
    nlohmann::json m_root;
};

namespace profile_paths {

inline constexpr std::string_view settings_filename = "settings.conf";
inline constexpr std::string_view last_save_filename = "lastSave";
inline constexpr std::string_view save_extension = ".ntsav";

[[nodiscard]] std::string profile_directory_name(int profile_index);
[[nodiscard]] std::string slot_filename(int slot);
[[nodiscard]] std::string slot_path(int profile_index, int slot);

} // namespace profile_paths

} // namespace noveltea::core
