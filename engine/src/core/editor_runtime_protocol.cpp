#include "noveltea/core/editor_runtime_protocol.hpp"

#include "noveltea/core/json_access.hpp"
#include "noveltea/render/material_codec.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::core::editor {
namespace {

template<typename> inline constexpr bool always_false = false;

Diagnostic error(std::string code, std::string message, std::string path = {})
{
    return Diagnostic{
        .code = std::move(code), .message = std::move(message), .source_path = std::move(path)};
}

std::optional<std::uint64_t> nonnegative_integer(const nlohmann::json& value) noexcept
{
    return json_access::get<std::uint64_t>(value);
}

bool valid_utf8(std::string_view text) noexcept
{
    const auto* bytes = reinterpret_cast<const unsigned char*>(text.data());
    std::size_t index = 0;
    while (index < text.size()) {
        const unsigned char lead = bytes[index++];
        if (lead <= 0x7f)
            continue;
        std::size_t continuation = 0;
        std::uint32_t value = 0;
        if ((lead & 0xe0) == 0xc0) {
            continuation = 1;
            value = lead & 0x1f;
        } else if ((lead & 0xf0) == 0xe0) {
            continuation = 2;
            value = lead & 0x0f;
        } else if ((lead & 0xf8) == 0xf0) {
            continuation = 3;
            value = lead & 0x07;
        } else {
            return false;
        }
        if (index + continuation > text.size())
            return false;
        for (std::size_t offset = 0; offset < continuation; ++offset) {
            const unsigned char byte = bytes[index++];
            if ((byte & 0xc0) != 0x80)
                return false;
            value = (value << 6) | (byte & 0x3f);
        }
        if ((continuation == 1 && value < 0x80) || (continuation == 2 && value < 0x800) ||
            (continuation == 3 && value < 0x10000) || value > 0x10ffff ||
            (value >= 0xd800 && value <= 0xdfff))
            return false;
    }
    return true;
}

bool exact_fields(const nlohmann::json& value, std::initializer_list<std::string_view> allowed,
                  Diagnostics& diagnostics, std::string_view path)
{
    if (!value.is_object()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an object.", std::string(path)));
        return false;
    }
    for (const auto& [key, unused] : value.items()) {
        (void)unused;
        if (std::none_of(allowed.begin(), allowed.end(),
                         [&](std::string_view item) { return item == key; })) {
            diagnostics.push_back(error("editor_protocol.unknown_field",
                                        "Unknown field '" + key + "'.",
                                        std::string(path) + "/" + key));
        }
    }
    return diagnostics.empty();
}

std::optional<std::string> string_field(const nlohmann::json& object, std::string_view key,
                                        Diagnostics& diagnostics, std::string_view path,
                                        const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_string()) {
        diagnostics.push_back(error("editor_protocol.wrong_type", "Expected a string.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    const auto value = *json_access::get<std::string>(*found);
    if (value.size() > limits.max_string_bytes) {
        diagnostics.push_back(error("editor_protocol.size_limit", "String exceeds size limit.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    if (!valid_utf8(value)) {
        diagnostics.push_back(error("editor_protocol.invalid_utf8", "String is not valid UTF-8.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    return value;
}

template<class Id>
std::optional<Id> id_field(const nlohmann::json& object, std::string_view key,
                           Diagnostics& diagnostics, std::string_view path,
                           const EditorRuntimeProtocolLimits& limits)
{
    auto value = string_field(object, key, diagnostics, path, limits);
    if (!value)
        return std::nullopt;
    auto id = Id::create(std::move(*value));
    if (!id) {
        diagnostics.push_back(error("editor_protocol.invalid_id", "Invalid stable ID.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    return std::move(*id.value_if());
}

std::optional<PropertyOwnerRef> property_owner_field(const nlohmann::json& object,
                                                     std::string_view key, Diagnostics& diagnostics,
                                                     std::string_view path,
                                                     const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    const auto owner_path = std::string(path) + "/" + std::string(key);
    if (found == object.end() || !found->is_object()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an owner object.", owner_path));
        return std::nullopt;
    }
    exact_fields(*found, {"kind", "id"}, diagnostics, owner_path);
    auto kind = string_field(*found, "kind", diagnostics, owner_path, limits);
    if (!kind)
        return std::nullopt;

#define DECODE_OWNER(kind_text, id_type)                                                           \
    if (*kind == kind_text) {                                                                      \
        auto id = id_field<id_type>(*found, "id", diagnostics, owner_path, limits);                \
        return id ? std::optional<PropertyOwnerRef>{PropertyOwnerRef{std::move(*id)}}              \
                  : std::nullopt;                                                                  \
    }
    DECODE_OWNER("room", RoomId)
    DECODE_OWNER("scene", SceneId)
    DECODE_OWNER("dialogue", DialogueId)
    DECODE_OWNER("character", CharacterId)
    DECODE_OWNER("interactable", InteractableId)
    DECODE_OWNER("verb", VerbId)
    DECODE_OWNER("interaction", InteractionId)
    DECODE_OWNER("map", MapId)
#undef DECODE_OWNER

    diagnostics.push_back(error("editor_protocol.invalid_owner_kind",
                                "Unknown property owner kind.", owner_path + "/kind"));
    return std::nullopt;
}

std::optional<TypedSaveSlotId> save_slot_field(const nlohmann::json& object, std::string_view key,
                                               Diagnostics& diagnostics, std::string_view path,
                                               const EditorRuntimeProtocolLimits& limits)
{
    auto value = string_field(object, key, diagnostics, path, limits);
    if (!value)
        return std::nullopt;
    if (*value == "autosave")
        return TypedSaveSlotId::autosave();
    constexpr std::string_view prefix = "manual-";
    if (!value->starts_with(prefix) || value->size() == prefix.size()) {
        diagnostics.push_back(error("editor_protocol.invalid_save_slot",
                                    "Save slot must be 'autosave' or 'manual-N'.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::uint64_t number = 0;
    for (const char character : std::string_view(*value).substr(prefix.size())) {
        if (character < '0' || character > '9' ||
            number > (std::numeric_limits<std::uint32_t>::max() -
                      static_cast<std::uint64_t>(character - '0')) /
                         10) {
            diagnostics.push_back(error("editor_protocol.invalid_save_slot",
                                        "Manual save slot number is invalid.",
                                        std::string(path) + "/" + std::string(key)));
            return std::nullopt;
        }
        number = number * 10 + static_cast<std::uint64_t>(character - '0');
    }
    return TypedSaveSlotId::manual(static_cast<std::uint32_t>(number));
}

std::optional<RuntimeValue> runtime_value(const nlohmann::json& value, Diagnostics& diagnostics,
                                          std::string_view path,
                                          const EditorRuntimeProtocolLimits& limits)
{
    if (value.is_null())
        return RuntimeValue{std::monostate{}};
    if (value.is_boolean())
        return RuntimeValue{*json_access::get<bool>(value)};
    if (value.is_number_integer())
        return RuntimeValue{*json_access::get<std::int64_t>(value)};
    if (value.is_number_float()) {
        const auto number = *json_access::get<double>(value);
        if (!std::isfinite(number)) {
            diagnostics.push_back(
                error("editor_protocol.non_finite", "Number must be finite.", std::string(path)));
            return std::nullopt;
        }
        return RuntimeValue{number};
    }
    if (value.is_string()) {
        const auto text = *json_access::get<std::string>(value);
        if (text.size() > limits.max_string_bytes || !valid_utf8(text)) {
            diagnostics.push_back(error("editor_protocol.invalid_string",
                                        "String is invalid or exceeds the size limit.",
                                        std::string(path)));
            return std::nullopt;
        }
        return RuntimeValue{text};
    }
    diagnostics.push_back(
        error("editor_protocol.unsupported_value",
              "Runtime values must be null, boolean, integer, finite number, or string.",
              std::string(path)));
    return std::nullopt;
}

std::optional<std::string> preview_inline_source(const nlohmann::json& data, std::string_view key,
                                                 Diagnostics& diagnostics,
                                                 const EditorRuntimeProtocolLimits& limits)
{
    const auto path = "/" + std::string(key);
    const auto found = data.find(std::string(key));
    if (found == data.end())
        return std::string{};
    if (!found->is_object()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "Preview source must be an object.", path));
        return std::nullopt;
    }
    const auto mode = found->find("sourceMode");
    if (mode != found->end() && (!mode->is_string() || mode->get<std::string>() != "inline")) {
        diagnostics.push_back(error("editor_preview.unsupported_source_mode",
                                    "Only resolved inline preview sources are admitted.",
                                    path + "/sourceMode"));
        return std::nullopt;
    }
    const auto text = found->find("sourceText");
    if (text == found->end())
        return std::string{};
    if (!text->is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Preview sourceText must be a string.", path + "/sourceText"));
        return std::nullopt;
    }
    const auto value = text->get<std::string>();
    if (value.size() > limits.max_document_bytes || !valid_utf8(value)) {
        diagnostics.push_back(error("editor_preview.invalid_source",
                                    "Preview source is invalid or exceeds the size limit.",
                                    path + "/sourceText"));
        return std::nullopt;
    }
    return value;
}

std::optional<std::string> optional_preview_string(const nlohmann::json& object,
                                                   std::string_view key, Diagnostics& diagnostics,
                                                   std::string_view path,
                                                   const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end())
        return std::nullopt;
    if (!found->is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type", "Expected a string.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    const auto value = found->get<std::string>();
    if (value.size() > limits.max_document_bytes || !valid_utf8(value)) {
        diagnostics.push_back(error("editor_preview.invalid_string",
                                    "Preview string is invalid or exceeds the size limit.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    return value;
}

std::optional<compiled::ReferenceResolution> preview_resolution(const nlohmann::json& object,
                                                                std::string_view key,
                                                                Diagnostics& diagnostics,
                                                                std::string_view path)
{
    const auto field_path = std::string(path) + "/" + std::string(key);
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_object()) {
        diagnostics.push_back(
            error("editor_preview.wrong_type", "Resolution must be an object.", field_path));
        return std::nullopt;
    }
    exact_fields(*found, {"width", "height"}, diagnostics, field_path);
    const auto width_it = found->find("width");
    const auto height_it = found->find("height");
    const auto width =
        width_it == found->end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*width_it);
    const auto height = height_it == found->end() ? std::optional<std::uint64_t>{}
                                                  : nonnegative_integer(*height_it);
    const auto valid_dimension = [](const auto value) {
        return value && *value > 0 && *value <= compiled::max_reference_resolution_dimension;
    };
    if (!valid_dimension(width))
        diagnostics.push_back(error("editor_preview.invalid_resolution",
                                    "Resolution width must be a positive supported integer.",
                                    field_path + "/width"));
    if (!valid_dimension(height))
        diagnostics.push_back(error("editor_preview.invalid_resolution",
                                    "Resolution height must be a positive supported integer.",
                                    field_path + "/height"));
    if (!valid_dimension(width) || !valid_dimension(height))
        return std::nullopt;
    return compiled::ReferenceResolution{static_cast<std::uint32_t>(*width),
                                         static_cast<std::uint32_t>(*height)};
}

std::optional<LayoutScalePolicy>
preview_scale_policy(const nlohmann::json& object, Diagnostics& diagnostics, std::string_view path)
{
    if (!object.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type", "scalePolicy must be an object.",
                                    std::string(path)));
        return std::nullopt;
    }
    exact_fields(object, {"ui", "text"}, diagnostics, path);
    const auto decode = [&](std::string_view key) -> std::optional<LayoutScaleInheritance> {
        const auto found = object.find(std::string(key));
        const auto field_path = std::string(path) + "/" + std::string(key);
        if (found == object.end() || !found->is_string()) {
            diagnostics.push_back(error("editor_preview.wrong_type",
                                        "Scale inheritance must be a string.", field_path));
            return std::nullopt;
        }
        const auto value = found->get<std::string>();
        if (value == "inherit")
            return LayoutScaleInheritance::Inherit;
        if (value == "ignore")
            return LayoutScaleInheritance::Ignore;
        diagnostics.push_back(error("editor_preview.invalid_scale_policy",
                                    "Scale inheritance must be 'inherit' or 'ignore'.",
                                    field_path));
        return std::nullopt;
    };
    const auto ui = decode("ui");
    const auto text = decode("text");
    return ui && text ? std::optional{LayoutScalePolicy{*ui, *text}} : std::nullopt;
}

std::optional<compiled::AccessibilityScalePolicy>
preview_accessibility_scale_policy(const nlohmann::json& object, Diagnostics& diagnostics,
                                   std::string_view path)
{
    if (!object.is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "Accessibility scale policy must be an object.",
                                    std::string(path)));
        return std::nullopt;
    }
    exact_fields(object, {"enabled", "minimum", "maximum"}, diagnostics, path);
    const auto enabled = object.find("enabled");
    const auto minimum = object.find("minimum");
    const auto maximum = object.find("maximum");
    if (enabled == object.end() || !enabled->is_boolean())
        diagnostics.push_back(error("editor_preview.wrong_type", "enabled must be a boolean.",
                                    std::string(path) + "/enabled"));
    const auto minimum_value = minimum != object.end() && minimum->is_number()
                                   ? std::optional{minimum->get<double>()}
                                   : std::nullopt;
    const auto maximum_value = maximum != object.end() && maximum->is_number()
                                   ? std::optional{maximum->get<double>()}
                                   : std::nullopt;
    if (!minimum_value || !std::isfinite(*minimum_value) || *minimum_value <= 0.0)
        diagnostics.push_back(error("editor_preview.invalid_accessibility",
                                    "minimum must be a positive finite number.",
                                    std::string(path) + "/minimum"));
    if (!maximum_value || !minimum_value || !std::isfinite(*maximum_value) ||
        *maximum_value < *minimum_value)
        diagnostics.push_back(error("editor_preview.invalid_accessibility",
                                    "maximum must be finite and at least minimum.",
                                    std::string(path) + "/maximum"));
    if (enabled == object.end() || !enabled->is_boolean() || !minimum_value || !maximum_value ||
        !std::isfinite(*minimum_value) || !std::isfinite(*maximum_value) || *minimum_value <= 0.0 ||
        *maximum_value < *minimum_value)
        return std::nullopt;
    return compiled::AccessibilityScalePolicy{enabled->get<bool>(), *minimum_value, *maximum_value};
}

std::optional<TypedEditorAuthoredPreviewEnvironment>
preview_authored_environment(const nlohmann::json& document, Diagnostics& diagnostics,
                             const EditorRuntimeProtocolLimits& limits)
{
    const auto environment = document.find("environment");
    if (environment == document.end() || !environment->is_object()) {
        diagnostics.push_back(error("editor_preview.environment_required",
                                    "Authored Layout preview environment is required.",
                                    "/environment"));
        return std::nullopt;
    }
    exact_fields(*environment, {"profile", "project"}, diagnostics, "/environment");
    const auto profile = environment->find("profile");
    const auto project = environment->find("project");
    if (profile == environment->end() || !profile->is_object())
        diagnostics.push_back(error("editor_preview.wrong_type", "profile must be an object.",
                                    "/environment/profile"));
    if (project == environment->end() || !project->is_object())
        diagnostics.push_back(error("editor_preview.wrong_type", "project must be an object.",
                                    "/environment/project"));
    if (profile == environment->end() || !profile->is_object() || project == environment->end() ||
        !project->is_object())
        return std::nullopt;

    exact_fields(*profile, {"name", "nativeResolution", "scalePolicy"}, diagnostics,
                 "/environment/profile");
    exact_fields(*project,
                 {"referenceResolution", "worldRasterPolicy", "barColor", "accessibility"},
                 diagnostics, "/environment/project");
    auto name = string_field(*profile, "name", diagnostics, "/environment/profile", limits);
    auto native_resolution =
        preview_resolution(*profile, "nativeResolution", diagnostics, "/environment/profile");
    const auto scale_policy_it = profile->find("scalePolicy");
    if (scale_policy_it == profile->end()) {
        diagnostics.push_back(error("editor_preview.missing_field",
                                    "Missing authored Layout scalePolicy.",
                                    "/environment/profile/scalePolicy"));
    }
    auto scale_policy = scale_policy_it == profile->end()
                            ? std::optional<LayoutScalePolicy>{}
                            : preview_scale_policy(*scale_policy_it, diagnostics,
                                                   "/environment/profile/scalePolicy");
    auto reference_resolution =
        preview_resolution(*project, "referenceResolution", diagnostics, "/environment/project");

    compiled::WorldRasterPolicy world_raster_policy = compiled::WorldRasterPolicy::Capped;
    const auto world_raster = project->find("worldRasterPolicy");
    if (world_raster == project->end() || !world_raster->is_string()) {
        diagnostics.push_back(error("editor_preview.wrong_type",
                                    "worldRasterPolicy must be a string.",
                                    "/environment/project/worldRasterPolicy"));
    } else if (world_raster->get<std::string>() == "native") {
        world_raster_policy = compiled::WorldRasterPolicy::Native;
    } else if (world_raster->get<std::string>() != "capped") {
        diagnostics.push_back(error("editor_preview.invalid_world_raster_policy",
                                    "worldRasterPolicy must be 'capped' or 'native'.",
                                    "/environment/project/worldRasterPolicy"));
    }

    auto bar_color =
        string_field(*project, "barColor", diagnostics, "/environment/project", limits);
    if (bar_color) {
        unsigned rgb = 0;
        const auto parsed = bar_color->size() == 7 && bar_color->front() == '#'
                                ? std::from_chars(bar_color->data() + 1,
                                                  bar_color->data() + bar_color->size(), rgb, 16)
                                : std::from_chars(bar_color->data(), bar_color->data(), rgb, 16);
        if (bar_color->size() != 7 || bar_color->front() != '#' || parsed.ec != std::errc{} ||
            parsed.ptr != bar_color->data() + bar_color->size()) {
            diagnostics.push_back(error("editor_preview.invalid_bar_color",
                                        "barColor must be #RRGGBB.",
                                        "/environment/project/barColor"));
        }
    }

    const auto accessibility = project->find("accessibility");
    std::optional<compiled::AccessibilityScalePolicy> ui_scale;
    std::optional<compiled::AccessibilityScalePolicy> text_scale;
    if (accessibility == project->end() || !accessibility->is_object()) {
        diagnostics.push_back(error("editor_preview.wrong_type", "accessibility must be an object.",
                                    "/environment/project/accessibility"));
    } else {
        exact_fields(*accessibility, {"uiScale", "textScale"}, diagnostics,
                     "/environment/project/accessibility");
        const auto ui = accessibility->find("uiScale");
        const auto text = accessibility->find("textScale");
        if (ui == accessibility->end()) {
            diagnostics.push_back(error("editor_preview.missing_field",
                                        "Missing UI accessibility scale policy.",
                                        "/environment/project/accessibility/uiScale"));
        } else {
            ui_scale = preview_accessibility_scale_policy(
                *ui, diagnostics, "/environment/project/accessibility/uiScale");
        }
        if (text == accessibility->end()) {
            diagnostics.push_back(error("editor_preview.missing_field",
                                        "Missing text accessibility scale policy.",
                                        "/environment/project/accessibility/textScale"));
        } else {
            text_scale = preview_accessibility_scale_policy(
                *text, diagnostics, "/environment/project/accessibility/textScale");
        }
    }

    if (name && name->empty()) {
        diagnostics.push_back(error("editor_preview.invalid_profile_name",
                                    "Authored preview profile name must not be empty.",
                                    "/environment/profile/name"));
    }
    const bool complete = name && !name->empty() && native_resolution && scale_policy &&
                          reference_resolution && bar_color && ui_scale && text_scale;
    if (!complete && diagnostics.empty()) {
        diagnostics.push_back(error("editor_preview.environment_invalid",
                                    "Authored preview environment is incomplete.", "/environment"));
    }
    if (!complete || !diagnostics.empty())
        return std::nullopt;
    return TypedEditorAuthoredPreviewEnvironment{
        .profile_name = std::move(*name),
        .native_resolution = *native_resolution,
        .scale_policy = *scale_policy,
        .project_display = {.reference_resolution = *reference_resolution,
                            .bar_color = std::move(*bar_color),
                            .world_raster_policy = world_raster_policy},
        .accessibility = {.ui_scale = *ui_scale, .text_scale = *text_scale},
    };
}

void append_material_diagnostics(const std::vector<MaterialDiagnostic>& material_diagnostics,
                                 Diagnostics& diagnostics, std::string_view fallback_path)
{
    for (const auto& material : material_diagnostics) {
        if (material.severity != MaterialDiagnosticSeverity::Error)
            continue;
        diagnostics.push_back(error(
            "editor_preview.shader_material." + std::string(to_string(material.code)),
            material.message, material.path.empty() ? std::string(fallback_path) : material.path));
    }
}

template<class Id>
std::optional<std::vector<Id>> id_array(const nlohmann::json& object, std::string_view key,
                                        Diagnostics& diagnostics, std::string_view path,
                                        const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_array()) {
        diagnostics.push_back(error("editor_protocol.wrong_type", "Expected an array.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    if (found->size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.size_limit", "ID array exceeds size limit.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::vector<Id> result;
    result.reserve(found->size());
    for (std::size_t index = 0; index < found->size(); ++index) {
        const auto& item = (*found)[index];
        const auto item_path =
            std::string(path) + "/" + std::string(key) + "/" + std::to_string(index);
        if (!item.is_string()) {
            diagnostics.push_back(
                error("editor_protocol.wrong_type", "Expected a string ID.", item_path));
            continue;
        }
        const auto text = *json_access::get<std::string>(item);
        if (text.size() > limits.max_string_bytes) {
            diagnostics.push_back(
                error("editor_protocol.size_limit", "ID exceeds size limit.", item_path));
            continue;
        }
        if (!valid_utf8(text)) {
            diagnostics.push_back(
                error("editor_protocol.invalid_utf8", "ID is not valid UTF-8.", item_path));
            continue;
        }
        auto id = Id::create(text);
        if (!id) {
            diagnostics.push_back(
                error("editor_protocol.invalid_id", "Invalid stable ID.", item_path));
            continue;
        }
        result.push_back(std::move(*id.value_if()));
    }
    if (!diagnostics.empty())
        return std::nullopt;
    return result;
}

std::optional<std::vector<compiled::InteractionSubject>>
subject_array(const nlohmann::json& object, std::string_view key, Diagnostics& diagnostics,
              std::string_view path, const EditorRuntimeProtocolLimits& limits)
{
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_array() || found->size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.wrong_type",
                                    "Expected a bounded Interaction subject array.",
                                    std::string(path) + "/" + std::string(key)));
        return std::nullopt;
    }
    std::vector<compiled::InteractionSubject> result;
    for (std::size_t index = 0; index < found->size(); ++index) {
        const auto item_path =
            std::string(path) + "/" + std::string(key) + "/" + std::to_string(index);
        const auto& item = (*found)[index];
        if (!item.is_object()) {
            diagnostics.push_back(error("editor_protocol.wrong_type",
                                        "Expected an Interaction subject object.", item_path));
            continue;
        }
        exact_fields(item, {"kind", "id"}, diagnostics, item_path);
        const auto kind = string_field(item, "kind", diagnostics, item_path, limits);
        if (kind && *kind == "character") {
            auto id = id_field<CharacterId>(item, "id", diagnostics, item_path, limits);
            if (id)
                result.emplace_back(compiled::CharacterInteractionSubject{std::move(*id)});
        } else if (kind && *kind == "interactable") {
            auto id = id_field<InteractableId>(item, "id", diagnostics, item_path, limits);
            if (id)
                result.emplace_back(compiled::InteractableInteractionSubject{std::move(*id)});
        } else if (kind) {
            diagnostics.push_back(
                error("editor_protocol.invalid_subject_kind",
                      "Interaction subject kind must be character or interactable.",
                      item_path + "/kind"));
        }
    }
    return diagnostics.empty() ? std::optional{std::move(result)} : std::nullopt;
}

nlohmann::json encode_subject(const compiled::InteractionSubject& subject)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::CharacterInteractionSubject>)
                return nlohmann::json{{"kind", "character"}, {"id", value.character.text()}};
            else
                return nlohmann::json{{"kind", "interactable"}, {"id", value.interactable.text()}};
        },
        subject);
}

Result<RuntimeInputMessage, Diagnostics>
decode_input_object(const nlohmann::json& document, const EditorRuntimeProtocolLimits& limits,
                    std::string_view path, bool require_envelope)
{
    Diagnostics diagnostics;
    const nlohmann::json* input = &document;
    if (require_envelope) {
        exact_fields(document, {"schema", "version", "input"}, diagnostics, path);
        const auto schema = document.find("schema");
        const auto version = document.find("version");
        const auto input_value = document.find("input");
        if (schema == document.end() || !schema->is_string() ||
            schema->get<std::string>() != runtime_input_schema) {
            diagnostics.push_back(error("editor_protocol.unsupported_schema",
                                        "Unsupported runtime input schema.", "/schema"));
        }
        const auto decoded_version = version == document.end() ? std::optional<std::uint64_t>{}
                                                               : nonnegative_integer(*version);
        if (!decoded_version || *decoded_version != editor_runtime_protocol_version) {
            diagnostics.push_back(error("editor_protocol.unsupported_version",
                                        "Unsupported runtime input version.", "/version"));
        }
        if (input_value == document.end()) {
            diagnostics.push_back(
                error("editor_protocol.missing_field", "Missing input.", "/input"));
        } else {
            input = &*input_value;
        }
    }
    if (!diagnostics.empty())
        return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
    if (!input->is_object())
        return Result<RuntimeInputMessage, Diagnostics>::failure(Diagnostics{
            error("editor_protocol.wrong_type", "Input must be an object.", std::string(path))});
    auto type = string_field(*input, "type", diagnostics, path, limits);
    if (!type)
        return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));

    auto success = [](RuntimeInputMessage message) {
        return Result<RuntimeInputMessage, Diagnostics>::success(std::move(message));
    };
    if (*type == "start" || *type == "stop" || *type == "reset" || *type == "continue" ||
        *type == "clear-selection" || *type == "begin-playback" || *type == "end-playback" ||
        *type == "clear-playback" || *type == "undo-playback-step" || *type == "replay-playback") {
        exact_fields(*input, {"type"}, diagnostics, path);
        if (!diagnostics.empty())
            return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
        if (*type == "start")
            return success(StartRuntimeInput{});
        if (*type == "stop")
            return success(StopRuntimeInput{});
        if (*type == "reset")
            return success(ResetRuntimeInput{});
        if (*type == "continue")
            return success(ContinueInput{});
        if (*type == "clear-selection")
            return success(ClearInteractionSubjectSelectionInput{});
        if (*type == "begin-playback")
            return success(BeginPlaybackInput{});
        if (*type == "end-playback")
            return success(EndPlaybackInput{});
        if (*type == "clear-playback")
            return success(ClearPlaybackInput{});
        if (*type == "undo-playback-step")
            return success(UndoPlaybackStepInput{});
        return success(ReplayPlaybackInput{});
    }
    if (*type == "advance-time") {
        exact_fields(*input, {"type", "microseconds"}, diagnostics, path);
        const auto found = input->find("microseconds");
        const auto duration =
            found == input->end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*found);
        if (!duration ||
            *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            diagnostics.push_back(error("editor_protocol.invalid_duration",
                                        "microseconds must be a non-negative 64-bit integer.",
                                        std::string(path) + "/microseconds"));
        }
        if (!diagnostics.empty())
            return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
        return success(
            AdvanceTimeInput{std::chrono::microseconds(static_cast<std::int64_t>(*duration))});
    }
    if (*type == "dialogue-choice") {
        exact_fields(*input, {"type", "edge"}, diagnostics, path);
        auto id = id_field<DialogueEdgeId>(*input, "edge", diagnostics, path, limits);
        if (id)
            return success(SelectDialogueChoiceInput{std::move(*id)});
    } else if (*type == "scene-choice") {
        exact_fields(*input, {"type", "option"}, diagnostics, path);
        auto id = id_field<SceneChoiceOptionId>(*input, "option", diagnostics, path, limits);
        if (id)
            return success(SelectSceneChoiceInput{std::move(*id)});
    } else if (*type == "navigate") {
        exact_fields(*input, {"type", "exit"}, diagnostics, path);
        auto id = id_field<RoomExitId>(*input, "exit", diagnostics, path, limits);
        if (id)
            return success(NavigateRoomInput{std::move(*id)});
    } else if (*type == "select-subjects") {
        exact_fields(*input, {"type", "subjects"}, diagnostics, path);
        auto ids = subject_array(*input, "subjects", diagnostics, path, limits);
        if (ids)
            return success(SelectInteractionSubjectsInput{std::move(*ids)});
    } else if (*type == "invoke-interaction") {
        exact_fields(*input, {"type", "verb", "operands"}, diagnostics, path);
        auto verb = id_field<VerbId>(*input, "verb", diagnostics, path, limits);
        auto operands = subject_array(*input, "operands", diagnostics, path, limits);
        if (verb && operands)
            return success(InvokeInteractionInput{std::move(*verb), std::move(*operands)});
    } else if (*type == "set-variable") {
        exact_fields(*input, {"type", "variable", "value"}, diagnostics, path);
        auto variable = id_field<VariableId>(*input, "variable", diagnostics, path, limits);
        const auto found = input->find("value");
        if (found == input->end())
            diagnostics.push_back(error("editor_protocol.missing_field", "Missing value.",
                                        std::string(path) + "/value"));
        auto value = found == input->end()
                         ? std::optional<RuntimeValue>{}
                         : runtime_value(*found, diagnostics, std::string(path) + "/value", limits);
        if (variable && value)
            return success(SetVariableDebugInput{std::move(*variable), std::move(*value)});
    } else if (*type == "set-property") {
        exact_fields(*input, {"type", "owner", "property", "value"}, diagnostics, path);
        auto owner = property_owner_field(*input, "owner", diagnostics, path, limits);
        auto property = id_field<PropertyId>(*input, "property", diagnostics, path, limits);
        const auto found = input->find("value");
        if (found == input->end())
            diagnostics.push_back(error("editor_protocol.missing_field", "Missing value.",
                                        std::string(path) + "/value"));
        auto value = found == input->end()
                         ? std::optional<RuntimeValue>{}
                         : runtime_value(*found, diagnostics, std::string(path) + "/value", limits);
        if (owner && property && value)
            return success(
                SetPropertyDebugInput{std::move(*owner), std::move(*property), std::move(*value)});
    } else if (*type == "save" || *type == "load") {
        exact_fields(*input, {"type", "slot"}, diagnostics, path);
        auto slot = save_slot_field(*input, "slot", diagnostics, path, limits);
        if (slot) {
            if (*type == "save")
                return success(SaveRuntimeInput{std::move(*slot)});
            return success(LoadRuntimeInput{std::move(*slot)});
        }
    } else {
        diagnostics.push_back(error("editor_protocol.unknown_input", "Unknown runtime input type.",
                                    std::string(path) + "/type"));
    }
    return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(diagnostics));
}

