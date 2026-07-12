#pragma once

#include "noveltea/core/runtime_value.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::core {

inline constexpr char runtime_project_schema[] = "noveltea.runtime.project";
inline constexpr std::uint32_t runtime_project_schema_version = 1;

struct ProjectIdentity {
    std::string id;
    std::string name;
    std::string version;
    std::string author;
    std::string website;
};

struct RuntimeSettings {
    std::string locale = "en";
    std::string default_font;
    bool allow_saves = true;
};

enum class EntrypointKind : std::uint8_t {
    Room,
    Dialogue,
    Scene,
    Script
};
struct RuntimeEntrypoint {
    EntrypointKind kind = EntrypointKind::Room;
    std::string id;
};

struct AssetRecord {
    std::string id;
    std::string path;
    std::string media_type;
};
struct AssetAlias {
    std::string id;
    std::string asset_id;
};
struct RoomRecord {
    std::string id;
    std::string name;
    std::string description;
    std::optional<std::string> map_id;
    std::vector<std::string> object_ids;
    std::vector<std::string> verb_ids;
};
struct ObjectRecord {
    std::string id;
    std::string name;
    std::string description;
    std::vector<std::string> verb_ids;
};
struct VerbRecord {
    std::string id;
    std::string label;
};
struct ActionRecord {
    std::string id;
    std::string verb_id;
    std::optional<std::string> object_id;
    std::vector<std::string> action_steps;
};
struct DialogueChoice {
    std::string label;
    std::optional<std::string> next_node_id;
};
struct DialogueNode {
    std::string id;
    std::string text;
    std::vector<DialogueChoice> choices;
};
struct DialogueRecord {
    std::string id;
    std::vector<DialogueNode> nodes;
};
struct SceneRecord {
    std::string id;
    std::vector<std::string> action_steps;
};
struct MapLocation {
    std::string id;
    std::string room_id;
    double x = 0.0;
    double y = 0.0;
};
struct MapRecord {
    std::string id;
    std::optional<std::string> asset_id;
    std::vector<MapLocation> locations;
};
struct ScriptRecord {
    std::string id;
    std::string source;
};
struct LayoutRecord {
    std::string id;
    std::string document_asset_id;
};
struct RuntimeUiConfig {
    std::optional<std::string> default_layout_id;
    std::optional<std::string> theme_asset_id;
};

struct RuntimeProject {
    ProjectIdentity identity;
    RuntimeSettings settings;
    RuntimeEntrypoint entrypoint;
    std::unordered_map<std::string, RuntimeValue> variables;
    std::vector<AssetRecord> assets;
    std::vector<AssetAlias> asset_aliases;
    std::vector<RoomRecord> rooms;
    std::vector<ObjectRecord> objects;
    std::vector<VerbRecord> verbs;
    std::vector<ActionRecord> actions;
    std::vector<DialogueRecord> dialogues;
    std::vector<SceneRecord> scenes;
    std::vector<MapRecord> maps;
    std::vector<ScriptRecord> scripts;
    std::vector<LayoutRecord> layouts;
    RuntimeUiConfig runtime_ui;
};

} // namespace noveltea::core
