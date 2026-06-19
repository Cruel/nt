#pragma once

#include <array>
#include <cstddef>
#include <string_view>

namespace noveltea::core::project_ids {

inline constexpr float engine_version_value = 1.0f;

inline constexpr std::string_view engine_version = "engine";
inline constexpr std::string_view engine_fonts = "sysfonts";
inline constexpr std::string_view project_name = "name";
inline constexpr std::string_view project_version = "version";
inline constexpr std::string_view project_author = "author";
inline constexpr std::string_view project_website = "website";
inline constexpr std::string_view project_fonts = "fonts";
inline constexpr std::string_view project_font_default = "fontDefault";
inline constexpr std::string_view starting_inventory = "startInv";
inline constexpr std::string_view entrypoint_entity = "entrypoint";
inline constexpr std::string_view entrypoint_metadata = "entrydata";
inline constexpr std::string_view quick_verb = "quickVerb";
inline constexpr std::string_view script_before_save = "sbs";
inline constexpr std::string_view script_after_load = "sas";
inline constexpr std::string_view script_after_action = "saa";
inline constexpr std::string_view script_before_action = "sba";
inline constexpr std::string_view script_undefined_action = "sua";
inline constexpr std::string_view script_after_enter = "sae";
inline constexpr std::string_view script_before_enter = "sbe";
inline constexpr std::string_view script_after_leave = "sal";
inline constexpr std::string_view script_before_leave = "sbl";
inline constexpr std::size_t select_entity_type = 0;
inline constexpr std::size_t select_entity_id = 1;
inline constexpr std::size_t entity_id = 0;
inline constexpr std::size_t entity_parent_id = 1;
inline constexpr std::size_t entity_properties = 2;
inline constexpr std::size_t cutscene_segment_type = 0;
inline constexpr std::string_view player = "player";

inline constexpr std::string_view shaders = "shaders";
inline constexpr std::string_view system_shaders = "systemShaders";
inline constexpr std::size_t shader_background = 0;
inline constexpr std::size_t shader_post_process = 1;
inline constexpr std::string_view textures = "textures";

inline constexpr std::string_view action = "action";
inline constexpr std::string_view cutscene = "cutscene";
inline constexpr std::string_view dialogue = "dialogue";
inline constexpr std::string_view map = "map";
inline constexpr std::string_view object = "object";
inline constexpr std::string_view room = "room";
inline constexpr std::string_view script = "script";
inline constexpr std::string_view verb = "verb";

inline constexpr std::array<std::string_view, 8> entity_collection_keys = {
    action, cutscene, dialogue, map, object, room, script, verb,
};

inline constexpr std::string_view tests = "tests";
inline constexpr std::string_view test_script_init = "init";
inline constexpr std::string_view test_script_check = "check";
inline constexpr std::string_view test_steps = "steps";
inline constexpr std::string_view open_tabs = "tabs";
inline constexpr std::string_view open_tab_index = "tabIndex";
inline constexpr std::string_view entity_colors = "colors";
inline constexpr std::string_view entity_preview = "preview";
inline constexpr std::string_view spell_whitelist = "whitelist";

inline constexpr std::string_view entity_queue = "entityQueue";
inline constexpr std::string_view log = "log";
inline constexpr std::string_view save_map = "map";
inline constexpr std::string_view map_enabled = "mapEnabled";
inline constexpr std::string_view navigation_enabled = "navEnabled";
inline constexpr std::string_view object_locations = "objectLocations";
inline constexpr std::string_view play_time = "playTime";
inline constexpr std::string_view properties = "properties";
inline constexpr std::string_view room_descriptions = "roomDescriptions";
inline constexpr std::string_view visited_rooms = "visitedRooms";

} // namespace noveltea::core::project_ids
