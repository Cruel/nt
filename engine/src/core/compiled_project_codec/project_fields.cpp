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
    if (!decoder.object(value, pointer, {"display", "systemLayouts", "text", "titleScreen"}))
        return std::nullopt;
    const auto* display_value = decoder.member(value, "display", pointer);
    const auto* layouts_value = decoder.member(value, "systemLayouts", pointer);
    const auto* text_value = decoder.member(value, "text", pointer);
    const auto* title_value = decoder.member(value, "titleScreen", pointer);
    std::optional<DisplaySettings> display;
    if (display_value && decoder.object(*display_value, pointer_child(pointer, "display"),
                                        {"aspectRatio", "barColor", "orientation"})) {
        const auto display_pointer = pointer_child(pointer, "display");
        const auto* ratio_value = decoder.member(*display_value, "aspectRatio", display_pointer);
        const auto* bar_value = decoder.member(*display_value, "barColor", display_pointer);
        const auto* orientation_value =
            decoder.member(*display_value, "orientation", display_pointer);
        std::optional<AspectRatio> ratio;
        if (ratio_value &&
            decoder.object(*ratio_value, pointer_child(display_pointer, "aspectRatio"),
                           {"height", "width"})) {
            const auto ratio_pointer = pointer_child(display_pointer, "aspectRatio");
            const auto* height_value = decoder.member(*ratio_value, "height", ratio_pointer);
            const auto* width_value = decoder.member(*ratio_value, "width", ratio_pointer);
            auto height = height_value
                              ? decoder.unsigned_integer<std::uint32_t>(
                                    *height_value, pointer_child(ratio_pointer, "height"), true)
                              : std::nullopt;
            auto width = width_value
                             ? decoder.unsigned_integer<std::uint32_t>(
                                   *width_value, pointer_child(ratio_pointer, "width"), true)
                             : std::nullopt;
            if (height && width)
                ratio = AspectRatio{*width, *height};
        }
        auto bar = bar_value
                       ? decoder.string(*bar_value, pointer_child(display_pointer, "barColor"))
                       : std::nullopt;
        auto orientation = orientation_value ? decoder.enumeration<DisplayOrientation>(
                                                   *orientation_value,
                                                   pointer_child(display_pointer, "orientation"),
                                                   {{"landscape", DisplayOrientation::Landscape},
                                                    {"portrait", DisplayOrientation::Portrait}})
                                             : std::nullopt;
        if (ratio && bar && orientation)
            display = DisplaySettings{std::move(*ratio), std::move(*bar), *orientation};
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
                                             {"debug-overlay", SystemLayoutRole::DebugOverlay}})
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
    if (!display || !layouts || !text || !title)
        return std::nullopt;
    return RuntimeSettings{std::move(*display), std::move(*layouts), std::move(*text),
                           std::move(*title)};
}

std::optional<VariableDeclaration> decode_variable(Decoder& decoder, const nlohmann::json& value,
                                                   std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"defaultValue", "enumValues", "id", "type"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* enum_value = decoder.member(value, "enumValues", pointer);
    const auto* default_value = decoder.member(value, "defaultValue", pointer);
    auto id =
        id_value ? decoder.id<VariableId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
    std::vector<std::string> enum_values;
    auto type = type_value && enum_value
                    ? decode_value_type(decoder, *type_value, *enum_value, pointer, enum_values)
                    : std::nullopt;
    auto default_runtime = default_value
                               ? decode_runtime_value(decoder, *default_value,
                                                      pointer_child(pointer, "defaultValue"), false)
                               : std::nullopt;
    if (!id || !type || !default_runtime)
        return std::nullopt;
    return VariableDeclaration{std::move(*id), std::move(*type), std::move(*default_runtime),
                               std::move(enum_values)};
}

