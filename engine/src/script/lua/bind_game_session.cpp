#include "script/lua/script_runtime_internal.hpp"
#include "script/lua/sol_access.hpp"

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/json_access.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/project_model.hpp>
#include <noveltea/core/runtime_session_host.hpp>
#include <noveltea/runtime_command.hpp>

#include <SDL3/SDL_log.h>

#include <lua.hpp>
#include <nlohmann/json.hpp>
#include <sol/sol.hpp>

#include <algorithm>
#include <random>
#include <regex>
#include <string>
#include <string_view>

namespace noveltea::script {
namespace {

// -------------------------------------------------------------------
// Bridge — pointer to GameSession + seeded RNG, stored in Lua registry
// -------------------------------------------------------------------
struct ScriptBridge {
    core::GameSession* session = nullptr;
    core::RuntimeSessionHost* host = nullptr;
    RuntimeCommandDispatcher* dispatcher = nullptr;
    std::mt19937_64 rng;
    std::uniform_real_distribution<double> dist; // [0, 1)
};

constexpr const char kBridgeKey[] = "__noveltea_script_bridge";

ScriptBridge* get_bridge(lua_State* L)
{
    sol::state_view lua(L);
    return detail::registry_pointer<ScriptBridge>(lua, kBridgeKey);
}

core::GameSession* get_session(lua_State* L)
{
    auto* bridge = get_bridge(L);
    return bridge ? bridge->session : nullptr;
}

nlohmann::json sol_to_json(const sol::object& object)
{
    if (!object.valid() || object == sol::lua_nil) {
        return nullptr;
    }
    switch (object.get_type()) {
    case sol::type::boolean:
        return object.as<bool>();
    case sol::type::number:
        if (object.is<std::int64_t>()) {
            return object.as<std::int64_t>();
        }
        return object.as<double>();
    case sol::type::string:
        return object.as<std::string>();
    case sol::type::table: {
        sol::table table = object;
        nlohmann::json result = nlohmann::json::object();
        bool array_like = true;
        std::size_t max_index = 0;
        std::size_t count = 0;
        for (const auto& pair : table) {
            if (pair.first.get_type() != sol::type::number || !pair.first.is<std::int64_t>()) {
                array_like = false;
                break;
            }
            const auto index = pair.first.as<std::int64_t>();
            if (index <= 0) {
                array_like = false;
                break;
            }
            max_index = std::max(max_index, static_cast<std::size_t>(index));
            ++count;
        }
        if (array_like && max_index == count) {
            result = nlohmann::json::array();
            for (std::size_t i = 1; i <= max_index; ++i) {
                result.push_back(sol_to_json(table[static_cast<int>(i)]));
            }
            return result;
        }
        result = nlohmann::json::object();
        for (const auto& pair : table) {
            if (pair.first.get_type() == sol::type::string) {
                result[pair.first.as<std::string>()] = sol_to_json(pair.second);
            }
        }
        return result;
    }
    default:
        return nullptr;
    }
}

sol::object json_to_sol(lua_State* L, const nlohmann::json& value,
                        sol::optional<sol::object> default_value)
{
    if (value.is_null()) {
        return default_value.value_or(sol::lua_nil);
    }
    sol::state_view lua(L);
    if (value.is_string()) {
        return sol::make_object(lua, core::json_access::get_or<std::string>(value, {}));
    }
    if (value.is_number_integer()) {
        return sol::make_object(lua, core::json_access::get_or<std::int64_t>(value, 0));
    }
    if (value.is_number()) {
        return sol::make_object(lua, core::json_access::get_or<double>(value, 0.0));
    }
    if (value.is_boolean()) {
        return sol::make_object(lua, core::json_access::get_or<bool>(value, false));
    }
    return sol::make_object(lua, value.dump());
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
sol::object entity_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                        const std::string& key, sol::optional<sol::object> default_value,
                        sol::this_state L)
{
    if (!session)
        return default_value.value_or(sol::lua_nil);
    return json_to_sol(L, session->entity_property(type, id, key), default_value);
}

bool entity_has_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                     const std::string& key)
{
    if (!session || !session->project())
        return false;
    return !session->entity_property(type, id, key).is_null();
}

void entity_set_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                     const std::string& key, const sol::object& value)
{
    if (session) {
        session->set_entity_property(type, id, key, sol_to_json(value));
    }
}

void entity_unset_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                       const std::string& key)
{
    if (session) {
        session->unset_entity_property(type, id, key);
    }
}