nlohmann::json encode_view(const TypedRuntimeUIViewState& view)
{
    nlohmann::json out = {{"mode", view.mode},
                          {"gameplayPaused", view.gameplay_paused},
                          {"canContinue", view.can_continue},
                          {"selectedSubjects", nlohmann::json::array()},
                          {"inventory", nlohmann::json::array()},
                          {"textLog", nlohmann::json::array()}};
    for (const auto& id : view.selected_subjects)
        out["selectedSubjects"].push_back(encode_subject(id));
    for (const auto& item : view.inventory.items) {
        out["inventory"].push_back({{"id", item.interactable.text()},
                                    {"label", item.display_name},
                                    {"enabled", item.enabled},
                                    {"visible", item.visible}});
    }
    for (const auto& entry : view.text_log.entries)
        out["textLog"].push_back(entry.text);
    if (view.room) {
        out["room"] = {{"id", view.room->room.text()},
                       {"visits", view.room->visits},
                       {"description", view.room->description},
                       {"exits", nlohmann::json::array()},
                       {"placements", nlohmann::json::array()}};
        for (const auto& exit : view.room->exits)
            out["room"]["exits"].push_back({{"id", exit.exit.text()},
                                            {"target", exit.target.text()},
                                            {"label", exit.label},
                                            {"enabled", exit.enabled}});
        for (const auto& placement : view.room->placements) {
            nlohmann::json occupants = nlohmann::json::array();
            for (const auto& occupant : placement.occupants) {
                nlohmann::json encoded{{"enabled", occupant.enabled},
                                       {"visible", occupant.visible}};
                std::visit(
                    [&encoded](const auto& subject) {
                        using T = std::decay_t<decltype(subject)>;
                        if constexpr (std::is_same_v<T, compiled::CharacterInteractionSubject>) {
                            encoded["kind"] = "character";
                            encoded["character"] = subject.character.text();
                        } else {
                            encoded["kind"] = "interactable";
                            encoded["interactable"] = subject.interactable.text();
                        }
                    },
                    occupant.subject);
                occupants.push_back(std::move(encoded));
            }
            out["room"]["placements"].push_back(
                {{"id", placement.placement.text()}, {"occupants", std::move(occupants)}});
        }
    }
    if (view.dialogue)
        out["dialogue"] = {{"id", view.dialogue->dialogue.text()},
                           {"hasLine", view.dialogue->line.has_value()},
                           {"hasChoice", view.dialogue->choice.has_value()}};
    if (view.scene)
        out["scene"] = {{"id", view.scene->scene.text()},
                        {"hasText", view.scene->text.has_value()},
                        {"hasChoice", view.scene->choice.has_value()}};
    if (view.interaction)
        out["interaction"] = {{"verb", view.interaction->verb.text()},
                              {"operands", nlohmann::json::array()}};
    if (view.interaction)
        for (const auto& operand : view.interaction->operands)
            out["interaction"]["operands"].push_back(encode_subject(operand));
    return out;
}

