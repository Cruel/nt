#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {
namespace {

std::optional<PropertyValueType> decode_value_type(Decoder& decoder, const nlohmann::json& value,
                                                   const nlohmann::json& enum_values,
                                                   std::string_view pointer,
                                                   std::vector<std::string>& decoded_enum_values)
{
    auto values = decoder.array<std::string>(
        enum_values, pointer_child(pointer, "enumValues"),
        [&](const nlohmann::json& item, const std::string& item_pointer) {
            return decoder.string(item, item_pointer, true);
        });
    auto type = decoder.string(value, pointer_child(pointer, "type"));
    if (!values || !type)
        return std::nullopt;
    decoded_enum_values = std::move(*values);
    if (*type == "boolean")
        return PropertyValueType{BooleanPropertyType{}};
    if (*type == "integer")
        return PropertyValueType{IntegerPropertyType{}};
    if (*type == "number")
        return PropertyValueType{NumberPropertyType{}};
    if (*type == "string")
        return PropertyValueType{StringPropertyType{}};
    if (*type == "enum")
        return PropertyValueType{EnumPropertyType{decoded_enum_values}};
    decoder.error(k_code_enum, "Unknown scalar declaration type '" + *type + "'.",
                  pointer_child(pointer, "type"));
    return std::nullopt;
}

} // namespace