// -------------------------------------------------------------------
// RoomLua — exposed as "Room" usertype
// -------------------------------------------------------------------
struct RoomLua {
    core::GameSession* session = nullptr;
    std::string id;

    std::string get_id() const { return id; }

    sol::object prop(const std::string& key, sol::optional<sol::object> default_value,
                     sol::this_state L) const
    {
        return entity_prop(session, core::EntityType::Room, id, key, default_value, L);
    }

    bool has_prop(const std::string& key) const
    {
        return entity_has_prop(session, core::EntityType::Room, id, key);
    }

    void set_prop(const std::string& key, const sol::object& value)
    {
        entity_set_prop(session, core::EntityType::Room, id, key, value);
    }

    void unset_prop(const std::string& key)
    {
        entity_unset_prop(session, core::EntityType::Room, id, key);
    }

    std::string get_description() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& rooms = model->rooms();
        auto it = rooms.find(id);
        if (it == rooms.end())
            return {};
        return it->second.description_raw;
    }

    int get_visit_count() const { return 0; }

    std::string get_script_before_enter() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& rooms = model->rooms();
        auto it = rooms.find(id);
        if (it == rooms.end())
            return {};
        return it->second.script_before_enter;
    }

    std::string get_script_after_enter() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& rooms = model->rooms();
        auto it = rooms.find(id);
        if (it == rooms.end())
            return {};
        return it->second.script_after_enter;
    }

    std::string get_script_before_leave() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& rooms = model->rooms();
        auto it = rooms.find(id);
        if (it == rooms.end())
            return {};
        return it->second.script_before_leave;
    }

    std::string get_script_after_leave() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& rooms = model->rooms();
        auto it = rooms.find(id);
        if (it == rooms.end())
            return {};
        return it->second.script_after_leave;
    }

    std::string get_name() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& rooms = model->rooms();
        auto it = rooms.find(id);
        if (it == rooms.end())
            return {};
        return it->second.name;
    }
};

// -------------------------------------------------------------------
// ScriptEntityLua — exposed as "ScriptEntity" usertype
// -------------------------------------------------------------------
struct ScriptEntityLua {
    core::GameSession* session = nullptr;
    std::string id;

    std::string get_id() const { return id; }

    sol::object prop(const std::string& key, sol::optional<sol::object> default_value,
                     sol::this_state L) const
    {
        return entity_prop(session, core::EntityType::Script, id, key, default_value, L);
    }

    bool has_prop(const std::string& key) const
    {
        return entity_has_prop(session, core::EntityType::Script, id, key);
    }

    void set_prop(const std::string& key, const sol::object& value)
    {
        entity_set_prop(session, core::EntityType::Script, id, key, value);
    }

    void unset_prop(const std::string& key)
    {
        entity_unset_prop(session, core::EntityType::Script, id, key);
    }

    bool get_autorun() const
    {
        if (!session || !session->project())
            return false;
        auto* model = session->project();
        const auto& scripts = model->scripts();
        auto it = scripts.find(id);
        if (it == scripts.end())
            return false;
        return it->second.autorun;
    }

    std::string get_content() const
    {
        if (!session || !session->project())
            return {};
        auto* model = session->project();
        const auto& scripts = model->scripts();
        auto it = scripts.find(id);
        if (it == scripts.end())
            return {};
        return it->second.content;
    }
};

// -------------------------------------------------------------------
// GameBinding — exposed as "Game" usertype
// -------------------------------------------------------------------
struct GameBinding {
    core::GameSession* session = nullptr;
    core::RuntimeSessionHost* host = nullptr;
    RuntimeCommandDispatcher* dispatcher = nullptr;

