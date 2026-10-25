#include "native_authoring_resources.hpp"
#include "native_authoring_messages.hpp"

#include <stdexcept>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& object(const Json& value, const char* key)
{
    static const Json empty = Json::object();
    return value.is_object() && value.contains(key) && value[key].is_object() ? value[key] : empty;
}

const Json& array(const Json& value, const char* key)
{
    static const Json empty = Json::array();
    return value.is_object() && value.contains(key) && value[key].is_array() ? value[key] : empty;
}

std::string str(const Json& value, const char* key)
{
    return value.is_object() && value.contains(key) && value[key].is_string()
               ? value[key].get<std::string>()
               : std::string{};
}

Json asset_ref(const Json& reference)
{
    if (reference.is_null())
        return nullptr;
    if (!reference.is_object() || !reference.contains("$ref") || !reference.at("$ref").is_object())
        throw std::runtime_error("Normalized Asset reference is invalid.");
    return {{"kind", "asset"}, {"id", reference.at("$ref").at("id")}};
}

Json assets(const Json& project)
{
    Json result = Json::array();
    for (const auto& [id, record] : object(project, "assets").items()) {
        const auto& data = object(record, "data");
        const auto kind = str(data, "kind");
        if (kind.empty())
            throw std::runtime_error("Native normalized Asset is missing its kind.");
        Json item{{"id", id},
                  {"kind", kind},
                  {"path", object(data, "source").at("path")},
                  {"aliases", array(data, "aliases")}};
        if (kind == "image") {
            const auto& metadata = object(data, "imageMetadata");
            if (metadata.empty())
                throw std::runtime_error("Native normalized Image is missing image metadata.");
            item["sampling"] = data.value("sampling", "linear");
            item["width"] = metadata.at("width");
            item["height"] = metadata.at("height");
        }
        Json localized = Json::array();
        const auto& locales = object(object(project, "localization"), "assets");
        for (const auto& [locale, targets] : locales.items()) {
            if (!targets.is_object() || !targets.contains(id))
                continue;
            const auto& target = targets.at(id);
            if (target.contains("useSource"))
                localized.push_back({{"locale", locale}, {"state", "source"}});
            else
                localized.push_back({{"locale", locale},
                                     {"state", "variant"},
                                     {"asset", asset_ref(target.at("asset"))}});
        }
        if (!localized.empty())
            item["localized"] = std::move(localized);
        result.push_back(std::move(item));
    }
    return result;
}

Json animations(const Json& project)
{
    Json result = Json::array();
    for (const auto& [id, record] : object(project, "animations").items()) {
        const auto& data = object(record, "data");
        const auto& original_motions = array(data, "motions");
        bool all_nonempty = true;
        for (const auto& motion : original_motions)
            all_nonempty &= str(motion, "kind") == "video" || !array(motion, "frames").empty();
        if (!all_nonempty)
            continue;
        Json motions = Json::array();
        for (const auto& motion : original_motions) {
            const auto kind = str(motion, "kind");
            Json value{
                {"id", motion.at("id")}, {"kind", kind}, {"markers", array(motion, "markers")}};
            if (kind == "sprite-sequence") {
                Json frames = Json::array();
                for (const auto& frame : array(motion, "frames"))
                    frames.push_back({{"image", asset_ref(frame.at("image"))},
                                      {"durationMs", frame.at("durationMs")}});
                value["frames"] = std::move(frames);
            } else if (kind == "video") {
                value["video"] = asset_ref(motion.at("video"));
                if (motion.contains("sourceRange") && !motion.at("sourceRange").is_null())
                    value["sourceRange"] = motion.at("sourceRange");
            } else {
                throw std::runtime_error("Normalized Animation kind cannot be lowered.");
            }
            motions.push_back(std::move(value));
        }
        result.push_back({{"id", id},
                          {"canvas", data.at("canvas")},
                          {"defaultMotionId", data.at("defaultMotionId")},
                          {"motions", std::move(motions)}});
    }
    return result;
}

Json scripts(const Json& project)
{
    Json result = Json::array();
    for (const auto& [id, record] : object(project, "scripts").items()) {
        const auto& source = object(object(record, "data"), "source");
        const auto kind = str(source, "kind");
        if (kind == "inline-lua")
            result.push_back(
                {{"id", id}, {"source", {{"kind", kind}, {"source", source.at("source")}}}});
        else if (kind == "project-file")
            result.push_back(
                {{"id", id},
                 {"source",
                  {{"kind", kind}, {"path", "project:/" + source.at("path").get<std::string>()}}}});
        else
            throw std::runtime_error("Normalized Script source cannot be lowered.");
    }
    return result;
}
} // namespace

Json lower_static_authoring_resources(const Json& admitted_project)
{
    return {{"assets", assets(admitted_project)},
            {"animations", animations(admitted_project)},
            {"scripts", scripts(admitted_project)}};
}

Json lower_static_authoring_identity(const Json& admitted_project)
{
    const auto& bootstrap = object(admitted_project, "bootstrapModule");
    const auto& entrance = object(admitted_project, "entrypoint");
    const auto kind = str(entrance, "kind");
    if (kind != "room" && kind != "scene" && kind != "dialogue")
        throw std::runtime_error("Native Project entrypoint kind is invalid.");
    Json global_properties = Json::array();
    Json pending_messages = Json::array();
    for (const auto& [id, record] : object(admitted_project, "variables").items()) {
        const auto& data = object(record, "data");
        if (str(data, "scope") != "global")
            throw std::runtime_error("Native Variable must have global scope.");
        if (str(data, "type") == "message") {
            // Message variables require the same package-wide stable ID
            // assignment as localized dialogue and structured text. Never
            // substitute an authored key for a compiled runtime message ref.
            pending_messages.push_back(id);
            continue;
        }
        Json item{{"id", id},
                  {"label", record.at("label")},
                  {"description", record.value("description", std::string{})},
                  {"type", data.at("type")},
                  {"nullable", data.at("nullable")},
                  {"defaultValue", data.at("value")},
                  {"enumValues", array(data, "enumValues")},
                  {"scope", "global"}};
        global_properties.push_back(std::move(item));
    }
    Json entrypoint{{"kind", kind}};
    entrypoint[kind] = {{"kind", kind}, {"id", entrance.at("id")}};
    return {{"project", admitted_project.at("project")},
            {"bootstrapModule", {{"kind", "script"}, {"id", object(bootstrap, "$ref").at("id")}}},
            {"entrypoint", std::move(entrypoint)},
            {"unresolvedMessageVariables", std::move(pending_messages)},
            {"globalProperties", std::move(global_properties)}};
}

Json lower_authoring_global_properties(const Json& admitted_project,
                                       const NativeMessageProjection& messages)
{
    Json globals = Json::array();
    for (const auto& [id, record] : object(admitted_project, "variables").items()) {
        const auto& data = object(record, "data");
        if (str(data, "scope") != "global")
            throw std::runtime_error("Native Variable must have global scope.");
        Json lowered_value;
        try {
            lowered_value =
                lower_authoring_message_value(admitted_project, messages, data.at("value"));
        } catch (const std::exception& error) {
            throw std::runtime_error("at /variables/" + id + "/data/value: " + error.what());
        }
        globals.push_back({{"id", id},
                           {"label", record.at("label")},
                           {"description", record.value("description", std::string{})},
                           {"type", data.at("type")},
                           {"nullable", data.at("nullable")},
                           {"defaultValue", std::move(lowered_value)},
                           {"enumValues", array(data, "enumValues")},
                           {"scope", "global"}});
    }
    return globals;
}

} // namespace noveltea::cli