std::optional<ProjectIdentity>
decode_project_identity(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"author", "description", "id", "name", "version"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* name_value = decoder.member(value, "name", pointer);
    const auto* version_value = decoder.member(value, "version", pointer);
    const auto* author_value = decoder.member(value, "author", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    auto id =
        id_value ? decoder.id<ProjectId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto name =
        name_value ? decoder.string(*name_value, pointer_child(pointer, "name")) : std::nullopt;
    auto version = version_value ? decoder.string(*version_value, pointer_child(pointer, "version"))
                                 : std::nullopt;
    auto author = author_value ? decoder.string(*author_value, pointer_child(pointer, "author"))
                               : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;
    if (!id || !name || !version || !author || !description)
        return std::nullopt;
    return ProjectIdentity{std::move(*id), std::move(*name), std::move(*version),
                           std::move(*author), std::move(*description)};
}

std::optional<Entrypoint> decode_entrypoint(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an entrypoint object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "room") {
        decoder.object(value, pointer, {"kind", "room"});
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        return room ? std::optional<Entrypoint>(std::move(*room)) : std::nullopt;
    }
    if (*kind == "scene") {
        decoder.object(value, pointer, {"kind", "scene"});
        const auto* scene_value = decoder.member(value, "scene", pointer);
        auto scene = scene_value
                         ? decode_reference<SceneId>(decoder, *scene_value,
                                                     pointer_child(pointer, "scene"), "scene")
                         : std::nullopt;
        return scene ? std::optional<Entrypoint>(std::move(*scene)) : std::nullopt;
    }
    if (*kind == "dialogue") {
        decoder.object(value, pointer, {"dialogue", "kind"});
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        return dialogue ? std::optional<Entrypoint>(std::move(*dialogue)) : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown entrypoint variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<Localization> decode_localization(Decoder& decoder, const nlohmann::json& value,
                                                std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"catalogs", "defaultLocale", "fallbackLocale"}))
        return std::nullopt;
    const auto* default_value = decoder.member(value, "defaultLocale", pointer);
    const auto* fallback_value = decoder.member(value, "fallbackLocale", pointer);
    const auto* catalogs_value = decoder.member(value, "catalogs", pointer);
    auto default_locale =
        default_value
            ? decoder.string(*default_value, pointer_child(pointer, "defaultLocale"), false, true)
            : std::nullopt;
    std::optional<std::string> fallback;
    bool fallback_ok = fallback_value != nullptr;
    if (fallback_value && !fallback_value->is_null()) {
        fallback =
            decoder.string(*fallback_value, pointer_child(pointer, "fallbackLocale"), false, true);
        fallback_ok = fallback.has_value();
    }
    auto catalogs =
        catalogs_value
            ? decoder.array<LocalizationCatalog>(
                  *catalogs_value, pointer_child(pointer, "catalogs"),
                  [&](const nlohmann::json& catalog,
                      const std::string& catalog_pointer) -> std::optional<LocalizationCatalog> {
                      if (!decoder.object(catalog, catalog_pointer, {"entries", "locale"}))
                          return std::nullopt;
                      const auto* locale_value = decoder.member(catalog, "locale", catalog_pointer);
                      const auto* entries_value =
                          decoder.member(catalog, "entries", catalog_pointer);
                      auto locale = locale_value
                                        ? decoder.string(*locale_value,
                                                         pointer_child(catalog_pointer, "locale"),
                                                         false, true)
                                        : std::nullopt;
                      auto entries =
                          entries_value
                              ? decoder.array<LocalizationEntry>(
                                    *entries_value, pointer_child(catalog_pointer, "entries"),
                                    [&](const nlohmann::json& entry,
                                        const std::string& entry_pointer)
                                        -> std::optional<LocalizationEntry> {
                                        if (!decoder.object(entry, entry_pointer, {"key", "value"}))
                                            return std::nullopt;
                                        const auto* key_value =
                                            decoder.member(entry, "key", entry_pointer);
                                        const auto* text_value =
                                            decoder.member(entry, "value", entry_pointer);
                                        auto key =
                                            key_value
                                                ? decoder.string(
                                                      *key_value,
                                                      pointer_child(entry_pointer, "key"), true)
                                                : std::nullopt;
                                        auto text = text_value
                                                        ? decoder.string(
                                                              *text_value,
                                                              pointer_child(entry_pointer, "value"))
                                                        : std::nullopt;
                                        if (key && text)
                                            return LocalizationEntry{std::move(*key),
                                                                     std::move(*text)};
                                        return std::nullopt;
                                    })
                              : std::nullopt;
                      if (entries) {
                          std::unordered_set<std::string> keys;
                          for (std::size_t index = 0; index < entries->size(); ++index) {
                              if (!keys.insert((*entries)[index].key).second)
                                  decoder.error(
                                      k_code_duplicate,
                                      "Duplicate localization key '" + (*entries)[index].key + "'.",
                                      pointer_child(
                                          pointer_index(pointer_child(catalog_pointer, "entries"),
                                                        index),
                                          "key"));
                          }
                      }
                      if (locale && entries)
                          return LocalizationCatalog{std::move(*locale), std::move(*entries)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (catalogs) {
        std::unordered_set<std::string> locales;
        for (std::size_t index = 0; index < catalogs->size(); ++index) {
            if (!locales.insert((*catalogs)[index].locale).second)
                decoder.error(
                    k_code_duplicate,
                    "Duplicate localization locale '" + (*catalogs)[index].locale + "'.",
                    pointer_child(pointer_index(pointer_child(pointer, "catalogs"), index),
                                  "locale"));
        }
    }
    if (!default_locale || !fallback_ok || !catalogs)
        return std::nullopt;
    return Localization{std::move(*default_locale), std::move(fallback), std::move(*catalogs)};
}

std::optional<RuntimeSettings> decode_settings(Decoder& decoder, const nlohmann::json& value,
                                               std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"accessibility", "audio", "display", "roomNavigationTransition",
                         "systemLayouts", "text", "titleScreen"}))
        return std::nullopt;
    const auto* accessibility_value = decoder.member(value, "accessibility", pointer);
    const auto* display_value = decoder.member(value, "display", pointer);
    const auto* audio_value = decoder.member(value, "audio", pointer);
    const auto* layouts_value = decoder.member(value, "systemLayouts", pointer);
    const auto* text_value = decoder.member(value, "text", pointer);
    const auto* title_value = decoder.member(value, "titleScreen", pointer);
    const auto* transition_value = decoder.member(value, "roomNavigationTransition", pointer);
    std::optional<DisplaySettings> display;
    if (display_value && decoder.object(*display_value, pointer_child(pointer, "display"),
                                        {"barColor", "referenceResolution", "worldRasterPolicy"})) {
        const auto display_pointer = pointer_child(pointer, "display");
        const auto* resolution_value =
            decoder.member(*display_value, "referenceResolution", display_pointer);
        const auto* bar_value = decoder.member(*display_value, "barColor", display_pointer);
        const auto* raster_value =
            decoder.member(*display_value, "worldRasterPolicy", display_pointer);
        std::optional<ReferenceResolution> resolution;
        if (resolution_value &&
            decoder.object(*resolution_value, pointer_child(display_pointer, "referenceResolution"),
                           {"height", "width"})) {
            const auto resolution_pointer = pointer_child(display_pointer, "referenceResolution");
            const auto* height_value =
                decoder.member(*resolution_value, "height", resolution_pointer);
            const auto* width_value =
                decoder.member(*resolution_value, "width", resolution_pointer);
            auto height =
                height_value ? decoder.unsigned_integer<std::uint32_t>(
                                   *height_value, pointer_child(resolution_pointer, "height"), true)
                             : std::nullopt;
            auto width = width_value
                             ? decoder.unsigned_integer<std::uint32_t>(
                                   *width_value, pointer_child(resolution_pointer, "width"), true)
                             : std::nullopt;
            if (height && *height > max_reference_resolution_dimension) {
                decoder.error("reference_resolution_out_of_range",
                              "Reference resolution dimensions must not exceed 10000.",
                              pointer_child(resolution_pointer, "height"));
                height.reset();
            }
            if (width && *width > max_reference_resolution_dimension) {
                decoder.error("reference_resolution_out_of_range",
                              "Reference resolution dimensions must not exceed 10000.",
                              pointer_child(resolution_pointer, "width"));
                width.reset();
            }
            if (height && width)
                resolution = ReferenceResolution{*width, *height};
        }
        auto bar = bar_value
                       ? decoder.string(*bar_value, pointer_child(display_pointer, "barColor"))
                       : std::nullopt;
        auto raster = raster_value
                          ? decoder.enumeration<WorldRasterPolicy>(
                                *raster_value, pointer_child(display_pointer, "worldRasterPolicy"),
                                {{"capped", WorldRasterPolicy::Capped},
                                 {"native", WorldRasterPolicy::Native}})
                          : std::nullopt;
        if (resolution && bar && raster)
            display = DisplaySettings{std::move(*resolution), std::move(*bar), *raster};
    }
    std::optional<AccessibilitySettings> accessibility;
    if (accessibility_value &&
        decoder.object(*accessibility_value, pointer_child(pointer, "accessibility"),
                       {"textScale", "uiScale"})) {
        const auto accessibility_pointer = pointer_child(pointer, "accessibility");
        const auto decode_policy =
            [&](std::string_view name) -> std::optional<AccessibilityScalePolicy> {
            const auto* policy_value =
                decoder.member(*accessibility_value, name, accessibility_pointer);
            const auto policy_pointer = pointer_child(accessibility_pointer, name);
            if (!policy_value ||
                !decoder.object(*policy_value, policy_pointer, {"enabled", "maximum", "minimum"}))
                return std::nullopt;
            const auto* enabled_value = decoder.member(*policy_value, "enabled", policy_pointer);
            const auto* minimum_value = decoder.member(*policy_value, "minimum", policy_pointer);
            const auto* maximum_value = decoder.member(*policy_value, "maximum", policy_pointer);
            auto enabled = enabled_value ? decoder.boolean(*enabled_value,
                                                           pointer_child(policy_pointer, "enabled"))
                                         : std::nullopt;
            auto minimum = minimum_value
                               ? decoder.finite_number(*minimum_value,
                                                       pointer_child(policy_pointer, "minimum"))
                               : std::nullopt;
            auto maximum = maximum_value
                               ? decoder.finite_number(*maximum_value,
                                                       pointer_child(policy_pointer, "maximum"))
                               : std::nullopt;
            if (!enabled || !minimum || !maximum)
                return std::nullopt;
            if (*minimum <= 0.0 || *maximum <= 0.0 || *minimum > *maximum ||
                (*enabled && (*minimum > 1.0 || *maximum < 1.0))) {
                decoder.error("invalid_accessibility_range",
                              "Accessibility scale ranges must be positive, ordered, and include "
                              "1.0 when enabled.",
                              policy_pointer);
                return std::nullopt;
            }
            return AccessibilityScalePolicy{*enabled, *minimum, *maximum};
        };
        auto ui_scale = decode_policy("uiScale");
        auto text_scale = decode_policy("textScale");
        if (ui_scale && text_scale)
            accessibility = AccessibilitySettings{*ui_scale, *text_scale};
    }
    std::optional<AudioMixSettings> audio;
    if (audio_value && decoder.object(*audio_value, pointer_child(pointer, "audio"),
                                      {"purposes", "voiceDucking"})) {
        const auto audio_pointer = pointer_child(pointer, "audio");
        const auto* purposes_value = decoder.member(*audio_value, "purposes", audio_pointer);
        const auto* ducking_value = decoder.member(*audio_value, "voiceDucking", audio_pointer);
        std::optional<AudioPurposeMixSettings> music;
        std::optional<AudioPurposeMixSettings> ambience;
        std::optional<AudioPurposeMixSettings> voice;
        std::optional<AudioPurposeMixSettings> sound_effect;
        std::optional<AudioPurposeMixSettings> ui_sound;
        if (purposes_value &&
            decoder.object(*purposes_value, pointer_child(audio_pointer, "purposes"),
                           {"ambience", "music", "sound-effect", "ui-sound", "voice"})) {
            const auto purposes_pointer = pointer_child(audio_pointer, "purposes");
            const auto decode_mix =
                [&](std::string_view name) -> std::optional<AudioPurposeMixSettings> {
                const auto* mix_value = decoder.member(*purposes_value, name, purposes_pointer);
                const auto mix_pointer = pointer_child(purposes_pointer, name);
                if (!mix_value || !decoder.object(*mix_value, mix_pointer, {"muted", "volume"}))
                    return std::nullopt;
                const auto* volume_value = decoder.member(*mix_value, "volume", mix_pointer);
                const auto* muted_value = decoder.member(*mix_value, "muted", mix_pointer);
                auto volume =
                    volume_value
                        ? decoder.finite_number(*volume_value, pointer_child(mix_pointer, "volume"))
                        : std::nullopt;
                auto muted =
                    muted_value ? decoder.boolean(*muted_value, pointer_child(mix_pointer, "muted"))
                                : std::nullopt;
                if (!volume || !muted)
                    return std::nullopt;
                if (*volume < 0.0 || *volume > 1.0) {
                    decoder.error(k_code_number,
                                  "Audio Purpose volume must be between zero and one.",
                                  pointer_child(mix_pointer, "volume"));
                    return std::nullopt;
                }
                return AudioPurposeMixSettings{*volume, *muted};
            };
            music = decode_mix("music");
            ambience = decode_mix("ambience");
            voice = decode_mix("voice");
            sound_effect = decode_mix("sound-effect");
            ui_sound = decode_mix("ui-sound");
        }
        std::optional<VoiceDuckingSettings> ducking;
        if (ducking_value &&
            decoder.object(*ducking_value, pointer_child(audio_pointer, "voiceDucking"),
                           {"ambienceGain", "enabled", "musicGain"})) {
            const auto ducking_pointer = pointer_child(audio_pointer, "voiceDucking");
            const auto* enabled_value = decoder.member(*ducking_value, "enabled", ducking_pointer);
            const auto* music_gain_value =
                decoder.member(*ducking_value, "musicGain", ducking_pointer);
            const auto* ambience_gain_value =
                decoder.member(*ducking_value, "ambienceGain", ducking_pointer);
            auto enabled =
                enabled_value
                    ? decoder.boolean(*enabled_value, pointer_child(ducking_pointer, "enabled"))
                    : std::nullopt;
            auto music_gain =
                music_gain_value
                    ? decoder.finite_number(*music_gain_value,
                                            pointer_child(ducking_pointer, "musicGain"))
                    : std::nullopt;
            auto ambience_gain =
                ambience_gain_value
                    ? decoder.finite_number(*ambience_gain_value,
                                            pointer_child(ducking_pointer, "ambienceGain"))
                    : std::nullopt;
            if (music_gain && (*music_gain < 0.0 || *music_gain > 1.0)) {
                decoder.error(k_code_number,
                              "Voice ducking Music gain must be between zero and one.",
                              pointer_child(ducking_pointer, "musicGain"));
                music_gain.reset();
            }
            if (ambience_gain && (*ambience_gain < 0.0 || *ambience_gain > 1.0)) {
                decoder.error(k_code_number,
                              "Voice ducking Ambience gain must be between zero and one.",
                              pointer_child(ducking_pointer, "ambienceGain"));
                ambience_gain.reset();
            }
            if (enabled && music_gain && ambience_gain)
                ducking = VoiceDuckingSettings{*enabled, *music_gain, *ambience_gain};
        }
        if (music && ambience && voice && sound_effect && ui_sound && ducking)
            audio = AudioMixSettings{*music, *ambience, *voice, *sound_effect, *ui_sound, *ducking};
    }

    auto layouts =
        layouts_value
            ? decoder.array<SystemLayout>(
                  *layouts_value, pointer_child(pointer, "systemLayouts"),
                  [&](const nlohmann::json& layout,
                      const std::string& item_pointer) -> std::optional<SystemLayout> {
                      if (!decoder.object(layout, item_pointer, {"layout", "role"}))
                          return std::nullopt;
                      const auto* role_value = decoder.member(layout, "role", item_pointer);
                      const auto* id_value = decoder.member(layout, "layout", item_pointer);
                      auto role = role_value
                                      ? decoder.enumeration<SystemLayoutRole>(
                                            *role_value, pointer_child(item_pointer, "role"),
                                            {{"title", SystemLayoutRole::Title},
                                             {"game-hud", SystemLayoutRole::GameHud},
                                             {"pause-menu", SystemLayoutRole::PauseMenu},
                                             {"load-menu", SystemLayoutRole::LoadMenu},
                                             {"settings-menu", SystemLayoutRole::SettingsMenu},
                                             {"modal", SystemLayoutRole::Modal},
                                             {"debug-overlay", SystemLayoutRole::DebugOverlay},
                                             {"save-menu", SystemLayoutRole::SaveMenu},
                                             {"text-log", SystemLayoutRole::TextLog},
                                             {"command-builder", SystemLayoutRole::CommandBuilder},
                                             {"scene-text", SystemLayoutRole::SceneText},
                                             {"scene-choice", SystemLayoutRole::SceneChoice}})
                                      : std::nullopt;
                      std::optional<LayoutId> id;
                      bool id_ok = id_value != nullptr;
                      if (id_value && !id_value->is_null()) {
                          id = decode_reference<LayoutId>(
                              decoder, *id_value, pointer_child(item_pointer, "layout"), "layout");
                          id_ok = id.has_value();
                      }
                      return role && id_ok
                                 ? std::optional<SystemLayout>(SystemLayout{*role, std::move(id)})
                                 : std::nullopt;
                  })
            : std::nullopt;
    std::optional<TextSettings> text;
    if (text_value &&
        decoder.object(*text_value, pointer_child(pointer, "text"), {"defaultFont"})) {
        const auto text_pointer = pointer_child(pointer, "text");
        const auto* font_value = decoder.member(*text_value, "defaultFont", text_pointer);
        std::optional<AssetId> font;
        bool font_ok = font_value != nullptr;
        if (font_value && !font_value->is_null()) {
            font = decode_reference<AssetId>(decoder, *font_value,
                                             pointer_child(text_pointer, "defaultFont"), "asset");
            font_ok = font.has_value();
        }
        if (font_ok)
            text = TextSettings{std::move(font)};
    }
    std::optional<TitleScreenSettings> title;
    if (title_value && decoder.object(*title_value, pointer_child(pointer, "titleScreen"),
                                      {"showAuthor", "showProjectTitle", "startLabel", "subtitle",
                                       "titleImage"})) {
        const auto title_pointer = pointer_child(pointer, "titleScreen");
        const auto* show_author_value = decoder.member(*title_value, "showAuthor", title_pointer);
        const auto* show_title_value =
            decoder.member(*title_value, "showProjectTitle", title_pointer);
        const auto* start_value = decoder.member(*title_value, "startLabel", title_pointer);
        const auto* subtitle_value = decoder.member(*title_value, "subtitle", title_pointer);
        const auto* image_value = decoder.member(*title_value, "titleImage", title_pointer);
        auto show_author =
            show_author_value
                ? decoder.boolean(*show_author_value, pointer_child(title_pointer, "showAuthor"))
                : std::nullopt;
        auto show_title = show_title_value
                              ? decoder.boolean(*show_title_value,
                                                pointer_child(title_pointer, "showProjectTitle"))
                              : std::nullopt;
        auto start = start_value ? decoder.string(*start_value,
                                                  pointer_child(title_pointer, "startLabel"), true)
                                 : std::nullopt;
        auto subtitle = subtitle_value ? decoder.string(*subtitle_value,
                                                        pointer_child(title_pointer, "subtitle"))
                                       : std::nullopt;
        std::optional<AssetId> image;
        bool image_ok = image_value != nullptr;
        if (image_value && !image_value->is_null()) {
            image = decode_reference<AssetId>(decoder, *image_value,
                                              pointer_child(title_pointer, "titleImage"), "asset");
            image_ok = image.has_value();
        }
        if (show_author && show_title && start && subtitle && image_ok)
            title = TitleScreenSettings{*show_author, *show_title, std::move(*start),
                                        std::move(*subtitle), std::move(image)};
    }
    std::optional<RoomNavigationTransition> transition;
    if (transition_value &&
        decoder.object(*transition_value, pointer_child(pointer, "roomNavigationTransition"),
                       {"color", "durationMs", "kind", "skippable"})) {
        const auto transition_pointer = pointer_child(pointer, "roomNavigationTransition");
        const auto* kind_value = decoder.member(*transition_value, "kind", transition_pointer);
        const auto* duration_value =
            decoder.member(*transition_value, "durationMs", transition_pointer);
        const auto* color_value = decoder.member(*transition_value, "color", transition_pointer);
        const auto* skippable_value =
            decoder.member(*transition_value, "skippable", transition_pointer);
        auto kind = kind_value ? decoder.enumeration<TransitionKind>(
                                     *kind_value, pointer_child(transition_pointer, "kind"),
                                     {{"fade", TransitionKind::Fade},
                                      {"cut", TransitionKind::Cut},
                                      {"dissolve", TransitionKind::Dissolve}})
                               : std::nullopt;
        auto duration = duration_value
                            ? decoder.unsigned_integer<std::uint64_t>(
                                  *duration_value, pointer_child(transition_pointer, "durationMs"))
                            : std::nullopt;
        std::optional<std::string> color;
        bool color_ok = color_value != nullptr;
        if (color_value && !color_value->is_null()) {
            color = decoder.string(*color_value, pointer_child(transition_pointer, "color"));
            color_ok = color.has_value();
        }
        auto skippable =
            skippable_value
                ? decoder.boolean(*skippable_value, pointer_child(transition_pointer, "skippable"))
                : std::nullopt;
        if (kind && duration && color_ok && skippable &&
            ((*kind == TransitionKind::Cut) == (*duration == 0)) &&
            (*kind == TransitionKind::Fade || !color))
            transition = RoomNavigationTransition{*kind, *duration, std::move(color), *skippable};
    }
    if (!display || !accessibility || !audio || !layouts || !text || !title || !transition)
        return std::nullopt;
    return RuntimeSettings{std::move(*display), std::move(*accessibility), std::move(*layouts),
                           std::move(*text),    std::move(*title),         std::move(*transition),
                           std::move(*audio)};
}