    bool dispatch(std::string name, nlohmann::json payload = nlohmann::json::object()) const
    {
        if (!dispatcher) {
            SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                        "[lua] Game.command(%s) ignored: runtime dispatcher is not bound",
                        name.c_str());
            return false;
        }
        RuntimeCommand command;
        command.source = RuntimeCommandSource::LayoutLua;
        command.domain = domain_from_command_name(name);
        command.name = std::move(name);
        command.payload = std::move(payload);
        return dispatcher->dispatch(std::move(command)).handled;
    }

    sol::object get_room(sol::this_state L) const
    {
        if (!session || !session->current_room_id())
            return sol::lua_nil;
        sol::state_view lua(L);
        return sol::make_object(lua, RoomLua{session, *session->current_room_id()});
    }

    sol::object get_map_id(sol::this_state L) const
    {
        if (!session || !session->current_map_id())
            return sol::lua_nil;
        sol::state_view lua(L);
        return sol::make_object(lua, *session->current_map_id());
    }

    bool get_navigation() const { return session ? session->navigation_enabled() : false; }
    bool get_minimap() const { return session ? session->map_enabled() : false; }
    bool get_save_enabled() const { return true; }

    void push_next(int type, std::string id)
    {
        if (!session)
            return;
        auto et = core::entity_type_from_integer(type);
        if (et) {
            session->queue_entity(core::EntityRef{*et, std::move(id)});
        }
    }

    sol::object prop(const std::string& key, sol::optional<sol::object> default_value,
                     sol::this_state L) const
    {
        if (!session)
            return default_value.value_or(sol::lua_nil);
        return json_to_sol(L, session->property(key), default_value);
    }

    void set_prop(const std::string& key, sol::object value) const
    {
        if (session) {
            session->set_property(key, sol_to_json(value));
        }
    }

    void unset_prop(const std::string& key) const
    {
        if (session) {
            session->unset_property(key);
        }
    }

    sol::object load_room(const std::string& id, sol::this_state L) const
    {
        if (!session || !session->project())
            return sol::lua_nil;
        const auto& rooms = session->project()->rooms();
        if (rooms.find(id) == rooms.end())
            return sol::lua_nil;
        sol::state_view lua(L);
        return sol::make_object(lua, RoomLua{session, id});
    }

    bool exists_room(const std::string& id) const
    {
        if (!session || !session->project())
            return false;
        return session->project()->rooms().find(id) != session->project()->rooms().end();
    }

    sol::object load_script(const std::string& id, sol::this_state L) const
    {
        if (!session || !session->project())
            return sol::lua_nil;
        const auto& scripts = session->project()->scripts();
        if (scripts.find(id) == scripts.end())
            return sol::lua_nil;
        sol::state_view lua(L);
        return sol::make_object(lua, ScriptEntityLua{session, id});
    }

    bool exists_script(const std::string& id) const
    {
        if (!session || !session->project())
            return false;
        return session->project()->scripts().find(id) != session->project()->scripts().end();
    }

    sol::object get_inventory(sol::this_state L) const
    {
        sol::state_view lua(L);
        return sol::make_object(lua, lua.create_table());
    }

    void save(sol::optional<int> slot) const
    {
        if (host) {
            (void)host->save(core::SaveSlotId{slot.value_or(0)});
        }
    }

    void load(sol::optional<int> slot) const
    {
        if (host) {
            (void)host->load_save(core::SaveSlotId{slot.value_or(0)});
        }
    }

    void autosave() const
    {
        if (host) {
            (void)host->autosave();
        }
    }
    void quit() const { SDL_Log("[lua] Game.quit — stub"); }
    void save_entity(sol::object) const { SDL_Log("[lua] Game.save_entity — stub"); }

    void set_object_location(const std::string& object_id, int location_type,
                             const std::string& location_id) const
    {
        if (!session)
            return;
        auto type = core::entity_type_from_integer(location_type);
        if (!type)
            return;
        session->set_object_location(object_id, core::EntityRef{*type, location_id});
    }

    sol::object object_location(const std::string& object_id, sol::this_state L) const
    {
        if (!session)
            return sol::lua_nil;
        auto location = session->object_location(object_id);
        if (!location)
            return sol::lua_nil;
        sol::state_view lua(L);
        sol::table table = lua.create_table();
        table["type"] = core::to_integer(location->type);
        table["id"] = location->id;
        return table;
    }

    void clear_object_location(const std::string& object_id) const
    {
        if (session) {
            session->clear_object_location(object_id);
        }
    }

    bool command(std::string name, sol::optional<sol::object> payload) const
    {
        return dispatch(std::move(name),
                        payload ? sol_to_json(*payload) : nlohmann::json::object());
    }

    bool start() const { return dispatch("game.start"); }
    bool pause() const { return dispatch("game.pause"); }
    bool resume() const { return dispatch("game.resume"); }
    bool open_load_menu() const { return dispatch("menu.load"); }
    bool open_settings_menu() const { return dispatch("menu.settings"); }
    bool close_menu() const { return dispatch("menu.close"); }
    bool continue_game() const { return dispatch("runtime.continue"); }

    bool navigate(int direction) const
    {
        return dispatch("runtime.navigate", {{"direction", direction}});
    }

    bool choose(int index) const { return dispatch("runtime.dialogue-option", {{"index", index}}); }

    bool select_object(std::string object_id) const
    {
        return dispatch("runtime.select-object", {{"object_id", std::move(object_id)}});
    }

    bool clear_selection() const { return dispatch("runtime.clear-selection"); }

    bool run_action(std::string verb_id, sol::optional<sol::object> object_ids) const
    {
        nlohmann::json payload = {{"verb_id", std::move(verb_id)}};
        if (object_ids) {
            payload["object_ids"] = sol_to_json(*object_ids);
        }
        return dispatch("runtime.run-action", std::move(payload));
    }

    bool start_room(std::string room_id) const
    {
        return dispatch("runtime.start-room", {{"room_id", std::move(room_id)}});
    }

    bool go_to_room(std::string room_id) const { return start_room(std::move(room_id)); }

    bool start_dialogue(std::string dialogue_id) const
    {
        return dispatch("runtime.start-dialogue", {{"dialogue_id", std::move(dialogue_id)}});
    }

    bool start_scene(std::string scene_id) const
    {
        return dispatch("runtime.start-scene", {{"scene_id", std::move(scene_id)}});
    }

    bool run_script(std::string script_id) const
    {
        return dispatch("runtime.run-script", {{"script_id", std::move(script_id)}});
    }

    bool add_layer(std::string layout_id, sol::optional<int> z_index) const
    {
        nlohmann::json payload = {{"layout_id", std::move(layout_id)}};
        if (z_index) {
            payload["z_index"] = *z_index;
        }
        return dispatch("layout.add-layer", std::move(payload));
    }
};

