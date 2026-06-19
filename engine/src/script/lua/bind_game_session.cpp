#include "script/lua/script_runtime_internal.hpp"

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/project_model.hpp>

#include <SDL3/SDL_log.h>

#include <lua.hpp>
#include <sol/sol.hpp>

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
    std::mt19937_64 rng;
    std::uniform_real_distribution<double> dist; // [0, 1)
};

constexpr const char kBridgeKey[] = "__noveltea_script_bridge";

ScriptBridge* get_bridge(lua_State* L)
{
    sol::state_view lua(L);
    return lua.registry().get<ScriptBridge*>(kBridgeKey);
}

core::GameSession* get_session(lua_State* L)
{
    auto* bridge = get_bridge(L);
    return bridge ? bridge->session : nullptr;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
sol::object entity_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                        const std::string& key, sol::optional<sol::object> default_value,
                        sol::this_state L)
{
    if (!session || !session->project())
        return default_value.value_or(sol::lua_nil);
    const auto merged = session->project()->merged_properties(type, id);
    if (merged.contains(key)) {
        const auto& val = merged[key];
        sol::state_view lua(L);
        if (val.is_string())
            return sol::make_object(lua, val.get<std::string>());
        if (val.is_number()) {
            double d = val.get<double>();
            if (d == static_cast<double>(static_cast<std::int64_t>(d))) {
                return sol::make_object(lua, static_cast<std::int64_t>(d));
            }
            return sol::make_object(lua, d);
        }
        if (val.is_boolean())
            return sol::make_object(lua, val.get<bool>());
        return sol::make_object(lua, val.dump());
    }
    return default_value.value_or(sol::lua_nil);
}

bool entity_has_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                     const std::string& key)
{
    if (!session || !session->project())
        return false;
    const auto merged = session->project()->merged_properties(type, id);
    return merged.contains(key);
}

void entity_set_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                     const std::string& key, const sol::object& value)
{
    SDL_Log("[lua] set_prop(%s/%s, %s) — stub (no save mutation)",
            core::entity_type_collection_key(type).value_or("?").data(), id.c_str(), key.c_str());
}

