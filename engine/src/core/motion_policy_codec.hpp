#pragma once

#include "json_decoder.hpp"
#include "noveltea/core/motion_policy.hpp"

namespace noveltea::core {

inline nlohmann::json encode_motion_policy(const MotionPlaybackPolicy& policy)
{
    return {{"repeat", policy.repeat == MotionRepeat::Once ? "once" : "loop"},
            {"rate", policy.rate},
            {"clock",
             policy.clock == LayoutClockDomain::Gameplay ? "gameplay" : "unscaled-presentation"},
            {"initialMarker", policy.initial_marker ? nlohmann::json(*policy.initial_marker)
                                                    : nlohmann::json(nullptr)}};
}

inline std::optional<MotionPlaybackPolicy>
decode_motion_policy(JsonDecoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"repeat", "rate", "clock", "initialMarker"}))
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
    return MotionPlaybackPolicy{*repeat == "once" ? MotionRepeat::Once : MotionRepeat::Loop, *rate,
                                *clock == "gameplay" ? LayoutClockDomain::Gameplay
                                                     : LayoutClockDomain::UnscaledPresentation,
                                std::move(marker)};
}

} // namespace noveltea::core