// -------------------------------------------------------------------
// ScriptBinding — exposed as "Script" usertype
// -------------------------------------------------------------------
struct ScriptBinding {
    lua_State* L = nullptr;

    double rand()
    {
        auto* bridge = get_bridge(L);
        if (!bridge)
            return 0.0;
        return bridge->dist(bridge->rng);
    }

    void seed(int seed_val)
    {
        auto* bridge = get_bridge(L);
        if (bridge) {
            bridge->rng.seed(seed_val);
        }
    }

    std::string eval_expressions(std::string text)
    {
        static const std::regex pattern(R"(\{\{([\s\S]*?)\}\})");
        std::string result;
        std::size_t last = 0;
        std::sregex_iterator it(text.begin(), text.end(), pattern);
        std::sregex_iterator end;
        for (; it != end; ++it) {
            result.append(text, last, it->position() - last);
            std::string expr = (*it)[1].str();
            sol::state_view lua(L);
            auto load_result = lua.load("return " + expr, "={{expression}}");
            if (!load_result.valid()) {
                sol::error err = load_result;
                SDL_Log("[lua] eval_expressions: failed to compile '{{%s}}': %s", expr.c_str(),
                        err.what());
                result += "{{" + expr + "}}";
            } else {
                sol::protected_function eval_fn(load_result);
                sol::protected_function_result eval_result = eval_fn();
                if (!eval_result.valid()) {
                    sol::error err = eval_result;
                    SDL_Log("[lua] eval_expressions: failed to evaluate '{{%s}}': %s", expr.c_str(),
                            err.what());
                    result += "{{" + expr + "}}";
                } else {
                    const int stack_index = eval_result.stack_index();
                    const int type = lua_type(L, stack_index);
                    if (type == LUA_TSTRING) {
                        std::size_t length = 0;
                        const char* text_value = lua_tolstring(L, stack_index, &length);
                        if (text_value) {
                            result.append(text_value, length);
                        }
                    } else if (type == LUA_TNUMBER) {
                        double d = static_cast<double>(lua_tonumber(L, stack_index));
                        if (d == static_cast<double>(static_cast<std::int64_t>(d))) {
                            result += std::to_string(static_cast<std::int64_t>(d));
                        } else {
                            result += std::to_string(d);
                        }
                    } else if (type == LUA_TBOOLEAN) {
                        result += lua_toboolean(L, stack_index) != 0 ? "true" : "false";
                    }
                }
            }
            last = it->position() + it->length();
        }
        result.append(text, last, text.size() - last);
        return result;
    }

    bool run(std::string script_id)
    {
        auto* session = get_session(L);
        if (!session || !session->project())
            return false;
        const auto& scripts = session->project()->scripts();
        auto it = scripts.find(script_id);
        if (it == scripts.end())
            return false;

        const std::string& source = it->second.content;
        sol::state_view lua(L);
        sol::load_result loaded = lua.load(source, "=Script.run(" + script_id + ")");
        if (!loaded.valid()) {
            sol::error err = loaded;
            SDL_Log("[lua] Script.run(%s): load failed: %s", script_id.c_str(), err.what());
            return false;
        }
        sol::protected_function fn(loaded);
        auto result = fn();
        if (!result.valid()) {
            sol::error err = result;
            SDL_Log("[lua] Script.run(%s): execution failed: %s", script_id.c_str(), err.what());
            return false;
        }
        return true;
    }

