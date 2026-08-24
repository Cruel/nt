#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

namespace {

std::optional<MaterialParameterValue> decode_material_parameter_value(Decoder& decoder,
                                                                      const nlohmann::json& value,
                                                                      std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"type", "value"}))
        return std::nullopt;
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* payload = decoder.member(value, "value", pointer);
    auto type =
        type_value ? decoder.string(*type_value, pointer_child(pointer, "type")) : std::nullopt;
    if (!type || payload == nullptr)
        return std::nullopt;
    const auto payload_pointer = pointer_child(pointer, "value");
    if (*type == "float") {
        auto number = decoder.finite_number(*payload, payload_pointer);
        return number ? std::optional<MaterialParameterValue>(*number) : std::nullopt;
    }
    const auto vector = [&](std::size_t size) -> std::optional<std::vector<double>> {
        if (!payload->is_array() || payload->size() != size) {
            decoder.error(k_code_type, "Material vector value has the wrong component count.",
                          payload_pointer);
            return std::nullopt;
        }
        std::vector<double> result;
        result.reserve(size);
        for (std::size_t index = 0; index < size; ++index) {
            auto component = decoder.finite_number((*payload)[index],
                                                   payload_pointer + "/" + std::to_string(index));
            if (!component)
                return std::nullopt;
            result.push_back(*component);
        }
        return result;
    };
    if (*type == "vec2") {
        auto values = vector(2);
        return values ? std::optional<MaterialParameterValue>(
                            std::array<double, 2>{(*values)[0], (*values)[1]})
                      : std::nullopt;
    }
    if (*type == "vec3") {
        auto values = vector(3);
        return values ? std::optional<MaterialParameterValue>(
                            std::array<double, 3>{(*values)[0], (*values)[1], (*values)[2]})
                      : std::nullopt;
    }
    if (*type == "vec4") {
        auto values = vector(4);
        return values ? std::optional<MaterialParameterValue>(std::array<double, 4>{
                            (*values)[0], (*values)[1], (*values)[2], (*values)[3]})
                      : std::nullopt;
    }
    if (*type == "color") {
        if (!decoder.object(*payload, payload_pointer, {"a", "b", "g", "r"}))
            return std::nullopt;
        const auto component = [&](std::string_view name) -> std::optional<double> {
            const auto* item = decoder.member(*payload, name, payload_pointer);
            return item ? decoder.finite_number(*item, pointer_child(payload_pointer, name))
                        : std::nullopt;
        };
        auto r = component("r");
        auto g = component("g");
        auto b = component("b");
        auto a = component("a");
        return r && g && b && a
                   ? std::optional<MaterialParameterValue>(MaterialColorValue{*r, *g, *b, *a})
                   : std::nullopt;
    }
    if (*type == "int") {
        if (!payload->is_number_integer()) {
            decoder.error(k_code_number, "Material integer value must be an integer.",
                          payload_pointer);
            return std::nullopt;
        }
        return MaterialParameterValue{payload->get<std::int64_t>()};
    }
    if (*type == "bool") {
        auto flag = decoder.boolean(*payload, payload_pointer);
        return flag ? std::optional<MaterialParameterValue>(*flag) : std::nullopt;
    }
    decoder.error(k_code_variant, "Unknown Material Parameter value type.",
                  pointer_child(pointer, "type"));
    return std::nullopt;
}

bool decode_layout_scale_overrides(Decoder& decoder, const nlohmann::json& owner,
                                   std::string_view pointer, LayoutScaleOverrides& overrides)
{
    const auto* value = json_access::member(owner, "scaleOverrides");
    if (!value)
        return true;
    const auto overrides_pointer = pointer_child(pointer, "scaleOverrides");
    if (!decoder.object(*value, overrides_pointer, {"text", "ui"}))
        return false;
    const auto decode_value = [&](std::string_view name) -> std::optional<LayoutScaleInheritance> {
        const auto* member = json_access::member(*value, name);
        if (!member)
            return std::nullopt;
        return decoder.enumeration<LayoutScaleInheritance>(
            *member, pointer_child(overrides_pointer, name),
            {{"inherit", LayoutScaleInheritance::Inherit},
             {"ignore", LayoutScaleInheritance::Ignore}});
    };
    if (value->contains("ui")) {
        overrides.ui = decode_value("ui");
        if (!overrides.ui)
            return false;
    }
    if (value->contains("text")) {
        overrides.text = decode_value("text");
        if (!overrides.text)
            return false;
    }
    return true;
}

} // namespace

