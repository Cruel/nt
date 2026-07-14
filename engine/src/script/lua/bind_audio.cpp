#include "script/lua/script_runtime_internal.hpp"
#include "script/lua/sol_access.hpp"

#include "noveltea/audio/audio_system.hpp"

#include <SDL3/SDL_log.h>
#include <lua.hpp>
#include <sol/sol.hpp>

#include <algorithm>
#include <string>

namespace noveltea::script {
namespace {

constexpr const char kAudioKey[] = "__noveltea_audio_system";

AudioBus parse_bus(const std::string& name)
{
    if (name == "master")
        return AudioBus::Master;
    if (name == "music")
        return AudioBus::Music;
    if (name == "ambience" || name == "ambient")
        return AudioBus::Ambience;
    if (name == "voice")
        return AudioBus::Voice;
    return AudioBus::Sfx;
}

float option_float(const sol::optional<sol::table>& options, const char* key, float fallback)
{
    if (!options)
        return fallback;
    sol::optional<float> value = (*options)[key];
    return value.value_or(fallback);
}

bool option_bool(const sol::optional<sol::table>& options, const char* key, bool fallback)
{
    if (!options)
        return fallback;
    sol::optional<bool> value = (*options)[key];
    return value.value_or(fallback);
}

std::string option_string(const sol::optional<sol::table>& options, const char* key,
                          std::string fallback)
{
    if (!options)
        return fallback;
    sol::optional<std::string> value = (*options)[key];
    return value.value_or(std::move(fallback));
}

AudioTrackReplaceMode option_replace_mode(const sol::optional<sol::table>& options)
{
    const std::string mode = option_string(options, "replace_mode", "replace");
    return mode == "layer" ? AudioTrackReplaceMode::Layer : AudioTrackReplaceMode::Replace;
}

AudioSystem* audio_from(sol::state_view lua)
{
    return detail::registry_pointer<AudioSystem>(lua, kAudioKey);
}

AudioSfxDesc sfx_desc(const sol::optional<sol::table>& options)
{
    return AudioSfxDesc{.volume = option_float(options, "volume", 1.0f),
                        .pitch = option_float(options, "pitch", 1.0f),
                        .max_simultaneous = static_cast<uint32_t>(
                            std::max(0.0f, option_float(options, "max_simultaneous", 0.0f)))};
}

AudioTrackDesc track_desc(const std::string& track_id, const sol::optional<sol::table>& options)
{
    return AudioTrackDesc{.track_id = track_id,
                          .bus = parse_bus(option_string(options, "bus", "music")),
                          .volume = option_float(options, "volume", 1.0f),
                          .pitch = option_float(options, "pitch", 1.0f),
                          .loop = option_bool(options, "loop", true),
                          .fade_in_seconds = option_float(options, "fade_in", 0.0f),
                          .fade_out_seconds = option_float(options, "fade_out", 0.0f),
                          .replace_mode = option_replace_mode(options)};
}

} // namespace

void bind_audio(lua_State* state, AudioSystem* audio)
{
    sol::state_view lua(state);
    lua.registry().set(kAudioKey, audio);

    sol::table table = lua.create_table();
    table.set_function(
        "play_sfx",
        [](std::string path, sol::optional<sol::table> options, sol::this_state L) -> bool {
            AudioSystem* audio_system = audio_from(sol::state_view(L));
            if (!audio_system) {
                SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                            "[lua] audio.play_sfx ignored; audio system is unavailable");
                return false;
            }
            return static_cast<bool>(audio_system->play_sfx(path, sfx_desc(options)));
        });
    table.set_function(
        "play_track",
        [](std::string track_id, std::string path, sol::optional<sol::table> options,
           sol::this_state L) -> bool {
            AudioSystem* audio_system = audio_from(sol::state_view(L));
            if (!audio_system) {
                SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                            "[lua] audio.play_track ignored; audio system is unavailable");
                return false;
            }
            return static_cast<bool>(
                audio_system->play_track(track_id, path, track_desc(track_id, options)));
        });
    table.set_function(
        "play_sfx_alias",
        [](std::string alias, sol::optional<sol::table> options, sol::this_state L) -> bool {
            AudioSystem* audio_system = audio_from(sol::state_view(L));
            if (!audio_system) {
                SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                            "[lua] audio.play_sfx_alias ignored; audio system is unavailable");
                return false;
            }
            return static_cast<bool>(audio_system->play_sfx_alias(alias, sfx_desc(options)));
        });
    table.set_function(
        "play_track_alias",
        [](std::string track_id, std::string alias, sol::optional<sol::table> options,
           sol::this_state L) -> bool {
            AudioSystem* audio_system = audio_from(sol::state_view(L));
            if (!audio_system) {
                SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                            "[lua] audio.play_track_alias ignored; audio system is unavailable");
                return false;
            }
            return static_cast<bool>(
                audio_system->play_track_alias(track_id, alias, track_desc(track_id, options)));
        });
    table.set_function("stop_track", [](std::string track_id, sol::optional<sol::table> options,
                                        sol::this_state L) {
        AudioSystem* audio_system = audio_from(sol::state_view(L));
        if (!audio_system) {
            SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                        "[lua] audio.stop_track ignored; audio system is unavailable");
            return;
        }
        audio_system->stop_track(track_id, option_float(options, "fade", 0.0f));
    });
    table.set_function("set_bus_volume", [](std::string bus, float volume, sol::this_state L) {
        AudioSystem* audio_system = audio_from(sol::state_view(L));
        if (!audio_system) {
            SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                        "[lua] audio.set_bus_volume ignored; audio system is unavailable");
            return;
        }
        audio_system->set_bus_volume(parse_bus(bus), volume);
    });
    table.set_function("pause", [](sol::this_state L) {
        AudioSystem* audio_system = audio_from(sol::state_view(L));
        if (audio_system)
            audio_system->pause();
    });
    table.set_function("resume", [](sol::this_state L) {
        AudioSystem* audio_system = audio_from(sol::state_view(L));
        if (audio_system)
            audio_system->resume();
    });
    table.set_function("paused", [](sol::this_state L) -> bool {
        AudioSystem* audio_system = audio_from(sol::state_view(L));
        return audio_system ? audio_system->paused() : true;
    });

    lua["audio"] = table;
}

void clear_audio_binding(lua_State* state)
{
    sol::state_view lua(state);
    lua.registry().set(kAudioKey, nullptr);
    lua["audio"] = sol::lua_nil;
}

} // namespace noveltea::script