    void get_text_input(std::string msg, sol::protected_function callback)
    {
        SDL_Log("[lua] Script.get_text_input(%s) — stub", msg.c_str());
        if (callback.valid()) {
            auto result = callback("");
            detail::log_protected_failure("Script.get_text_input callback", result);
        }
    }
};

// -------------------------------------------------------------------
// LogBinding — exposed as "Log" usertype
// -------------------------------------------------------------------
struct LogBinding {
    core::GameSession* session = nullptr;

    void push(std::string text)
    {
        SDL_Log("[lua] Log.push: %s", text.c_str());
        if (session) {
            session->append_log(std::move(text));
        }
    }
};

// -------------------------------------------------------------------
// TimerBinding — exposed as "Timer" usertype
// -------------------------------------------------------------------
struct TimerBinding {
    lua_State* L = nullptr;
    core::GameSession* session = nullptr;

    sol::object start(double duration_ms, sol::protected_function callback)
    {
        if (!session)
            return sol::lua_nil;
        auto handle = session->timers().start(
            duration_ms / 1000.0, [callback = std::make_shared<sol::protected_function>(callback)](
                                      core::RuntimeTimerId id) {
                if (callback->valid()) {
                    auto result = (*callback)(static_cast<std::int64_t>(id));
                    detail::log_protected_failure("Timer.start callback", result);
                }
            });
        return sol::make_object(L, static_cast<std::int64_t>(handle.id));
    }

    sol::object start_repeat(double duration_ms, sol::protected_function callback)
    {
        if (!session)
            return sol::lua_nil;
        auto handle = session->timers().start_repeat(
            duration_ms / 1000.0, [callback = std::make_shared<sol::protected_function>(callback)](
                                      core::RuntimeTimerId id) {
                if (callback->valid()) {
                    auto result = (*callback)(static_cast<std::int64_t>(id));
                    detail::log_protected_failure("Timer.start_repeat callback", result);
                }
            });
        return sol::make_object(L, static_cast<std::int64_t>(handle.id));
    }

    bool cancel(std::int64_t id)
    {
        return session ? session->timers().cancel(static_cast<core::RuntimeTimerId>(id)) : false;
    }

    bool active(std::int64_t id) const
    {
        return session ? session->timers().active(static_cast<core::RuntimeTimerId>(id)) : false;
    }
};

// -------------------------------------------------------------------
// SaveBinding — exposed as "Save" usertype
// -------------------------------------------------------------------
struct SaveBinding {
    void reset_room_descriptions() const { SDL_Log("[lua] Save.reset_room_descriptions — stub"); }
};