std::optional<SceneInstruction>
decode_scene_instruction(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Scene instruction object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* id_value = decoder.member(value, "id", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    auto id =
        id_value ? decoder.id<SceneStepId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    bool condition_ok = false;
    auto condition = decode_optional_condition(decoder, value, pointer, condition_ok);
    if (!kind || !id || !condition_ok)
        return std::nullopt;
#define SCENE_FIELDS(...) decoder.object(value, pointer, {"condition", "id", "kind", __VA_ARGS__})
    if (*kind == "set-background") {
        SCENE_FIELDS("asset", "color", "durationMs", "fit", "material", "skippable", "transition",
                     "waitForCompletion");
        const auto* asset_value = decoder.member(value, "asset", pointer);
        const auto* color_value = decoder.member(value, "color", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* fit_value = decoder.member(value, "fit", pointer);
        const auto* material_value = decoder.member(value, "material", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        std::optional<AssetId> asset;
        bool asset_ok = asset_value != nullptr;
        if (asset_value && !asset_value->is_null()) {
            asset = decode_reference<AssetId>(decoder, *asset_value,
                                              pointer_child(pointer, "asset"), "asset");
            asset_ok = asset.has_value();
        }
        std::optional<std::string> color;
        bool color_ok = color_value != nullptr;
        if (color_value && !color_value->is_null()) {
            color = decoder.string(*color_value, pointer_child(pointer, "color"));
            color_ok = color.has_value();
        }
        auto fit =
            fit_value
                ? decoder.enumeration<BackgroundFit>(*fit_value, pointer_child(pointer, "fit"),
                                                     {{"cover", BackgroundFit::Cover},
                                                      {"contain", BackgroundFit::Contain},
                                                      {"stretch", BackgroundFit::Stretch},
                                                      {"center", BackgroundFit::Center}})
                : std::nullopt;
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(decoder, *material_value,
                                                    pointer_child(pointer, "material"), "material");
            material_ok = material.has_value();
        }
        auto transition = transition_value
                              ? decoder.enumeration<BackgroundTransition>(
                                    *transition_value, pointer_child(pointer, "transition"),
                                    {{"none", BackgroundTransition::None},
                                     {"fade", BackgroundTransition::Fade},
                                     {"cut", BackgroundTransition::Cut}})
                              : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (transition && duration && waits) {
            if (*transition == BackgroundTransition::Fade && *duration == 0) {
                decoder.error(k_code_number,
                              "Animated background transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            } else if (*transition != BackgroundTransition::Fade && (*duration != 0 || *waits)) {
                decoder.error(k_code_variant,
                              "Immediate background transitions require zero duration and no wait.",
                              pointer_child(pointer, "transition"));
                duration.reset();
            }
        }
        PresentationInstructionWait wait =
            waits && *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                            : PresentationInstructionWait{ImmediateWait{}};
        return asset_ok && color_ok && duration && fit && material_ok && skippable && transition &&
                       waits
                   ? std::optional<SceneInstruction>(SetBackgroundInstruction{
                         std::move(*id), std::move(condition),
                         BackgroundPresentation{std::move(asset), std::move(color), *fit,
                                                std::move(material)},
                         *transition, *duration, std::move(wait), *skippable})
                   : std::nullopt;
    }
    if (*kind == "actor-cue") {
        SCENE_FIELDS("action", "appearanceId", "character", "durationMs", "expressionId", "offset",
                     "poseId", "position", "profileId", "scale", "skippable", "slotId",
                     "transition", "waitForCompletion");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* character_value = decoder.member(value, "character", pointer);
        const auto* profile_value = decoder.member(value, "profileId", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* expression_value = decoder.member(value, "expressionId", pointer);
        const auto* appearance_value = decoder.member(value, "appearanceId", pointer);
        const auto* offset_value = decoder.member(value, "offset", pointer);
        const auto* pose_value = decoder.member(value, "poseId", pointer);
        const auto* position_value = decoder.member(value, "position", pointer);
        const auto* scale_value = decoder.member(value, "scale", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* slot_value = decoder.member(value, "slotId", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto action = action_value ? decoder.enumeration<ActorCueAction>(
                                         *action_value, pointer_child(pointer, "action"),
                                         {{"show", ActorCueAction::Show},
                                          {"hide", ActorCueAction::Hide},
                                          {"move", ActorCueAction::Move},
                                          {"profile", ActorCueAction::Profile},
                                          {"pose", ActorCueAction::Pose},
                                          {"expression", ActorCueAction::Expression},
                                          {"appearance", ActorCueAction::Appearance}})
                                   : std::nullopt;
        auto character =
            character_value
                ? decode_reference<CharacterId>(decoder, *character_value,
                                                pointer_child(pointer, "character"), "character")
                : std::nullopt;
        std::optional<CharacterPresentationProfileId> profile;
        bool profile_ok = profile_value != nullptr;
        if (profile_value && !profile_value->is_null()) {
            profile = decoder.id<CharacterPresentationProfileId>(
                *profile_value, pointer_child(pointer, "profileId"));
            profile_ok = profile.has_value();
        }
        std::optional<CharacterExpressionId> expression;
        bool expression_ok = expression_value != nullptr;
        if (expression_value && !expression_value->is_null()) {
            expression = decoder.id<CharacterExpressionId>(*expression_value,
                                                           pointer_child(pointer, "expressionId"));
            expression_ok = expression.has_value();
        }
        std::optional<CharacterAppearanceId> appearance;
        bool appearance_ok = appearance_value != nullptr;
        if (appearance_value && !appearance_value->is_null()) {
            appearance = decoder.id<CharacterAppearanceId>(*appearance_value,
                                                           pointer_child(pointer, "appearanceId"));
            appearance_ok = appearance.has_value();
        }
        auto offset = offset_value
                          ? decode_vector2(decoder, *offset_value, pointer_child(pointer, "offset"))
                          : std::nullopt;
        std::optional<CharacterPoseId> pose;
        bool pose_ok = pose_value != nullptr;
        if (pose_value && !pose_value->is_null()) {
            pose = decoder.id<CharacterPoseId>(*pose_value, pointer_child(pointer, "poseId"));
            pose_ok = pose.has_value();
        }
        auto position = position_value ? decoder.enumeration<ActorPosition>(
                                             *position_value, pointer_child(pointer, "position"),
                                             {{"left", ActorPosition::Left},
                                              {"center", ActorPosition::Center},
                                              {"right", ActorPosition::Right},
                                              {"custom", ActorPosition::Custom}})
                                       : std::nullopt;
        auto scale = scale_value
                         ? decoder.finite_number(*scale_value, pointer_child(pointer, "scale"))
                         : std::nullopt;
        if (scale && *scale <= 0.0) {
            decoder.error(k_code_number, "Scale must be positive.",
                          pointer_child(pointer, "scale"));
            scale.reset();
        }
        auto slot = slot_value
                        ? decoder.id<ActorSlotId>(*slot_value, pointer_child(pointer, "slotId"))
                        : std::nullopt;
        auto transition = transition_value
                              ? decoder.enumeration<ActorTransition>(
                                    *transition_value, pointer_child(pointer, "transition"),
                                    {{"none", ActorTransition::None},
                                     {"fade", ActorTransition::Fade},
                                     {"slide", ActorTransition::Slide}})
                              : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (action && transition && duration && waits) {
            if (*transition == ActorTransition::None && (*duration != 0 || *waits)) {
                decoder.error(k_code_variant,
                              "Immediate actor changes require zero duration and no wait.",
                              pointer_child(pointer, "transition"));
                duration.reset();
            } else if (*transition != ActorTransition::None && *duration == 0) {
                decoder.error(k_code_number,
                              "Animated actor transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            }
            if (*transition == ActorTransition::Slide && *action != ActorCueAction::Show &&
                *action != ActorCueAction::Hide && *action != ActorCueAction::Move) {
                decoder.error(k_code_variant,
                              "Slide is valid only for show, hide, and move actor actions.",
                              pointer_child(pointer, "transition"));
                transition.reset();
            }
        }
        if (!action || !character || !profile_ok || !expression_ok || !appearance_ok || !offset ||
            !pose_ok || !position || !scale || !skippable || !slot || !transition || !duration ||
            !waits)
            return std::nullopt;
        PresentationInstructionWait wait =
            *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                   : PresentationInstructionWait{ImmediateWait{}};
        return ActorCueInstruction{std::move(*id),
                                   std::move(condition),
                                   *action,
                                   std::move(*character),
                                   std::move(profile),
                                   std::move(expression),
                                   std::move(appearance),
                                   std::move(*offset),
                                   std::move(pose),
                                   *position,
                                   *scale,
                                   std::move(*slot),
                                   *transition,
                                   *duration,
                                   std::move(wait),
                                   *skippable};
    }
    if (*kind == "call-dialogue") {
        SCENE_FIELDS("autosaveSafePoint", "dialogue", "startBlockId");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        const auto* block_value = decoder.member(value, "startBlockId", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        std::optional<DialogueBlockId> block;
        bool block_ok = block_value != nullptr;
        if (block_value && !block_value->is_null()) {
            block =
                decoder.id<DialogueBlockId>(*block_value, pointer_child(pointer, "startBlockId"));
            block_ok = block.has_value();
        }
        return safe && dialogue && block_ok
                   ? std::optional<SceneInstruction>(
                         CallDialogueSceneInstruction{std::move(*id), std::move(condition), *safe,
                                                      std::move(*dialogue), std::move(block)})
                   : std::nullopt;
    }
    if (*kind == "show-text") {
        SCENE_FIELDS("autosaveSafePoint", "speaker", "text", "wait");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* speaker_value = decoder.member(value, "speaker", pointer);
        const auto* text_value = decoder.member(value, "text", pointer);
        const auto* wait_value = decoder.member(value, "wait", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        std::optional<CharacterId> speaker;
        bool speaker_ok = speaker_value != nullptr;
        if (speaker_value && !speaker_value->is_null()) {
            speaker = decode_reference<CharacterId>(decoder, *speaker_value,
                                                    pointer_child(pointer, "speaker"), "character");
            speaker_ok = speaker.has_value();
        }
        auto text = text_value ? decode_text(decoder, *text_value, pointer_child(pointer, "text"))
                               : std::nullopt;
        auto wait_name =
            wait_value ? decoder.string(*wait_value, pointer_child(pointer, "wait")) : std::nullopt;
        std::optional<InputInstructionWait> wait;
        if (wait_name && *wait_name == "input")
            wait = InputWait{};
        else if (wait_name && *wait_name == "immediate")
            wait = ImmediateWait{};
        else if (wait_name)
            decoder.error(k_code_enum, "Unknown wait value '" + *wait_name + "'.",
                          pointer_child(pointer, "wait"));
        return safe && speaker_ok && text && wait
                   ? std::optional<SceneInstruction>(ShowTextInstruction{
                         std::move(*id), std::move(condition), *safe, std::move(speaker),
                         std::move(*text), std::move(*wait)})
                   : std::nullopt;
    }
    if (*kind == "audio-cue") {
        SCENE_FIELDS("action", "asset", "causality", "fadeMs", "gain", "instanceId", "lifetime",
                     "pan", "panSource", "pausePolicy", "purpose", "replacementGroup",
                     "skipBehavior", "synchronized", "waitForCompletion");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* asset_value = decoder.member(value, "asset", pointer);
        const auto* purpose_value = decoder.member(value, "purpose", pointer);
        const auto* lifetime_value = decoder.member(value, "lifetime", pointer);
        const auto* pause_value = decoder.member(value, "pausePolicy", pointer);
        const auto* gain_value = decoder.member(value, "gain", pointer);
        const auto* pan_value = decoder.member(value, "pan", pointer);
        const auto* pan_source_value = decoder.member(value, "panSource", pointer);
        const auto* fade_value = decoder.member(value, "fadeMs", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        const auto* causality_value = decoder.member(value, "causality", pointer);
        const auto* synchronized_value = decoder.member(value, "synchronized", pointer);
        const auto* skip_value = decoder.member(value, "skipBehavior", pointer);
        const auto* instance_value = decoder.member(value, "instanceId", pointer);
        const auto* replacement_value = decoder.member(value, "replacementGroup", pointer);
        auto action =
            action_value
                ? decoder.enumeration<AudioAction>(*action_value, pointer_child(pointer, "action"),
                                                   {{"play", AudioAction::Play},
                                                    {"stop", AudioAction::Stop},
                                                    {"fade-in", AudioAction::FadeIn},
                                                    {"fade-out", AudioAction::FadeOut}})
                : std::nullopt;
        std::optional<AssetId> asset;
        bool asset_ok = asset_value != nullptr;
        if (asset_value && !asset_value->is_null()) {
            asset = decode_reference<AssetId>(decoder, *asset_value,
                                              pointer_child(pointer, "asset"), "asset");
            asset_ok = asset.has_value();
        }
        auto purpose = purpose_value ? decoder.enumeration<AudioPurpose>(
                                           *purpose_value, pointer_child(pointer, "purpose"),
                                           {{"music", AudioPurpose::Music},
                                            {"ambience", AudioPurpose::Ambience},
                                            {"voice", AudioPurpose::Voice},
                                            {"sound-effect", AudioPurpose::SoundEffect},
                                            {"ui-sound", AudioPurpose::UiSound}})
                                     : std::nullopt;
        auto lifetime = lifetime_value ? decoder.enumeration<AudioLifetime>(
                                             *lifetime_value, pointer_child(pointer, "lifetime"),
                                             {{"desired-loop", AudioLifetime::DesiredLoop},
                                              {"one-shot", AudioLifetime::OneShot}})
                                       : std::nullopt;
        auto pause_policy = pause_value ? decoder.enumeration<AudioPausePolicy>(
                                              *pause_value, pointer_child(pointer, "pausePolicy"),
                                              {{"gameplay", AudioPausePolicy::Gameplay},
                                               {"owner", AudioPausePolicy::Owner},
                                               {"unscaled", AudioPausePolicy::Unscaled}})
                                        : std::nullopt;
        auto gain = gain_value ? decoder.finite_number(*gain_value, pointer_child(pointer, "gain"))
                               : std::nullopt;
        if (gain && (*gain < 0.0 || *gain > 1.0)) {
            decoder.error(k_code_number, "Audio gain must be between zero and one.",
                          pointer_child(pointer, "gain"));
            gain.reset();
        }
        auto pan = pan_value ? decoder.finite_number(*pan_value, pointer_child(pointer, "pan"))
                             : std::nullopt;
        if (pan && (*pan < -1.0 || *pan > 1.0)) {
            decoder.error(k_code_number, "Audio pan must be between negative one and one.",
                          pointer_child(pointer, "pan"));
            pan.reset();
        }
        std::optional<AudioPanSource> pan_source;
        bool pan_source_ok = pan_source_value != nullptr;
        if (pan_source_value && !pan_source_value->is_null()) {
            const auto pan_pointer = pointer_child(pointer, "panSource");
            if (decoder.object(*pan_source_value, pan_pointer,
                               {"anchorId", "kind", "room", "slotId"})) {
                const auto* source_kind_value =
                    decoder.member(*pan_source_value, "kind", pan_pointer);
                auto source_kind =
                    source_kind_value
                        ? decoder.string(*source_kind_value, pointer_child(pan_pointer, "kind"))
                        : std::nullopt;
                if (source_kind && *source_kind == "scene-actor") {
                    decoder.object(*pan_source_value, pan_pointer, {"kind", "slotId"});
                    const auto* slot_value =
                        decoder.member(*pan_source_value, "slotId", pan_pointer);
                    auto slot = slot_value ? decoder.id<ActorSlotId>(
                                                 *slot_value, pointer_child(pan_pointer, "slotId"))
                                           : std::nullopt;
                    if (slot)
                        pan_source = SceneActorAudioPanSource{std::move(*slot)};
                } else if (source_kind && *source_kind == "room-anchor") {
                    decoder.object(*pan_source_value, pan_pointer, {"anchorId", "kind", "room"});
                    const auto* room_value = decoder.member(*pan_source_value, "room", pan_pointer);
                    const auto* anchor_value =
                        decoder.member(*pan_source_value, "anchorId", pan_pointer);
                    auto room =
                        room_value
                            ? decode_reference<RoomId>(decoder, *room_value,
                                                       pointer_child(pan_pointer, "room"), "room")
                            : std::nullopt;
                    auto anchor = anchor_value
                                      ? decoder.id<RoomAnchorId>(
                                            *anchor_value, pointer_child(pan_pointer, "anchorId"))
                                      : std::nullopt;
                    if (room && anchor)
                        pan_source = RoomAnchorAudioPanSource{std::move(*room), std::move(*anchor)};
                } else if (source_kind) {
                    decoder.error(k_code_enum,
                                  "Unknown audio Pan Source kind '" + *source_kind + "'.",
                                  pointer_child(pan_pointer, "kind"));
                }
                pan_source_ok = pan_source.has_value();
            } else {
                pan_source_ok = false;
            }
        }
        auto fade = fade_value ? decoder.unsigned_integer<std::uint64_t>(
                                     *fade_value, pointer_child(pointer, "fadeMs"))
                               : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        auto causality = causality_value
                             ? decoder.enumeration<AudioCausality>(
                                   *causality_value, pointer_child(pointer, "causality"),
                                   {{"causal", AudioCausality::Causal},
                                    {"disposable", AudioCausality::Disposable}})
                             : std::nullopt;
        auto synchronized =
            synchronized_value
                ? decoder.boolean(*synchronized_value, pointer_child(pointer, "synchronized"))
                : std::nullopt;
        auto skip = skip_value ? decoder.enumeration<AudioSkipBehavior>(
                                     *skip_value, pointer_child(pointer, "skipBehavior"),
                                     {{"stop", AudioSkipBehavior::Stop},
                                      {"suppress", AudioSkipBehavior::Suppress},
                                      {"play", AudioSkipBehavior::Play}})
                               : std::nullopt;
        std::optional<std::string> instance_id;
        bool instance_ok = instance_value != nullptr;
        if (instance_value && !instance_value->is_null()) {
            instance_id =
                decoder.string(*instance_value, pointer_child(pointer, "instanceId"), true);
            instance_ok = instance_id.has_value();
        }
        std::optional<std::string> replacement_group;
        bool replacement_ok = replacement_value != nullptr;
        if (replacement_value && !replacement_value->is_null()) {
            replacement_group = decoder.string(*replacement_value,
                                               pointer_child(pointer, "replacementGroup"), true);
            replacement_ok = replacement_group.has_value();
        }
        if (!action || !asset_ok || !purpose || !lifetime || !pause_policy || !gain || !pan ||
            !pan_source_ok || !fade || !waits || !causality || !synchronized || !skip ||
            !instance_ok || !replacement_ok)
            return std::nullopt;
        AudioInstructionWait wait = *waits ? AudioInstructionWait{AudioCompletionWait{}}
                                           : AudioInstructionWait{ImmediateWait{}};
        return AudioCueInstruction{std::move(*id),
                                   std::move(condition),
                                   *action,
                                   std::move(asset),
                                   *purpose,
                                   *lifetime,
                                   *pause_policy,
                                   *gain,
                                   *pan,
                                   std::move(pan_source),
                                   *fade,
                                   std::move(wait),
                                   *causality,
                                   *synchronized,
                                   *skip,
                                   std::move(instance_id),
                                   std::move(replacement_group)};
    }
    if (*kind == "set-global-property") {
        SCENE_FIELDS("property", "value");
        const auto* property_value = decoder.member(value, "property", pointer);
        const auto* assignment_value = decoder.member(value, "value", pointer);
        auto property =
            property_value
                ? decode_reference<PropertyId>(decoder, *property_value,
                                               pointer_child(pointer, "property"), "property")
                : std::nullopt;
        auto assignment = assignment_value ? decode_runtime_value(decoder, *assignment_value,
                                                                  pointer_child(pointer, "value"))
                                           : std::nullopt;
        return property && assignment
                   ? std::optional<SceneInstruction>(SetGlobalPropertySceneInstruction{
                         std::move(*id), std::move(condition), std::move(*property),
                         std::move(*assignment)})
                   : std::nullopt;
    }
    if (*kind == "run-lua") {
        SCENE_FIELDS("autosaveSafePoint", "mayYield", "source");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* yield_value = decoder.member(value, "mayYield", pointer);
        const auto* source_value = decoder.member(value, "source", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto may_yield = yield_value
                             ? decoder.boolean(*yield_value, pointer_child(pointer, "mayYield"))
                             : std::nullopt;
        auto source = source_value
                          ? decoder.string(*source_value, pointer_child(pointer, "source"), true)
                          : std::nullopt;
        return safe && may_yield && source ? std::optional<SceneInstruction>(RunLuaSceneInstruction{
                                                 std::move(*id), std::move(condition), *safe,
                                                 *may_yield, std::move(*source)})
                                           : std::nullopt;
    }
    if (*kind == "wait-duration") {
        SCENE_FIELDS("durationMs", "skippable");
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        if (!duration || !skippable ||
            *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            if (duration)
                decoder.error(k_code_number, "Duration is outside the supported range.",
                              pointer_child(pointer, "durationMs"));
            return std::nullopt;
        }
        auto wait_result = DurationWait::create(std::chrono::milliseconds(*duration));
        std::optional<DurationWait> wait;
        (void)wait_result.transform([&](const DurationWait& decoded) {
            wait = decoded;
            return true;
        });
        return wait ? std::optional<SceneInstruction>(WaitDurationInstruction{
                          std::move(*id), std::move(condition), std::move(*wait), *skippable})
                    : std::nullopt;
    }
    if (*kind == "wait-input") {
        SCENE_FIELDS("skippable");
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        return skippable ? std::optional<SceneInstruction>(WaitInputInstruction{
                               std::move(*id), std::move(condition), *skippable})
                         : std::nullopt;
    }
    if (*kind == "conditional-branch") {
        SCENE_FIELDS("branches", "fallbackInstructionId");
        const auto* branches_value = decoder.member(value, "branches", pointer);
        const auto* fallback_value = decoder.member(value, "fallbackInstructionId", pointer);
        auto branches =
            branches_value
                ? decoder.array<SceneBranch>(
                      *branches_value, pointer_child(pointer, "branches"),
                      [&](const nlohmann::json& branch,
                          const std::string& branch_pointer) -> std::optional<SceneBranch> {
                          if (!decoder.object(branch, branch_pointer,
                                              {"condition", "id", "targetInstructionId"}))
                              return std::nullopt;
                          const auto* branch_id_value =
                              decoder.member(branch, "id", branch_pointer);
                          const auto* branch_condition_value =
                              decoder.member(branch, "condition", branch_pointer);
                          const auto* target_value =
                              decoder.member(branch, "targetInstructionId", branch_pointer);
                          auto branch_id =
                              branch_id_value
                                  ? decoder.id<SceneBranchId>(*branch_id_value,
                                                              pointer_child(branch_pointer, "id"))
                                  : std::nullopt;
                          auto branch_condition =
                              branch_condition_value
                                  ? decode_condition_impl(
                                        decoder, *branch_condition_value,
                                        pointer_child(branch_pointer, "condition"))
                                  : std::nullopt;
                          auto target =
                              target_value
                                  ? decoder.id<SceneStepId>(
                                        *target_value,
                                        pointer_child(branch_pointer, "targetInstructionId"))
                                  : std::nullopt;
                          return branch_id && branch_condition && target
                                     ? std::optional<SceneBranch>(SceneBranch{
                                           std::move(*branch_id), std::move(*branch_condition),
                                           std::move(*target)})
                                     : std::nullopt;
                      })
                : std::nullopt;
        auto fallback = fallback_value
                            ? decoder.id<SceneStepId>(
                                  *fallback_value, pointer_child(pointer, "fallbackInstructionId"))
                            : std::nullopt;
        if (branches)
            decoder.duplicate_ids(
                *branches, pointer_child(pointer, "branches"),
                [](const SceneBranch& branch) -> const SceneBranchId& { return branch.id; });
        return branches && fallback ? std::optional<SceneInstruction>(ConditionalBranchInstruction{
                                          std::move(*id), std::move(condition),
                                          std::move(*branches), std::move(*fallback)})
                                    : std::nullopt;
    }
    if (*kind == "choice") {
        SCENE_FIELDS("autosaveSafePoint", "options", "prompt");
        const auto* safe_value = decoder.member(value, "autosaveSafePoint", pointer);
        const auto* options_value = decoder.member(value, "options", pointer);
        const auto* prompt_value = decoder.member(value, "prompt", pointer);
        auto safe = safe_value
                        ? decoder.boolean(*safe_value, pointer_child(pointer, "autosaveSafePoint"))
                        : std::nullopt;
        auto options =
            options_value
                ? decoder.array<SceneChoiceOption>(
                      *options_value, pointer_child(pointer, "options"),
                      [&](const nlohmann::json& option,
                          const std::string& option_pointer) -> std::optional<SceneChoiceOption> {
                          if (!decoder.object(
                                  option, option_pointer,
                                  {"condition", "effects", "id", "label", "targetInstructionId"}))
                              return std::nullopt;
                          const auto* option_id_value =
                              decoder.member(option, "id", option_pointer);
                          const auto* effects_value =
                              decoder.member(option, "effects", option_pointer);
                          const auto* label_value = decoder.member(option, "label", option_pointer);
                          const auto* target_value =
                              decoder.member(option, "targetInstructionId", option_pointer);
                          auto option_id =
                              option_id_value
                                  ? decoder.id<SceneChoiceOptionId>(
                                        *option_id_value, pointer_child(option_pointer, "id"))
                                  : std::nullopt;
                          bool option_condition_ok = false;
                          auto option_condition = decode_optional_condition(
                              decoder, option, option_pointer, option_condition_ok);
                          auto effects =
                              effects_value
                                  ? decode_effects(decoder, *effects_value,
                                                   pointer_child(option_pointer, "effects"))
                                  : std::nullopt;
                          auto label = label_value
                                           ? decode_text(decoder, *label_value,
                                                         pointer_child(option_pointer, "label"))
                                           : std::nullopt;
                          auto target =
                              target_value
                                  ? decoder.id<SceneStepId>(
                                        *target_value,
                                        pointer_child(option_pointer, "targetInstructionId"))
                                  : std::nullopt;
                          if (option_id && option_condition_ok && effects && label && target)
                              return SceneChoiceOption{
                                  std::move(*option_id), std::move(option_condition),
                                  std::move(*effects), std::move(*label), std::move(*target)};
                          return std::nullopt;
                      })
                : std::nullopt;
        if (options && options->empty()) {
            decoder.error(k_code_type, "At least one choice option is required.",
                          pointer_child(pointer, "options"));
            options.reset();
        }
        std::optional<TextContent> prompt;
        bool prompt_ok = prompt_value != nullptr;
        if (prompt_value && !prompt_value->is_null()) {
            prompt = decode_text(decoder, *prompt_value, pointer_child(pointer, "prompt"));
            prompt_ok = prompt.has_value();
        }
        if (options)
            decoder.duplicate_ids(
                *options, pointer_child(pointer, "options"),
                [](const SceneChoiceOption& option) -> const SceneChoiceOptionId& {
                    return option.id;
                });
        return safe && options && prompt_ok
                   ? std::optional<SceneInstruction>(
                         ChoiceSceneInstruction{std::move(*id), std::move(condition), *safe,
                                                std::move(*options), std::move(prompt)})
                   : std::nullopt;
    }
    if (*kind == "set-layout") {
        SCENE_FIELDS("action", "durationMs", "layout", "scaleOverrides", "skippable", "slot",
                     "transition", "waitForCompletion");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* layout_value = decoder.member(value, "layout", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* slot_value = decoder.member(value, "slot", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto action =
            action_value
                ? decoder.enumeration<LayoutAction>(*action_value, pointer_child(pointer, "action"),
                                                    {{"show", LayoutAction::Show},
                                                     {"hide", LayoutAction::Hide},
                                                     {"swap", LayoutAction::Swap}})
                : std::nullopt;
        std::optional<LayoutId> layout;
        bool layout_ok = layout_value != nullptr;
        if (layout_value && !layout_value->is_null()) {
            layout = decode_reference<LayoutId>(decoder, *layout_value,
                                                pointer_child(pointer, "layout"), "layout");
            layout_ok = layout.has_value();
        }
        auto slot =
            slot_value
                ? decoder.enumeration<LayoutSlot>(*slot_value, pointer_child(pointer, "slot"),
                                                  {{"hud", LayoutSlot::Hud},
                                                   {"dialogue-box", LayoutSlot::DialogueBox},
                                                   {"overlay", LayoutSlot::Overlay},
                                                   {"custom", LayoutSlot::Custom}})
                : std::nullopt;
        auto transition =
            transition_value
                ? decoder.enumeration<LayoutTransition>(
                      *transition_value, pointer_child(pointer, "transition"),
                      {{"none", LayoutTransition::None}, {"fade", LayoutTransition::Fade}})
                : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        LayoutScaleOverrides scale_overrides;
        const bool scale_overrides_ok =
            decode_layout_scale_overrides(decoder, value, pointer, scale_overrides);
        if (action && layout_ok) {
            if ((*action == LayoutAction::Hide) != !layout.has_value()) {
                decoder.error(k_code_variant,
                              "Hide Layout changes require no Layout; show and swap require one.",
                              pointer_child(pointer, "layout"));
                layout_ok = false;
            }
        }
        if (transition && duration && waits) {
            if (*transition == LayoutTransition::None && (*duration != 0 || *waits)) {
                decoder.error(k_code_variant,
                              "Immediate Layout changes require zero duration and no wait.",
                              pointer_child(pointer, "transition"));
                duration.reset();
            } else if (*transition == LayoutTransition::Fade && *duration == 0) {
                decoder.error(k_code_number,
                              "Animated Layout transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            }
        }
        PresentationInstructionWait wait =
            waits && *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                            : PresentationInstructionWait{ImmediateWait{}};
        return action && duration && layout_ok && scale_overrides_ok && skippable && slot &&
                       transition && waits
                   ? std::optional<SceneInstruction>(
                         SetLayoutInstruction{std::move(*id), std::move(condition), *action,
                                              std::move(layout), std::move(scale_overrides), *slot,
                                              *transition, *duration, std::move(wait), *skippable})
                   : std::nullopt;
    }
    if (*kind == "material-parameter") {
        SCENE_FIELDS("clock", "durationMs", "easing", "material", "parameter", "skippable",
                     "target", "transition", "value", "waitForCompletion");
        const auto* target_value = decoder.member(value, "target", pointer);
        const auto* material_value = decoder.member(value, "material", pointer);
        const auto* parameter_value = decoder.member(value, "parameter", pointer);
        const auto* parameter_payload = decoder.member(value, "value", pointer);
        const auto* transition_value = decoder.member(value, "transition", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* easing_value = decoder.member(value, "easing", pointer);
        const auto* clock_value = decoder.member(value, "clock", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);

        std::optional<MaterialOccurrenceInstructionTarget> target;
        if (target_value && target_value->is_object()) {
            const auto target_pointer = pointer_child(pointer, "target");
            const auto* target_kind_value = decoder.member(*target_value, "kind", target_pointer);
            auto target_kind =
                target_kind_value
                    ? decoder.string(*target_kind_value, pointer_child(target_pointer, "kind"))
                    : std::nullopt;
            if (target_kind && *target_kind == "background" &&
                decoder.object(*target_value, target_pointer, {"kind"})) {
                target = BackgroundMaterialInstructionTarget{};
            } else if (target_kind && *target_kind == "actor" &&
                       decoder.object(*target_value, target_pointer,
                                      {"kind", "layerId", "slotId"})) {
                const auto* slot_value = decoder.member(*target_value, "slotId", target_pointer);
                const auto* layer_value = decoder.member(*target_value, "layerId", target_pointer);
                auto slot = slot_value ? decoder.id<ActorSlotId>(
                                             *slot_value, pointer_child(target_pointer, "slotId"))
                                       : std::nullopt;
                auto layer = layer_value
                                 ? decoder.id<CharacterPresentationLayerId>(
                                       *layer_value, pointer_child(target_pointer, "layerId"))
                                 : std::nullopt;
                if (slot && layer)
                    target = ActorMaterialInstructionTarget{std::move(*slot), std::move(*layer)};
            } else if (target_kind && *target_kind == "layout" &&
                       decoder.object(*target_value, target_pointer, {"kind", "slot"})) {
                const auto* slot_value = decoder.member(*target_value, "slot", target_pointer);
                auto slot = slot_value ? decoder.enumeration<LayoutSlot>(
                                             *slot_value, pointer_child(target_pointer, "slot"),
                                             {{"hud", LayoutSlot::Hud},
                                              {"dialogue-box", LayoutSlot::DialogueBox},
                                              {"overlay", LayoutSlot::Overlay},
                                              {"custom", LayoutSlot::Custom}})
                                       : std::nullopt;
                if (slot)
                    target = LayoutMaterialInstructionTarget{*slot};
            } else if (target_kind && *target_kind == "postprocess" &&
                       decoder.object(*target_value, target_pointer, {"instanceId", "kind"})) {
                const auto* instance_value =
                    decoder.member(*target_value, "instanceId", target_pointer);
                auto instance = instance_value ? decoder.id<PostprocessEffectInstanceId>(
                                                     *instance_value,
                                                     pointer_child(target_pointer, "instanceId"))
                                               : std::nullopt;
                if (instance)
                    target = PostprocessMaterialInstructionTarget{std::move(*instance)};
            } else if (target_kind) {
                decoder.error(k_code_variant, "Unknown Material occurrence target.",
                              pointer_child(target_pointer, "kind"));
            }
        } else if (target_value) {
            decoder.error(k_code_type, "Expected a Material occurrence target object.",
                          pointer_child(pointer, "target"));
        }
        auto material =
            material_value
                ? decode_reference<MaterialId>(decoder, *material_value,
                                               pointer_child(pointer, "material"), "material")
                : std::nullopt;
        auto parameter = parameter_value
                             ? decoder.string(*parameter_value, pointer_child(pointer, "parameter"))
                             : std::nullopt;
        auto parameter_data = parameter_payload
                                  ? decode_material_parameter_value(decoder, *parameter_payload,
                                                                    pointer_child(pointer, "value"))
                                  : std::nullopt;
        auto transition = transition_value
                              ? decoder.enumeration<MaterialParameterTransition>(
                                    *transition_value, pointer_child(pointer, "transition"),
                                    {{"none", MaterialParameterTransition::None},
                                     {"tween", MaterialParameterTransition::Tween}})
                              : std::nullopt;
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto easing = easing_value ? decoder.enumeration<MaterialEasing>(
                                         *easing_value, pointer_child(pointer, "easing"),
                                         {{"linear", MaterialEasing::Linear},
                                          {"ease-in", MaterialEasing::EaseIn},
                                          {"ease-out", MaterialEasing::EaseOut},
                                          {"ease-in-out", MaterialEasing::EaseInOut}})
                                   : std::nullopt;
        auto clock = clock_value
                         ? decoder.enumeration<MaterialClock>(
                               *clock_value, pointer_child(pointer, "clock"),
                               {{"gameplay", MaterialClock::Gameplay},
                                {"unscaled-presentation", MaterialClock::UnscaledPresentation}})
                         : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        if (transition && duration && waits) {
            if (*transition == MaterialParameterTransition::None && (*duration != 0 || *waits)) {
                decoder.error(
                    k_code_variant,
                    "Immediate Material Parameter assignments require zero duration and no wait.",
                    pointer_child(pointer, "transition"));
                duration.reset();
            } else if (*transition == MaterialParameterTransition::Tween && *duration == 0) {
                decoder.error(k_code_number,
                              "Material Parameter transitions require a positive duration.",
                              pointer_child(pointer, "durationMs"));
                duration.reset();
            }
        }
        PresentationInstructionWait wait =
            waits && *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                            : PresentationInstructionWait{ImmediateWait{}};
        return target && material && parameter && !parameter->empty() && parameter_data &&
                       transition && duration && easing && clock && waits && skippable
                   ? std::optional<SceneInstruction>(MaterialParameterInstruction{
                         std::move(*id), std::move(condition), std::move(*target),
                         std::move(*material), std::move(*parameter), std::move(*parameter_data),
                         *transition, *duration, *easing, *clock, std::move(wait), *skippable})
                   : std::nullopt;
    }
    if (*kind == "postprocess-effect") {
        SCENE_FIELDS("action", "clock", "instanceId", "material", "order", "parameters", "scope");
        const auto* action_value = decoder.member(value, "action", pointer);
        const auto* instance_value = decoder.member(value, "instanceId", pointer);
        const auto* material_value = decoder.member(value, "material", pointer);
        const auto* scope_value = decoder.member(value, "scope", pointer);
        const auto* order_value = decoder.member(value, "order", pointer);
        const auto* clock_value = decoder.member(value, "clock", pointer);
        const auto* parameters_value = decoder.member(value, "parameters", pointer);
        auto action = action_value ? decoder.enumeration<PostprocessEffectAction>(
                                         *action_value, pointer_child(pointer, "action"),
                                         {{"upsert", PostprocessEffectAction::Upsert},
                                          {"remove", PostprocessEffectAction::Remove}})
                                   : std::nullopt;
        auto instance = instance_value ? decoder.id<PostprocessEffectInstanceId>(
                                             *instance_value, pointer_child(pointer, "instanceId"))
                                       : std::nullopt;
        std::optional<MaterialId> material;
        bool material_ok = material_value != nullptr;
        if (material_value && !material_value->is_null()) {
            material = decode_reference<MaterialId>(decoder, *material_value,
                                                    pointer_child(pointer, "material"), "material");
            material_ok = material.has_value();
        }
        auto scope = scope_value
                         ? decoder.enumeration<MaterialPostprocessScope>(
                               *scope_value, pointer_child(pointer, "scope"),
                               {{"world", MaterialPostprocessScope::World},
                                {"full-game-viewport", MaterialPostprocessScope::FullGameViewport}})
                         : std::nullopt;
        std::optional<std::int32_t> order;
        if (order_value) {
            if (!order_value->is_number_integer())
                decoder.error(k_code_number, "Postprocess order must be an integer.",
                              pointer_child(pointer, "order"));
            else {
                const auto wide = order_value->get<std::int64_t>();
                if (wide < std::numeric_limits<std::int32_t>::min() ||
                    wide > std::numeric_limits<std::int32_t>::max())
                    decoder.error(k_code_number, "Postprocess order exceeds the supported range.",
                                  pointer_child(pointer, "order"));
                else
                    order = static_cast<std::int32_t>(wide);
            }
        }
        auto clock = clock_value
                         ? decoder.enumeration<MaterialClock>(
                               *clock_value, pointer_child(pointer, "clock"),
                               {{"gameplay", MaterialClock::Gameplay},
                                {"unscaled-presentation", MaterialClock::UnscaledPresentation}})
                         : std::nullopt;
        auto parameters =
            parameters_value
                ? decoder.array<PostprocessEffectParameter>(
                      *parameters_value, pointer_child(pointer, "parameters"),
                      [&](const nlohmann::json& item, const std::string& item_pointer)
                          -> std::optional<PostprocessEffectParameter> {
                          if (!decoder.object(item, item_pointer, {"name", "value"}))
                              return std::nullopt;
                          const auto* name_value = decoder.member(item, "name", item_pointer);
                          const auto* payload = decoder.member(item, "value", item_pointer);
                          auto name =
                              name_value
                                  ? decoder.string(*name_value, pointer_child(item_pointer, "name"))
                                  : std::nullopt;
                          auto data =
                              payload ? decode_material_parameter_value(
                                            decoder, *payload, pointer_child(item_pointer, "value"))
                                      : std::nullopt;
                          return name && !name->empty() && data
                                     ? std::optional<PostprocessEffectParameter>(
                                           PostprocessEffectParameter{std::move(*name),
                                                                      std::move(*data)})
                                     : std::nullopt;
                      })
                : std::nullopt;
        if (parameters) {
            std::unordered_set<std::string> names;
            for (std::size_t index = 0; index < parameters->size(); ++index) {
                if (!names.emplace((*parameters)[index].name).second)
                    decoder.error(
                        k_code_duplicate, "Duplicate Postprocess Material Parameter name.",
                        pointer_child(pointer_child(pointer, "parameters"), std::to_string(index)) +
                            "/name");
            }
        }
        if (action && material_ok && parameters &&
            ((*action == PostprocessEffectAction::Remove) != !material.has_value())) {
            decoder.error(
                k_code_variant,
                "Removing a Postprocess Effect requires no Material; upsert requires one.",
                pointer_child(pointer, "material"));
            material_ok = false;
        }
        if (action && *action == PostprocessEffectAction::Remove && parameters &&
            !parameters->empty()) {
            decoder.error(k_code_variant,
                          "Removing a Postprocess Effect cannot assign Material Parameters.",
                          pointer_child(pointer, "parameters"));
            parameters.reset();
        }
        return action && instance && material_ok && scope && order && clock && parameters
                   ? std::optional<SceneInstruction>(PostprocessEffectInstruction{
                         std::move(*id), std::move(condition), *action, std::move(*instance),
                         std::move(material), *scope, *order, *clock, std::move(*parameters)})
                   : std::nullopt;
    }
    if (*kind == "transition-group") {
        SCENE_FIELDS("children", "color", "durationMs", "skippable", "transitionKind",
                     "waitForCompletion");
        const auto* children_value = decoder.member(value, "children", pointer);
        const auto* color_value = decoder.member(value, "color", pointer);
        const auto* duration_value = decoder.member(value, "durationMs", pointer);
        const auto* skippable_value = decoder.member(value, "skippable", pointer);
        const auto* transition_value = decoder.member(value, "transitionKind", pointer);
        const auto* wait_value = decoder.member(value, "waitForCompletion", pointer);
        auto children =
            children_value
                ? decoder.array<TransitionGroupMutation>(
                      *children_value, pointer_child(pointer, "children"),
                      [&](const nlohmann::json& child, const std::string& child_pointer)
                          -> std::optional<TransitionGroupMutation> {
                          if (!child.is_object()) {
                              decoder.error(k_code_type, "Expected a TransitionGroup child object.",
                                            child_pointer);
                              return std::nullopt;
                          }
                          const auto* child_kind_value =
                              decoder.member(child, "kind", child_pointer);
                          const auto* child_id_value = decoder.member(child, "id", child_pointer);
                          auto child_kind =
                              child_kind_value
                                  ? decoder.string(*child_kind_value,
                                                   pointer_child(child_pointer, "kind"))
                                  : std::nullopt;
                          auto child_id = child_id_value ? decoder.id<TransitionGroupChildId>(
                                                               *child_id_value,
                                                               pointer_child(child_pointer, "id"))
                                                         : std::nullopt;
                          if (!child_kind || !child_id)
                              return std::nullopt;
                          if (*child_kind == "clear-background") {
                              if (!decoder.object(child, child_pointer, {"id", "kind"}))
                                  return std::nullopt;
                              return TransitionGroupClearBackgroundMutation{std::move(*child_id)};
                          }
                          if (*child_kind == "set-background") {
                              if (!decoder.object(
                                      child, child_pointer,
                                      {"asset", "color", "fit", "id", "kind", "material"}))
                                  return std::nullopt;
                              const auto* asset_value =
                                  decoder.member(child, "asset", child_pointer);
                              const auto* child_color_value =
                                  decoder.member(child, "color", child_pointer);
                              const auto* fit_value = decoder.member(child, "fit", child_pointer);
                              const auto* material_value =
                                  decoder.member(child, "material", child_pointer);
                              std::optional<AssetId> asset;
                              bool asset_ok = asset_value != nullptr;
                              if (asset_value && !asset_value->is_null()) {
                                  asset = decode_reference<AssetId>(
                                      decoder, *asset_value, pointer_child(child_pointer, "asset"),
                                      "asset");
                                  asset_ok = asset.has_value();
                              }
                              std::optional<std::string> child_color;
                              bool child_color_ok = child_color_value != nullptr;
                              if (child_color_value && !child_color_value->is_null()) {
                                  child_color = decoder.string(
                                      *child_color_value, pointer_child(child_pointer, "color"));
                                  child_color_ok = child_color.has_value();
                              }
                              auto fit = fit_value
                                             ? decoder.enumeration<BackgroundFit>(
                                                   *fit_value, pointer_child(child_pointer, "fit"),
                                                   {{"cover", BackgroundFit::Cover},
                                                    {"contain", BackgroundFit::Contain},
                                                    {"stretch", BackgroundFit::Stretch},
                                                    {"center", BackgroundFit::Center}})
                                             : std::nullopt;
                              std::optional<MaterialId> material;
                              bool material_ok = material_value != nullptr;
                              if (material_value && !material_value->is_null()) {
                                  material = decode_reference<MaterialId>(
                                      decoder, *material_value,
                                      pointer_child(child_pointer, "material"), "material");
                                  material_ok = material.has_value();
                              }
                              if (!asset_ok || !child_color_ok || !fit || !material_ok)
                                  return std::nullopt;
                              return TransitionGroupSetBackgroundMutation{
                                  std::move(*child_id),
                                  BackgroundPresentation{std::move(asset), std::move(child_color),
                                                         *fit, std::move(material)}};
                          }
                          if (*child_kind == "actor-cue") {
                              if (!decoder.object(child, child_pointer,
                                                  {"action", "appearanceId", "character",
                                                   "expressionId", "id", "kind", "offset", "poseId",
                                                   "position", "profileId", "scale", "slotId"}))
                                  return std::nullopt;
                              const auto* action_value =
                                  decoder.member(child, "action", child_pointer);
                              const auto* character_value =
                                  decoder.member(child, "character", child_pointer);
                              const auto* profile_value =
                                  decoder.member(child, "profileId", child_pointer);
                              const auto* expression_value =
                                  decoder.member(child, "expressionId", child_pointer);
                              const auto* appearance_value =
                                  decoder.member(child, "appearanceId", child_pointer);
                              const auto* offset_value =
                                  decoder.member(child, "offset", child_pointer);
                              const auto* pose_value =
                                  decoder.member(child, "poseId", child_pointer);
                              const auto* position_value =
                                  decoder.member(child, "position", child_pointer);
                              const auto* scale_value =
                                  decoder.member(child, "scale", child_pointer);
                              const auto* slot_value =
                                  decoder.member(child, "slotId", child_pointer);
                              auto action =
                                  action_value
                                      ? decoder.enumeration<ActorCueAction>(
                                            *action_value, pointer_child(child_pointer, "action"),
                                            {{"show", ActorCueAction::Show},
                                             {"hide", ActorCueAction::Hide},
                                             {"move", ActorCueAction::Move},
                                             {"profile", ActorCueAction::Profile},
                                             {"pose", ActorCueAction::Pose},
                                             {"expression", ActorCueAction::Expression},
                                             {"appearance", ActorCueAction::Appearance}})
                                      : std::nullopt;
                              auto character =
                                  character_value
                                      ? decode_reference<CharacterId>(
                                            decoder, *character_value,
                                            pointer_child(child_pointer, "character"), "character")
                                      : std::nullopt;
                              std::optional<CharacterPresentationProfileId> profile;
                              bool profile_ok = profile_value != nullptr;
                              if (profile_value && !profile_value->is_null()) {
                                  profile = decoder.id<CharacterPresentationProfileId>(
                                      *profile_value, pointer_child(child_pointer, "profileId"));
                                  profile_ok = profile.has_value();
                              }
                              std::optional<CharacterExpressionId> expression;
                              bool expression_ok = expression_value != nullptr;
                              if (expression_value && !expression_value->is_null()) {
                                  expression = decoder.id<CharacterExpressionId>(
                                      *expression_value,
                                      pointer_child(child_pointer, "expressionId"));
                                  expression_ok = expression.has_value();
                              }
                              std::optional<CharacterAppearanceId> appearance;
                              bool appearance_ok = appearance_value != nullptr;
                              if (appearance_value && !appearance_value->is_null()) {
                                  appearance = decoder.id<CharacterAppearanceId>(
                                      *appearance_value,
                                      pointer_child(child_pointer, "appearanceId"));
                                  appearance_ok = appearance.has_value();
                              }
                              auto offset =
                                  offset_value
                                      ? decode_vector2(decoder, *offset_value,
                                                       pointer_child(child_pointer, "offset"))
                                      : std::nullopt;
                              std::optional<CharacterPoseId> pose;
                              bool pose_ok = pose_value != nullptr;
                              if (pose_value && !pose_value->is_null()) {
                                  pose = decoder.id<CharacterPoseId>(
                                      *pose_value, pointer_child(child_pointer, "poseId"));
                                  pose_ok = pose.has_value();
                              }
                              auto position = position_value
                                                  ? decoder.enumeration<ActorPosition>(
                                                        *position_value,
                                                        pointer_child(child_pointer, "position"),
                                                        {{"left", ActorPosition::Left},
                                                         {"center", ActorPosition::Center},
                                                         {"right", ActorPosition::Right},
                                                         {"custom", ActorPosition::Custom}})
                                                  : std::nullopt;
                              auto scale =
                                  scale_value
                                      ? decoder.finite_number(*scale_value,
                                                              pointer_child(child_pointer, "scale"))
                                      : std::nullopt;
                              if (scale && *scale <= 0.0) {
                                  decoder.error(k_code_number, "Scale must be positive.",
                                                pointer_child(child_pointer, "scale"));
                                  scale.reset();
                              }
                              auto slot = slot_value ? decoder.id<ActorSlotId>(
                                                           *slot_value,
                                                           pointer_child(child_pointer, "slotId"))
                                                     : std::nullopt;
                              if (!action || !character || !profile_ok || !expression_ok ||
                                  !appearance_ok || !offset || !pose_ok || !position || !scale ||
                                  !slot)
                                  return std::nullopt;
                              return TransitionGroupActorMutation{std::move(*child_id),
                                                                  *action,
                                                                  std::move(*character),
                                                                  std::move(profile),
                                                                  std::move(expression),
                                                                  std::move(appearance),
                                                                  std::move(*offset),
                                                                  std::move(pose),
                                                                  *position,
                                                                  *scale,
                                                                  std::move(*slot)};
                          }
                          if (*child_kind == "set-layout") {
                              if (!decoder.object(child, child_pointer,
                                                  {"action", "id", "kind", "layout", "plane",
                                                   "scaleOverrides", "slot"}))
                                  return std::nullopt;
                              const auto* action_value =
                                  decoder.member(child, "action", child_pointer);
                              const auto* layout_value =
                                  decoder.member(child, "layout", child_pointer);
                              const auto* plane_value =
                                  decoder.member(child, "plane", child_pointer);
                              const auto* slot_value = decoder.member(child, "slot", child_pointer);
                              auto action =
                                  action_value
                                      ? decoder.enumeration<LayoutAction>(
                                            *action_value, pointer_child(child_pointer, "action"),
                                            {{"show", LayoutAction::Show},
                                             {"hide", LayoutAction::Hide},
                                             {"swap", LayoutAction::Swap}})
                                      : std::nullopt;
                              std::optional<LayoutId> layout;
                              bool layout_ok = layout_value != nullptr;
                              if (layout_value && !layout_value->is_null()) {
                                  layout = decode_reference<LayoutId>(
                                      decoder, *layout_value,
                                      pointer_child(child_pointer, "layout"), "layout");
                                  layout_ok = layout.has_value();
                              }
                              auto plane =
                                  plane_value
                                      ? decoder.string(*plane_value,
                                                       pointer_child(child_pointer, "plane"))
                                      : std::nullopt;
                              if (plane && *plane != "world-overlay") {
                                  decoder.error(k_code_enum,
                                                "TransitionGroup Layout children must target "
                                                "world-overlay.",
                                                pointer_child(child_pointer, "plane"));
                                  plane.reset();
                              }
                              auto slot = slot_value ? decoder.enumeration<LayoutSlot>(
                                                           *slot_value,
                                                           pointer_child(child_pointer, "slot"),
                                                           {{"overlay", LayoutSlot::Overlay},
                                                            {"custom", LayoutSlot::Custom}})
                                                     : std::nullopt;
                              LayoutScaleOverrides scale_overrides;
                              const bool scale_overrides_ok = decode_layout_scale_overrides(
                                  decoder, child, child_pointer, scale_overrides);
                              if (!action || !layout_ok || !plane || !scale_overrides_ok || !slot)
                                  return std::nullopt;
                              if ((*action == LayoutAction::Hide) != !layout.has_value()) {
                                  decoder.error(k_code_variant,
                                                "Hide Layout children require no Layout; show and "
                                                "swap require one.",
                                                pointer_child(child_pointer, "layout"));
                                  return std::nullopt;
                              }
                              return TransitionGroupLayoutMutation{
                                  std::move(*child_id), *action, std::move(layout),
                                  std::move(scale_overrides), *slot};
                          }
                          decoder.object(child, child_pointer, {"id", "kind"});
                          decoder.error(k_code_variant,
                                        "Unknown TransitionGroup child variant '" + *child_kind +
                                            "'.",
                                        pointer_child(child_pointer, "kind"));
                          return std::nullopt;
                      })
                : std::nullopt;
        std::optional<std::string> color;
        bool color_ok = color_value != nullptr;
        if (color_value && !color_value->is_null()) {
            color = decoder.string(*color_value, pointer_child(pointer, "color"));
            color_ok = color.has_value();
        }
        auto duration = duration_value ? decoder.unsigned_integer<std::uint64_t>(
                                             *duration_value, pointer_child(pointer, "durationMs"))
                                       : std::nullopt;
        auto skippable =
            skippable_value ? decoder.boolean(*skippable_value, pointer_child(pointer, "skippable"))
                            : std::nullopt;
        auto transition = transition_value
                              ? decoder.enumeration<TransitionKind>(
                                    *transition_value, pointer_child(pointer, "transitionKind"),
                                    {{"fade", TransitionKind::Fade},
                                     {"cut", TransitionKind::Cut},
                                     {"dissolve", TransitionKind::Dissolve}})
                              : std::nullopt;
        auto waits = wait_value
                         ? decoder.boolean(*wait_value, pointer_child(pointer, "waitForCompletion"))
                         : std::nullopt;
        if (children && children->empty()) {
            decoder.error(k_code_type, "TransitionGroup requires at least one child.",
                          pointer_child(pointer, "children"));
            children.reset();
        }
        if (children)
            decoder.duplicate_ids(
                *children, pointer_child(pointer, "children"),
                [](const TransitionGroupMutation& child) -> const TransitionGroupChildId& {
                    return std::visit(
                        [](const auto& typed) -> const TransitionGroupChildId& { return typed.id; },
                        child);
                });
        if (!children || !color_ok || !duration || !skippable || !transition || !waits)
            return std::nullopt;
        if (*transition == TransitionKind::Cut && (*duration != 0 || *waits || color.has_value())) {
            decoder.error(
                k_code_variant,
                "Cut TransitionGroup values require zero duration, no wait, and no color.",
                pointer_child(pointer, "transitionKind"));
            return std::nullopt;
        }
        if (*transition != TransitionKind::Cut && *duration == 0) {
            decoder.error(k_code_number,
                          "Animated TransitionGroup values require a positive duration.",
                          pointer_child(pointer, "durationMs"));
            return std::nullopt;
        }
        if (*transition == TransitionKind::Dissolve && color.has_value()) {
            decoder.error(k_code_variant, "Dissolve TransitionGroup values do not accept a color.",
                          pointer_child(pointer, "color"));
            return std::nullopt;
        }
        PresentationInstructionWait wait =
            *waits ? PresentationInstructionWait{PresentationCompletionWait{}}
                   : PresentationInstructionWait{ImmediateWait{}};
        return TransitionGroupInstruction{std::move(*id), std::move(condition), std::move(color),
                                          *duration,      *transition,          std::move(wait),
                                          *skippable,     std::move(*children)};
    }
#undef SCENE_FIELDS
    decoder.object(value, pointer, {"condition", "id", "kind"});
    decoder.error(k_code_variant, "Unknown Scene instruction variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<SceneDefinition> decode_scene(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"continuation", "defaultBackground", "defaultLayout", "displayName", "id", "program"}))
        return std::nullopt;
    auto identity = decode_definition_identity<SceneId>(decoder, value, pointer);
    const auto* display_value = decoder.member(value, "displayName", pointer);
    const auto* background_value = decoder.member(value, "defaultBackground", pointer);
    const auto* layout_value = decoder.member(value, "defaultLayout", pointer);
    const auto* program_value = decoder.member(value, "program", pointer);
    const auto* continuation_value = decoder.member(value, "continuation", pointer);
    auto display = display_value
                       ? decoder.string(*display_value, pointer_child(pointer, "displayName"))
                       : std::nullopt;
    auto background = background_value
                          ? decode_background(decoder, *background_value,
                                              pointer_child(pointer, "defaultBackground"))
                          : std::nullopt;
    std::optional<LayoutId> layout;
    bool layout_ok = layout_value != nullptr;
    if (layout_value && !layout_value->is_null()) {
        layout = decode_reference<LayoutId>(decoder, *layout_value,
                                            pointer_child(pointer, "defaultLayout"), "layout");
        layout_ok = layout.has_value();
    }
    std::optional<SceneProgram> program;
    if (program_value &&
        decoder.object(*program_value, pointer_child(pointer, "program"), {"instructions"})) {
        const auto program_pointer = pointer_child(pointer, "program");
        const auto* instructions_value =
            decoder.member(*program_value, "instructions", program_pointer);
        auto instructions =
            instructions_value
                ? decoder.array<SceneInstruction>(
                      *instructions_value, pointer_child(program_pointer, "instructions"),
                      [&](const nlohmann::json& instruction,
                          const std::string& instruction_pointer) {
                          return decode_scene_instruction(decoder, instruction,
                                                          instruction_pointer);
                      })
                : std::nullopt;
        if (instructions) {
            decoder.duplicate_ids(
                *instructions, pointer_child(program_pointer, "instructions"),
                [](const SceneInstruction& instruction) -> const SceneStepId& {
                    return std::visit(
                        [](const auto& typed) -> const SceneStepId& { return typed.id; },
                        instruction);
                });
            program = SceneProgram{std::move(*instructions)};
        }
    }
    auto continuation = continuation_value
                            ? decode_flow_target_impl(decoder, *continuation_value,
                                                      pointer_child(pointer, "continuation"))
                            : std::nullopt;
    if (!identity || !display || !background || !layout_ok || !program || !continuation)
        return std::nullopt;
    return SceneDefinition{std::move(*identity), std::move(*display), std::move(*background),
                           std::move(layout),    std::move(*program), std::move(*continuation)};
}

} // namespace noveltea::core::compiled::wire::detail