std::optional<PropertyOwnerRef>
decode_exact_property_owner(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"character", "interactable", "kind", "room"}))
        return std::nullopt;
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "room") {
        const auto* room_value = decoder.member(value, "room", pointer);
        auto room = room_value ? decode_reference<RoomId>(decoder, *room_value,
                                                          pointer_child(pointer, "room"), "room")
                               : std::nullopt;
        return room ? std::optional<PropertyOwnerRef>{PropertyOwnerRef{std::move(*room)}}
                    : std::nullopt;
    }
    if (*kind == "character") {
        const auto* character_value = decoder.member(value, "character", pointer);
        auto character =
            character_value
                ? decode_reference<CharacterId>(decoder, *character_value,
                                                pointer_child(pointer, "character"), "character")
                : std::nullopt;
        return character ? std::optional<PropertyOwnerRef>{PropertyOwnerRef{std::move(*character)}}
                         : std::nullopt;
    }
    if (*kind == "interactable") {
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableInstanceId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        return interactable
                   ? std::optional<PropertyOwnerRef>{PropertyOwnerRef{std::move(*interactable)}}
                   : std::nullopt;
    }
    decoder.error(k_code_variant,
                  "Expected Property owner kind 'room', 'character', or 'interactable'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<PropertyDeclaration> decode_property(Decoder& decoder, const nlohmann::json& value,
                                                   std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* scope_value = decoder.member(value, "scope", pointer);
    auto scope =
        scope_value
            ? decoder.enumeration<PropertyScope>(
                  *scope_value, pointer_child(pointer, "scope"),
                  {{"global", PropertyScope::Global}, {"identity", PropertyScope::Identity}})
            : std::nullopt;
    if (!scope)
        return std::nullopt;

    const bool global = *scope == PropertyScope::Global;
    if (!decoder.object(
            value, pointer,
            global ? std::initializer_list<std::string_view>{"defaultValue", "description",
                                                             "enumValues", "id", "label",
                                                             "nullable", "scope", "type"}
                   : std::initializer_list<std::string_view>{"defaultValue", "description",
                                                             "enumValues", "id", "label",
                                                             "nullable", "owner", "scope", "type"}))
        return std::nullopt;

    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* enum_value = decoder.member(value, "enumValues", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* nullable_value = decoder.member(value, "nullable", pointer);
    const auto* owner_value = global ? nullptr : decoder.member(value, "owner", pointer);
    auto id =
        id_value ? decoder.id<PropertyId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    std::vector<std::string> enum_values;
    auto type = type_value && enum_value
                    ? decode_value_type(decoder, *type_value, *enum_value, pointer, enum_values)
                    : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;
    auto label = label_value ? decoder.string(*label_value, pointer_child(pointer, "label"), true)
                             : std::nullopt;
    auto nullable = nullable_value
                        ? decoder.boolean(*nullable_value, pointer_child(pointer, "nullable"))
                        : std::nullopt;
    std::optional<PropertyOwnerRef> exact_owner;
    bool owner_ok = global;
    if (!global && owner_value) {
        exact_owner =
            decode_exact_property_owner(decoder, *owner_value, pointer_child(pointer, "owner"));
        owner_ok = exact_owner.has_value();
    }
    const auto* default_value = global ? decoder.member(value, "defaultValue", pointer)
                                       : json_access::member(value, "defaultValue");
    std::optional<RuntimeValue> default_runtime;
    bool default_ok = !global;
    if (default_value != nullptr) {
        default_runtime =
            decode_runtime_value(decoder, *default_value, pointer_child(pointer, "defaultValue"));
        default_ok = default_runtime.has_value();
    }
    if (!id || !type || !description || !label || !nullable || !default_ok || !owner_ok)
        return std::nullopt;
    return PropertyDeclaration{std::move(*id),
                               std::move(*type),
                               *nullable,
                               std::move(default_runtime),
                               *scope,
                               std::move(enum_values),
                               std::move(exact_owner),
                               std::move(*label),
                               std::move(*description)};
}

std::optional<TraitProperty> decode_owner_property_contract(Decoder& decoder,
                                                            const nlohmann::json& value,
                                                            std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"defaultValue", "description", "enumValues", "id", "label", "nullable", "type"}))
        return std::nullopt;
    const auto* property_value = decoder.member(value, "id", pointer);
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* enum_value = decoder.member(value, "enumValues", pointer);
    const auto* nullable_value = decoder.member(value, "nullable", pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    auto property = property_value
                        ? decoder.id<PropertyId>(*property_value, pointer_child(pointer, "id"))
                        : std::nullopt;
    std::vector<std::string> enum_values;
    auto type = type_value && enum_value
                    ? decode_value_type(decoder, *type_value, *enum_value, pointer, enum_values)
                    : std::nullopt;
    auto nullable = nullable_value
                        ? decoder.boolean(*nullable_value, pointer_child(pointer, "nullable"))
                        : std::nullopt;
    auto label = label_value ? decoder.string(*label_value, pointer_child(pointer, "label"), true)
                             : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;
    const auto* default_value = json_access::member(value, "defaultValue");
    std::optional<RuntimeValue> configured_value;
    bool value_ok = true;
    if (default_value != nullptr) {
        configured_value =
            decode_runtime_value(decoder, *default_value, pointer_child(pointer, "defaultValue"));
        value_ok = configured_value.has_value();
    }
    return property && type && nullable && label && description && value_ok
               ? std::optional<TraitProperty>(TraitProperty{
                     std::move(*property), std::move(*type), *nullable, std::move(enum_values),
                     std::move(configured_value), std::move(*label), std::move(*description)})
               : std::nullopt;
}

