#pragma once

#include <optional>
#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>
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
    [[nodiscard]] static std::optional<SaveDocument>
    parse_json_text(std::string_view text, std::vector<DocumentError>& errors);

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

struct SaveSlotId {
    int value = 0;

    [[nodiscard]] static constexpr SaveSlotId autosave() noexcept { return SaveSlotId{-1}; }
    [[nodiscard]] constexpr bool is_autosave() const noexcept { return value < 0; }
    [[nodiscard]] constexpr bool operator==(const SaveSlotId&) const noexcept = default;
};

struct SaveSlotResult {
    bool success = false;
    std::optional<SaveDocument> save;
    std::vector<DocumentError> errors;
};

class SaveSlotStore {
public:
    virtual ~SaveSlotStore() = default;

    [[nodiscard]] virtual bool has_slot(SaveSlotId slot) const = 0;
    [[nodiscard]] virtual SaveSlotResult read_slot(SaveSlotId slot) const = 0;
    [[nodiscard]] virtual SaveSlotResult write_slot(SaveSlotId slot, const SaveDocument& save) = 0;
    virtual void delete_slot(SaveSlotId slot) = 0;
};

class MemorySaveSlotStore final : public SaveSlotStore {
public:
    [[nodiscard]] bool has_slot(SaveSlotId slot) const override;
    [[nodiscard]] SaveSlotResult read_slot(SaveSlotId slot) const override;
    [[nodiscard]] SaveSlotResult write_slot(SaveSlotId slot, const SaveDocument& save) override;
    void delete_slot(SaveSlotId slot) override;

private:
    std::unordered_map<int, SaveDocument> m_slots;
};

class FilesystemSaveSlotStore final : public SaveSlotStore {
public:
    explicit FilesystemSaveSlotStore(std::filesystem::path root);
    [[nodiscard]] bool has_slot(SaveSlotId slot) const override;
    [[nodiscard]] SaveSlotResult read_slot(SaveSlotId slot) const override;
    [[nodiscard]] SaveSlotResult write_slot(SaveSlotId slot, const SaveDocument& save) override;
    void delete_slot(SaveSlotId slot) override;
    [[nodiscard]] const std::filesystem::path& root() const noexcept { return m_root; }

private:
    [[nodiscard]] std::filesystem::path slot_path(SaveSlotId slot) const;
    std::filesystem::path m_root;
};

struct Profile {
    std::string name;
};

class SettingsDocument {
public:
    SettingsDocument();
    explicit SettingsDocument(nlohmann::json root);

    [[nodiscard]] static SettingsDocument defaults();
    [[nodiscard]] static std::optional<SettingsDocument>
    parse_json_text(std::string_view text, std::vector<DocumentError>& errors);

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