std::string severity_name(ErrorSeverity severity)
{
    switch (severity) {
    case ErrorSeverity::Info:
        return "info";
    case ErrorSeverity::Warning:
        return "warning";
    case ErrorSeverity::Error:
        return "error";
    case ErrorSeverity::Fatal:
        return "fatal";
    }
    return "error";
}

nlohmann::json encode_diagnostic(const Diagnostic& diagnostic)
{
    return {{"severity", severity_name(diagnostic.severity)},
            {"code", diagnostic.code},
            {"message", diagnostic.message},
            {"sourcePath", diagnostic.source_path}};
}

nlohmann::json encode_save_outcome(const SaveOutcome& value)
{
    std::string status;
    switch (value.status) {
    case SaveOutcomeStatus::Saved:
        status = "saved";
        break;
    case SaveOutcomeStatus::Loaded:
        status = "loaded";
        break;
    case SaveOutcomeStatus::Deleted:
        status = "deleted";
        break;
    case SaveOutcomeStatus::Failed:
        status = "failed";
        break;
    }
    const std::string slot =
        value.slot.is_autosave() ? "autosave" : "manual-" + std::to_string(value.slot.number());
    return {{"type", "save-outcome"},
            {"slot", slot},
            {"status", std::move(status)},
            {"autosave", value.autosave}};
}