void entity_unset_prop(core::GameSession* session, core::EntityType type, const std::string& id,
                       const std::string& key)
{
    SDL_Log("[lua] unset_prop(%s/%s, %s) — stub",
            core::entity_type_collection_key(type).value_or("?").data(), id.c_str(), key.c_str());
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
        // Check save properties first, then fall back to project default properties
        if (session && session->save()) {
            const auto& root = session->save()->root();
            const auto& props = root[std::string(core::project_ids::properties)];
            if (props.contains(key)) {
                const auto& val = props[key];
                sol::state_view lua(L);
                if (val.is_string())
                    return sol::make_object(lua, val.get<std::string>());
                if (val.is_number()) {
                    double d = val.get<double>();
                    if (d == static_cast<double>(static_cast<std::int64_t>(d))) {
                        return sol::make_object(lua, static_cast<std::int64_t>(d));
                    }
                    return sol::make_object(lua, d);
                }
                if (val.is_boolean())
                    return sol::make_object(lua, val.get<bool>());
                return sol::make_object(lua, val.dump());
            }
        }
        // Fall back to project default properties
        if (session && session->project()) {
            const auto& doc = session->project()->document_root();
            if (doc.contains(std::string(core::project_ids::properties))) {
                const auto& props = doc[std::string(core::project_ids::properties)];
                if (props.contains(key)) {
                    const auto& val = props[key];
                    sol::state_view lua(L);
                    if (val.is_string())
                        return sol::make_object(lua, val.get<std::string>());
                    if (val.is_number()) {
                        double d = val.get<double>();
                        if (d == static_cast<double>(static_cast<std::int64_t>(d))) {
                            return sol::make_object(lua, static_cast<std::int64_t>(d));
                        }
                        return sol::make_object(lua, d);
                    }
                    if (val.is_boolean())
                        return sol::make_object(lua, val.get<bool>());
                    return sol::make_object(lua, val.dump());
                }
            }
        }
        return default_value.value_or(sol::lua_nil);
    }

    void set_prop(const std::string& key, sol::object value) const
    {
        SDL_Log("[lua] Game.set_prop(%s) — stub", key.c_str());
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

    void save(sol::optional<int>) const { SDL_Log("[lua] Game.save — stub"); }
    void load(sol::optional<int>) const { SDL_Log("[lua] Game.load — stub"); }
    void autosave() const { SDL_Log("[lua] Game.autosave — stub"); }
    void quit() const { SDL_Log("[lua] Game.quit — stub"); }
    void save_entity(sol::object) const { SDL_Log("[lua] Game.save_entity — stub"); }
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
                    auto type = eval_result.get_type();
                    if (type == sol::type::string) {
                        result += eval_result.get<std::string>();
                    } else if (type == sol::type::number) {
                        double d = eval_result.get<double>();
                        if (d == static_cast<double>(static_cast<std::int64_t>(d))) {
                            result += std::to_string(static_cast<std::int64_t>(d));
                        } else {
                            result += std::to_string(d);
                        }
                    } else if (type == sol::type::boolean) {
                        result += eval_result.get<bool>() ? "true" : "false";
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

    void get_text_input(std::string msg, sol::function callback)
    {
        SDL_Log("[lua] Script.get_text_input(%s) — stub", msg.c_str());
        if (callback.valid()) {
            callback("");
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
            session->events().push(
                core::RuntimeEvent{core::RuntimeEventType::TextLogged, 0, 0.0, std::move(text)});
        }
    }
};

// -------------------------------------------------------------------
// TimerBinding — exposed as "Timer" usertype
// -------------------------------------------------------------------
struct TimerBinding {
    lua_State* L = nullptr;
    core::GameSession* session = nullptr;

    sol::object start(double duration_ms, sol::function callback)
    {
        if (!session)
            return sol::lua_nil;
        auto handle = session->timers().start(
            duration_ms / 1000.0,
            [callback = std::make_shared<sol::function>(callback)](core::RuntimeTimerId id) {
                if (callback->valid()) {
                    (*callback)(static_cast<std::int64_t>(id));
                }
            });
        return sol::make_object(L, static_cast<std::int64_t>(handle.id));
    }

    sol::object start_repeat(double duration_ms, sol::function callback)
    {
        if (!session)
            return sol::lua_nil;
        auto handle = session->timers().start_repeat(
            duration_ms / 1000.0,
            [callback = std::make_shared<sol::function>(callback)](core::RuntimeTimerId id) {
                if (callback->valid()) {
                    (*callback)(static_cast<std::int64_t>(id));
                }
            });
        return sol::make_object(L, static_cast<std::int64_t>(handle.id));
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
void build_game_table(lua_State* L, core::GameSession* session)
{
    sol::state_view lua(L);
    GameBinding binding{session};
    sol::table game = lua.create_table();

    game.set_function("push_next", [binding](int type, std::string id) mutable {
        binding.push_next(type, std::move(id));
    });
    game.set_function("prop",
                      [binding](std::string key, sol::optional<sol::object> def,
                                sol::this_state L_) mutable { return binding.prop(key, def, L_); });
    game.set_function("set_prop", [binding](std::string key, sol::object value) mutable {
        binding.set_prop(key, value);
    });
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
    script.set_function("get_text_input", [sb](std::string msg, sol::function cb) mutable {
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
            session->events().push(
                core::RuntimeEvent{core::RuntimeEventType::TextLogged, 0, 0.0, std::move(text)});
        }
    });
    lua["Log"] = log;
}

void build_timer_table(lua_State* L, core::GameSession* session)
{
    sol::state_view lua(L);
    sol::table timer = lua.create_table();
    timer.set_function(
        "start", [session, L](double duration_ms, sol::function callback) -> sol::object {
            if (!session)
                return sol::lua_nil;
            auto handle = session->timers().start(
                duration_ms / 1000.0, [callback = std::make_shared<sol::function>(
                                           std::move(callback))](core::RuntimeTimerId id) {
                    if (callback->valid()) {
                        (*callback)(static_cast<std::int64_t>(id));
                    }
                });
            return sol::make_object(L, static_cast<std::int64_t>(handle.id));
        });
    timer.set_function(
        "start_repeat", [session, L](double duration_ms, sol::function callback) -> sol::object {
            if (!session)
                return sol::lua_nil;
            auto handle = session->timers().start_repeat(
                duration_ms / 1000.0, [callback = std::make_shared<sol::function>(
                                           std::move(callback))](core::RuntimeTimerId id) {
                    if (callback->valid()) {
                        (*callback)(static_cast<std::int64_t>(id));
                    }
                });
            return sol::make_object(L, static_cast<std::int64_t>(handle.id));
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
                             auto result = entity["prop"](entity, key, default_value);
                             if (result.valid())
                                 return result;
                         }
                         return default_value.value_or(sol::lua_nil);
                     });

    lua.set_function("set_prop", [lua](std::string key, sol::object value) {
        auto entity = lua["thisEntity"];
        if (!entity.valid() || entity == sol::lua_nil)
            return;
        if (entity.get_type() == sol::type::userdata) {
            entity["set_prop"](entity, key, value);
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
    auto* bridge = lua.registry().get<ScriptBridge*>(kBridgeKey);
    if (!bridge) {
        bridge = new ScriptBridge();
        lua.registry().set(kBridgeKey, bridge);
    }
    bridge->session = session;

    // Register entity usertypes once (harmless to do multiple times but avoid it)
    {
        auto reg = lua.registry();
        if (!reg["__noveltea_types_registered"].valid() ||
            !reg["__noveltea_types_registered"].get<bool>()) {
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
    build_game_table(L, session);
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
            session->events().push(
                core::RuntimeEvent{core::RuntimeEventType::Notification, 0, dur, msg});
            if (log) {
                session->events().push(
                    core::RuntimeEvent{core::RuntimeEventType::TextLogged, 0, 0.0, msg});
            }
        }
    });

    lua.set_function("alert", [](std::string text) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[lua] %s", text.c_str());
    });
}

// -------------------------------------------------------------------
// clear_game_bindings — remove game globals, keep the state reusable
// -------------------------------------------------------------------
void clear_game_bindings(lua_State* L)
{
    sol::state_view lua(L);
    auto* bridge = lua.registry().get<ScriptBridge*>(kBridgeKey);
    if (bridge) {
        bridge->session = nullptr;
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
