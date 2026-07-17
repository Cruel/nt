#include "script/lua/script_runtime_internal.hpp"

#include "noveltea/script/runtime_script_api.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <tuple>
#include <utility>

namespace noveltea::script {
namespace {

using MutationResult = std::tuple<bool, sol::object>;
using ObjectResult = std::tuple<sol::object, sol::object>;

sol::object nil(sol::state_view lua) { return sol::make_object(lua, sol::lua_nil); }

core::Diagnostics invalid(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::string diagnostic_message(const core::Diagnostics& diagnostics)
{
    return diagnostics.empty() ? "typed runtime operation failed" : diagnostics.front().message;
}

MutationResult mutation(sol::state_view lua, const core::Result<void, core::Diagnostics>& result)
{
    return result
               ? MutationResult{true, nil(lua)}
               : MutationResult{false, sol::make_object(lua, diagnostic_message(result.error()))};
}

ObjectResult failure(sol::state_view lua, const core::Diagnostics& diagnostics)
{
    return {nil(lua), sol::make_object(lua, diagnostic_message(diagnostics))};
}

template<class Id> core::Result<Id, core::Diagnostics> parse_id(std::string value)
{
    return Id::create(std::move(value));
}

core::Result<core::compiled::InitialMapMode, core::Diagnostics>
parse_map_mode(const std::string& value)
{
    using Result = core::Result<core::compiled::InitialMapMode, core::Diagnostics>;
    if (value == "minimap")
        return Result::success(core::compiled::InitialMapMode::Minimap);
    if (value == "full-map")
        return Result::success(core::compiled::InitialMapMode::FullMap);
    return Result::failure(
        invalid("runtime.invalid_map_mode", "Map mode must be 'minimap' or 'full-map'"));
}

const char* map_mode_name(core::compiled::InitialMapMode mode) noexcept
{
    return mode == core::compiled::InitialMapMode::Minimap ? "minimap" : "full-map";
}

core::Result<core::compiled::LayoutSlot, core::Diagnostics>
parse_layout_slot(const std::string& value)
{
    using Result = core::Result<core::compiled::LayoutSlot, core::Diagnostics>;
    if (value == "hud")
        return Result::success(core::compiled::LayoutSlot::Hud);
    if (value == "dialogue-box")
        return Result::success(core::compiled::LayoutSlot::DialogueBox);
    if (value == "overlay")
        return Result::success(core::compiled::LayoutSlot::Overlay);
    if (value == "custom")
        return Result::success(core::compiled::LayoutSlot::Custom);
    return Result::failure(invalid("runtime.invalid_layout_slot",
                                   "Layout slot must be 'hud', 'dialogue-box', 'overlay', or "
                                   "'custom'"));
}

core::Result<runtime::RuntimePresentationOwnerScope, core::Diagnostics>
parse_presentation_owner_scope(const std::string& value)
{
    using Result = core::Result<runtime::RuntimePresentationOwnerScope, core::Diagnostics>;
    if (value == "session")
        return Result::success(runtime::RuntimePresentationOwnerScope::Session);
    if (value == "current-room")
        return Result::success(runtime::RuntimePresentationOwnerScope::CurrentRoom);
    if (value == "room")
        return Result::success(runtime::RuntimePresentationOwnerScope::Room);
    return Result::failure(
        invalid("runtime.invalid_presentation_owner_scope",
                "Presentation owner must be 'session', 'current-room', or 'room'"));
}

core::Result<core::PresentationPlane, core::Diagnostics>
parse_environment_plane(const std::string& value)
{
    using Result = core::Result<core::PresentationPlane, core::Diagnostics>;
    if (value == "world-background")
        return Result::success(core::PresentationPlane::WorldBackground);
    if (value == "world-content")
        return Result::success(core::PresentationPlane::WorldContent);
    if (value == "world-overlay")
        return Result::success(core::PresentationPlane::WorldOverlay);
    return Result::failure(invalid(
        "runtime.invalid_environment_plane",
        "Environment plane must be 'world-background', 'world-content', or 'world-overlay'"));
}

core::Result<core::LayoutClockDomain, core::Diagnostics>
parse_presentation_clock(const std::string& value)
{
    using Result = core::Result<core::LayoutClockDomain, core::Diagnostics>;
    if (value == "gameplay")
        return Result::success(core::LayoutClockDomain::Gameplay);
    if (value == "unscaled-presentation")
        return Result::success(core::LayoutClockDomain::UnscaledPresentation);
    return Result::failure(
        invalid("runtime.invalid_presentation_clock",
                "Presentation clock must be 'gameplay' or 'unscaled-presentation'"));
}

struct ParsedPresentationOwnerOptions {
    runtime::RuntimePresentationOwnerScope scope =
        runtime::RuntimePresentationOwnerScope::CurrentRoom;
    std::optional<core::RoomId> room;
};

core::Result<ParsedPresentationOwnerOptions, core::Diagnostics>
parse_presentation_owner_options(const sol::optional<sol::table>& options,
                                 runtime::RuntimePresentationOwnerScope default_scope =
                                     runtime::RuntimePresentationOwnerScope::CurrentRoom)
{
    ParsedPresentationOwnerOptions result;
    result.scope = default_scope;
    if (!options)
        return core::Result<ParsedPresentationOwnerOptions, core::Diagnostics>::success(
            std::move(result));
    const sol::optional<std::string> owner_name = (*options)["owner"];
    const std::string default_owner =
        default_scope == runtime::RuntimePresentationOwnerScope::Session
            ? "session"
            : (default_scope == runtime::RuntimePresentationOwnerScope::Room ? "room"
                                                                             : "current-room");
    auto owner = parse_presentation_owner_scope(owner_name.value_or(default_owner));
    const auto* owner_value = owner.value_if();
    if (!owner_value)
        return core::Result<ParsedPresentationOwnerOptions, core::Diagnostics>::failure(
            owner.error());
    result.scope = *owner_value;
    const sol::optional<std::string> room_name = (*options)["room"];
    if (room_name) {
        auto room = parse_id<core::RoomId>(*room_name);
        auto* room_value = room.value_if();
        if (!room_value)
            return core::Result<ParsedPresentationOwnerOptions, core::Diagnostics>::failure(
                room.error());
        result.room = std::move(*room_value);
    }
    return core::Result<ParsedPresentationOwnerOptions, core::Diagnostics>::success(
        std::move(result));
}

core::Result<core::compiled::AudioChannel, core::Diagnostics>
parse_audio_channel(const std::string& value)
{
    using Result = core::Result<core::compiled::AudioChannel, core::Diagnostics>;
    if (value == "sound-effect")
        return Result::success(core::compiled::AudioChannel::SoundEffect);
    if (value == "music")
        return Result::success(core::compiled::AudioChannel::Music);
    if (value == "voice")
        return Result::success(core::compiled::AudioChannel::Voice);
    if (value == "ambient")
        return Result::success(core::compiled::AudioChannel::Ambient);
    return Result::failure(
        invalid("runtime.invalid_audio_channel",
                "Audio channel must be 'sound-effect', 'music', 'voice', or 'ambient'"));
}

std::chrono::milliseconds option_fade(const sol::optional<sol::table>& options)
{
    if (!options)
        return std::chrono::milliseconds{0};
    const sol::optional<std::int64_t> value = (*options)["fade_ms"];
    return std::chrono::milliseconds{value.value_or(0)};
}

double option_volume(const sol::optional<sol::table>& options)
{
    if (!options)
        return 1.0;
    const sol::optional<double> value = (*options)["volume"];
    return value.value_or(1.0);
}

bool option_loop(const sol::optional<sol::table>& options)
{
    if (!options)
        return false;
    const sol::optional<bool> value = (*options)["loop"];
    return value.value_or(false);
}

std::chrono::milliseconds option_fade_in(const sol::optional<sol::table>& options)
{
    if (!options)
        return std::chrono::milliseconds{0};
    const sol::optional<std::int64_t> specific = (*options)["fade_in_ms"];
    return specific ? std::chrono::milliseconds{*specific} : option_fade(options);
}

std::chrono::milliseconds option_fade_out(const sol::optional<sol::table>& options)
{
    if (!options)
        return std::chrono::milliseconds{0};
    const sol::optional<std::int64_t> specific = (*options)["fade_out_ms"];
    return specific ? std::chrono::milliseconds{*specific} : option_fade(options);
}

std::string audio_channel_name(core::compiled::AudioChannel channel)
{
    switch (channel) {
    case core::compiled::AudioChannel::SoundEffect:
        return "sound-effect";
    case core::compiled::AudioChannel::Music:
        return "music";
    case core::compiled::AudioChannel::Voice:
        return "voice";
    case core::compiled::AudioChannel::Ambient:
        return "ambient";
    }
    return "unknown";
}

core::Result<core::TextLogEntryKind, core::Diagnostics> parse_log_kind(const std::string& value)
{
    using Result = core::Result<core::TextLogEntryKind, core::Diagnostics>;
    if (value == "line")
        return Result::success(core::TextLogEntryKind::Line);
    if (value == "choice")
        return Result::success(core::TextLogEntryKind::Choice);
    if (value == "notification")
        return Result::success(core::TextLogEntryKind::Notification);
    return Result::failure(invalid("runtime.invalid_text_log_kind",
                                   "Text-log kind must be 'line', 'choice', or 'notification'"));
}

core::Result<core::TextMarkup, core::Diagnostics> parse_markup(const std::string& value)
{
    using Result = core::Result<core::TextMarkup, core::Diagnostics>;
    if (value == "plain")
        return Result::success(core::TextMarkup::Plain);
    if (value == "active-text")
        return Result::success(core::TextMarkup::ActiveText);
    return Result::failure(
        invalid("runtime.invalid_text_markup", "Text markup must be 'plain' or 'active-text'"));
}

} // namespace

void bind_runtime_capabilities(lua_State* state, RuntimeScriptApi* api)
{
    sol::state_view lua(state);
    if (api == nullptr) {
        clear_runtime_capabilities(state);
        return;
    }

    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();

    sol::table room_presentation = lua.create_table();
    room_presentation.set_function(
        "set_character_visible",
        [api](std::string character_id, bool visible, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::CharacterId>(std::move(character_id));
            const auto* id = parsed.value_if();
            return id ? mutation(view, api->set_composed_character_visible(*id, visible))
                      : mutation(view, core::Result<void, core::Diagnostics>::failure(
                                           std::move(parsed).error()));
        });
    room_presentation.set_function(
        "set_interactable_visible",
        [api](std::string interactable_id, bool visible, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableId>(std::move(interactable_id));
            const auto* id = parsed.value_if();
            return id ? mutation(view, api->set_composed_interactable_visible(*id, visible))
                      : mutation(view, core::Result<void, core::Diagnostics>::failure(
                                           std::move(parsed).error()));
        });
    noveltea["room_presentation"] = room_presentation;

    sol::table random = lua.create_table();
    random.set_function("seed", [api](std::int64_t seed, sol::this_state state) {
        sol::state_view view(state);
        if (seed < 0)
            return mutation(view, core::Result<void, core::Diagnostics>::failure(
                                      invalid("runtime.invalid_random_seed",
                                              "Random seed must be a non-negative integer")));
        return mutation(view, api->seed_random(static_cast<std::uint64_t>(seed)));
    });
    random.set_function(
        "integer",
        [api](std::int64_t minimum, std::int64_t maximum, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto result = api->random_integer(minimum, maximum);
            const auto* value = result.value_if();
            return value ? ObjectResult{sol::make_object(view, *value), nil(view)}
                         : failure(view, result.error());
        });
    random.set_function("number", [api](sol::this_state state) -> ObjectResult {
        sol::state_view view(state);
        auto result = api->random_unit();
        const auto* value = result.value_if();
        return value ? ObjectResult{sol::make_object(view, *value), nil(view)}
                     : failure(view, result.error());
    });
    noveltea["random"] = random;
    const auto random_wrappers = lua.safe_script(
        "math.random = function(minimum, maximum) "
        "local value, err; "
        "if minimum == nil then value, err = noveltea.random.number() "
        "elseif maximum == nil then value, err = noveltea.random.integer(1, minimum) "
        "else value, err = noveltea.random.integer(minimum, maximum) end; "
        "if value == nil then error(err, 2) end; return value end\n"
        "math.randomseed = function(seed) "
        "local ok, err = noveltea.random.seed(seed); "
        "if not ok then error(err, 2) end end",
        sol::script_pass_on_error);
    (void)random_wrappers;

    sol::table map = lua.create_table();
    map.set_function(
        "present",
        [api](std::string map_id, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto parsed_map = parse_id<core::MapId>(std::move(map_id));
            auto* map_value = parsed_map.value_if();
            if (!map_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(parsed_map.error()));

            std::optional<core::compiled::InitialMapMode> mode;
            bool visible = true;
            std::optional<core::MapLocationId> focus;
            if (options) {
                if (const sol::optional<std::string> value = (*options)["mode"]; value) {
                    auto parsed = parse_map_mode(*value);
                    const auto* parsed_value = parsed.value_if();
                    if (!parsed_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    mode = *parsed_value;
                }
                const sol::optional<bool> visible_value = (*options)["visible"];
                visible = visible_value.value_or(true);
                if (const sol::optional<std::string> value = (*options)["focus"]; value) {
                    auto parsed = parse_id<core::MapLocationId>(*value);
                    auto* parsed_value = parsed.value_if();
                    if (!parsed_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    focus = std::move(*parsed_value);
                }
            }
            return mutation(
                view, api->present_map(std::move(*map_value), mode, visible, std::move(focus)));
        });
    map.set_function("hide", [api](sol::this_state state) {
        return mutation(sol::state_view(state), api->hide_map());
    });
    map.set_function("select", [api](std::string location, sol::this_state state) {
        sol::state_view view(state);
        auto parsed = parse_id<core::MapLocationId>(std::move(location));
        auto* value = parsed.value_if();
        return value
                   ? mutation(view, api->select_map_location(std::move(*value)))
                   : mutation(view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
    });
    map.set_function("activate", [api](std::string connection, sol::this_state state) {
        sol::state_view view(state);
        auto parsed = parse_id<core::MapConnectionId>(std::move(connection));
        auto* value = parsed.value_if();
        return value
                   ? mutation(view, api->activate_map_connection(std::move(*value)))
                   : mutation(view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
    });
    map.set_function("state", [api](sol::this_state state) -> ObjectResult {
        sol::state_view view(state);
        auto result = api->map_state();
        const auto* value = result.value_if();
        if (!value)
            return failure(view, result.error());
        sol::table object = view.create_table();
        object["map"] = value->map.text();
        object["mode"] = map_mode_name(value->mode);
        object["visible"] = value->visible;
        if (value->focused_location)
            object["focused_location"] = value->focused_location->text();
        return {sol::make_object(view, object), nil(view)};
    });
    noveltea["map"] = map;

    sol::table layouts = lua.create_table();
    layouts.set_function(
        "get", [api](std::string slot_name, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto slot = parse_layout_slot(slot_name);
            const auto* slot_value = slot.value_if();
            if (!slot_value)
                return failure(view, slot.error());
            auto result = api->layout(*slot_value);
            const auto* layout = result.value_if();
            if (!layout)
                return failure(view, result.error());
            return {*layout ? sol::make_object(view, (*layout)->text()) : nil(view), nil(view)};
        });
    layouts.set_function(
        "set",
        [api](std::string slot_name, std::string layout_id,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto slot = parse_layout_slot(slot_name);
            auto layout = parse_id<core::LayoutId>(std::move(layout_id));
            const auto* slot_value = slot.value_if();
            auto* layout_value = layout.value_if();
            if (!slot_value)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(slot.error()));
            if (!layout_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(layout.error()));
            return mutation(view, api->set_layout(*slot_value, std::move(*layout_value)));
        });
    layouts.set_function("clear", [api](std::string slot_name, sol::this_state state) {
        sol::state_view view(state);
        auto slot = parse_layout_slot(slot_name);
        const auto* slot_value = slot.value_if();
        return slot_value
                   ? mutation(view, api->clear_layout(*slot_value))
                   : mutation(view, core::Result<void, core::Diagnostics>::failure(slot.error()));
    });
    noveltea["layouts"] = layouts;

    sol::table presentation = lua.create_table();
    presentation.set_function(
        "set_environment",
        [api](std::string instance_name, std::string material_name,
              sol::optional<sol::table> options, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::PresentationEnvironmentInstanceId>(instance_name);
            auto material = parse_id<core::MaterialId>(std::move(material_name));
            auto owner_options = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* material_value = material.value_if();
            auto* owner_value = owner_options.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!material_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(material.error()));
            if (!owner_value)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(owner_options.error()));

            const std::string stop_key_name =
                options ? sol::optional<std::string>((*options)["stop_key"]).value_or(instance_name)
                        : instance_name;
            auto stop_key = parse_id<core::PresentationEnvironmentStopKey>(stop_key_name);
            auto* stop_key_value = stop_key.value_if();
            if (!stop_key_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(stop_key.error()));

            const std::string plane_name =
                options ? sol::optional<std::string>((*options)["plane"]).value_or("world-content")
                        : "world-content";
            const std::string clock_name =
                options ? sol::optional<std::string>((*options)["clock"]).value_or("gameplay")
                        : "gameplay";
            auto plane = parse_environment_plane(plane_name);
            auto clock = parse_presentation_clock(clock_name);
            const auto* plane_value = plane.value_if();
            const auto* clock_value = clock.value_if();
            if (!plane_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(plane.error()));
            if (!clock_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(clock.error()));

            std::optional<core::AssetId> asset;
            if (options) {
                const sol::optional<std::string> asset_name = (*options)["asset"];
                if (asset_name) {
                    auto parsed = parse_id<core::AssetId>(*asset_name);
                    auto* parsed_value = parsed.value_if();
                    if (!parsed_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    asset = std::move(*parsed_value);
                }
            }

            const auto number = [&options](const char* key, double fallback) {
                return options ? sol::optional<double>((*options)[key]).value_or(fallback)
                               : fallback;
            };
            const auto integer = [&options](const char* key, std::int32_t fallback) {
                return options ? sol::optional<std::int32_t>((*options)[key]).value_or(fallback)
                               : fallback;
            };
            const auto boolean = [&options](const char* key, bool fallback) {
                return options ? sol::optional<bool>((*options)[key]).value_or(fallback) : fallback;
            };

            EnvironmentLoopCommandOptions command_options{
                owner_value->scope,
                std::move(owner_value->room),
                std::move(asset),
                std::move(*stop_key_value),
                {number("x", 0.0), number("y", 0.0), number("width", 1.0), number("height", 1.0)},
                *plane_value,
                integer("order", 0),
                *clock_value,
                {number("scroll_x", 0.0), number("scroll_y", 0.0)},
                number("opacity", 1.0),
                boolean("visible", true)};
            return mutation(view, api->set_environment(std::move(*instance_value),
                                                       std::move(*material_value),
                                                       std::move(command_options)));
        });
    presentation.set_function(
        "clear_environment",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance =
                parse_id<core::PresentationEnvironmentInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(view,
                            api->clear_environment(std::move(*instance_value), owner_value->scope,
                                                   std::move(owner_value->room)));
        });
    presentation.set_function(
        "stop_environments",
        [api](std::string stop_key_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto stop_key =
                parse_id<core::PresentationEnvironmentStopKey>(std::move(stop_key_name));
            auto owner = parse_presentation_owner_options(options);
            auto* stop_key_value = stop_key.value_if();
            auto* owner_value = owner.value_if();
            if (!stop_key_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(stop_key.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(view,
                            api->stop_environments(std::move(*stop_key_value), owner_value->scope,
                                                   std::move(owner_value->room)));
        });
    noveltea["presentation"] = presentation;

    sol::table audio = lua.create_table();
    audio.set_function(
        "_play",
        [api](std::string asset_id, std::string channel_name, sol::optional<sol::table> options,
              bool await_completion, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto asset = parse_id<core::AssetId>(std::move(asset_id));
            auto channel = parse_audio_channel(channel_name);
            auto* asset_value = asset.value_if();
            const auto* channel_value = channel.value_if();
            if (!asset_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(asset.error()));
            if (!channel_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(channel.error()));
            const auto fade = option_fade(options);
            const auto action = fade.count() == 0 ? core::compiled::AudioAction::Play
                                                  : core::compiled::AudioAction::FadeIn;
            return mutation(view,
                            api->request_audio(action, *channel_value, std::move(*asset_value),
                                               fade, option_loop(options), option_volume(options),
                                               await_completion));
        });
    audio.set_function(
        "play_ui",
        [api](std::string asset_id, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto asset = parse_id<core::AssetId>(std::move(asset_id));
            auto* asset_value = asset.value_if();
            if (!asset_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(asset.error()));
            return mutation(view, api->request_audio(core::compiled::AudioAction::Play,
                                                     core::compiled::AudioChannel::SoundEffect,
                                                     std::move(*asset_value),
                                                     std::chrono::milliseconds{0}, false,
                                                     option_volume(options), false,
                                                     core::AudioOperationPurpose::UiCosmetic));
        });
    audio.set_function(
        "_stop",
        [api](std::string channel_name, sol::optional<sol::table> options, bool await_completion,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto channel = parse_audio_channel(channel_name);
            const auto* channel_value = channel.value_if();
            if (!channel_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(channel.error()));
            const auto fade = option_fade(options);
            const auto action = fade.count() == 0 ? core::compiled::AudioAction::Stop
                                                  : core::compiled::AudioAction::FadeOut;
            return mutation(view,
                            api->request_audio(action, *channel_value, std::nullopt, fade, false,
                                               option_volume(options), await_completion));
        });
    audio.set_function(
        "set_loop",
        [api](std::string instance_name, std::string asset_name, std::string bus_name,
              sol::optional<sol::table> options, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::DesiredAudioInstanceId>(std::move(instance_name));
            auto asset = parse_id<core::AssetId>(std::move(asset_name));
            auto bus = parse_audio_channel(bus_name);
            auto owner = parse_presentation_owner_options(
                options, runtime::RuntimePresentationOwnerScope::Session);
            auto* instance_value = instance.value_if();
            auto* asset_value = asset.value_if();
            const auto* bus_value = bus.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!asset_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(asset.error()));
            if (!bus_value)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(bus.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            DesiredAudioCommandOptions command_options;
            command_options.owner_scope = owner_value->scope;
            command_options.room = std::move(owner_value->room);
            command_options.volume = option_volume(options);
            command_options.fade_in = option_fade_in(options);
            command_options.fade_out = option_fade_out(options);
            if (options) {
                const sol::optional<std::string> replacement_name = (*options)["replacement_key"];
                if (replacement_name) {
                    auto replacement =
                        parse_id<core::DesiredAudioReplacementKey>(*replacement_name);
                    auto* replacement_value = replacement.value_if();
                    if (!replacement_value)
                        return mutation(view, core::Result<void, core::Diagnostics>::failure(
                                                  replacement.error()));
                    command_options.replacement_key = std::move(*replacement_value);
                }
            }
            return mutation(view, api->set_desired_audio(std::move(*instance_value), *bus_value,
                                                         std::move(*asset_value),
                                                         std::move(command_options)));
        });
    audio.set_function(
        "set_music",
        [api](std::string asset_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = core::DesiredAudioInstanceId::create("background-music");
            auto replacement = core::DesiredAudioReplacementKey::create("background-music");
            auto asset = parse_id<core::AssetId>(std::move(asset_name));
            auto owner = parse_presentation_owner_options(
                options, runtime::RuntimePresentationOwnerScope::Session);
            auto* asset_value = asset.value_if();
            auto* owner_value = owner.value_if();
            if (!asset_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(asset.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            DesiredAudioCommandOptions command_options;
            command_options.owner_scope = owner_value->scope;
            command_options.room = std::move(owner_value->room);
            command_options.volume = option_volume(options);
            command_options.fade_in = option_fade_in(options);
            command_options.fade_out = option_fade_out(options);
            command_options.replacement_key = *replacement.value_if();
            return mutation(view, api->set_desired_audio(
                                      *instance.value_if(), core::compiled::AudioChannel::Music,
                                      std::move(*asset_value), std::move(command_options)));
        });
    audio.set_function(
        "clear_loop",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::DesiredAudioInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(
                options, runtime::RuntimePresentationOwnerScope::Session);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(view,
                            api->clear_desired_audio(std::move(*instance_value), owner_value->scope,
                                                     std::move(owner_value->room)));
        });
    audio.set_function(
        "clear_bus",
        [api](std::string bus_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto bus = parse_audio_channel(bus_name);
            auto owner = parse_presentation_owner_options(
                options, runtime::RuntimePresentationOwnerScope::Session);
            const auto* bus_value = bus.value_if();
            auto* owner_value = owner.value_if();
            if (!bus_value)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(bus.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(view, api->clear_desired_audio_bus(*bus_value, owner_value->scope,
                                                               std::move(owner_value->room)));
        });
    audio.set_function("state",
                       [api](std::string instance_name, sol::optional<sol::table> options,
                             sol::this_state state) -> ObjectResult {
                           sol::state_view view(state);
                           auto instance =
                               parse_id<core::DesiredAudioInstanceId>(std::move(instance_name));
                           auto owner = parse_presentation_owner_options(
                               options, runtime::RuntimePresentationOwnerScope::Session);
                           auto* instance_value = instance.value_if();
                           auto* owner_value = owner.value_if();
                           if (!instance_value)
                               return failure(view, instance.error());
                           if (!owner_value)
                               return failure(view, owner.error());
                           auto result =
                               api->desired_audio(std::move(*instance_value), owner_value->scope,
                                                  std::move(owner_value->room));
                           const auto* value = result.value_if();
                           if (!value)
                               return failure(view, result.error());
                           if (!*value)
                               return {nil(view), nil(view)};
                           sol::table object = view.create_table();
                           object["asset"] = (*value)->asset.text();
                           object["bus"] = audio_channel_name((*value)->bus);
                           object["volume"] = (*value)->volume;
                           object["fade_in_ms"] = (*value)->fade_in.count();
                           object["fade_out_ms"] = (*value)->fade_out.count();
                           if ((*value)->replacement_key)
                               object["replacement_key"] = (*value)->replacement_key->text();
                           return {sol::make_object(view, object), nil(view)};
                       });
    lua["audio"] = audio;
    const auto wrappers = lua.safe_script(
        "audio.play = function(asset, channel, options) "
        "return audio._play(asset, channel, options, false) end\n"
        "audio.stop = function(channel, options) "
        "return audio._stop(channel, options, false) end\n"
        "audio.play_and_wait = function(asset, channel, options) "
        "local ok, err = audio._play(asset, channel, options, true); "
        "if not ok then return false, err end; coroutine.yield(); return true, nil end\n"
        "audio.stop_and_wait = function(channel, options) "
        "local ok, err = audio._stop(channel, options, true); "
        "if not ok then return false, err end; coroutine.yield(); return true, nil end",
        sol::script_pass_on_error);
    (void)wrappers;

    sol::table text_log = lua.create_table();
    text_log.set_function(
        "append",
        [api](std::string kind_name, std::string origin_name, std::string text,
              sol::optional<std::string> markup_name, sol::optional<std::string> speaker_name,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto kind = parse_log_kind(kind_name);
            auto markup = parse_markup(markup_name.value_or("plain"));
            const auto* kind_value = kind.value_if();
            const auto* markup_value = markup.value_if();
            if (!kind_value)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(kind.error()));
            if (origin_name != "system")
                return mutation(view, core::Result<void, core::Diagnostics>::failure(invalid(
                                          "runtime.invalid_text_log_origin",
                                          "Direct Lua text-log entries require origin 'system'")));
            if (!markup_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(markup.error()));
            std::optional<core::CharacterId> speaker;
            if (speaker_name) {
                auto parsed = parse_id<core::CharacterId>(*speaker_name);
                auto* parsed_value = parsed.value_if();
                if (!parsed_value)
                    return mutation(view,
                                    core::Result<void, core::Diagnostics>::failure(parsed.error()));
                speaker = std::move(*parsed_value);
            }
            return mutation(view, api->append_text_log(core::TextLogEntry{
                                      *kind_value, core::SystemTextLogOrigin{}, std::move(speaker),
                                      std::move(text), *markup_value}));
        });
    text_log.set_function("clear", [api](sol::this_state state) {
        return mutation(sol::state_view(state), api->clear_text_log());
    });
    noveltea["text_log"] = text_log;

    sol::table game = lua["Game"].get_or_create<sol::table>();
    game.set_function("pause", [api](sol::this_state state) {
        return mutation(sol::state_view(state), api->set_gameplay_paused(true));
    });
    game.set_function("resume", [api](sol::this_state state) {
        return mutation(sol::state_view(state), api->set_gameplay_paused(false));
    });
    game.set_function("paused", [api](sol::this_state state) -> ObjectResult {
        sol::state_view view(state);
        auto result = api->gameplay_paused();
        const auto* value = result.value_if();
        return value ? ObjectResult{sol::make_object(view, *value), nil(view)}
                     : failure(view, result.error());
    });
}

void clear_runtime_capabilities(lua_State* state)
{
    sol::state_view lua(state);
    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();
    noveltea["random"] = sol::lua_nil;
    noveltea["map"] = sol::lua_nil;
    noveltea["layouts"] = sol::lua_nil;
    noveltea["presentation"] = sol::lua_nil;
    noveltea["text_log"] = sol::lua_nil;
    lua["audio"] = sol::lua_nil;
    sol::table math = lua["math"].get_or_create<sol::table>();
    math["random"] = sol::lua_nil;
    math["randomseed"] = sol::lua_nil;
    sol::table game = lua["Game"].get_or_create<sol::table>();
    game["pause"] = sol::lua_nil;
    game["resume"] = sol::lua_nil;
    game["paused"] = sol::lua_nil;
}

} // namespace noveltea::script
