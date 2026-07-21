#include "codec_internal.hpp"

namespace noveltea::core::save_state_codec {
namespace {

template<class Enum> nlohmann::json encode_enum(Enum value)
{
    return static_cast<std::uint8_t>(value);
}

template<class Enum>
std::optional<Enum> decode_enum(Decoder& d, const nlohmann::json& value, std::string_view pointer,
                                Enum maximum)
{
    auto number = d.unsigned_integer<std::uint8_t>(value, pointer);
    if (!number)
        return std::nullopt;
    const auto decoded = static_cast<Enum>(*number);
    if (decoded > maximum) {
        d.error(k_value, "Enumeration value is outside the supported range.", std::string(pointer));
        return std::nullopt;
    }
    return decoded;
}

std::optional<double> decode_number(Decoder& d, const nlohmann::json& value,
                                    std::string_view pointer)
{
    auto result = json_access::get<double>(value);
    if (!result || !std::isfinite(*result)) {
        d.error(k_type, "Expected a finite number.", std::string(pointer));
        return std::nullopt;
    }
    return result;
}

std::optional<std::int32_t> decode_order(Decoder& d, const nlohmann::json& value,
                                         std::string_view pointer)
{
    auto result = json_access::get<std::int32_t>(value);
    if (!result)
        d.error(k_type, "Expected a signed 32-bit integer.", std::string(pointer));
    return result;
}

std::optional<std::optional<std::string>>
decode_optional_string(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<std::string>{};
    auto decoded = d.string(value, pointer);
    return decoded ? std::optional<std::optional<std::string>>{std::move(*decoded)} : std::nullopt;
}

template<class Id>
std::optional<std::optional<Id>> decode_optional_id_value(Decoder& d, const nlohmann::json& value,
                                                          std::string_view pointer)
{
    auto decoded = d.optional_id<Id>(value, pointer);
    return decoded ? std::optional<std::optional<Id>>{std::move(decoded.value)} : std::nullopt;
}

nlohmann::json encode_presentation_owner(const SavedPresentationOwner& owner)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedScenePresentationOwner>)
                return {{"kind", "scene"},
                        {"invocation", value.invocation.value},
                        {"scene", value.scene.text()}};
            else if constexpr (std::is_same_v<T, SavedCurrentRoomPresentationOwner>)
                return {{"kind", "current-room"}, {"room", value.room.text()}};
            else if constexpr (std::is_same_v<T, SavedRoomPresentationOwner>)
                return {{"kind", "room"}, {"room", value.room.text()}};
            else
                return {{"kind", "session"}};
        },
        owner);
}

std::optional<SavedPresentationOwner>
decode_presentation_owner(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a presentation owner object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = d.member(value, "kind", pointer);
    auto kind = kind_value ? d.string(*kind_value, child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "scene") {
        d.object(value, pointer, {"kind", "invocation", "scene"});
        const auto* invocation_value = d.member(value, "invocation", pointer);
        const auto* scene_value = d.member(value, "scene", pointer);
        auto invocation =
            invocation_value ? d.unsigned_integer<std::uint64_t>(*invocation_value,
                                                                 child(pointer, "invocation"), true)
                             : std::nullopt;
        auto scene =
            scene_value ? d.id<SceneId>(*scene_value, child(pointer, "scene")) : std::nullopt;
        return invocation && scene
                   ? std::optional<SavedPresentationOwner>{SavedScenePresentationOwner{
                         SavedFlowFrameId{*invocation}, std::move(*scene)}}
                   : std::nullopt;
    }
    if (*kind == "current-room" || *kind == "room") {
        d.object(value, pointer, {"kind", "room"});
        const auto* room_value = d.member(value, "room", pointer);
        auto room = room_value ? d.id<RoomId>(*room_value, child(pointer, "room")) : std::nullopt;
        if (!room)
            return std::nullopt;
        if (*kind == "current-room")
            return SavedCurrentRoomPresentationOwner{std::move(*room)};
        return SavedRoomPresentationOwner{std::move(*room)};
    }
    if (*kind == "session") {
        d.object(value, pointer, {"kind"});
        return SavedSessionPresentationOwner{};
    }
    d.error(k_variant, "Unknown presentation owner kind '" + *kind + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_actor_key(const SavedActorPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CharacterActorKey>)
                return {{"kind", "character"}, {"character", value.character.text()}};
            else if constexpr (std::is_same_v<T, RoomCastActorKey>)
                return {{"kind", "room-cast"},
                        {"room", value.room.text()},
                        {"entry", value.entry.text()}};
            else if constexpr (std::is_same_v<T, SavedSceneActorKey>)
                return {{"kind", "scene"},
                        {"owner", encode_presentation_owner(value.owner)},
                        {"slot", value.slot.text()}};
            else
                return {{"kind", "scoped"}, {"instance", value.instance.text()}};
        },
        key);
}