nlohmann::json encode_observation(const RuntimeObservation& value)
{
    return std::visit(
        [](const auto& observation) -> nlohmann::json {
            using O = std::decay_t<decltype(observation)>;
            if constexpr (std::is_same_v<O, PlaybackObservation>)
                return {{"type", "playback-observation"},
                        {"stepIndex", observation.step_index},
                        {"handled", observation.handled}};
            else if constexpr (std::is_same_v<O, DebuggerObservation>)
                return {{"type", "debugger-observation"},
                        {"hasActiveFrame", observation.active_frame.has_value()}};
            else if constexpr (std::is_same_v<O, RuntimeStateObservation>)
                return {{"type", "runtime-state-observation"},
                        {"hasActiveFrame", observation.active_frame.has_value()},
                        {"blocked", observation.blocker.has_value()}};
            else if constexpr (std::is_same_v<O, RoomPresentationDiagnosticObservation>) {
                nlohmann::json diagnostics = nlohmann::json::array();
                for (const auto& diagnostic : observation.diagnostics)
                    diagnostics.push_back(
                        {{"code", diagnostic.code},
                         {"message", diagnostic.message},
                         {"severity", static_cast<std::uint8_t>(diagnostic.severity)}});
                return {{"type", "room-presentation-diagnostic"},
                        {"room", observation.room.text()},
                        {"diagnostics", std::move(diagnostics)}};
            } else if constexpr (std::is_same_v<O, CheckpointRuntimeObservation>) {
                nlohmann::json issues = nlohmann::json::array();
                for (const auto& issue : observation.readiness.issues) {
                    issues.push_back({{"reason", static_cast<std::uint8_t>(issue.reason)},
                                      {"code", issue.diagnostic.code},
                                      {"message", issue.diagnostic.message},
                                      {"hasBarrier", issue.barrier.has_value()}});
                }
                nlohmann::json retained = nullptr;
                if (observation.retained_revision && observation.retained_metadata) {
                    retained = {
                        {"revision", observation.retained_revision->number()},
                        {"saveFormatVersion", observation.retained_metadata->save_format_version},
                        {"project", observation.retained_metadata->project.text()},
                        {"projectVersion", observation.retained_metadata->project_version},
                        {"playTimeMs", observation.retained_metadata->play_time.count()}};
                }
                nlohmann::json reconstructible = nullptr;
                if (observation.presentation.reconstructible_activity) {
                    const auto& activity = *observation.presentation.reconstructible_activity;
                    reconstructible = {
                        {"snapshotRevision", activity.snapshot.number()},
                        {"actorIdleCount", activity.actor_idles.size()},
                        {"environmentLoopCount", activity.environment_loops.size()},
                        {"desiredAudioCount", activity.desired_audio.size()},
                    };
                }
                return {
                    {"type", "checkpoint-observation"},
                    {"readinessRevision", observation.readiness.revision.number()},
                    {"canCapture", observation.readiness.can_capture()},
                    {"issues", std::move(issues)},
                    {"presentationStatusRevision", observation.presentation.revision.number()},
                    {"activeBarrierCount", observation.presentation.active_barriers.size()},
                    {"reconstructibleActivity", std::move(reconstructible)},
                    {"retained", std::move(retained)},
                    {"replayDistance",
                     {{"structuralGenerations", observation.replay_distance.structural_generations},
                      {"timeGenerations", observation.replay_distance.time_generations},
                      {"playTimeMs", observation.replay_distance.play_time.count()}}},
                    {"thumbnailAvailable", observation.thumbnail_available},
                    {"thumbnailCapturePending", observation.thumbnail_capture_pending},
                };
            } else
                static_assert(always_false<O>, "Unhandled RuntimeObservation alternative");
        },
        value);
}