std::optional<TraitDeclaration> decode_trait(Decoder& decoder, const nlohmann::json& value,
                                             std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"description", "id", "label", "ownerKinds", "properties"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* owners_value = decoder.member(value, "ownerKinds", pointer);
    const auto* properties_value = decoder.member(value, "properties", pointer);
    auto id =
        id_value ? decoder.id<TraitId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto label = label_value ? decoder.string(*label_value, pointer_child(pointer, "label"), true)
                             : std::nullopt;
    auto description = description_value ? decoder.string(*description_value,
                                                          pointer_child(pointer, "description"))
                                         : std::nullopt;
    auto owners = owners_value
                      ? decoder.array<PropertyOwnerKind>(
                            *owners_value, pointer_child(pointer, "ownerKinds"),
                            [&](const nlohmann::json& owner, const std::string& owner_pointer) {
                                return decoder.enumeration<PropertyOwnerKind>(
                                    owner, owner_pointer,
                                    {{"room", PropertyOwnerKind::Room},
                                     {"character", PropertyOwnerKind::Character},
                                     {"interactable", PropertyOwnerKind::Interactable},
                                     {"feature", PropertyOwnerKind::Feature}});
                            })
                      : std::nullopt;
    auto properties =
        properties_value
            ? decoder.array<TraitProperty>(
                  *properties_value, pointer_child(pointer, "properties"),
                  [&](const nlohmann::json& member,
                      const std::string& member_pointer) -> std::optional<TraitProperty> {
                      if (!member.is_object()) {
                          decoder.error(k_code_type, "Expected an object.", member_pointer);
                          return std::nullopt;
                      }
                      if (!decoder.object(member, member_pointer,
                                          {"defaultValue", "description", "enumValues", "id",
                                           "label", "nullable", "type"}))
                          return std::nullopt;
                      const auto* property_value = decoder.member(member, "id", member_pointer);
                      const auto* type_value = decoder.member(member, "type", member_pointer);
                      const auto* enum_value = decoder.member(member, "enumValues", member_pointer);
                      const auto* nullable_value =
                          decoder.member(member, "nullable", member_pointer);
                      const auto* label_value = decoder.member(member, "label", member_pointer);
                      const auto* description_value =
                          decoder.member(member, "description", member_pointer);
                      auto property =
                          property_value ? decoder.id<PropertyId>(
                                               *property_value, pointer_child(member_pointer, "id"))
                                         : std::nullopt;
                      std::vector<std::string> enum_values;
                      auto type = type_value && enum_value
                                      ? decode_value_type(decoder, *type_value, *enum_value,
                                                          member_pointer, enum_values)
                                      : std::nullopt;
                      auto nullable =
                          nullable_value
                              ? decoder.boolean(*nullable_value,
                                                pointer_child(member_pointer, "nullable"))
                              : std::nullopt;
                      auto label =
                          label_value ? decoder.string(*label_value,
                                                       pointer_child(member_pointer, "label"), true)
                                      : std::nullopt;
                      auto description =
                          description_value
                              ? decoder.string(*description_value,
                                               pointer_child(member_pointer, "description"))
                              : std::nullopt;
                      const auto* default_value = json_access::member(member, "defaultValue");
                      std::optional<RuntimeValue> configured_value;
                      bool value_ok = true;
                      if (default_value != nullptr) {
                          configured_value =
                              decode_runtime_value(decoder, *default_value,
                                                   pointer_child(member_pointer, "defaultValue"));
                          value_ok = configured_value.has_value();
                      }
                      return property && type && nullable && label && description && value_ok
                                 ? std::optional<TraitProperty>(TraitProperty{
                                       std::move(*property), std::move(*type), *nullable,
                                       std::move(enum_values), std::move(configured_value),
                                       std::move(*label), std::move(*description)})
                                 : std::nullopt;
                  })
            : std::nullopt;
    if (owners) {
        auto sorted = *owners;
        std::sort(sorted.begin(), sorted.end());
        if (std::adjacent_find(sorted.begin(), sorted.end()) != sorted.end())
            decoder.error(k_code_duplicate, "Trait owner kinds must be unique.",
                          pointer_child(pointer, "ownerKinds"));
    }
    if (properties) {
        std::unordered_set<std::string> ids;
        for (std::size_t index = 0; index < properties->size(); ++index) {
            const auto& text = (*properties)[index].property_id.text();
            if (!ids.insert(text).second)
                decoder.error(
                    k_code_duplicate, "Duplicate Trait Property '" + text + "'.",
                    pointer_child(pointer_index(pointer_child(pointer, "properties"), index),
                                  "id"));
        }
    }
    if (!id || !label || !description || !owners || owners->empty() || !properties)
        return std::nullopt;
    return TraitDeclaration{std::move(*id), std::move(*label), std::move(*description),
                            std::move(*owners), std::move(*properties)};
}