// -------------------------------------------------------------------
// Builder for Game table
// -------------------------------------------------------------------
void build_game_table(lua_State* L, core::GameSession* session, core::RuntimeSessionHost* host,
                      RuntimeCommandDispatcher* dispatcher)
{
    sol::state_view lua(L);
    GameBinding binding{session, host, dispatcher};
    sol::table game = lua.create_table();

    game.set_function("command",
                      [binding](std::string name, sol::optional<sol::object> payload) mutable {
                          return binding.command(std::move(name), payload);
                      });
    game.set_function("start", [binding]() mutable { return binding.start(); });
    game.set_function("pause", [binding]() mutable { return binding.pause(); });
    game.set_function("resume", [binding]() mutable { return binding.resume(); });
    game.set_function("open_load_menu", [binding]() mutable { return binding.open_load_menu(); });
    game.set_function("open_settings_menu",
                      [binding]() mutable { return binding.open_settings_menu(); });
    game.set_function("close_menu", [binding]() mutable { return binding.close_menu(); });
    game.set_function("continue", [binding]() mutable { return binding.continue_game(); });
    game.set_function("navigate",
                      [binding](int direction) mutable { return binding.navigate(direction); });
    game.set_function("choose", [binding](int index) mutable { return binding.choose(index); });
    game.set_function("select_object", [binding](std::string object_id) mutable {
        return binding.select_object(std::move(object_id));
    });
    game.set_function("clear_selection", [binding]() mutable { return binding.clear_selection(); });
    game.set_function("run_action", [binding](std::string verb_id,
                                              sol::optional<sol::object> object_ids) mutable {
        return binding.run_action(std::move(verb_id), object_ids);
    });
    game.set_function("start_room", [binding](std::string room_id) mutable {
        return binding.start_room(std::move(room_id));
    });
    game.set_function("go_to_room", [binding](std::string room_id) mutable {
        return binding.go_to_room(std::move(room_id));
    });
    game.set_function("start_dialogue", [binding](std::string dialogue_id) mutable {
        return binding.start_dialogue(std::move(dialogue_id));
    });
    game.set_function("start_scene", [binding](std::string scene_id) mutable {
        return binding.start_scene(std::move(scene_id));
    });
    game.set_function("run_script", [binding](std::string script_id) mutable {
        return binding.run_script(std::move(script_id));
    });
    game.set_function("add_layer",
                      [binding](std::string layout_id, sol::optional<int> z_index) mutable {
                          return binding.add_layer(std::move(layout_id), z_index);
                      });

    game.set_function("push_next", [binding](int type, std::string id) mutable {
        binding.push_next(type, std::move(id));
    });
    game.set_function("prop",
                      [binding](std::string key, sol::optional<sol::object> def,
                                sol::this_state L_) mutable { return binding.prop(key, def, L_); });
    game.set_function("set_prop", [binding](std::string key, sol::object value) mutable {
        binding.set_prop(key, value);
    });
    game.set_function("unset_prop",
                      [binding](std::string key) mutable { binding.unset_prop(key); });
    game.set_function("load_room", [binding](std::string id, sol::this_state L_) mutable {
        return binding.load_room(std::move(id), L_);
    });
    game.set_function("exists_room", [binding](std::string id) mutable {
        return binding.exists_room(std::move(id));
    });
    game.set_function("load_script", [binding](std::string id, sol::this_state L_) mutable {
        return binding.load_script(std::move(id), L_);
    });
    game.set_function("exists_script", [binding](std::string id) mutable {
        return binding.exists_script(std::move(id));
    });
    game.set_function("save", [binding](sol::optional<int> slot) mutable { binding.save(slot); });
    game.set_function("load", [binding](sol::optional<int> slot) mutable { binding.load(slot); });
    game.set_function("autosave", [binding]() mutable { binding.autosave(); });
    game.set_function("quit", [binding]() mutable { binding.quit(); });
    game.set_function("save_entity", [binding](sol::object e) mutable { binding.save_entity(e); });
    game.set_function("set_object_location",
                      [binding](std::string object_id, int type, std::string id) mutable {
                          binding.set_object_location(object_id, type, id);
                      });
    game.set_function("object_location",
                      [binding](std::string object_id, sol::this_state L_) mutable {
                          return binding.object_location(object_id, L_);
                      });
    game.set_function("clear_object_location", [binding](std::string object_id) mutable {
        binding.clear_object_location(object_id);
    });

    // Properties via __index
    sol::table meta = lua.create_table();
    meta[sol::meta_function::index] = [binding](sol::table t,
                                                const std::string& key) -> sol::object {
        lua_State* L_ = t.lua_state();
        if (key == "room")
            return binding.get_room(L_);
        if (key == "map_id")
            return binding.get_map_id(L_);
        if (key == "navigation")
            return sol::make_object(L_, binding.get_navigation());
        if (key == "minimap")
            return sol::make_object(L_, binding.get_minimap());
        if (key == "save_enabled")
            return sol::make_object(L_, binding.get_save_enabled());
        if (key == "inventory")
            return binding.get_inventory(L_);
        return sol::lua_nil;
    };
    meta[sol::meta_function::new_index] = [](sol::table, sol::object, sol::object) {};
    game[sol::metatable_key] = meta;
    lua["Game"] = game;
}

void build_script_table(lua_State* L)
{
    sol::state_view lua(L);
    ScriptBinding sb{L};
    sol::table script = lua.create_table();
    script.set_function("rand", [sb]() mutable -> double { return sb.rand(); });
    script.set_function("seed", [sb](int v) mutable { sb.seed(v); });
    script.set_function("eval_expressions", [sb](std::string text) mutable {
        return sb.eval_expressions(std::move(text));
    });
    script.set_function("run", [sb](std::string id) mutable { return sb.run(std::move(id)); });
    script.set_function("get_text_input",
                        [sb](std::string msg, sol::protected_function cb) mutable {
                            sb.get_text_input(std::move(msg), std::move(cb));
                        });
    lua["Script"] = script;
}

