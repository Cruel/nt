#include "noveltea/core/runtime_user_settings_codec.hpp"

#include "noveltea/core/json_access.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <utility>

namespace noveltea::core {
namespace {

constexpr std::string_view schema_name = "noveltea.runtime.user-settings";
constexpr std::uint32_t schema_version = 2;

Diagnostic diagnostic(std::string code, std::string message, const std::string& source_path,
                      std::string json_pointer = {})
{
    return Diagnostic{.code = std::move(code),
                      .message = std::move(message),
                      .source_path = source_path,
                      .json_pointer = std::move(json_pointer)};
}

} // namespace

Result<nlohmann::json, Diagnostics>
encode_runtime_user_settings(const RuntimeUserSettings& settings)
{
    return Result<nlohmann::json, Diagnostics>::success(nlohmann::json::object({
        {"schema", schema_name},
        {"schemaVersion", schema_version},
        {"uiScale", settings.ui_scale()},
        {"textScale", settings.text_scale()},
    }));
}

Result<RuntimeUserSettings, Diagnostics>
decode_runtime_user_settings(const nlohmann::json& document,
                             const compiled::AccessibilitySettings& accessibility,
                             std::string source_path)
{
    Diagnostics diagnostics;
    if (!document.is_object()) {
        diagnostics.push_back(
            diagnostic("runtime_user_settings.type", "Expected an object.", source_path));
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(diagnostics));
    }

    constexpr std::array<std::string_view, 4> fields = {"schema", "schemaVersion", "uiScale",
                                                        "textScale"};
    for (auto item = document.cbegin(); item != document.cend(); ++item) {
        bool known = false;
        for (const auto field : fields) {
            if (item.key() == field) {
                known = true;
                break;
            }
        }
        if (!known) {
            diagnostics.push_back(diagnostic("runtime_user_settings.unknown_field",
                                             "Unknown field '" + item.key() + "'.", source_path,
                                             "/" + item.key()));
        }
    }

    const auto* schema = json_access::member(document, "schema");
    const auto* version = json_access::member(document, "schemaVersion");
    const auto* ui_scale = json_access::member(document, "uiScale");
    const auto* text_scale = json_access::member(document, "textScale");
    if (schema == nullptr)
        diagnostics.push_back(diagnostic("runtime_user_settings.missing_field",
                                         "Missing required field 'schema'.", source_path,
                                         "/schema"));
    if (version == nullptr)
        diagnostics.push_back(diagnostic("runtime_user_settings.missing_field",
                                         "Missing required field 'schemaVersion'.", source_path,
                                         "/schemaVersion"));
    if (ui_scale == nullptr)
        diagnostics.push_back(diagnostic("runtime_user_settings.missing_field",
                                         "Missing required field 'uiScale'.", source_path,
                                         "/uiScale"));
    if (text_scale == nullptr)
        diagnostics.push_back(diagnostic("runtime_user_settings.missing_field",
                                         "Missing required field 'textScale'.", source_path,
                                         "/textScale"));

    if (schema != nullptr) {
        const auto value = json_access::get<std::string_view>(*schema);
        if (!value) {
            diagnostics.push_back(diagnostic("runtime_user_settings.type", "Expected a string.",
                                             source_path, "/schema"));
        } else if (*value != schema_name) {
            diagnostics.push_back(diagnostic("runtime_user_settings.unsupported_schema",
                                             "Expected schema 'noveltea.runtime.user-settings'.",
                                             source_path, "/schema"));
        }
    }

    if (version != nullptr) {
        const auto value = json_access::get<std::uint32_t>(*version);
        if (!value) {
            diagnostics.push_back(diagnostic("runtime_user_settings.type",
                                             "Expected a nonnegative integer in range.",
                                             source_path, "/schemaVersion"));
        } else if (*value != schema_version) {
            diagnostics.push_back(diagnostic("runtime_user_settings.unsupported_version",
                                             "Only schema version 2 is supported.", source_path,
                                             "/schemaVersion"));
        }
    }

    std::optional<double> decoded_ui_scale;
    if (ui_scale != nullptr) {
        decoded_ui_scale = json_access::get<double>(*ui_scale);
        if (!decoded_ui_scale) {
            diagnostics.push_back(diagnostic("runtime_user_settings.type", "Expected a number.",
                                             source_path, "/uiScale"));
        }
    }

    std::optional<double> decoded_text_scale;
    if (text_scale != nullptr) {
        decoded_text_scale = json_access::get<double>(*text_scale);
        if (!decoded_text_scale) {
            diagnostics.push_back(diagnostic("runtime_user_settings.type", "Expected a number.",
                                             source_path, "/textScale"));
        }
    }

    if (!diagnostics.empty())
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(diagnostics));
    auto loaded = RuntimeUserSettings::load(*decoded_ui_scale, *decoded_text_scale, accessibility);
    if (!loaded) {
        for (auto& error : loaded.error()) {
            error.source_path = source_path;
            if (error.code.find("ui_scale") != std::string::npos)
                error.json_pointer = "/uiScale";
            else if (error.code.find("text_scale") != std::string::npos)
                error.json_pointer = "/textScale";
            diagnostics.push_back(std::move(error));
        }
        return Result<RuntimeUserSettings, Diagnostics>::failure(std::move(diagnostics));
    }
    return loaded;
}

Result<std::string, Diagnostics>
encode_runtime_user_settings_text(const RuntimeUserSettings& settings)
{
    auto encoded = encode_runtime_user_settings(settings);
    const auto* document = encoded.value_if();
    if (document == nullptr)
        return Result<std::string, Diagnostics>::failure(encoded.error());
    return Result<std::string, Diagnostics>::success(document->dump());
}

Result<RuntimeUserSettings, Diagnostics>
decode_runtime_user_settings_text(std::string_view text,
                                  const compiled::AccessibilitySettings& accessibility,
                                  std::string source_path)
{
    auto document = nlohmann::json::parse(text.begin(), text.end(), nullptr, false);
    if (document.is_discarded()) {
        return Result<RuntimeUserSettings, Diagnostics>::failure(Diagnostics{
            diagnostic("runtime_user_settings.malformed_json",
                       "Runtime user settings do not contain valid JSON.", source_path)});
    }
    return decode_runtime_user_settings(document, accessibility, std::move(source_path));
}

} // namespace noveltea::core