nlohmann::json encode_event(const runtime::RuntimeEvent& event)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, runtime::NotificationEvent>)
                return {{"type", "notification"}, {"message", value.message}};
            else if constexpr (std::is_same_v<T, runtime::SaveOutcomeEvent>)
                return encode_save_outcome(value.outcome);
            else if constexpr (std::is_same_v<T, runtime::ObservationEvent>)
                return encode_observation(value.observation);
            else
                static_assert(always_false<T>, "Unhandled RuntimeEvent alternative");
        },
        event);
}

nlohmann::json encode_publication(const runtime::RuntimePublication& publication)
{
    const auto& presentation = publication.presentation;
    nlohmann::json observations = nlohmann::json::array();
    for (const auto& observation : publication.observations.values)
        observations.push_back(encode_observation(observation));
    return {
        {"revision", publication.revision.number()},
        {"gameplayUi", encode_view(publication.gameplay_ui)},
        {"presentation",
         {{"revision", presentation.revision.number()},
          {"actorCount", presentation.actors.size()},
          {"interactableCount", presentation.interactables.size()},
          {"propCount", presentation.props.size()},
          {"environmentCount", presentation.environments.size()},
          {"layoutCount", presentation.layouts.size()},
          {"desiredAudioCount", presentation.desired_audio.size()}}},
        {"observations", std::move(observations)},
    };
}

} // namespace

