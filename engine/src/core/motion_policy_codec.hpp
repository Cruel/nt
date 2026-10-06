#pragma once

#include "json_decoder.hpp"
#include "noveltea/core/motion_policy.hpp"

namespace noveltea::core {

inline nlohmann::json encode_motion_policy(const MotionPlaybackPolicy& policy)
{
    nlohmann::json result = {
        {"repeat", policy.repeat == MotionRepeat::Once ? "once" : "loop"},
        {"rate", policy.rate},
        {"clock",
         policy.clock == LayoutClockDomain::Gameplay ? "gameplay" : "unscaled-presentation"},
        {"initialMarker",
         policy.initial_marker ? nlohmann::json(*policy.initial_marker) : nlohmann::json(nullptr)}};
    if (policy.loop_range)
        result["loopRange"] = {{"start", policy.loop_range->start},
                               {"end", policy.loop_range->end}};
    return result;
}

inline std::optional<MotionPlaybackPolicy>
decode_motion_policy(JsonDecoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"repeat", "rate", "clock", "initialMarker", "loopRange"}))
        return std::nullopt;
    const auto child = [&](std::string_view key) {
        return std::string(pointer) + "/" + std::string(key);
    };
    const auto* repeat_value = decoder.member(value, "repeat", pointer);
    const auto* rate_value = decoder.member(value, "rate", pointer);
    const auto* clock_value = decoder.member(value, "clock", pointer);
    const auto* marker_value = decoder.member(value, "initialMarker", pointer);
    auto repeat =
        repeat_value ? decoder.string(*repeat_value, child("repeat"), true) : std::nullopt;
    auto rate = rate_value ? decoder.finite_number(*rate_value, child("rate")) : std::nullopt;
    auto clock = clock_value ? decoder.string(*clock_value, child("clock"), true) : std::nullopt;
    std::optional<std::string> marker;
    if (marker_value && !marker_value->is_null()) {
        marker = decoder.string(*marker_value, child("initialMarker"), true);
        if (!marker)
            return std::nullopt;
    }
    if (!repeat || !rate || !clock || !marker_value)
        return std::nullopt;
    if ((*repeat != "once" && *repeat != "loop") || *rate <= 0.0 ||
        (*clock != "gameplay" && *clock != "unscaled-presentation")) {
        decoder.error("motion.invalid_policy", "Invalid motion playback policy.",
                      std::string(pointer));
        return std::nullopt;
    }
    std::optional<MotionLoopRange> range;
    if (const auto* value_range = json_access::member(value, "loopRange")) {
        const auto path = child("loopRange");
        if (*repeat != "loop" || !decoder.object(*value_range, path, {"start", "end"})) {
            decoder.error("motion.invalid_policy", "A loop range requires loop playback.", path);
            return std::nullopt;
        }
        const auto* start_value = decoder.member(*value_range, "start", path);
        const auto* end_value = decoder.member(*value_range, "end", path);
        auto start =
            start_value ? decoder.string(*start_value, path + "/start", true) : std::nullopt;
        auto end = end_value ? decoder.string(*end_value, path + "/end", true) : std::nullopt;
        if (!start || !end)
            return std::nullopt;
        range = MotionLoopRange{*start, *end};
    }
    return MotionPlaybackPolicy{*repeat == "once" ? MotionRepeat::Once : MotionRepeat::Loop, *rate,
                                *clock == "gameplay" ? LayoutClockDomain::Gameplay
                                                     : LayoutClockDomain::UnscaledPresentation,
                                std::move(marker), std::move(range)};
}

} // namespace noveltea::core