std::optional<AssetResource> decode_asset(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind = kind_value
                    ? decoder.enumeration<AssetKind>(*kind_value, pointer_child(pointer, "kind"),
                                                     {{"image", AssetKind::Image},
                                                      {"font", AssetKind::Font},
                                                      {"audio", AssetKind::Audio},
                                                      {"script", AssetKind::Script},
                                                      {"shader-source", AssetKind::ShaderSource},
                                                      {"text", AssetKind::Text},
                                                      {"data", AssetKind::Data},
                                                      {"binary", AssetKind::Binary}})
                    : std::nullopt;
    if (!kind)
        return std::nullopt;

    if (*kind == AssetKind::Image) {
        decoder.object(value, pointer,
                       {"aliases", "height", "id", "kind", "path", "sampling", "width"});
    } else {
        decoder.object(value, pointer, {"aliases", "id", "kind", "path"});
    }

    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* path_value = decoder.member(value, "path", pointer);
    const auto* aliases_value = decoder.member(value, "aliases", pointer);
    const auto* sampling_value =
        *kind == AssetKind::Image ? decoder.member(value, "sampling", pointer) : nullptr;
    const auto* width_value =
        *kind == AssetKind::Image ? decoder.member(value, "width", pointer) : nullptr;
    const auto* height_value =
        *kind == AssetKind::Image ? decoder.member(value, "height", pointer) : nullptr;
    auto id =
        id_value ? decoder.id<AssetId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto path = path_value ? decoder.string(*path_value, pointer_child(pointer, "path"), true)
                           : std::nullopt;
    auto aliases = aliases_value
                       ? decoder.array<std::string>(
                             *aliases_value, pointer_child(pointer, "aliases"),
                             [&](const nlohmann::json& alias, const std::string& alias_pointer) {
                                 return decoder.string(alias, alias_pointer, true);
                             })
                       : std::nullopt;
    auto sampling =
        sampling_value
            ? decoder.enumeration<ImageSampling>(
                  *sampling_value, pointer_child(pointer, "sampling"),
                  {{"linear", ImageSampling::Linear}, {"nearest", ImageSampling::Nearest}})
            : std::optional<ImageSampling>{};
    auto width =
        width_value
            ? decoder.unsigned_integer<std::uint32_t>(*width_value, pointer_child(pointer, "width"))
            : std::optional<std::uint32_t>{};
    auto height = height_value ? decoder.unsigned_integer<std::uint32_t>(
                                     *height_value, pointer_child(pointer, "height"))
                               : std::optional<std::uint32_t>{};
    if (!id || !path || !aliases ||
        (*kind == AssetKind::Image &&
         (!sampling || !width || !height || *width == 0 || *height == 0)))
        return std::nullopt;
    return AssetResource{std::move(*id),      *kind,
                         std::move(*path),    std::move(*aliases),
                         std::move(sampling), std::move(width),
                         std::move(height)};
}