Result<RuntimeInputMessage, Diagnostics>
decode_editor_runtime_input(const nlohmann::json& document,
                            const EditorRuntimeProtocolLimits& limits)
{
    return decode_input_object(document, limits, "/input", true);
}

Result<RuntimeInputMessage, Diagnostics>
decode_editor_runtime_input_text(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    auto document = parse_editor_protocol_document(text, limits);
    if (!document)
        return Result<RuntimeInputMessage, Diagnostics>::failure(std::move(document).error());
    return decode_editor_runtime_input(*document.value_if(), limits);
}

Result<RuntimeValue, Diagnostics>
decode_editor_runtime_value_text(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    auto parsed = parse_editor_protocol_document(text, limits);
    if (!parsed)
        return Result<RuntimeValue, Diagnostics>::failure(std::move(parsed).error());
    auto& document = *parsed.value_if();
    Diagnostics diagnostics;
    auto value = runtime_value(document, diagnostics, "/value", limits);
    if (!value || !diagnostics.empty())
        return Result<RuntimeValue, Diagnostics>::failure(std::move(diagnostics));
    return Result<RuntimeValue, Diagnostics>::success(std::move(*value));
}

Result<std::vector<compiled::InteractionSubject>, Diagnostics>
decode_editor_interaction_subjects_text(std::string_view text,
                                        const EditorRuntimeProtocolLimits& limits)
{
    auto parsed = parse_editor_protocol_document(text, limits);
    if (!parsed)
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(parsed).error());
    auto& document = *parsed.value_if();

    Diagnostics diagnostics;
    if (!document.is_array()) {
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "Expected an array.", "/subjects"));
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(diagnostics));
    }
    if (document.size() > limits.max_ids_per_input) {
        diagnostics.push_back(error("editor_protocol.size_limit",
                                    "Interaction subject array exceeds size limit.", "/subjects"));
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(diagnostics));
    }

    std::vector<compiled::InteractionSubject> subjects;
    subjects.reserve(document.size());
    for (std::size_t index = 0; index < document.size(); ++index) {
        const auto path = "/subjects/" + std::to_string(index);
        const auto& item = document[index];
        exact_fields(item, {"kind", "id"}, diagnostics, path);
        auto kind = string_field(item, "kind", diagnostics, path, limits);
        if (!kind)
            continue;
        if (*kind == "character") {
            auto id = id_field<CharacterId>(item, "id", diagnostics, path, limits);
            if (id)
                subjects.emplace_back(compiled::CharacterInteractionSubject{std::move(*id)});
        } else if (*kind == "interactable") {
            auto id = id_field<InteractableId>(item, "id", diagnostics, path, limits);
            if (id)
                subjects.emplace_back(compiled::InteractableInteractionSubject{std::move(*id)});
        } else {
            diagnostics.push_back(error("editor_protocol.invalid_subject_kind",
                                        "Interaction subject kind is unsupported.",
                                        path + "/kind"));
        }
    }
    if (!diagnostics.empty())
        return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::failure(
            std::move(diagnostics));
    return Result<std::vector<compiled::InteractionSubject>, Diagnostics>::success(
        std::move(subjects));
}