std::optional<PropertyDeclaration> decode_property(Decoder& decoder, const nlohmann::json& value,
                                                   std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"defaultValue", "description", "enumValues", "id", "label", "nullable",
                         "ownerKinds", "persistence", "type"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* type_value = decoder.member(value, "type", pointer);
    const auto* enum_value = decoder.member(value, "enumValues", pointer);
    const auto* description_value = decoder.member(value, "description", pointer);
    const auto* label_value = decoder.member(value, "label", pointer);
    const auto* nullable_value = decoder.member(value, "nullable", pointer);
    const auto* owners_value = decoder.member(value, "ownerKinds", pointer);
    const auto* persistence_value = decoder.member(value, "persistence", pointer);
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
    auto owners = owners_value
                      ? decoder.array<PropertyOwnerKind>(
                            *owners_value, pointer_child(pointer, "ownerKinds"),
                            [&](const nlohmann::json& owner, const std::string& owner_pointer) {
                                return decoder.enumeration<PropertyOwnerKind>(
                                    owner, owner_pointer,
                                    {{"room", PropertyOwnerKind::Room},
                                     {"scene", PropertyOwnerKind::Scene},
                                     {"dialogue", PropertyOwnerKind::Dialogue},
                                     {"character", PropertyOwnerKind::Character},
                                     {"interactable", PropertyOwnerKind::Interactable},
                                     {"verb", PropertyOwnerKind::Verb},
                                     {"interaction", PropertyOwnerKind::Interaction},
                                     {"map", PropertyOwnerKind::Map}});
                            })
                      : std::nullopt;
    auto persistence =
        persistence_value
            ? decoder.enumeration<PropertyPersistence>(
                  *persistence_value, pointer_child(pointer, "persistence"),
                  {{"Session", PropertyPersistence::Session}, {"Save", PropertyPersistence::Save}})
            : std::nullopt;
    std::optional<RuntimeValue> default_runtime;
    bool default_ok = true;
    if (const auto* default_value = json_access::member(value, "defaultValue")) {
        default_runtime =
            decode_runtime_value(decoder, *default_value, pointer_child(pointer, "defaultValue"));
        default_ok = default_runtime.has_value();
    }
    if (!id || !type || !description || !label || !nullable || !owners || !persistence ||
        !default_ok)
        return std::nullopt;
    return PropertyDeclaration{
        std::move(*id),         std::move(*type),   *nullable,    std::move(default_runtime),
        std::move(enum_values), std::move(*owners), *persistence, std::move(*label),
        std::move(*description)};
}

std::optional<AssetResource> decode_asset(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"aliases", "id", "kind", "path"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* path_value = decoder.member(value, "path", pointer);
    const auto* aliases_value = decoder.member(value, "aliases", pointer);
    auto id =
        id_value ? decoder.id<AssetId>(*id_value, pointer_child(pointer, "id")) : std::nullopt;
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
    auto path = path_value ? decoder.string(*path_value, pointer_child(pointer, "path"), true)
                           : std::nullopt;
    auto aliases = aliases_value
                       ? decoder.array<std::string>(
                             *aliases_value, pointer_child(pointer, "aliases"),
                             [&](const nlohmann::json& alias, const std::string& alias_pointer) {
                                 return decoder.string(alias, alias_pointer, true);
                             })
                       : std::nullopt;
    if (!id || !kind || !path || !aliases)
        return std::nullopt;
    return AssetResource{std::move(*id), *kind, std::move(*path), std::move(*aliases)};
}

std::optional<LayoutResource> decode_layout(Decoder& decoder, const nlohmann::json& value,
                                            std::string_view pointer)
{
    if (!decoder.object(
            value, pointer,
            {"dependencies", "id", "kind", "lua", "mount", "rcss", "rml", "script", "target"}))
        return std::nullopt;
    const auto* id_value = decoder.member(value, "id", pointer);
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* target_value = decoder.member(value, "target", pointer);
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
    if (!id || !kind || !target || !rml || !rcss || !lua || !dependencies || !mount_ok ||
        !script_ok)
        return std::nullopt;
    return LayoutResource{std::move(*id),
                          *kind,
                          *target,
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
