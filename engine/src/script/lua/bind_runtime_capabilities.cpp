#include "script/lua/script_runtime_internal.hpp"

#include "noveltea/script/runtime_script_api.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>

namespace noveltea::script {
namespace {

using MutationResult = std::tuple<bool, sol::object>;
using ObjectResult = std::tuple<sol::object, sol::object>;

sol::object nil(sol::state_view lua) { return sol::make_object(lua, sol::lua_nil); }

template<class T> sol::optional<T> table_option(const sol::table& table, std::string_view key)
{
    return table.raw_get<sol::optional<T>>(std::string{key});
}

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
    if (value == "scene")
        return Result::success(runtime::RuntimePresentationOwnerScope::Scene);
    if (value == "session")
        return Result::success(runtime::RuntimePresentationOwnerScope::Session);
    if (value == "current-room")
        return Result::success(runtime::RuntimePresentationOwnerScope::CurrentRoom);
    if (value == "room")
        return Result::success(runtime::RuntimePresentationOwnerScope::Room);
    return Result::failure(
        invalid("runtime.invalid_presentation_owner_scope",
                "Presentation owner must be 'scene', 'session', 'current-room', or 'room'"));
}

core::Result<core::PresentationPlane, core::Diagnostics>
parse_layout_plane(const std::string& value)
{
    using Result = core::Result<core::PresentationPlane, core::Diagnostics>;
    if (value == "world-background")
        return Result::success(core::PresentationPlane::WorldBackground);
    if (value == "world-content")
        return Result::success(core::PresentationPlane::WorldContent);
    if (value == "world-overlay")
        return Result::success(core::PresentationPlane::WorldOverlay);
    if (value == "game-ui")
        return Result::success(core::PresentationPlane::GameUi);
    if (value == "menu-overlay")
        return Result::success(core::PresentationPlane::MenuOverlay);
    if (value == "modal")
        return Result::success(core::PresentationPlane::Modal);
    if (value == "transition")
        return Result::success(core::PresentationPlane::Transition);
    if (value == "debug")
        return Result::success(core::PresentationPlane::Debug);
    return Result::failure(invalid(
        "runtime.invalid_layout_plane",
        "Layout plane must be 'world-background', 'world-content', 'world-overlay', 'game-ui', "
        "'menu-overlay', 'modal', 'transition', or 'debug'"));
}

core::Result<core::LayoutInputMode, core::Diagnostics> parse_layout_input(const std::string& value)
{
    using Result = core::Result<core::LayoutInputMode, core::Diagnostics>;
    if (value == "none")
        return Result::success(core::LayoutInputMode::None);
    if (value == "normal")
        return Result::success(core::LayoutInputMode::Normal);
    if (value == "block-gameplay")
        return Result::success(core::LayoutInputMode::BlockGameplay);
    if (value == "modal")
        return Result::success(core::LayoutInputMode::Modal);
    return Result::failure(
        invalid("runtime.invalid_layout_input",
                "Layout input must be 'none', 'normal', 'block-gameplay', or 'modal'"));
}

core::Result<core::GameplayPausePolicy, core::Diagnostics>
parse_layout_pause(const std::string& value)
{
    using Result = core::Result<core::GameplayPausePolicy, core::Diagnostics>;
    if (value == "continue")
        return Result::success(core::GameplayPausePolicy::Continue);
    if (value == "pause-while-visible")
        return Result::success(core::GameplayPausePolicy::PauseWhileVisible);
    return Result::failure(
        invalid("runtime.invalid_layout_pause",
                "Layout pause policy must be 'continue' or 'pause-while-visible'"));
}

core::Result<core::LayoutScaleInheritance, core::Diagnostics>
parse_layout_scale_inheritance(const std::string& value, std::string_view option)
{
    using Result = core::Result<core::LayoutScaleInheritance, core::Diagnostics>;
    if (value == "inherit")
        return Result::success(core::LayoutScaleInheritance::Inherit);
    if (value == "ignore")
        return Result::success(core::LayoutScaleInheritance::Ignore);
    return Result::failure(
        invalid("runtime.invalid_layout_scale_inheritance",
                "Layout " + std::string(option) + " must be 'inherit' or 'ignore'"));
}

core::Result<core::PresentationCompositionGroup, core::Diagnostics>
parse_layout_composition(const std::string& value)
{
    using Result = core::Result<core::PresentationCompositionGroup, core::Diagnostics>;
    if (value == "world")
        return Result::success(core::PresentationCompositionGroup::World);
    if (value == "interface")
        return Result::success(core::PresentationCompositionGroup::Interface);
    if (value == "debug")
        return Result::success(core::PresentationCompositionGroup::Debug);
    return Result::failure(
        invalid("runtime.invalid_layout_composition",
                "Gameplay Layout composition must be 'world', 'interface', or 'debug'"));
}

core::Result<core::compiled::BackgroundFit, core::Diagnostics>
parse_background_fit(const std::string& value)
{
    using Result = core::Result<core::compiled::BackgroundFit, core::Diagnostics>;
    if (value == "cover")
        return Result::success(core::compiled::BackgroundFit::Cover);
    if (value == "contain")
        return Result::success(core::compiled::BackgroundFit::Contain);
    if (value == "stretch")
        return Result::success(core::compiled::BackgroundFit::Stretch);
    if (value == "center")
        return Result::success(core::compiled::BackgroundFit::Center);
    return Result::failure(
        invalid("runtime.invalid_background_fit",
                "Background fit must be 'cover', 'contain', 'stretch', or 'center'"));
}

core::Result<core::compiled::ActorPosition, core::Diagnostics>
parse_actor_position(const std::string& value)
{
    using Result = core::Result<core::compiled::ActorPosition, core::Diagnostics>;
    if (value == "left")
        return Result::success(core::compiled::ActorPosition::Left);
    if (value == "center")
        return Result::success(core::compiled::ActorPosition::Center);
    if (value == "right")
        return Result::success(core::compiled::ActorPosition::Right);
    if (value == "custom")
        return Result::success(core::compiled::ActorPosition::Custom);
    return Result::failure(
        invalid("runtime.invalid_actor_position",
                "Actor position must be 'left', 'center', 'right', or 'custom'"));
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

const char* layout_plane_name(core::PresentationPlane value) noexcept
{
    switch (value) {
    case core::PresentationPlane::WorldBackground:
        return "world-background";
    case core::PresentationPlane::WorldContent:
        return "world-content";
    case core::PresentationPlane::WorldOverlay:
        return "world-overlay";
    case core::PresentationPlane::GameUi:
        return "game-ui";
    case core::PresentationPlane::MenuOverlay:
        return "menu-overlay";
    case core::PresentationPlane::Modal:
        return "modal";
    case core::PresentationPlane::Transition:
        return "transition";
    case core::PresentationPlane::Debug:
        return "debug";
    }
    return "invalid";
}

const char* layout_clock_name(core::LayoutClockDomain value) noexcept
{
    return value == core::LayoutClockDomain::Gameplay ? "gameplay" : "unscaled-presentation";
}

const char* layout_input_name(core::LayoutInputMode value) noexcept
{
    switch (value) {
    case core::LayoutInputMode::None:
        return "none";
    case core::LayoutInputMode::Normal:
        return "normal";
    case core::LayoutInputMode::BlockGameplay:
        return "block-gameplay";
    case core::LayoutInputMode::Modal:
        return "modal";
    }
    return "invalid";
}

const char* layout_pause_name(core::GameplayPausePolicy value) noexcept
{
    return value == core::GameplayPausePolicy::Continue ? "continue" : "pause-while-visible";
}

const char* layout_scale_inheritance_name(core::LayoutScaleInheritance value) noexcept
{
    return value == core::LayoutScaleInheritance::Inherit ? "inherit" : "ignore";
}

const char* layout_composition_name(core::PresentationCompositionGroup value) noexcept
{
    switch (value) {
    case core::PresentationCompositionGroup::World:
        return "world";
    case core::PresentationCompositionGroup::Interface:
        return "interface";
    case core::PresentationCompositionGroup::Shell:
        return "shell";
    case core::PresentationCompositionGroup::Debug:
        return "debug";
    }
    return "invalid";
}

core::Result<std::optional<LayoutTransitionCommandOptions>, core::Diagnostics>
parse_layout_transition(const sol::optional<sol::table>& options)
{
    using Result = core::Result<std::optional<LayoutTransitionCommandOptions>, core::Diagnostics>;
    if (!options)
        return Result::success(std::nullopt);

    const auto transition = table_option<std::string>(*options, "transition");
    const auto duration = table_option<std::int64_t>(*options, "duration_ms");
    const auto skippable = table_option<bool>(*options, "skippable");
    if (!transition) {
        if (duration || skippable)
            return Result::failure(
                invalid("runtime.invalid_layout_transition",
                        "Layout duration_ms and skippable require transition='fade'"));
        return Result::success(std::nullopt);
    }
    if (*transition == "immediate") {
        if (duration && *duration != 0)
            return Result::failure(
                invalid("runtime.invalid_layout_transition",
                        "Immediate Layout transitions cannot declare a nonzero duration_ms"));
        return Result::success(std::nullopt);
    }
    if (*transition != "fade")
        return Result::failure(invalid("runtime.invalid_layout_transition",
                                       "Layout transition must be 'immediate' or 'fade'"));
    if (!duration || *duration <= 0)
        return Result::failure(
            invalid("runtime.invalid_layout_transition",
                    "Layout fade transitions require duration_ms greater than zero"));
    return Result::success(LayoutTransitionCommandOptions{std::chrono::milliseconds{*duration},
                                                          skippable.value_or(true)});
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
    const auto owner_name = table_option<std::string>(*options, "owner");
    const std::string default_owner =
        default_scope == runtime::RuntimePresentationOwnerScope::Scene ? "scene"
        : default_scope == runtime::RuntimePresentationOwnerScope::Session
            ? "session"
            : (default_scope == runtime::RuntimePresentationOwnerScope::Room ? "room"
                                                                             : "current-room");
    auto owner = parse_presentation_owner_scope(owner_name.value_or(default_owner));
    const auto* owner_value = owner.value_if();
    if (!owner_value)
        return core::Result<ParsedPresentationOwnerOptions, core::Diagnostics>::failure(
            owner.error());
    result.scope = *owner_value;
    const auto room_name = table_option<std::string>(*options, "room");
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
    const auto value = table_option<std::int64_t>(*options, "fade_ms");
    return std::chrono::milliseconds{value.value_or(0)};
}

double option_volume(const sol::optional<sol::table>& options)
{
    if (!options)
        return 1.0;
    const auto value = table_option<double>(*options, "volume");
    return value.value_or(1.0);
}

bool option_loop(const sol::optional<sol::table>& options)
{
    if (!options)
        return false;
    const auto value = table_option<bool>(*options, "loop");
    return value.value_or(false);
}

std::chrono::milliseconds option_fade_in(const sol::optional<sol::table>& options)
{
    if (!options)
        return std::chrono::milliseconds{0};
    const auto specific = table_option<std::int64_t>(*options, "fade_in_ms");
    return specific ? std::chrono::milliseconds{*specific} : option_fade(options);
}

std::chrono::milliseconds option_fade_out(const sol::optional<sol::table>& options)
{
    if (!options)
        return std::chrono::milliseconds{0};
    const auto specific = table_option<std::int64_t>(*options, "fade_out_ms");
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
                if (const auto value = table_option<std::string>(*options, "mode"); value) {
                    auto parsed = parse_map_mode(*value);
                    const auto* parsed_value = parsed.value_if();
                    if (!parsed_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    mode = *parsed_value;
                }
                const auto visible_value = table_option<bool>(*options, "visible");
                visible = visible_value.value_or(true);
                if (const auto value = table_option<std::string>(*options, "focus"); value) {
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
    layouts.set_function(
        "mount",
        [api](std::string instance_name, std::string layout_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::ScopedLayoutInstanceId>(std::move(instance_name));
            auto layout = parse_id<core::LayoutId>(std::move(layout_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* layout_value = layout.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!layout_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(layout.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));

            const auto option_string = [&options](const char* key, const char* fallback) {
                return options ? table_option<std::string>(*options, key).value_or(fallback)
                               : std::string(fallback);
            };
            auto plane = parse_layout_plane(option_string("plane", "game-ui"));
            auto clock = parse_presentation_clock(option_string("clock", "gameplay"));
            auto input = parse_layout_input(option_string("input", "normal"));
            auto pause = parse_layout_pause(option_string("pause", "continue"));
            auto composition = parse_layout_composition(option_string("composition", "interface"));
            auto entrance = parse_layout_transition(options);
            std::optional<core::LayoutScaleInheritance> ui_scale;
            std::optional<core::LayoutScaleInheritance> text_scale;
            if (options) {
                if (const auto value = table_option<std::string>(*options, "ui_scale")) {
                    auto parsed = parse_layout_scale_inheritance(*value, "ui_scale");
                    if (!parsed)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    ui_scale = *parsed.value_if();
                }
                if (const auto value = table_option<std::string>(*options, "text_scale")) {
                    auto parsed = parse_layout_scale_inheritance(*value, "text_scale");
                    if (!parsed)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    text_scale = *parsed.value_if();
                }
            }
            if (!plane)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(plane.error()));
            if (!clock)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(clock.error()));
            if (!input)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(input.error()));
            if (!pause)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(pause.error()));
            if (!composition)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(composition.error()));
            if (!entrance)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(entrance.error()));

            CustomLayoutCommandOptions command_options;
            command_options.owner_scope = owner_value->scope;
            command_options.room = std::move(owner_value->room);
            command_options.plane = *plane.value_if();
            command_options.scale_overrides =
                core::LayoutScaleOverrides{.ui = ui_scale, .text = text_scale};
            command_options.order =
                options ? table_option<std::int32_t>(*options, "order").value_or(0) : 0;
            command_options.clock = *clock.value_if();
            command_options.input = *input.value_if();
            command_options.gameplay_pause = *pause.value_if();
            command_options.visibility =
                options && !table_option<bool>(*options, "visible").value_or(true)
                    ? core::LayoutVisibility::Hidden
                    : core::LayoutVisibility::Visible;
            command_options.escape_dismissal =
                options && table_option<bool>(*options, "dismiss_on_escape").value_or(false)
                    ? core::EscapeDismissalPolicy::Dismiss
                    : core::EscapeDismissalPolicy::Ignore;
            command_options.composition_group = *composition.value_if();
            command_options.entrance = std::move(*entrance.value_if());
            return mutation(view, api->set_custom_layout(std::move(*instance_value),
                                                         std::move(*layout_value),
                                                         std::move(command_options)));
        });
    layouts.set_function(
        "unmount",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::ScopedLayoutInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto exit = parse_layout_transition(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            if (!exit)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(exit.error()));
            return mutation(view, api->clear_custom_layout(
                                      std::move(*instance_value), owner_value->scope,
                                      std::move(owner_value->room), std::move(*exit.value_if())));
        });
    layouts.set_function(
        "mounted",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto instance = parse_id<core::ScopedLayoutInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return failure(view, instance.error());
            if (!owner_value)
                return failure(view, owner.error());
            auto result = api->custom_layout(std::move(*instance_value), owner_value->scope,
                                             std::move(owner_value->room));
            const auto* mounted = result.value_if();
            if (!mounted)
                return failure(view, result.error());
            if (!*mounted)
                return {nil(view), nil(view)};
            sol::table object = view.create_table();
            object["layout"] = (*mounted)->layout.text();
            object["plane"] = layout_plane_name((*mounted)->policy.plane);
            if ((*mounted)->scale_overrides.ui)
                object["ui_scale"] = layout_scale_inheritance_name(*(*mounted)->scale_overrides.ui);
            if ((*mounted)->scale_overrides.text)
                object["text_scale"] =
                    layout_scale_inheritance_name(*(*mounted)->scale_overrides.text);
            object["order"] = (*mounted)->policy.local_order;
            object["clock"] = layout_clock_name((*mounted)->policy.clock);
            object["input"] = layout_input_name((*mounted)->policy.input);
            object["pause"] = layout_pause_name((*mounted)->policy.gameplay_pause);
            object["visible"] = (*mounted)->policy.visibility == core::LayoutVisibility::Visible;
            object["dismiss_on_escape"] =
                (*mounted)->policy.escape_dismissal == core::EscapeDismissalPolicy::Dismiss;
            object["composition"] = layout_composition_name((*mounted)->composition_group);
            return {sol::make_object(view, object), nil(view)};
        });
    noveltea["layouts"] = layouts;

    sol::table presentation = lua.create_table();
    presentation.set_function(
        "set_background",
        [api](sol::optional<sol::table> options, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto owner = parse_presentation_owner_options(options);
            auto* owner_value = owner.value_if();
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            auto fit = parse_background_fit(
                options ? table_option<std::string>(*options, "fit").value_or("cover") : "cover");
            auto* fit_value = fit.value_if();
            if (!fit_value)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(fit.error()));
            BackgroundCommandOptions command_options;
            command_options.owner_scope = owner_value->scope;
            command_options.room = std::move(owner_value->room);
            command_options.fit = *fit_value;
            if (options) {
                if (const auto color = table_option<std::string>(*options, "color"))
                    command_options.color = *color;
                if (const auto asset_name = table_option<std::string>(*options, "asset")) {
                    auto asset = parse_id<core::AssetId>(*asset_name);
                    auto* asset_value = asset.value_if();
                    if (!asset_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(asset.error()));
                    command_options.asset = std::move(*asset_value);
                }
                if (const auto material_name = table_option<std::string>(*options, "material")) {
                    auto material = parse_id<core::MaterialId>(*material_name);
                    auto* material_value = material.value_if();
                    if (!material_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(material.error()));
                    command_options.material = std::move(*material_value);
                }
            }
            return mutation(view, api->set_background(std::move(command_options)));
        });
    presentation.set_function(
        "clear_background",
        [api](sol::optional<sol::table> options, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto owner = parse_presentation_owner_options(options);
            auto* owner_value = owner.value_if();
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(
                view, api->clear_background(owner_value->scope, std::move(owner_value->room)));
        });
    presentation.set_function(
        "background",
        [api](sol::optional<sol::table> options, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto owner = parse_presentation_owner_options(options);
            auto* owner_value = owner.value_if();
            if (!owner_value)
                return failure(view, owner.error());
            auto result = api->background(owner_value->scope, std::move(owner_value->room));
            const auto* background = result.value_if();
            if (!background)
                return failure(view, result.error());
            if (!*background)
                return {nil(view), nil(view)};
            sol::table object = view.create_table();
            if ((*background)->background.asset)
                object["asset"] = (*background)->background.asset->text();
            if ((*background)->background.color)
                object["color"] = *(*background)->background.color;
            if ((*background)->background.material)
                object["material"] = (*background)->background.material->text();
            return {sol::make_object(view, object), nil(view)};
        });
    presentation.set_function(
        "set_actor",
        [api](std::string instance_name, std::string character_name, std::string pose_name,
              std::string expression_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance =
                parse_id<core::StrongId<core::ScopedActorInstanceTag>>(std::move(instance_name));
            auto character = parse_id<core::CharacterId>(std::move(character_name));
            auto pose = parse_id<core::CharacterPoseId>(std::move(pose_name));
            auto expression = parse_id<core::CharacterExpressionId>(std::move(expression_name));
            auto owner = parse_presentation_owner_options(options);
            auto position = parse_actor_position(
                options ? table_option<std::string>(*options, "position").value_or("center")
                        : "center");
            auto* instance_value = instance.value_if();
            auto* character_value = character.value_if();
            auto* pose_value = pose.value_if();
            auto* expression_value = expression.value_if();
            auto* owner_value = owner.value_if();
            auto* position_value = position.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!character_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(character.error()));
            if (!pose_value)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(pose.error()));
            if (!expression_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(expression.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            if (!position_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(position.error()));

            ScopedActorCommandOptions command_options;
            command_options.owner_scope = owner_value->scope;
            command_options.room = std::move(owner_value->room);
            command_options.position = *position_value;
            command_options.offset = {
                options ? table_option<double>(*options, "offset_x").value_or(0.0) : 0.0,
                options ? table_option<double>(*options, "offset_y").value_or(0.0) : 0.0};
            command_options.scale =
                options ? table_option<double>(*options, "scale").value_or(1.0) : 1.0;
            command_options.visible =
                options ? table_option<bool>(*options, "visible").value_or(true) : true;
            if (options) {
                if (const auto idle_name = table_option<std::string>(*options, "idle")) {
                    auto idle = parse_id<core::CharacterIdleId>(*idle_name);
                    auto* idle_value = idle.value_if();
                    if (!idle_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(idle.error()));
                    command_options.idle = std::move(*idle_value);
                }
            }
            return mutation(view, api->set_scoped_actor(
                                      core::ScopedActorKey{std::move(*instance_value)},
                                      std::move(*character_value), std::move(*pose_value),
                                      std::move(*expression_value), std::move(command_options)));
        });
    presentation.set_function(
        "clear_actor",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance =
                parse_id<core::StrongId<core::ScopedActorInstanceTag>>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(
                view, api->clear_scoped_actor(core::ScopedActorKey{std::move(*instance_value)},
                                              owner_value->scope, std::move(owner_value->room)));
        });
    presentation.set_function(
        "actor",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto instance =
                parse_id<core::StrongId<core::ScopedActorInstanceTag>>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return failure(view, instance.error());
            if (!owner_value)
                return failure(view, owner.error());
            auto result = api->scoped_actor(core::ScopedActorKey{std::move(*instance_value)},
                                            owner_value->scope, std::move(owner_value->room));
            const auto* actor = result.value_if();
            if (!actor)
                return failure(view, result.error());
            if (!*actor)
                return {nil(view), nil(view)};
            sol::table object = view.create_table();
            object["character"] = (*actor)->character.text();
            object["pose"] = (*actor)->pose.text();
            object["expression"] = (*actor)->expression.text();
            object["visible"] = (*actor)->visible;
            object["scale"] = (*actor)->placement.scale;
            return {sol::make_object(view, object), nil(view)};
        });
    presentation.set_function(
        "set_prop",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::PresentationPropInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto plane = parse_layout_plane(
                options ? table_option<std::string>(*options, "plane").value_or("world-content")
                        : "world-content");
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            auto* plane_value = plane.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            if (!plane_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(plane.error()));
            const auto number = [&options](const char* key, double fallback) {
                return options ? table_option<double>(*options, key).value_or(fallback) : fallback;
            };
            PresentationPropCommandOptions command_options;
            command_options.owner_scope = owner_value->scope;
            command_options.room = std::move(owner_value->room);
            command_options.bounds = {number("x", 0.0), number("y", 0.0), number("width", 0.0),
                                      number("height", 0.0)};
            command_options.plane = *plane_value;
            command_options.order =
                options ? table_option<std::int32_t>(*options, "order").value_or(0) : 0;
            command_options.visible =
                options ? table_option<bool>(*options, "visible").value_or(true) : true;
            if (options) {
                if (const auto asset_name = table_option<std::string>(*options, "asset")) {
                    auto asset = parse_id<core::AssetId>(*asset_name);
                    auto* asset_value = asset.value_if();
                    if (!asset_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(asset.error()));
                    command_options.asset = std::move(*asset_value);
                }
                if (const auto material_name = table_option<std::string>(*options, "material")) {
                    auto material = parse_id<core::MaterialId>(*material_name);
                    auto* material_value = material.value_if();
                    if (!material_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(material.error()));
                    command_options.material = std::move(*material_value);
                }
                const auto placement_room = table_option<std::string>(*options, "placement_room");
                const auto placement_id = table_option<std::string>(*options, "placement_id");
                if (placement_room.has_value() != placement_id.has_value())
                    return mutation(
                        view,
                        core::Result<void, core::Diagnostics>::failure(invalid(
                            "runtime.invalid_prop_placement",
                            "Prop placement_room and placement_id must be provided together")));
                if (placement_room) {
                    auto room = parse_id<core::RoomId>(*placement_room);
                    auto placement = parse_id<core::RoomPlacementId>(*placement_id);
                    auto* room_value = room.value_if();
                    auto* placement_value = placement.value_if();
                    if (!room_value)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(room.error()));
                    if (!placement_value)
                        return mutation(view, core::Result<void, core::Diagnostics>::failure(
                                                  placement.error()));
                    command_options.placement = core::compiled::RoomPlacementRef{
                        std::move(*room_value), std::move(*placement_value)};
                }
            }
            return mutation(view, api->set_presentation_prop(std::move(*instance_value),
                                                             std::move(command_options)));
        });
    presentation.set_function(
        "clear_prop",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto instance = parse_id<core::PresentationPropInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(instance.error()));
            if (!owner_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            return mutation(view, api->clear_presentation_prop(std::move(*instance_value),
                                                               owner_value->scope,
                                                               std::move(owner_value->room)));
        });
    presentation.set_function(
        "prop",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto instance = parse_id<core::PresentationPropInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return failure(view, instance.error());
            if (!owner_value)
                return failure(view, owner.error());
            auto result = api->presentation_prop(std::move(*instance_value), owner_value->scope,
                                                 std::move(owner_value->room));
            const auto* prop = result.value_if();
            if (!prop)
                return failure(view, result.error());
            if (!*prop)
                return {nil(view), nil(view)};
            sol::table object = view.create_table();
            if ((*prop)->asset)
                object["asset"] = (*prop)->asset->text();
            if ((*prop)->material)
                object["material"] = (*prop)->material->text();
            object["order"] = (*prop)->order;
            object["visible"] = (*prop)->visible;
            object["x"] = (*prop)->bounds.x;
            object["y"] = (*prop)->bounds.y;
            object["width"] = (*prop)->bounds.width;
            object["height"] = (*prop)->bounds.height;
            return {sol::make_object(view, object), nil(view)};
        });
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
                options ? table_option<std::string>(*options, "stop_key").value_or(instance_name)
                        : instance_name;
            auto stop_key = parse_id<core::PresentationEnvironmentStopKey>(stop_key_name);
            auto* stop_key_value = stop_key.value_if();
            if (!stop_key_value)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(stop_key.error()));

            const std::string plane_name =
                options ? table_option<std::string>(*options, "plane").value_or("world-content")
                        : "world-content";
            const std::string clock_name =
                options ? table_option<std::string>(*options, "clock").value_or("gameplay")
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
                const auto asset_name = table_option<std::string>(*options, "asset");
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
                return options ? table_option<double>(*options, key).value_or(fallback) : fallback;
            };
            const auto integer = [&options](const char* key, std::int32_t fallback) {
                return options ? table_option<std::int32_t>(*options, key).value_or(fallback)
                               : fallback;
            };
            const auto boolean = [&options](const char* key, bool fallback) {
                return options ? table_option<bool>(*options, key).value_or(fallback) : fallback;
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
        "environment",
        [api](std::string instance_name, sol::optional<sol::table> options,
              sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto instance =
                parse_id<core::PresentationEnvironmentInstanceId>(std::move(instance_name));
            auto owner = parse_presentation_owner_options(options);
            auto* instance_value = instance.value_if();
            auto* owner_value = owner.value_if();
            if (!instance_value)
                return failure(view, instance.error());
            if (!owner_value)
                return failure(view, owner.error());
            auto result = api->environment(std::move(*instance_value), owner_value->scope,
                                           std::move(owner_value->room));
            const auto* environment = result.value_if();
            if (!environment)
                return failure(view, result.error());
            if (!*environment)
                return {nil(view), nil(view)};
            sol::table object = view.create_table();
            object["material"] = (*environment)->material.text();
            if ((*environment)->asset)
                object["asset"] = (*environment)->asset->text();
            object["stop_key"] = (*environment)->stop_key.text();
            object["order"] = (*environment)->order;
            object["visible"] = (*environment)->visible;
            object["opacity"] = (*environment)->opacity;
            return {sol::make_object(view, object), nil(view)};
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
                const auto replacement_name =
                    table_option<std::string>(*options, "replacement_key");
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