Result<TypedEditorPreviewDocument, Diagnostics>
decode_editor_preview_document_text(std::string_view kind, std::string_view data_text,
                                    const EditorRuntimeProtocolLimits& limits)
{
    if (kind.size() > limits.max_string_bytes || data_text.size() > limits.max_document_bytes) {
        return Result<TypedEditorPreviewDocument, Diagnostics>::failure(
            Diagnostics{error("editor_preview.size_limit", "Preview request exceeds size limit.")});
    }
    auto document = nlohmann::json::parse(data_text.empty() ? "{}" : data_text, nullptr, false);
    if (document.is_discarded()) {
        return Result<TypedEditorPreviewDocument, Diagnostics>::failure(
            Diagnostics{error("editor_preview.malformed_json", "Malformed preview JSON.")});
    }
    if (!document.is_object()) {
        return Result<TypedEditorPreviewDocument, Diagnostics>::failure(Diagnostics{
            error("editor_preview.wrong_type", "Preview data must be an object.", "/")});
    }

    Diagnostics diagnostics;
    if (kind == "layout-preview") {
        TypedEditorLayoutPreviewDocument result;
        auto environment = preview_authored_environment(document, diagnostics, limits);
        if (environment)
            result.environment = std::move(*environment);
        auto rml = preview_inline_source(document, "rml", diagnostics, limits);
        auto rcss = preview_inline_source(document, "rcss", diagnostics, limits);
        auto lua = preview_inline_source(document, "lua", diagnostics, limits);
        if (rml)
            result.rml = std::move(*rml);
        if (rcss)
            result.rcss = std::move(*rcss);
        if (lua)
            result.lua = std::move(*lua);

        if (const auto layout_kind = document.find("layoutKind"); layout_kind != document.end()) {
            if (!layout_kind->is_string()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "layoutKind must be a string.", "/layoutKind"));
            } else if (const auto value = layout_kind->get<std::string>(); value == "document") {
                result.layout_kind = EditorPreviewLayoutKind::Document;
            } else if (value == "fragment") {
                result.layout_kind = EditorPreviewLayoutKind::Fragment;
            } else {
                diagnostics.push_back(error("editor_preview.invalid_layout_kind",
                                            "layoutKind must be 'document' or 'fragment'.",
                                            "/layoutKind"));
            }
        }

        if (const auto script = document.find("script"); script != document.end()) {
            if (!script->is_object()) {
                diagnostics.push_back(
                    error("editor_preview.wrong_type", "script must be an object.", "/script"));
            } else if (const auto enabled = script->find("enabled"); enabled != script->end()) {
                if (!enabled->is_boolean()) {
                    diagnostics.push_back(error("editor_preview.wrong_type",
                                                "script.enabled must be a boolean.",
                                                "/script/enabled"));
                } else {
                    result.script_enabled = enabled->get<bool>();
                }
            }
        }

        if (const auto templates = document.find("templateTexts"); templates != document.end()) {
            if (!templates->is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "templateTexts must be an object.", "/templateTexts"));
            } else {
                result.fragment_host_rml = optional_preview_string(
                    *templates, "layoutFragmentHostRml", diagnostics, "/templateTexts", limits);
                result.fragment_host_rcss = optional_preview_string(
                    *templates, "layoutFragmentHostRcss", diagnostics, "/templateTexts", limits);
            }
        }

        if (!diagnostics.empty())
            return Result<TypedEditorPreviewDocument, Diagnostics>::failure(std::move(diagnostics));
        return Result<TypedEditorPreviewDocument, Diagnostics>::success(
            TypedEditorPreviewDocument{std::move(result)});
    }

    if (kind == "shader-preview") {
        TypedEditorShaderPreviewDocument result;
        if (const auto materials = document.find("shaderMaterials"); materials != document.end()) {
            if (!materials->is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "shaderMaterials must be an object.",
                                            "/shaderMaterials"));
            } else {
                auto parsed = parse_shader_material_project_json_value(*materials);
                append_material_diagnostics(parsed.diagnostics, diagnostics, "/shaderMaterials");
                if (parsed.project && !parsed.has_errors())
                    result.shader_materials = std::move(*parsed.project);
            }
        }

        if (auto value =
                optional_preview_string(document, "previewMaterialId", diagnostics, "/", limits))
            result.preview_material_id = std::move(*value);
        if (auto value = optional_preview_string(document, "shaderId", diagnostics, "/", limits))
            result.shader_id = std::move(*value);

        if (auto parsed = parse_material_id(result.preview_material_id); !parsed.ok()) {
            append_material_diagnostics(parsed.diagnostics, diagnostics, "/previewMaterialId");
        }
        if (!result.shader_id.empty()) {
            if (auto parsed = parse_shader_id(result.shader_id); !parsed.ok())
                append_material_diagnostics(parsed.diagnostics, diagnostics, "/shaderId");
        } else if (result.shader_materials) {
            diagnostics.push_back(error("editor_preview.missing_shader_id",
                                        "shaderId is required with shaderMaterials.", "/shaderId"));
        }

        if (const auto templates = document.find("templateTexts"); templates != document.end()) {
            if (!templates->is_object()) {
                diagnostics.push_back(error("editor_preview.wrong_type",
                                            "templateTexts must be an object.", "/templateTexts"));
            } else {
                result.template_rml = optional_preview_string(
                    *templates, "shaderSquareRml", diagnostics, "/templateTexts", limits);
                result.template_rcss = optional_preview_string(
                    *templates, "shaderSquareRcss", diagnostics, "/templateTexts", limits);
            }
        }

        if (!diagnostics.empty())
            return Result<TypedEditorPreviewDocument, Diagnostics>::failure(std::move(diagnostics));
        return Result<TypedEditorPreviewDocument, Diagnostics>::success(
            TypedEditorPreviewDocument{std::move(result)});
    }

    return Result<TypedEditorPreviewDocument, Diagnostics>::failure(Diagnostics{error(
        "editor_preview.unsupported_kind", "Unsupported editor preview document kind.", "/kind")});
}

Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback(const nlohmann::json& document, const EditorRuntimeProtocolLimits& limits)
{
    Diagnostics diagnostics;
    exact_fields(document, {"schema", "version", "id", "steps"}, diagnostics, "/");
    const auto schema = document.find("schema");
    const auto version = document.find("version");
    if (schema == document.end() || !schema->is_string() ||
        schema->get<std::string>() != playback_schema)
        diagnostics.push_back(
            error("editor_protocol.unsupported_schema", "Unsupported playback schema.", "/schema"));
    const auto decoded_version =
        version == document.end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*version);
    if (!decoded_version || *decoded_version != editor_runtime_protocol_version)
        diagnostics.push_back(error("editor_protocol.unsupported_version",
                                    "Unsupported playback version.", "/version"));
    auto id = string_field(document, "id", diagnostics, "/", limits);
    const auto steps = document.find("steps");
    if (steps == document.end() || !steps->is_array())
        diagnostics.push_back(
            error("editor_protocol.wrong_type", "steps must be an array.", "/steps"));
    else if (steps->size() > limits.max_steps)
        diagnostics.push_back(
            error("editor_protocol.size_limit", "Too many playback steps.", "/steps"));
    TypedPlaybackSpec spec;
    if (id)
        spec.id = std::move(*id);
    if (steps != document.end() && steps->is_array() && steps->size() <= limits.max_steps) {
        std::set<std::uint64_t> indexes;
        for (std::size_t position = 0; position < steps->size(); ++position) {
            const auto path = "/steps/" + std::to_string(position);
            const auto& step = (*steps)[position];
            Diagnostics step_diagnostics;
            exact_fields(step, {"index", "input"}, step_diagnostics, path);
            const auto index = step.find("index");
            const auto decoded_index =
                index == step.end() ? std::optional<std::uint64_t>{} : nonnegative_integer(*index);
            if (!decoded_index || !indexes.insert(*decoded_index).second)
                step_diagnostics.push_back(error("editor_protocol.invalid_step_index",
                                                 "Step index must be a unique unsigned integer.",
                                                 path + "/index"));
            const auto input = step.find("input");
            if (input == step.end())
                step_diagnostics.push_back(
                    error("editor_protocol.missing_field", "Missing input.", path + "/input"));
            else {
                auto decoded = decode_input_object(*input, limits, path + "/input", false);
                if (decoded && decoded_index)
                    spec.steps.push_back({*decoded_index, std::move(*decoded.value_if())});
                else if (!decoded)
                    step_diagnostics.insert(step_diagnostics.end(), decoded.error().begin(),
                                            decoded.error().end());
            }
            diagnostics.insert(diagnostics.end(), step_diagnostics.begin(), step_diagnostics.end());
        }
    }
    if (!diagnostics.empty())
        return Result<TypedPlaybackSpec, Diagnostics>::failure(std::move(diagnostics));
    return Result<TypedPlaybackSpec, Diagnostics>::success(std::move(spec));
}

Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback_text(std::string_view text, const EditorRuntimeProtocolLimits& limits)
{
    auto document = parse_editor_protocol_document(text, limits);
    if (!document)
        return Result<TypedPlaybackSpec, Diagnostics>::failure(std::move(document).error());
    return decode_editor_playback(*document.value_if(), limits);
}