std::optional<SavedActorPresentationKey> decode_actor_key(Decoder& d, const nlohmann::json& value,
                                                          std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected an actor key object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = d.member(value, "kind", pointer);
    auto kind = kind_value ? d.string(*kind_value, child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "character") {
        d.object(value, pointer, {"kind", "character"});
        const auto* character_value = d.member(value, "character", pointer);
        auto character = character_value
                             ? d.id<CharacterId>(*character_value, child(pointer, "character"))
                             : std::nullopt;
        return character ? std::optional<SavedActorPresentationKey>{CharacterActorKey{
                               std::move(*character)}}
                         : std::nullopt;
    }
    if (*kind == "room-cast") {
        d.object(value, pointer, {"kind", "room", "entry"});
        const auto* room_value = d.member(value, "room", pointer);
        const auto* entry_value = d.member(value, "entry", pointer);
        auto room = room_value ? d.id<RoomId>(*room_value, child(pointer, "room")) : std::nullopt;
        auto entry = entry_value ? d.id<RoomCastEntryId>(*entry_value, child(pointer, "entry"))
                                 : std::nullopt;
        return room && entry ? std::optional<SavedActorPresentationKey>{RoomCastActorKey{
                                   std::move(*room), std::move(*entry)}}
                             : std::nullopt;
    }
    if (*kind == "scene") {
        d.object(value, pointer, {"kind", "owner", "slot"});
        const auto* owner_value = d.member(value, "owner", pointer);
        const auto* slot_value = d.member(value, "slot", pointer);
        auto owner = owner_value
                         ? decode_presentation_owner(d, *owner_value, child(pointer, "owner"))
                         : std::nullopt;
        auto slot =
            slot_value ? d.id<ActorSlotId>(*slot_value, child(pointer, "slot")) : std::nullopt;
        const auto* scene_owner =
            owner ? std::get_if<SavedScenePresentationOwner>(&*owner) : nullptr;
        return scene_owner && slot ? std::optional<SavedActorPresentationKey>{SavedSceneActorKey{
                                         *scene_owner, std::move(*slot)}}
                                   : std::nullopt;
    }
    if (*kind == "scoped") {
        d.object(value, pointer, {"kind", "instance"});
        const auto* instance_value = d.member(value, "instance", pointer);
        auto instance = instance_value ? d.id<StrongId<ScopedActorInstanceTag>>(
                                             *instance_value, child(pointer, "instance"))
                                       : std::nullopt;
        return instance
                   ? std::optional<SavedActorPresentationKey>{ScopedActorKey{std::move(*instance)}}
                   : std::nullopt;
    }
    d.error(k_variant, "Unknown actor key kind '" + *kind + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_background(const compiled::BackgroundPresentation& value)
{
    return {{"asset", encode_optional_id(value.asset)},
            {"color", value.color ? nlohmann::json(*value.color) : nlohmann::json(nullptr)},
            {"fit", encode_enum(value.fit)},
            {"material", encode_optional_id(value.material)}};
}

std::optional<compiled::BackgroundPresentation>
decode_background(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer, {"asset", "color", "fit", "material"}))
        return std::nullopt;
    const auto* asset_value = d.member(value, "asset", pointer);
    const auto* color_value = d.member(value, "color", pointer);
    const auto* fit_value = d.member(value, "fit", pointer);
    const auto* material_value = d.member(value, "material", pointer);
    auto asset = asset_value
                     ? decode_optional_id_value<AssetId>(d, *asset_value, child(pointer, "asset"))
                     : std::nullopt;
    auto color = color_value ? decode_optional_string(d, *color_value, child(pointer, "color"))
                             : std::nullopt;
    auto fit = fit_value ? decode_enum(d, *fit_value, child(pointer, "fit"),
                                       compiled::BackgroundFit::Center)
                         : std::nullopt;
    auto material =
        material_value
            ? decode_optional_id_value<MaterialId>(d, *material_value, child(pointer, "material"))
            : std::nullopt;
    return asset && color && fit && material
               ? std::optional<compiled::BackgroundPresentation>{{std::move(*asset),
                                                                  std::move(*color), *fit,
                                                                  std::move(*material)}}
               : std::nullopt;
}

nlohmann::json encode_actor_placement(const ActorLogicalPlacement& value)
{
    return {{"position", encode_enum(value.position)},
            {"offset", {{"x", value.offset.x}, {"y", value.offset.y}}},
            {"scale", value.scale}};
}

std::optional<ActorLogicalPlacement> decode_actor_placement(Decoder& d, const nlohmann::json& value,
                                                            std::string_view pointer)
{
    if (!d.object(value, pointer, {"position", "offset", "scale"}))
        return std::nullopt;
    const auto* position_value = d.member(value, "position", pointer);
    const auto* offset_value = d.member(value, "offset", pointer);
    const auto* scale_value = d.member(value, "scale", pointer);
    auto position = position_value ? decode_enum(d, *position_value, child(pointer, "position"),
                                                 compiled::ActorPosition::Custom)
                                   : std::nullopt;
    std::optional<compiled::Vector2> offset;
    if (offset_value && d.object(*offset_value, child(pointer, "offset"), {"x", "y"})) {
        const auto offset_pointer = child(pointer, "offset");
        const auto* x_value = d.member(*offset_value, "x", offset_pointer);
        const auto* y_value = d.member(*offset_value, "y", offset_pointer);
        auto x = x_value ? decode_number(d, *x_value, child(offset_pointer, "x")) : std::nullopt;
        auto y = y_value ? decode_number(d, *y_value, child(offset_pointer, "y")) : std::nullopt;
        if (x && y)
            offset = compiled::Vector2{*x, *y};
    }
    auto scale =
        scale_value ? decode_number(d, *scale_value, child(pointer, "scale")) : std::nullopt;
    return position && offset && scale
               ? std::optional<ActorLogicalPlacement>{{*position, *offset, *scale}}
               : std::nullopt;
}

nlohmann::json encode_optional_placement(const std::optional<compiled::RoomPlacementRef>& value)
{
    return value ? nlohmann::json{{"room", value->room.text()},
                                  {"placement", value->placement_id.text()}}
                 : nlohmann::json(nullptr);
}

std::optional<std::optional<compiled::RoomPlacementRef>>
decode_optional_placement(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<compiled::RoomPlacementRef>{};
    if (!d.object(value, pointer, {"room", "placement"}))
        return std::nullopt;
    const auto* room_value = d.member(value, "room", pointer);
    const auto* placement_value = d.member(value, "placement", pointer);
    auto room = room_value ? d.id<RoomId>(*room_value, child(pointer, "room")) : std::nullopt;
    auto placement = placement_value
                         ? d.id<RoomPlacementId>(*placement_value, child(pointer, "placement"))
                         : std::nullopt;
    return room && placement
               ? std::optional<
                     std::optional<compiled::RoomPlacementRef>>{compiled::RoomPlacementRef{
                     std::move(*room), std::move(*placement)}}
               : std::nullopt;
}

nlohmann::json encode_rect(const compiled::NormalizedRect& value)
{
    return {{"x", value.x}, {"y", value.y}, {"width", value.width}, {"height", value.height}};
}

std::optional<compiled::NormalizedRect> decode_rect(Decoder& d, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!d.object(value, pointer, {"x", "y", "width", "height"}))
        return std::nullopt;
    const auto* x_value = d.member(value, "x", pointer);
    const auto* y_value = d.member(value, "y", pointer);
    const auto* width_value = d.member(value, "width", pointer);
    const auto* height_value = d.member(value, "height", pointer);
    auto x = x_value ? decode_number(d, *x_value, child(pointer, "x")) : std::nullopt;
    auto y = y_value ? decode_number(d, *y_value, child(pointer, "y")) : std::nullopt;
    auto width =
        width_value ? decode_number(d, *width_value, child(pointer, "width")) : std::nullopt;
    auto height =
        height_value ? decode_number(d, *height_value, child(pointer, "height")) : std::nullopt;
    return x && y && width && height
               ? std::optional<compiled::NormalizedRect>{{*x, *y, *width, *height}}
               : std::nullopt;
}