void build_log_table(lua_State* L, core::GameSession* session)
{
    sol::state_view lua(L);
    sol::table log = lua.create_table();
    log.set_function("push", [session](std::string text) {
        SDL_Log("[lua] Log.push: %s", text.c_str());
        if (session) {
            session->append_log(std::move(text));
        }
    });
    lua["Log"] = log;
}

void build_timer_table(lua_State* L, core::GameSession* session)
{
    sol::state_view lua(L);
    sol::table timer = lua.create_table();
    timer.set_function(
        "start", [session, L](double duration_ms, sol::protected_function callback) -> sol::object {
            if (!session)
                return sol::lua_nil;
            auto handle = session->timers().start(
                duration_ms / 1000.0, [callback = std::make_shared<sol::protected_function>(
                                           std::move(callback))](core::RuntimeTimerId id) {
                    if (callback->valid()) {
                        auto result = (*callback)(static_cast<std::int64_t>(id));
                        detail::log_protected_failure("Timer.start callback", result);
                    }
                });
            return sol::make_object(L, static_cast<std::int64_t>(handle.id));
        });
    timer.set_function(
        "start_repeat",
        [session, L](double duration_ms, sol::protected_function callback) -> sol::object {
            if (!session)
                return sol::lua_nil;
            auto handle = session->timers().start_repeat(
                duration_ms / 1000.0, [callback = std::make_shared<sol::protected_function>(
                                           std::move(callback))](core::RuntimeTimerId id) {
                    if (callback->valid()) {
                        auto result = (*callback)(static_cast<std::int64_t>(id));
                        detail::log_protected_failure("Timer.start_repeat callback", result);
                    }
                });
            return sol::make_object(L, static_cast<std::int64_t>(handle.id));
        });
    timer.set_function("cancel", [session](std::int64_t id) {
        return session ? session->timers().cancel(static_cast<core::RuntimeTimerId>(id)) : false;
    });
    timer.set_function("active", [session](std::int64_t id) {
        return session ? session->timers().active(static_cast<core::RuntimeTimerId>(id)) : false;
    });
    lua["Timer"] = timer;
}

void build_save_table(lua_State* L)
{
    sol::state_view lua(L);
    sol::table save = lua.create_table();
    save.set_function("reset_room_descriptions",
                      []() { SDL_Log("[lua] Save.reset_room_descriptions — stub"); });
    lua["Save"] = save;
}

void register_legacy_entity_functions(lua_State* L)
{
    sol::state_view lua(L);
    lua.set_function("prop",
                     [lua](std::string key, sol::optional<sol::object> default_value,
                           sol::this_state) -> sol::object {
                         auto entity = lua["thisEntity"];
                         if (!entity.valid() || entity == sol::lua_nil) {
                             return default_value.value_or(sol::lua_nil);
                         }
                         if (entity.get_type() == sol::type::userdata) {
                             sol::object function_object = entity["prop"];
                             if (function_object.is<sol::protected_function>()) {
                                 sol::protected_function function = function_object;
                                 auto result = function(entity, key, default_value);
                                 if (result.valid() && result.return_count() > 0) {
                                     return sol::object(result.lua_state(), result.stack_index());
                                 }
                                 detail::log_protected_failure("legacy prop callback", result);
                             }
                         }
                         return default_value.value_or(sol::lua_nil);
                     });

    lua.set_function("set_prop", [lua](std::string key, sol::object value) {
        auto entity = lua["thisEntity"];
        if (!entity.valid() || entity == sol::lua_nil)
            return;
        if (entity.get_type() == sol::type::userdata) {
            sol::object function_object = entity["set_prop"];
            if (!function_object.is<sol::protected_function>()) {
                return;
            }
            sol::protected_function function = function_object;
            auto result = function(entity, key, value);
            detail::log_protected_failure("legacy set_prop callback", result);
        }
    });
}

} // namespace