std::optional<LayoutStateShape>
decode_layout_state_shape(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Layout State Shape must be an object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* type_value = decoder.member(value, "type", pointer);
    auto type_name = type_value ? decoder.string(*type_value, pointer_child(pointer, "type"), true)
                                : std::nullopt;
    if (!type_name)
        return std::nullopt;

    const bool array = *type_name == "array";
    const bool object = *type_name == "object";
    if (array) {
        if (!decoder.object(value, pointer,
                            {"defaultValue", "hasDefault", "items", "nullable", "type"}))
            return std::nullopt;
    } else if (object) {
        if (!decoder.object(value, pointer,
                            {"defaultValue", "fields", "hasDefault", "nullable", "type"}))
            return std::nullopt;
    } else if (!decoder.object(value, pointer,
                               {"defaultValue", "hasDefault", "nullable", "type"})) {
        return std::nullopt;
    }

    const auto* nullable_value = decoder.member(value, "nullable", pointer);
    const auto* has_default_value = decoder.member(value, "hasDefault", pointer);
    const auto* default_value = decoder.member(value, "defaultValue", pointer);
    auto nullable = nullable_value
                        ? decoder.boolean(*nullable_value, pointer_child(pointer, "nullable"))
                        : std::nullopt;
    auto has_default = has_default_value ? decoder.boolean(*has_default_value,
                                                           pointer_child(pointer, "hasDefault"))
                                         : std::nullopt;
    if (!nullable || !has_default || !default_value)
        return std::nullopt;

    LayoutStateShapeType type;
    if (*type_name == "boolean")
        type = LayoutStateShapeType::Boolean;
    else if (*type_name == "integer")
        type = LayoutStateShapeType::Integer;
    else if (*type_name == "number")
        type = LayoutStateShapeType::Number;
    else if (*type_name == "string")
        type = LayoutStateShapeType::String;
    else if (array)
        type = LayoutStateShapeType::Array;
    else if (object)
        type = LayoutStateShapeType::Object;
    else {
        decoder.error(k_code_variant, "Unknown Layout State Shape type '" + *type_name + "'.",
                      pointer_child(pointer, "type"));
        return std::nullopt;
    }

    LayoutStateShape shape{.type = type,
                           .nullable = *nullable,
                           .default_value = std::nullopt,
                           .items = {},
                           .fields = {}};
    if (*has_default) {
        auto decoded = decode_persistable_value(decoder, *default_value,
                                                pointer_child(pointer, "defaultValue"));
        if (!decoded)
            return std::nullopt;
        shape.default_value = std::move(*decoded);
    } else if (!default_value->is_null()) {
        decoder.error("compiled.layout_state_default_presence",
                      "Layout State Shape without a default must encode defaultValue as null",
                      pointer_child(pointer, "defaultValue"));
        return std::nullopt;
    }

    if (array) {
        const auto* items_value = decoder.member(value, "items", pointer);
        auto items = items_value ? decode_layout_state_shape(decoder, *items_value,
                                                             pointer_child(pointer, "items"))
                                 : std::nullopt;
        if (!items)
            return std::nullopt;
        shape.items.push_back(std::move(*items));
    } else if (object) {
        const auto* fields_value = decoder.member(value, "fields", pointer);
        auto fields =
            fields_value
                ? decoder.array<LayoutStateObjectField>(
                      *fields_value, pointer_child(pointer, "fields"),
                      [&](const nlohmann::json& field, const std::string& field_pointer)
                          -> std::optional<LayoutStateObjectField> {
                          if (!decoder.object(field, field_pointer, {"id", "required", "shape"}))
                              return std::nullopt;
                          const auto* id_value = decoder.member(field, "id", field_pointer);
                          const auto* required_value =
                              decoder.member(field, "required", field_pointer);
                          const auto* shape_value = decoder.member(field, "shape", field_pointer);
                          auto id = id_value
                                        ? decoder.string(*id_value,
                                                         pointer_child(field_pointer, "id"), true)
                                        : std::nullopt;
                          auto required =
                              required_value
                                  ? decoder.boolean(*required_value,
                                                    pointer_child(field_pointer, "required"))
                                  : std::nullopt;
                          auto child =
                              shape_value
                                  ? decode_layout_state_shape(decoder, *shape_value,
                                                              pointer_child(field_pointer, "shape"))
                                  : std::nullopt;
                          if (!id || !required || !child)
                              return std::nullopt;
                          LayoutStateObjectField result{
                              .id = std::move(*id), .required = *required, .shape = {}};
                          result.shape.push_back(std::move(*child));
                          return result;
                      })
                : std::nullopt;
        if (!fields)
            return std::nullopt;
        shape.fields = std::move(*fields);
    }

    if (!layout_state_shape_valid(shape)) {
        decoder.error("compiled.layout_state_shape_invalid",
                      "Layout State Shape defaults or recursive members are invalid",
                      std::string(pointer));
        return std::nullopt;
    }
    return shape;
}