nlohmann::json encode_mount_key(const MountedLayoutPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>)
                return {{"kind", "reserved"}, {"slot", encode_enum(value.slot)}};
            else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>)
                return {{"kind", "room-overlay"},
                        {"room", value.room.text()},
                        {"overlay", value.overlay.text()}};
            else
                return {{"kind", "scoped"}, {"instance", value.instance.text()}};
        },
        key);
}

std::optional<MountedLayoutPresentationKey>
decode_mount_key(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a mounted Layout key object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = d.member(value, "kind", pointer);
    auto kind = kind_value ? d.string(*kind_value, child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "reserved") {
        d.object(value, pointer, {"kind", "slot"});
        const auto* slot_value = d.member(value, "slot", pointer);
        auto slot = slot_value ? decode_enum(d, *slot_value, child(pointer, "slot"),
                                             compiled::LayoutSlot::Custom)
                               : std::nullopt;
        return slot ? std::optional<MountedLayoutPresentationKey>{ReservedLayoutMountKey{*slot}}
                    : std::nullopt;
    }
    if (*kind == "room-overlay") {
        d.object(value, pointer, {"kind", "room", "overlay"});
        const auto* room_value = d.member(value, "room", pointer);
        const auto* overlay_value = d.member(value, "overlay", pointer);
        auto room = room_value ? d.id<RoomId>(*room_value, child(pointer, "room")) : std::nullopt;
        auto overlay = overlay_value
                           ? d.id<RoomOverlayId>(*overlay_value, child(pointer, "overlay"))
                           : std::nullopt;
        return room && overlay
                   ? std::optional<MountedLayoutPresentationKey>{RoomOverlayLayoutMountKey{
                         std::move(*room), std::move(*overlay)}}
                   : std::nullopt;
    }
    if (*kind == "scoped") {
        d.object(value, pointer, {"kind", "instance"});
        const auto* instance_value = d.member(value, "instance", pointer);
        auto instance = instance_value ? d.id<ScopedLayoutInstanceId>(*instance_value,
                                                                      child(pointer, "instance"))
                                       : std::nullopt;
        return instance ? std::optional<MountedLayoutPresentationKey>{ScopedLayoutMountKey{
                              std::move(*instance)}}
                        : std::nullopt;
    }
    d.error(k_variant, "Unknown mounted Layout key kind '" + *kind + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_policy(const MountedLayoutPolicy& value)
{
    nlohmann::json encoded{{"plane", encode_enum(value.plane)},
                           {"order", value.local_order},
                           {"clock", encode_enum(value.clock)},
                           {"input", encode_enum(value.input)},
                           {"gameplayPause", encode_enum(value.gameplay_pause)},
                           {"visibility", encode_enum(value.visibility)},
                           {"escapeDismissal", encode_enum(value.escape_dismissal)}};
    if (value.scale_overrides.ui || value.scale_overrides.text) {
        nlohmann::json overrides = nlohmann::json::object();
        if (value.scale_overrides.ui)
            overrides["ui"] = encode_enum(*value.scale_overrides.ui);
        if (value.scale_overrides.text)
            overrides["text"] = encode_enum(*value.scale_overrides.text);
        encoded["scaleOverrides"] = std::move(overrides);
    }
    return encoded;
}

std::optional<MountedLayoutPolicy> decode_policy(Decoder& d, const nlohmann::json& value,
                                                 std::string_view pointer)
{
    if (!d.object(value, pointer,
                  {"plane", "order", "clock", "input", "gameplayPause", "visibility",
                   "escapeDismissal", "scaleOverrides"}))
        return std::nullopt;
    const auto* plane_value = d.member(value, "plane", pointer);
    const auto* order_value = d.member(value, "order", pointer);
    const auto* clock_value = d.member(value, "clock", pointer);
    const auto* input_value = d.member(value, "input", pointer);
    const auto* pause_value = d.member(value, "gameplayPause", pointer);
    const auto* visibility_value = d.member(value, "visibility", pointer);
    const auto* escape_value = d.member(value, "escapeDismissal", pointer);
    const auto* scale_overrides_value = json_access::member(value, "scaleOverrides");
    auto plane = plane_value ? decode_enum(d, *plane_value, child(pointer, "plane"),
                                           PresentationPlane::Debug)
                             : std::nullopt;
    auto order =
        order_value ? decode_order(d, *order_value, child(pointer, "order")) : std::nullopt;
    auto clock = clock_value ? decode_enum(d, *clock_value, child(pointer, "clock"),
                                           LayoutClockDomain::UnscaledPresentation)
                             : std::nullopt;
    auto input = input_value
                     ? decode_enum(d, *input_value, child(pointer, "input"), LayoutInputMode::Modal)
                     : std::nullopt;
    auto pause = pause_value ? decode_enum(d, *pause_value, child(pointer, "gameplayPause"),
                                           GameplayPausePolicy::PauseWhileVisible)
                             : std::nullopt;
    auto visibility = visibility_value
                          ? decode_enum(d, *visibility_value, child(pointer, "visibility"),
                                        LayoutVisibility::Visible)
                          : std::nullopt;
    auto escape = escape_value ? decode_enum(d, *escape_value, child(pointer, "escapeDismissal"),
                                             EscapeDismissalPolicy::Dismiss)
                               : std::nullopt;
    LayoutScaleOverrides scale_overrides;
    bool scale_overrides_ok = true;
    if (scale_overrides_value) {
        const auto scale_pointer = child(pointer, "scaleOverrides");
        scale_overrides_ok = d.object(*scale_overrides_value, scale_pointer, {"ui", "text"});
        if (scale_overrides_ok) {
            if (const auto* ui_value = json_access::member(*scale_overrides_value, "ui")) {
                auto ui = decode_enum(d, *ui_value, child(scale_pointer, "ui"),
                                      LayoutScaleInheritance::Ignore);
                if (ui)
                    scale_overrides.ui = *ui;
                else
                    scale_overrides_ok = false;
            }
            if (const auto* text_value = json_access::member(*scale_overrides_value, "text")) {
                auto text = decode_enum(d, *text_value, child(scale_pointer, "text"),
                                        LayoutScaleInheritance::Ignore);
                if (text)
                    scale_overrides.text = *text;
                else
                    scale_overrides_ok = false;
            }
        }
    }
    return plane && order && clock && input && pause && visibility && escape && scale_overrides_ok
               ? std::optional<MountedLayoutPolicy>{{.plane = *plane,
                                                     .scale_overrides = scale_overrides,
                                                     .local_order = *order,
                                                     .clock = *clock,
                                                     .input = *input,
                                                     .gameplay_pause = *pause,
                                                     .visibility = *visibility,
                                                     .escape_dismissal = *escape,
                                                     .entrance_operation = std::nullopt,
                                                     .exit_operation = std::nullopt}}
               : std::nullopt;
}

template<class T, class Decode>
std::optional<std::vector<T>> decode_required_array(Decoder& d, const nlohmann::json& value,
                                                    std::string_view pointer, Decode&& decode)
{
    if (!value.is_array()) {
        d.error(k_type, "Expected an array.", std::string(pointer));
        return std::nullopt;
    }
    std::vector<T> result;
    result.reserve(value.size());
    for (std::size_t item = 0; item < value.size(); ++item) {
        const auto* entry = json_access::element(value, item);
        auto decoded = entry ? decode(*entry, index(pointer, item)) : std::nullopt;
        if (decoded)
            result.push_back(std::move(*decoded));
    }
    return result;
}

nlohmann::json encode_presented_text(const std::optional<PresentedTextState>& value)
{
    if (!value)
        return nullptr;
    return {{"speaker", encode_optional_id(value->speaker)},
            {"text", value->text},
            {"markup", encode_enum(value->markup)}};
}

std::optional<std::optional<PresentedTextState>>
decode_presented_text(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<PresentedTextState>{};
    if (!d.object(value, pointer, {"speaker", "text", "markup"}))
        return std::nullopt;
    const auto* speaker_value = d.member(value, "speaker", pointer);
    const auto* text_value = d.member(value, "text", pointer);
    const auto* markup_value = d.member(value, "markup", pointer);
    auto speaker = speaker_value ? decode_optional_id_value<CharacterId>(d, *speaker_value,
                                                                         child(pointer, "speaker"))
                                 : std::nullopt;
    auto text = text_value ? d.string(*text_value, child(pointer, "text")) : std::nullopt;
    auto markup = markup_value ? decode_enum(d, *markup_value, child(pointer, "markup"),
                                             TextMarkup::ActiveText)
                               : std::nullopt;
    return speaker && text && markup
               ? std::optional<std::optional<PresentedTextState>>{PresentedTextState{
                     std::move(*speaker), std::move(*text), *markup}}
               : std::nullopt;
}

nlohmann::json encode_choice(const std::optional<ActiveChoiceState>& value)
{
    if (!value)
        return nullptr;
    return std::visit(
        [](const auto& choice) -> nlohmann::json {
            using T = std::decay_t<decltype(choice)>;
            nlohmann::json options = nlohmann::json::array();
            if constexpr (std::is_same_v<T, SceneChoiceState>) {
                for (const auto& option : choice.options)
                    options.push_back({{"option", option.option.text()},
                                       {"label", option.label},
                                       {"enabled", option.enabled}});
                return {{"kind", "scene"},
                        {"scene", choice.scene.text()},
                        {"step", choice.step.text()},
                        {"prompt",
                         choice.prompt ? nlohmann::json(*choice.prompt) : nlohmann::json(nullptr)},
                        {"options", std::move(options)}};
            } else {
                for (const auto& option : choice.options)
                    options.push_back({{"edge", option.edge.text()},
                                       {"label", option.label},
                                       {"enabled", option.enabled},
                                       {"markup", encode_enum(option.markup)}});
                return {{"kind", "dialogue"},
                        {"dialogue", choice.dialogue.text()},
                        {"block", choice.block.text()},
                        {"options", std::move(options)}};
            }
        },
        *value);
}

std::optional<std::optional<ActiveChoiceState>>
decode_choice(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<ActiveChoiceState>{};
    if (!value.is_object()) {
        d.error(k_type, "Expected a choice object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = d.member(value, "kind", pointer);
    auto kind = kind_value ? d.string(*kind_value, child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "scene") {
        d.object(value, pointer, {"kind", "scene", "step", "prompt", "options"});
        const auto* scene_value = d.member(value, "scene", pointer);
        const auto* step_value = d.member(value, "step", pointer);
        const auto* prompt_value = d.member(value, "prompt", pointer);
        const auto* options_value = d.member(value, "options", pointer);
        auto scene =
            scene_value ? d.id<SceneId>(*scene_value, child(pointer, "scene")) : std::nullopt;
        auto step =
            step_value ? d.id<SceneStepId>(*step_value, child(pointer, "step")) : std::nullopt;
        auto prompt = prompt_value
                          ? decode_optional_string(d, *prompt_value, child(pointer, "prompt"))
                          : std::nullopt;
        auto options =
            options_value
                ? decode_required_array<SceneChoiceOptionState>(
                      d, *options_value, child(pointer, "options"),
                      [&d](const nlohmann::json& entry, const std::string& entry_pointer)
                          -> std::optional<SceneChoiceOptionState> {
                          if (!d.object(entry, entry_pointer, {"option", "label", "enabled"}))
                              return std::nullopt;
                          const auto* option_value = d.member(entry, "option", entry_pointer);
                          const auto* label_value = d.member(entry, "label", entry_pointer);
                          const auto* enabled_value = d.member(entry, "enabled", entry_pointer);
                          auto option = option_value
                                            ? d.id<SceneChoiceOptionId>(
                                                  *option_value, child(entry_pointer, "option"))
                                            : std::nullopt;
                          auto label = label_value
                                           ? d.string(*label_value, child(entry_pointer, "label"))
                                           : std::nullopt;
                          auto enabled = enabled_value ? d.boolean(*enabled_value,
                                                                   child(entry_pointer, "enabled"))
                                                       : std::nullopt;
                          return option && label && enabled
                                     ? std::optional<SceneChoiceOptionState>{{std::move(*option),
                                                                              std::move(*label),
                                                                              *enabled}}
                                     : std::nullopt;
                      })
                : std::nullopt;
        return scene && step && prompt && options
                   ? std::optional<std::optional<ActiveChoiceState>>{ActiveChoiceState{
                         SceneChoiceState{std::move(*scene), std::move(*step), std::move(*prompt),
                                          std::move(*options)}}}
                   : std::nullopt;
    }
    if (*kind == "dialogue") {
        d.object(value, pointer, {"kind", "dialogue", "block", "options"});
        const auto* dialogue_value = d.member(value, "dialogue", pointer);
        const auto* block_value = d.member(value, "block", pointer);
        const auto* options_value = d.member(value, "options", pointer);
        auto dialogue = dialogue_value
                            ? d.id<DialogueId>(*dialogue_value, child(pointer, "dialogue"))
                            : std::nullopt;
        auto block = block_value ? d.id<DialogueBlockId>(*block_value, child(pointer, "block"))
                                 : std::nullopt;
        auto options =
            options_value
                ? decode_required_array<DialogueChoiceOptionState>(
                      d, *options_value, child(pointer, "options"),
                      [&d](const nlohmann::json& entry, const std::string& entry_pointer)
                          -> std::optional<DialogueChoiceOptionState> {
                          if (!d.object(entry, entry_pointer,
                                        {"edge", "label", "enabled", "markup"}))
                              return std::nullopt;
                          const auto* edge_value = d.member(entry, "edge", entry_pointer);
                          const auto* label_value = d.member(entry, "label", entry_pointer);
                          const auto* enabled_value = d.member(entry, "enabled", entry_pointer);
                          const auto* markup_value = d.member(entry, "markup", entry_pointer);
                          auto edge =
                              edge_value
                                  ? d.id<DialogueEdgeId>(*edge_value, child(entry_pointer, "edge"))
                                  : std::nullopt;
                          auto label = label_value
                                           ? d.string(*label_value, child(entry_pointer, "label"))
                                           : std::nullopt;
                          auto enabled = enabled_value ? d.boolean(*enabled_value,
                                                                   child(entry_pointer, "enabled"))
                                                       : std::nullopt;
                          auto markup = markup_value ? decode_enum(d, *markup_value,
                                                                   child(entry_pointer, "markup"),
                                                                   TextMarkup::ActiveText)
                                                     : std::nullopt;
                          return edge && label && enabled && markup
                                     ? std::optional<DialogueChoiceOptionState>{{std::move(*edge),
                                                                                 std::move(*label),
                                                                                 *enabled, *markup}}
                                     : std::nullopt;
                      })
                : std::nullopt;
        return dialogue && block && options
                   ? std::optional<std::optional<ActiveChoiceState>>{ActiveChoiceState{
                         DialogueChoiceState{std::move(*dialogue), std::move(*block),
                                             std::move(*options)}}}
                   : std::nullopt;
    }
    d.error(k_variant, "Unknown choice kind '" + *kind + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_map(const std::optional<MapPresentationState>& value)
{
    if (!value)
        return nullptr;
    return {{"map", value->map.text()},
            {"mode", encode_enum(value->mode)},
            {"visible", value->visible},
            {"focusedLocation", encode_optional_id(value->focused_location)}};
}

std::optional<std::optional<MapPresentationState>>
decode_map(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<MapPresentationState>{};
    if (!d.object(value, pointer, {"map", "mode", "visible", "focusedLocation"}))
        return std::nullopt;
    const auto* map_value = d.member(value, "map", pointer);
    const auto* mode_value = d.member(value, "mode", pointer);
    const auto* visible_value = d.member(value, "visible", pointer);
    const auto* focused_value = d.member(value, "focusedLocation", pointer);
    auto map = map_value ? d.id<MapId>(*map_value, child(pointer, "map")) : std::nullopt;
    auto mode = mode_value ? decode_enum(d, *mode_value, child(pointer, "mode"),
                                         compiled::InitialMapMode::FullMap)
                           : std::nullopt;
    auto visible =
        visible_value ? d.boolean(*visible_value, child(pointer, "visible")) : std::nullopt;
    auto focused = focused_value ? decode_optional_id_value<MapLocationId>(
                                       d, *focused_value, child(pointer, "focusedLocation"))
                                 : std::nullopt;
    return map && mode && visible && focused
               ? std::optional<std::optional<MapPresentationState>>{MapPresentationState{
                     std::move(*map), *mode, *visible, std::move(*focused)}}
               : std::nullopt;
}

} // namespace

nlohmann::json encode_presentation_records(const SaveState& save)
{
    nlohmann::json backgrounds = nlohmann::json::array();
    for (const auto& value : save.background_overrides)
        backgrounds.push_back({{"owner", encode_presentation_owner(value.owner)},
                               {"background", encode_background(value.background)}});

    nlohmann::json actors = nlohmann::json::array();
    for (const auto& value : save.actors)
        actors.push_back({{"key", encode_actor_key(value.key)},
                          {"owner", encode_presentation_owner(value.owner)},
                          {"character", value.character.text()},
                          {"pose", value.pose.text()},
                          {"expression", value.expression.text()},
                          {"idle", encode_optional_id(value.idle)},
                          {"placement", encode_actor_placement(value.placement)},
                          {"visible", value.visible},
                          {"presentationComplete", value.presentation_complete}});

    nlohmann::json props = nlohmann::json::array();
    for (const auto& value : save.presentation_props)
        props.push_back({{"instance", value.instance.text()},
                         {"owner", encode_presentation_owner(value.owner)},
                         {"asset", encode_optional_id(value.asset)},
                         {"material", encode_optional_id(value.material)},
                         {"placement", encode_optional_placement(value.placement)},
                         {"bounds", encode_rect(value.bounds)},
                         {"plane", encode_enum(value.plane)},
                         {"order", value.order},
                         {"visible", value.visible}});

    nlohmann::json environments = nlohmann::json::array();
    for (const auto& value : save.presentation_environments)
        environments.push_back(
            {{"instance", value.instance.text()},
             {"owner", encode_presentation_owner(value.owner)},
             {"stopKey", value.stop_key.text()},
             {"asset", encode_optional_id(value.asset)},
             {"material", value.material.text()},
             {"bounds", encode_rect(value.bounds)},
             {"plane", encode_enum(value.plane)},
             {"order", value.order},
             {"clock", encode_enum(value.clock)},
             {"scrollPerSecond",
              {{"x", value.scroll_per_second.x}, {"y", value.scroll_per_second.y}}},
             {"opacity", value.opacity},
             {"visible", value.visible}});

    nlohmann::json layouts = nlohmann::json::array();
    for (const auto& value : save.mounted_layouts)
        layouts.push_back({{"key", encode_mount_key(value.key)},
                           {"owner", encode_presentation_owner(value.owner)},
                           {"layout", value.layout.text()},
                           {"policy", encode_policy(value.policy)},
                           {"compositionGroup", encode_enum(value.composition_group)}});

    nlohmann::json desired_audio = nlohmann::json::array();
    for (const auto& value : save.desired_audio)
        desired_audio.push_back({{"instance", value.instance.text()},
                                 {"owner", encode_presentation_owner(value.owner)},
                                 {"bus", encode_enum(value.bus)},
                                 {"asset", value.asset.text()},
                                 {"volume", value.volume},
                                 {"fadeInMs", value.fade_in.count()},
                                 {"fadeOutMs", value.fade_out.count()},
                                 {"replacementKey", encode_optional_id(value.replacement_key)}});

    return {{"backgroundOverrides", std::move(backgrounds)},
            {"actors", std::move(actors)},
            {"props", std::move(props)},
            {"environments", std::move(environments)},
            {"mountedLayouts", std::move(layouts)},
            {"desiredAudio", std::move(desired_audio)},
            {"presentedText", encode_presented_text(save.presented_text)},
            {"activeChoice", encode_choice(save.active_choice)},
            {"map", encode_map(save.map_presentation)}};
}

std::optional<SavedPresentationRecords>
decode_presentation_records(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer,
                  {"backgroundOverrides", "actors", "props", "environments", "mountedLayouts",
                   "desiredAudio", "presentedText", "activeChoice", "map"}))
        return std::nullopt;
    const auto* backgrounds_value = d.member(value, "backgroundOverrides", pointer);
    const auto* actors_value = d.member(value, "actors", pointer);
    const auto* props_value = d.member(value, "props", pointer);
    const auto* environments_value = d.member(value, "environments", pointer);
    const auto* layouts_value = d.member(value, "mountedLayouts", pointer);
    const auto* desired_audio_value = d.member(value, "desiredAudio", pointer);
    const auto* text_value = d.member(value, "presentedText", pointer);
    const auto* choice_value = d.member(value, "activeChoice", pointer);
    const auto* map_value = d.member(value, "map", pointer);

    auto backgrounds =
        backgrounds_value
            ? decode_required_array<SavedBackgroundOverride>(
                  d, *backgrounds_value, child(pointer, "backgroundOverrides"),
                  [&d](const nlohmann::json& entry,
                       const std::string& entry_pointer) -> std::optional<SavedBackgroundOverride> {
                      if (!d.object(entry, entry_pointer, {"owner", "background"}))
                          return std::nullopt;
                      const auto* owner_value = d.member(entry, "owner", entry_pointer);
                      const auto* background_value = d.member(entry, "background", entry_pointer);
                      auto owner = owner_value ? decode_presentation_owner(
                                                     d, *owner_value, child(entry_pointer, "owner"))
                                               : std::nullopt;
                      auto background = background_value
                                            ? decode_background(d, *background_value,
                                                                child(entry_pointer, "background"))
                                            : std::nullopt;
                      return owner && background
                                 ? std::optional<SavedBackgroundOverride>{{std::move(*owner),
                                                                           std::move(*background)}}
                                 : std::nullopt;
                  })
            : std::nullopt;

    auto actors =
        actors_value
            ? decode_required_array<SavedActorPresentation>(
                  d, *actors_value, child(pointer, "actors"),
                  [&d](const nlohmann::json& entry,
                       const std::string& entry_pointer) -> std::optional<SavedActorPresentation> {
                      if (!d.object(entry, entry_pointer,
                                    {"key", "owner", "character", "pose", "expression", "idle",
                                     "placement", "visible", "presentationComplete"}))
                          return std::nullopt;
                      const auto* key_value = d.member(entry, "key", entry_pointer);
                      const auto* owner_value = d.member(entry, "owner", entry_pointer);
                      const auto* character_value = d.member(entry, "character", entry_pointer);
                      const auto* pose_value = d.member(entry, "pose", entry_pointer);
                      const auto* expression_value = d.member(entry, "expression", entry_pointer);
                      const auto* idle_value = d.member(entry, "idle", entry_pointer);
                      const auto* placement_value = d.member(entry, "placement", entry_pointer);
                      const auto* visible_value = d.member(entry, "visible", entry_pointer);
                      const auto* complete_value =
                          d.member(entry, "presentationComplete", entry_pointer);
                      auto key = key_value
                                     ? decode_actor_key(d, *key_value, child(entry_pointer, "key"))
                                     : std::nullopt;
                      auto owner = owner_value ? decode_presentation_owner(
                                                     d, *owner_value, child(entry_pointer, "owner"))
                                               : std::nullopt;
                      auto character = character_value
                                           ? d.id<CharacterId>(*character_value,
                                                               child(entry_pointer, "character"))
                                           : std::nullopt;
                      auto pose = pose_value ? d.id<CharacterPoseId>(*pose_value,
                                                                     child(entry_pointer, "pose"))
                                             : std::nullopt;
                      auto expression =
                          expression_value
                              ? d.id<CharacterExpressionId>(*expression_value,
                                                            child(entry_pointer, "expression"))
                              : std::nullopt;
                      auto idle = idle_value ? decode_optional_id_value<CharacterIdleId>(
                                                   d, *idle_value, child(entry_pointer, "idle"))
                                             : std::nullopt;
                      auto placement =
                          placement_value
                              ? decode_actor_placement(d, *placement_value,
                                                       child(entry_pointer, "placement"))
                              : std::nullopt;
                      auto visible =
                          visible_value ? d.boolean(*visible_value, child(entry_pointer, "visible"))
                                        : std::nullopt;
                      auto complete = complete_value
                                          ? d.boolean(*complete_value,
                                                      child(entry_pointer, "presentationComplete"))
                                          : std::nullopt;
                      return key && owner && character && pose && expression && idle && placement &&
                                     visible && complete
                                 ? std::optional<SavedActorPresentation>{{std::move(*key),
                                                                          std::move(*owner),
                                                                          std::move(*character),
                                                                          std::move(*pose),
                                                                          std::move(*expression),
                                                                          std::move(*idle),
                                                                          std::move(*placement),
                                                                          *visible, *complete}}
                                 : std::nullopt;
                  })
            : std::nullopt;

    auto props =
        props_value
            ? decode_required_array<SavedPresentationProp>(
                  d, *props_value, child(pointer, "props"),
                  [&d](const nlohmann::json& entry,
                       const std::string& entry_pointer) -> std::optional<SavedPresentationProp> {
                      if (!d.object(entry, entry_pointer,
                                    {"instance", "owner", "asset", "material", "placement",
                                     "bounds", "plane", "order", "visible"}))
                          return std::nullopt;
                      const auto* instance_value = d.member(entry, "instance", entry_pointer);
                      const auto* owner_value = d.member(entry, "owner", entry_pointer);
                      const auto* asset_value = d.member(entry, "asset", entry_pointer);
                      const auto* material_value = d.member(entry, "material", entry_pointer);
                      const auto* placement_value = d.member(entry, "placement", entry_pointer);
                      const auto* bounds_value = d.member(entry, "bounds", entry_pointer);
                      const auto* plane_value = d.member(entry, "plane", entry_pointer);
                      const auto* order_value = d.member(entry, "order", entry_pointer);
                      const auto* visible_value = d.member(entry, "visible", entry_pointer);
                      auto instance = instance_value
                                          ? d.id<PresentationPropInstanceId>(
                                                *instance_value, child(entry_pointer, "instance"))
                                          : std::nullopt;
                      auto owner = owner_value ? decode_presentation_owner(
                                                     d, *owner_value, child(entry_pointer, "owner"))
                                               : std::nullopt;
                      auto asset = asset_value ? decode_optional_id_value<AssetId>(
                                                     d, *asset_value, child(entry_pointer, "asset"))
                                               : std::nullopt;
                      auto material =
                          material_value ? decode_optional_id_value<MaterialId>(
                                               d, *material_value, child(entry_pointer, "material"))
                                         : std::nullopt;
                      auto placement =
                          placement_value
                              ? decode_optional_placement(d, *placement_value,
                                                          child(entry_pointer, "placement"))
                              : std::nullopt;
                      auto bounds = bounds_value ? decode_rect(d, *bounds_value,
                                                               child(entry_pointer, "bounds"))
                                                 : std::nullopt;
                      auto plane = plane_value
                                       ? decode_enum(d, *plane_value, child(entry_pointer, "plane"),
                                                     PresentationPlane::Debug)
                                       : std::nullopt;
                      auto order =
                          order_value ? decode_order(d, *order_value, child(entry_pointer, "order"))
                                      : std::nullopt;
                      auto visible =
                          visible_value ? d.boolean(*visible_value, child(entry_pointer, "visible"))
                                        : std::nullopt;
                      return instance && owner && asset && material && placement && bounds &&
                                     plane && order && visible
                                 ? std::optional<SavedPresentationProp>{{std::move(*instance),
                                                                         std::move(*owner),
                                                                         std::move(*asset),
                                                                         std::move(*material),
                                                                         std::move(*placement),
                                                                         *bounds, *plane, *order,
                                                                         *visible}}
                                 : std::nullopt;
                  })
            : std::nullopt;

    auto environments =
        environments_value
            ? decode_required_array<SavedPresentationEnvironment>(
                  d, *environments_value, child(pointer, "environments"),
                  [&d](const nlohmann::json& entry, const std::string& entry_pointer)
                      -> std::optional<SavedPresentationEnvironment> {
                      if (!d.object(entry, entry_pointer,
                                    {"instance", "owner", "stopKey", "asset", "material", "bounds",
                                     "plane", "order", "clock", "scrollPerSecond", "opacity",
                                     "visible"}))
                          return std::nullopt;
                      const auto* instance_value = d.member(entry, "instance", entry_pointer);
                      const auto* owner_value = d.member(entry, "owner", entry_pointer);
                      const auto* stop_key_value = d.member(entry, "stopKey", entry_pointer);
                      const auto* asset_value = d.member(entry, "asset", entry_pointer);
                      const auto* material_value = d.member(entry, "material", entry_pointer);
                      const auto* bounds_value = d.member(entry, "bounds", entry_pointer);
                      const auto* plane_value = d.member(entry, "plane", entry_pointer);
                      const auto* order_value = d.member(entry, "order", entry_pointer);
                      const auto* clock_value = d.member(entry, "clock", entry_pointer);
                      const auto* scroll_value = d.member(entry, "scrollPerSecond", entry_pointer);
                      const auto* opacity_value = d.member(entry, "opacity", entry_pointer);
                      const auto* visible_value = d.member(entry, "visible", entry_pointer);
                      auto instance = instance_value
                                          ? d.id<PresentationEnvironmentInstanceId>(
                                                *instance_value, child(entry_pointer, "instance"))
                                          : std::nullopt;
                      auto owner = owner_value ? decode_presentation_owner(
                                                     d, *owner_value, child(entry_pointer, "owner"))
                                               : std::nullopt;
                      auto stop_key = stop_key_value
                                          ? d.id<PresentationEnvironmentStopKey>(
                                                *stop_key_value, child(entry_pointer, "stopKey"))
                                          : std::nullopt;
                      auto asset = asset_value ? decode_optional_id_value<AssetId>(
                                                     d, *asset_value, child(entry_pointer, "asset"))
                                               : std::nullopt;
                      auto material =
                          material_value
                              ? d.id<MaterialId>(*material_value, child(entry_pointer, "material"))
                              : std::nullopt;
                      auto bounds = bounds_value ? decode_rect(d, *bounds_value,
                                                               child(entry_pointer, "bounds"))
                                                 : std::nullopt;
                      auto plane = plane_value
                                       ? decode_enum(d, *plane_value, child(entry_pointer, "plane"),
                                                     PresentationPlane::Debug)
                                       : std::nullopt;
                      auto order =
                          order_value ? decode_order(d, *order_value, child(entry_pointer, "order"))
                                      : std::nullopt;
                      auto clock = clock_value
                                       ? decode_enum(d, *clock_value, child(entry_pointer, "clock"),
                                                     LayoutClockDomain::UnscaledPresentation)
                                       : std::nullopt;
                      std::optional<compiled::Vector2> scroll;
                      if (scroll_value &&
                          d.object(*scroll_value, child(entry_pointer, "scrollPerSecond"),
                                   {"x", "y"})) {
                          const auto scroll_pointer = child(entry_pointer, "scrollPerSecond");
                          const auto* x_value = d.member(*scroll_value, "x", scroll_pointer);
                          const auto* y_value = d.member(*scroll_value, "y", scroll_pointer);
                          auto x = x_value ? decode_number(d, *x_value, child(scroll_pointer, "x"))
                                           : std::nullopt;
                          auto y = y_value ? decode_number(d, *y_value, child(scroll_pointer, "y"))
                                           : std::nullopt;
                          if (x && y)
                              scroll = compiled::Vector2{*x, *y};
                      }
                      auto opacity = opacity_value ? decode_number(d, *opacity_value,
                                                                   child(entry_pointer, "opacity"))
                                                   : std::nullopt;
                      auto visible =
                          visible_value ? d.boolean(*visible_value, child(entry_pointer, "visible"))
                                        : std::nullopt;
                      return instance && owner && stop_key && asset && material && bounds &&
                                     plane && order && clock && scroll && opacity && visible
                                 ? std::optional<
                                       SavedPresentationEnvironment>{{std::move(*instance),
                                                                      std::move(*owner),
                                                                      std::move(*stop_key),
                                                                      std::move(*asset),
                                                                      std::move(*material), *bounds,
                                                                      *plane, *order, *clock,
                                                                      *scroll, *opacity, *visible}}
                                 : std::nullopt;
                  })
            : std::nullopt;

    auto layouts =
        layouts_value
            ? decode_required_array<SavedMountedLayout>(
                  d, *layouts_value, child(pointer, "mountedLayouts"),
                  [&d](const nlohmann::json& entry,
                       const std::string& entry_pointer) -> std::optional<SavedMountedLayout> {
                      if (!d.object(entry, entry_pointer,
                                    {"key", "owner", "layout", "policy", "compositionGroup"}))
                          return std::nullopt;
                      const auto* key_value = d.member(entry, "key", entry_pointer);
                      const auto* owner_value = d.member(entry, "owner", entry_pointer);
                      const auto* layout_value = d.member(entry, "layout", entry_pointer);
                      const auto* policy_value = d.member(entry, "policy", entry_pointer);
                      const auto* group_value = d.member(entry, "compositionGroup", entry_pointer);
                      auto key = key_value
                                     ? decode_mount_key(d, *key_value, child(entry_pointer, "key"))
                                     : std::nullopt;
                      auto owner = owner_value ? decode_presentation_owner(
                                                     d, *owner_value, child(entry_pointer, "owner"))
                                               : std::nullopt;
                      auto layout = layout_value ? d.id<LayoutId>(*layout_value,
                                                                  child(entry_pointer, "layout"))
                                                 : std::nullopt;
                      auto policy = policy_value ? decode_policy(d, *policy_value,
                                                                 child(entry_pointer, "policy"))
                                                 : std::nullopt;
                      auto group = group_value
                                       ? decode_enum(d, *group_value,
                                                     child(entry_pointer, "compositionGroup"),
                                                     PresentationCompositionGroup::Debug)
                                       : std::nullopt;
                      return key && owner && layout && policy && group
                                 ? std::optional<SavedMountedLayout>{{std::move(*key),
                                                                      std::move(*owner),
                                                                      std::move(*layout),
                                                                      std::move(*policy), *group}}
                                 : std::nullopt;
                  })
            : std::nullopt;

    auto desired_audio =
        desired_audio_value
            ? decode_required_array<SavedDesiredAudio>(
                  d, *desired_audio_value, child(pointer, "desiredAudio"),
                  [&d](const nlohmann::json& entry,
                       const std::string& entry_pointer) -> std::optional<SavedDesiredAudio> {
                      if (!d.object(entry, entry_pointer,
                                    {"instance", "owner", "bus", "asset", "volume", "fadeInMs",
                                     "fadeOutMs", "replacementKey"}))
                          return std::nullopt;
                      const auto* instance_value = d.member(entry, "instance", entry_pointer);
                      const auto* owner_value = d.member(entry, "owner", entry_pointer);
                      const auto* bus_value = d.member(entry, "bus", entry_pointer);
                      const auto* asset_value = d.member(entry, "asset", entry_pointer);
                      const auto* volume_value = d.member(entry, "volume", entry_pointer);
                      const auto* fade_in_value = d.member(entry, "fadeInMs", entry_pointer);
                      const auto* fade_out_value = d.member(entry, "fadeOutMs", entry_pointer);
                      const auto* replacement_value =
                          d.member(entry, "replacementKey", entry_pointer);
                      auto instance = instance_value
                                          ? d.id<DesiredAudioInstanceId>(
                                                *instance_value, child(entry_pointer, "instance"))
                                          : std::nullopt;
                      auto owner = owner_value ? decode_presentation_owner(
                                                     d, *owner_value, child(entry_pointer, "owner"))
                                               : std::nullopt;
                      auto bus = bus_value ? decode_enum(d, *bus_value, child(entry_pointer, "bus"),
                                                         compiled::AudioChannel::Ambient)
                                           : std::nullopt;
                      auto asset = asset_value
                                       ? d.id<AssetId>(*asset_value, child(entry_pointer, "asset"))
                                       : std::nullopt;
                      auto volume = volume_value ? decode_number(d, *volume_value,
                                                                 child(entry_pointer, "volume"))
                                                 : std::nullopt;
                      auto fade_in = fade_in_value
                                         ? d.unsigned_integer<std::uint64_t>(
                                               *fade_in_value, child(entry_pointer, "fadeInMs"))
                                         : std::nullopt;
                      auto fade_out = fade_out_value
                                          ? d.unsigned_integer<std::uint64_t>(
                                                *fade_out_value, child(entry_pointer, "fadeOutMs"))
                                          : std::nullopt;
                      auto replacement =
                          replacement_value
                              ? decode_optional_id_value<DesiredAudioReplacementKey>(
                                    d, *replacement_value, child(entry_pointer, "replacementKey"))
                              : std::nullopt;
                      if (!instance || !owner || !bus || !asset || !volume || !fade_in ||
                          !fade_out || !replacement ||
                          *fade_in > static_cast<std::uint64_t>(
                                         std::numeric_limits<std::int64_t>::max()) ||
                          *fade_out >
                              static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()))
                          return std::nullopt;
                      return SavedDesiredAudio{
                          std::move(*instance),
                          std::move(*owner),
                          *bus,
                          std::move(*asset),
                          *volume,
                          std::chrono::milliseconds{static_cast<std::int64_t>(*fade_in)},
                          std::chrono::milliseconds{static_cast<std::int64_t>(*fade_out)},
                          std::move(*replacement)};
                  })
            : std::nullopt;

    auto presented_text =
        text_value ? decode_presented_text(d, *text_value, child(pointer, "presentedText"))
                   : std::nullopt;
    auto active_choice = choice_value
                             ? decode_choice(d, *choice_value, child(pointer, "activeChoice"))
                             : std::nullopt;
    auto map = map_value ? decode_map(d, *map_value, child(pointer, "map")) : std::nullopt;

    if (!backgrounds || !actors || !props || !environments || !layouts || !desired_audio ||
        !presented_text || !active_choice || !map)
        return std::nullopt;
    return SavedPresentationRecords{
        std::move(*backgrounds),    std::move(*actors),        std::move(*props),
        std::move(*environments),   std::move(*layouts),       std::move(*desired_audio),
        std::move(*presented_text), std::move(*active_choice), std::move(*map)};
}

} // namespace noveltea::core::save_state_codec