nlohmann::json encode_editor_playback_report(std::string_view id,
                                             const std::vector<TypedPlaybackStepReport>& steps,
                                             const runtime::RuntimePublication& final_publication,
                                             bool passed)
{
    nlohmann::json result = {{"schema", playback_report_schema},
                             {"version", editor_runtime_protocol_version},
                             {"id", id},
                             {"passed", passed},
                             {"steps", nlohmann::json::array()},
                             {"finalPublication", encode_publication(final_publication)}};
    for (const auto& step : steps) {
        nlohmann::json encoded = {{"index", step.index},
                                  {"handled", step.handled},
                                  {"events", nlohmann::json::array()},
                                  {"diagnostics", nlohmann::json::array()}};
        for (const auto& event : step.events)
            encoded["events"].push_back(encode_event(event));
        for (const auto& diagnostic : step.diagnostics)
            encoded["diagnostics"].push_back(encode_diagnostic(diagnostic));
        result["steps"].push_back(std::move(encoded));
    }
    return result;
}

std::string encode_editor_playback_report_text(std::string_view id,
                                               const std::vector<TypedPlaybackStepReport>& steps,
                                               const runtime::RuntimePublication& final_publication,
                                               bool passed)
{
    return encode_editor_playback_report(id, steps, final_publication, passed).dump();
}

nlohmann::json encode_editor_debug_snapshot(const runtime::RuntimePublication& publication,
                                            const std::vector<runtime::RuntimeEvent>& events,
                                            const Diagnostics& diagnostics, bool preview_running)
{
    nlohmann::json result = {
        {"schema", debug_snapshot_schema},   {"version", editor_runtime_protocol_version},
        {"previewRunning", preview_running}, {"publication", encode_publication(publication)},
        {"events", nlohmann::json::array()}, {"diagnostics", nlohmann::json::array()}};
    for (const auto& event : events)
        result["events"].push_back(encode_event(event));
    for (const auto& diagnostic : diagnostics)
        result["diagnostics"].push_back(encode_diagnostic(diagnostic));
    return result;
}

std::string encode_editor_debug_snapshot_text(const runtime::RuntimePublication& publication,
                                              const std::vector<runtime::RuntimeEvent>& events,
                                              const Diagnostics& diagnostics, bool preview_running)
{
    return encode_editor_debug_snapshot(publication, events, diagnostics, preview_running).dump();
}

} // namespace noveltea::core::editor