std::optional<LayoutResource> decode_layout(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"contract", "dependencies", "id", "kind", "lua", "mount", "rcss", "rml",
                         "scalePolicy", "script", "target"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* target_value = decoder.member(value, "target", pointer);
    const auto* scale_policy_value = decoder.member(value, "scalePolicy", pointer);
    const auto* contract_value = json_access::member(value, "contract");
    const auto* rml_value = decoder.member(value, "rml", pointer);
    const auto* rcss_value = decoder.member(value, "rcss", pointer);
    const auto* lua_value = decoder.member(value, "lua", pointer);
    const auto* dependencies_value = decoder.member(value, "dependencies", pointer);
    const auto* mount_value = decoder.member(value, "mount", pointer);
    const auto* script_value = decoder.member(value, "script", pointer);
    auto id =
        id_value ? decoder.id<LayoutId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto kind = kind_value
                    ? decoder.enumeration<LayoutKind>(
                          *kind_value, pointer_child(pointer, "kind"),
                          {{"document", LayoutKind::Document}, {"fragment", LayoutKind::Fragment}})
                    : std::nullopt;
    auto target =
        target_value
            ? decoder.enumeration<LayoutTarget>(*target_value, pointer_child(pointer, "target"),
                                                {{"default-ui", LayoutTarget::DefaultUi},
                                                 {"dialogue-ui", LayoutTarget::DialogueUi},
                                                 {"scene-overlay", LayoutTarget::SceneOverlay},
                                                 {"room-overlay", LayoutTarget::RoomOverlay},
                                                 {"menu-ui", LayoutTarget::MenuUi},
                                                 {"custom-overlay", LayoutTarget::CustomOverlay}})
            : std::nullopt;
    std::optional<LayoutScalePolicy> scale_policy;
    if (scale_policy_value &&
        decoder.object(*scale_policy_value, pointer_child(pointer, "scalePolicy"),
                       {"text", "ui"})) {
        const auto policy_pointer = pointer_child(pointer, "scalePolicy");
        const auto* ui_value = decoder.member(*scale_policy_value, "ui", policy_pointer);
        const auto* text_value = decoder.member(*scale_policy_value, "text", policy_pointer);
        auto ui = ui_value ? decoder.enumeration<LayoutScaleInheritance>(
                                 *ui_value, pointer_child(policy_pointer, "ui"),
                                 {{"inherit", LayoutScaleInheritance::Inherit},
                                  {"ignore", LayoutScaleInheritance::Ignore}})
                           : std::nullopt;
        auto text = text_value ? decoder.enumeration<LayoutScaleInheritance>(
                                     *text_value, pointer_child(policy_pointer, "text"),
                                     {{"inherit", LayoutScaleInheritance::Inherit},
                                      {"ignore", LayoutScaleInheritance::Ignore}})
                               : std::nullopt;
        if (ui && text)
            scale_policy = LayoutScalePolicy{*ui, *text};
    }
    std::optional<LayoutContract> contract = LayoutContract{};
    if (contract_value && decoder.object(*contract_value, pointer_child(pointer, "contract"),
                                         {"inputs", "signals", "state"})) {
        const auto contract_pointer = pointer_child(pointer, "contract");
        const auto* inputs_value = decoder.member(*contract_value, "inputs", contract_pointer);
        const auto* signals_value = decoder.member(*contract_value, "signals", contract_pointer);
        const auto* state_value = decoder.member(*contract_value, "state", contract_pointer);
        auto decode_shape =
            [&](const nlohmann::json& item, const std::string& item_pointer,
                bool allow_required) -> std::optional<std::pair<LayoutContractValueShape, bool>> {
            if (allow_required) {
                if (!decoder.object(item, item_pointer, {"id", "nullable", "required", "type"}))
                    return std::nullopt;
            } else if (!decoder.object(item, item_pointer,
                                       {"defaultValue", "hasDefault", "id", "nullable", "type"})) {
                return std::nullopt;
            }
            const auto* type_value = decoder.member(item, "type", item_pointer);
            const auto* nullable_value = decoder.member(item, "nullable", item_pointer);
            auto type = type_value ? decoder.enumeration<LayoutContractValueType>(
                                         *type_value, pointer_child(item_pointer, "type"),
                                         {{"boolean", LayoutContractValueType::Boolean},
                                          {"integer", LayoutContractValueType::Integer},
                                          {"number", LayoutContractValueType::Number},
                                          {"string", LayoutContractValueType::String}})
                                   : std::nullopt;
            auto nullable =
                nullable_value
                    ? decoder.boolean(*nullable_value, pointer_child(item_pointer, "nullable"))
                    : std::nullopt;
            bool required = true;
            if (allow_required) {
                const auto* required_value = decoder.member(item, "required", item_pointer);
                auto decoded_required =
                    required_value
                        ? decoder.boolean(*required_value, pointer_child(item_pointer, "required"))
                        : std::nullopt;
                if (!decoded_required)
                    return std::nullopt;
                required = *decoded_required;
            }
            if (!type || !nullable)
                return std::nullopt;
            return std::pair{LayoutContractValueShape{*type, *nullable}, required};
        };
        std::optional<std::vector<LayoutInputDefinition>> inputs;
        if (inputs_value) {
            inputs = decoder.array<LayoutInputDefinition>(
                *inputs_value, pointer_child(contract_pointer, "inputs"),
                [&](const nlohmann::json& item,
                    const std::string& item_pointer) -> std::optional<LayoutInputDefinition> {
                    auto shape = decode_shape(item, item_pointer, false);
                    const auto* id_value = decoder.member(item, "id", item_pointer);
                    const auto* has_default_value =
                        decoder.member(item, "hasDefault", item_pointer);
                    const auto* default_value = decoder.member(item, "defaultValue", item_pointer);
                    auto input_id = id_value ? decoder.id<LayoutInputId>(
                                                   *id_value, pointer_child(item_pointer, "id"))
                                             : std::nullopt;
                    auto has_default =
                        has_default_value
                            ? decoder.boolean(*has_default_value,
                                              pointer_child(item_pointer, "hasDefault"))
                            : std::nullopt;
                    std::optional<RuntimeValue> decoded_default;
                    bool default_ok = default_value != nullptr;
                    if (default_value && has_default && *has_default) {
                        decoded_default =
                            decode_runtime_value(decoder, *default_value,
                                                 pointer_child(item_pointer, "defaultValue"), true);
                        default_ok = decoded_default.has_value();
                    } else if (default_value && has_default && !*has_default) {
                        default_ok = default_value->is_null();
                        if (!default_ok)
                            decoder.error(
                                "compiled.layout_contract_default_presence",
                                pointer_child(item_pointer, "defaultValue"),
                                "Layout input without a default must encode defaultValue as null");
                    }
                    if (!shape || !input_id || !has_default || !default_ok ||
                        (decoded_default &&
                         !layout_contract_value_matches(shape->first, *decoded_default))) {
                        if (decoded_default && shape &&
                            !layout_contract_value_matches(shape->first, *decoded_default))
                            decoder.error("compiled.layout_contract_default_type",
                                          pointer_child(item_pointer, "defaultValue"),
                                          "Layout input default does not match its declared type");
                        return std::nullopt;
                    }
                    return LayoutInputDefinition{std::move(*input_id), shape->first,
                                                 std::move(decoded_default)};
                });
        }
        std::optional<std::vector<LayoutSignalDefinition>> signals;
        if (signals_value) {
            signals = decoder.array<LayoutSignalDefinition>(
                *signals_value, pointer_child(contract_pointer, "signals"),
                [&](const nlohmann::json& item,
                    const std::string& item_pointer) -> std::optional<LayoutSignalDefinition> {
                    if (!decoder.object(item, item_pointer, {"fields", "id"}))
                        return std::nullopt;
                    const auto* id_value = decoder.member(item, "id", item_pointer);
                    const auto* fields_value = decoder.member(item, "fields", item_pointer);
                    auto signal_id = id_value ? decoder.id<LayoutSignalId>(
                                                    *id_value, pointer_child(item_pointer, "id"))
                                              : std::nullopt;
                    auto fields =
                        fields_value
                            ? decoder.array<LayoutSignalFieldDefinition>(
                                  *fields_value, pointer_child(item_pointer, "fields"),
                                  [&](const nlohmann::json& field, const std::string& field_pointer)
                                      -> std::optional<LayoutSignalFieldDefinition> {
                                      auto shape = decode_shape(field, field_pointer, true);
                                      const auto* field_id_value =
                                          decoder.member(field, "id", field_pointer);
                                      auto field_id = field_id_value
                                                          ? decoder.id<LayoutSignalFieldId>(
                                                                *field_id_value,
                                                                pointer_child(field_pointer, "id"))
                                                          : std::nullopt;
                                      if (!shape || !field_id)
                                          return std::nullopt;
                                      return LayoutSignalFieldDefinition{
                                          std::move(*field_id), shape->first, shape->second};
                                  })
                            : std::nullopt;
                    if (!signal_id || !fields)
                        return std::nullopt;
                    return LayoutSignalDefinition{std::move(*signal_id), std::move(*fields)};
                });
        }
        std::optional<LayoutStateShape> state;
        bool state_ok = state_value != nullptr;
        if (state_value && !state_value->is_null()) {
            state = decode_layout_state_shape(decoder, *state_value,
                                              pointer_child(contract_pointer, "state"));
            state_ok = state.has_value();
        }
        if (inputs && signals && state_ok)
            contract = LayoutContract{std::move(*inputs), std::move(*signals), std::move(state)};
    }
    auto rml = rml_value ? decode_layout_source(decoder, *rml_value, pointer_child(pointer, "rml"))
                         : std::nullopt;
    auto rcss = rcss_value
                    ? decode_layout_source(decoder, *rcss_value, pointer_child(pointer, "rcss"))
                    : std::nullopt;
    auto lua = lua_value ? decode_layout_source(decoder, *lua_value, pointer_child(pointer, "lua"))
                         : std::nullopt;
    std::optional<LayoutDependencies> dependencies;
    if (dependencies_value &&
        decoder.object(*dependencies_value, pointer_child(pointer, "dependencies"),
                       {"fonts", "images", "materials", "scripts", "stylesheets"})) {
        const auto dependency_pointer = pointer_child(pointer, "dependencies");
        auto decode_assets = [&](std::string_view key) -> std::optional<std::vector<AssetId>> {
            const auto* collection = decoder.member(*dependencies_value, key, dependency_pointer);
            return collection
                       ? decoder.array<AssetId>(
                             *collection, pointer_child(dependency_pointer, key),
                             [&](const nlohmann::json& reference, const std::string& item_pointer) {
                                 return decode_reference<AssetId>(decoder, reference, item_pointer,
                                                                  "asset");
                             })
                       : std::nullopt;
        };
        auto fonts = decode_assets("fonts");
        auto images = decode_assets("images");
        auto scripts = decode_assets("scripts");
        auto stylesheets = decode_assets("stylesheets");
        const auto* material_collection =
            decoder.member(*dependencies_value, "materials", dependency_pointer);
        auto materials =
            material_collection
                ? decoder.array<MaterialId>(
                      *material_collection, pointer_child(dependency_pointer, "materials"),
                      [&](const nlohmann::json& reference, const std::string& item_pointer) {
                          return decode_reference<MaterialId>(decoder, reference, item_pointer,
                                                              "material");
                      })
                : std::nullopt;
        if (fonts && images && materials && scripts && stylesheets)
            dependencies =
                LayoutDependencies{std::move(*fonts), std::move(*images), std::move(*materials),
                                   std::move(*scripts), std::move(*stylesheets)};
    }
    std::optional<std::string> default_parent;
    std::optional<bool> scoped_styles;
    bool mount_ok = false;
    if (mount_value && decoder.object(*mount_value, pointer_child(pointer, "mount"),
                                      {"defaultParent", "scopedStyles"})) {
        const auto mount_pointer = pointer_child(pointer, "mount");
        const auto* parent_value = decoder.member(*mount_value, "defaultParent", mount_pointer);
        const auto* scoped_value = decoder.member(*mount_value, "scopedStyles", mount_pointer);
        bool parent_ok = parent_value != nullptr;
        if (parent_value && !parent_value->is_null()) {
            default_parent =
                decoder.string(*parent_value, pointer_child(mount_pointer, "defaultParent"));
            parent_ok = default_parent.has_value();
        }
        scoped_styles = scoped_value ? decoder.boolean(*scoped_value,
                                                       pointer_child(mount_pointer, "scopedStyles"))
                                     : std::nullopt;
        mount_ok = parent_ok && scoped_styles.has_value();
    }
    std::optional<bool> script_enabled;
    std::optional<std::string> script_namespace;
    bool script_ok = false;
    if (script_value &&
        decoder.object(*script_value, pointer_child(pointer, "script"), {"enabled", "namespace"})) {
        const auto script_pointer = pointer_child(pointer, "script");
        const auto* enabled_value = decoder.member(*script_value, "enabled", script_pointer);
        const auto* namespace_value = decoder.member(*script_value, "namespace", script_pointer);
        script_enabled = enabled_value ? decoder.boolean(*enabled_value,
                                                         pointer_child(script_pointer, "enabled"))
                                       : std::nullopt;
        bool namespace_ok = namespace_value != nullptr;
        if (namespace_value && !namespace_value->is_null()) {
            script_namespace =
                decoder.string(*namespace_value, pointer_child(script_pointer, "namespace"));
            namespace_ok = script_namespace.has_value();
        }
        script_ok = script_enabled.has_value() && namespace_ok;
    }
    if (!id || !kind || !target || !scale_policy || !contract || !rml || !rcss || !lua ||
        !dependencies || !mount_ok || !script_ok)
        return std::nullopt;
    return LayoutResource{std::move(*id),
                          *kind,
                          *target,
                          *scale_policy,
                          std::move(*contract),
                          std::move(*rml),
                          std::move(*rcss),
                          std::move(*lua),
                          std::move(*dependencies),
                          std::move(default_parent),
                          *scoped_styles,
                          *script_enabled,
                          std::move(script_namespace)};
}

std::optional<ScriptResource> decode_script(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"id", "source"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* source_value = decoder.member(value, "source", pointer);
    auto id =
        id_value ? decoder.id<ScriptId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    auto source = source_value ? decode_script_source(decoder, *source_value,
                                                      pointer_child(pointer, "source"))
                               : std::nullopt;
    return id && source
               ? std::optional<ScriptResource>(ScriptResource{std::move(*id), std::move(*source)})
               : std::nullopt;
}

} // namespace noveltea::core::compiled::wire::detail