// -------------------------------------------------------------------
// bind_game_session — register all game compatibility globals
// -------------------------------------------------------------------
void bind_game_session(lua_State* L, noveltea::core::GameSession* session)
{
    sol::state_view lua(L);

    // Store/update bridge
    auto* bridge = detail::registry_pointer<ScriptBridge>(lua, kBridgeKey);
    if (!bridge) {
        bridge = new ScriptBridge();
        lua.registry().set(kBridgeKey, bridge);
    }
    bridge->session = session;
    bridge->host = nullptr;

    // Register entity usertypes once (harmless to do multiple times but avoid it)
    {
        auto reg = lua.registry();
        if (!detail::registry_bool(lua, "__noveltea_types_registered")) {
            lua.new_usertype<RoomLua>(
                "Room", sol::no_constructor, "id", sol::property(&RoomLua::get_id), "prop",
                &RoomLua::prop, "has_prop", &RoomLua::has_prop, "set_prop", &RoomLua::set_prop,
                "unset_prop", &RoomLua::unset_prop, "description",
                sol::property(&RoomLua::get_description), "visit_count",
                sol::property(&RoomLua::get_visit_count), "name", sol::property(&RoomLua::get_name),
                "script_before_enter", sol::property(&RoomLua::get_script_before_enter),
                "script_after_enter", sol::property(&RoomLua::get_script_after_enter),
                "script_before_leave", sol::property(&RoomLua::get_script_before_leave),
                "script_after_leave", sol::property(&RoomLua::get_script_after_leave));
            lua.new_usertype<ScriptEntityLua>(
                "ScriptEntity", sol::no_constructor, "id", sol::property(&ScriptEntityLua::get_id),
                "prop", &ScriptEntityLua::prop, "has_prop", &ScriptEntityLua::has_prop, "set_prop",
                &ScriptEntityLua::set_prop, "unset_prop", &ScriptEntityLua::unset_prop, "autorun",
                sol::property(&ScriptEntityLua::get_autorun), "content",
                sol::property(&ScriptEntityLua::get_content));
            reg["__noveltea_types_registered"] = true;
        }
    }

    // Recreate global tables each bind — captures current session pointer
    build_game_table(L, session, nullptr, bridge->dispatcher);
    build_script_table(L);
    build_log_table(L, session);
    build_timer_table(L, session);
    build_save_table(L);

    // Legacy single-function globals
    lua["thisEntity"] = sol::lua_nil;
    register_legacy_entity_functions(L);

    lua.set_function("toast", [session](std::string msg, sol::optional<bool> add_to_log,
                                        sol::optional<double> duration_ms) {
        bool log = add_to_log.value_or(true);
        double dur = duration_ms.value_or(3000.0 + msg.size() * 30.0);
        SDL_Log("[lua] toast(msg='%s', add_to_log=%s, duration=%.0f)", msg.c_str(),
                log ? "true" : "false", dur);
        if (session) {
            session->notify(msg, dur);
            if (log) {
                session->append_log(msg);
            }
        }
    });

    lua.set_function("alert", [](std::string text) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[lua] %s", text.c_str());
    });
}

void bind_runtime_host(lua_State* L, noveltea::core::RuntimeSessionHost* host)
{
    bind_game_session(L, host ? &host->session() : nullptr);
    sol::state_view lua(L);
    auto* bridge = detail::registry_pointer<ScriptBridge>(lua, kBridgeKey);
    if (bridge) {
        bridge->host = host;
    }
    build_game_table(L, host ? &host->session() : nullptr, host,
                     bridge ? bridge->dispatcher : nullptr);
}

void bind_runtime_command_dispatcher(lua_State* L, noveltea::RuntimeCommandDispatcher* dispatcher)
{
    sol::state_view lua(L);
    auto* bridge = detail::registry_pointer<ScriptBridge>(lua, kBridgeKey);
    if (!bridge) {
        bridge = new ScriptBridge();
        lua.registry().set(kBridgeKey, bridge);
    }
    bridge->dispatcher = dispatcher;
    build_game_table(L, bridge->session, bridge->host, dispatcher);
}

// -------------------------------------------------------------------
// clear_game_bindings — remove game globals, keep the state reusable
// -------------------------------------------------------------------
void clear_game_bindings(lua_State* L)
{
    sol::state_view lua(L);
    auto* bridge = detail::registry_pointer<ScriptBridge>(lua, kBridgeKey);
    if (bridge) {
        bridge->session = nullptr;
        bridge->host = nullptr;
        bridge->dispatcher = nullptr;
    }

    lua["Game"] = sol::lua_nil;
    lua["Save"] = sol::lua_nil;
    lua["Script"] = sol::lua_nil;
    lua["Log"] = sol::lua_nil;
    lua["Timer"] = sol::lua_nil;
    lua["thisEntity"] = sol::lua_nil;
    lua["prop"] = sol::lua_nil;
    lua["set_prop"] = sol::lua_nil;
    lua["toast"] = sol::lua_nil;
    lua["alert"] = sol::lua_nil;
}

} // namespace noveltea::script
