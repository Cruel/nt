#include "native_runtime_materials.hpp"

#include "embedded_material_registry.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <span>
#include <stdexcept>
#include <string>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& find_registry_record(const Json& records, std::string_view id)
{
    for (const auto& record : records)
        if (record.at("id") == id)
            return record;
    throw std::runtime_error("Native runtime Material references unknown contract '" +
                             std::string(id) + "'.");
}

Json ordered_request(const Json& effective)
{
    const auto& source = effective.at("shader");
    nlohmann::ordered_json request;
    for (const auto* field : {"vertexSource", "fragmentSource", "varyingDefinition"})
        request[field] = source.at(field);
    request["interfaceContract"] = effective.at("interfaceContract");
    request["interfaceFingerprint"] = effective.at("interfaceFingerprint");
    const auto bytes = request.dump();
    const auto digest =
        noveltea::core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size())));
    return "program-" + digest.substr(0, 24);
}

Json runtime_shader(const Json& effective, const Json& preset, const Json& role,
                    const std::string& key)
{
    const bool custom = effective.at("custom").get<bool>();
    Json stages;
    if (custom) {
        stages = {
            {"vertex",
             {{"source", effective.at("shader").at("vertexSource")}, {"compiled", Json::object()}}},
            {"fragment",
             {{"source", effective.at("shader").at("fragmentSource")},
              {"compiled", Json::object()}}}};
    } else {
        const auto program = preset.at("shader").at("programName").get<std::string>();
        const auto compiled = [&](std::string_view suffix) {
            Json result = Json::object();
            for (const auto* variant : {"glsl-330", "essl-300", "metal"})
                result[variant] = {{"runtimePath", "system:/shaders/bgfx/" + std::string(variant) +
                                                       "/" + program + "." + std::string(suffix) +
                                                       ".bin"}};
            return result;
        };
        stages = {{"vertex", {{"compiled", compiled("vs")}}},
                  {"fragment", {{"compiled", compiled("fs")}}}};
    }

    Json uniforms = Json::object();
    Json samplers = Json::object();
    if (!custom) {
        for (const auto& [name, value] : preset.at("defaultParameters").items()) {
            Json declaration{{"type", value.at("type")}};
            if (value.contains("default"))
                declaration["default"] = value.at("default");
            if (value.contains("range"))
                declaration["range"] = value.at("range");
            if (value.contains("binding"))
                declaration["binding"] = value.at("binding");
            if (value.contains("label") && value.at("label").is_string() &&
                !value.at("label").get<std::string>().empty())
                declaration["editor"] = {{"label", value.at("label")}};
            uniforms[name] = std::move(declaration);
        }
        for (const auto& [name, semantic] : preset.at("shader").at("standardUniforms").items()) {
            for (const auto& available : role.at("standardSemanticAvailability"))
                if (available.at("semantic") == semantic) {
                    uniforms[name] = {{"type", available.at("logicalType")}, {"binding", semantic}};
                    break;
                }
        }
        for (const auto& [name, state] : preset.at("capabilities").at("samplers").items()) {
            if (state == "disabled")
                continue;
            for (const auto& sampler : role.at("reservedInterface").at("samplers")) {
                if (sampler.at("name") != name)
                    continue;
                Json binding = nullptr;
                if (sampler.contains("semantic") && sampler.at("semantic").is_string()) {
                    const auto semantic = sampler.at("semantic").get<std::string>();
                    if (semantic == "engine.hotspot_image" || semantic == "engine.hotspot_mask")
                        binding = semantic;
                }
                samplers[name] = {
                    {"type", "texture2d"}, {"stage", sampler.at("stage")}, {"binding", binding}};
                break;
            }
        }
    }
    const auto role_id = effective.at("role").get<std::string>();
    return {{"display_name", custom ? "Derived " + preset.at("label").get<std::string>()
                                    : preset.at("label").get<std::string>()},
            {"interface_contract", effective.at("interfaceContract")},
            {"interface_fingerprint", effective.at("interfaceFingerprint")},
            {"stages", std::move(stages)},
            {"uniforms", std::move(uniforms)},
            {"samplers", std::move(samplers)},
            {"roles", Json::array({role_id})},
            {"role_bindings", {{role_id, {{"vertex", key}, {"fragment", key}}}}}};
}

Json source(const Json& project, const Json& value)
{
    if (value.contains("$ref")) {
        const auto& id = value.at("$ref").at("id").get<std::string>();
        const auto& asset = project.at("assets").at(id).at("data");
        return "project:/" + asset.at("source").at("path").get<std::string>();
    }
    if (value.contains("alias"))
        return "alias:" + value.at("alias").get<std::string>();
    return value.at("uri");
}

Json runtime_material(const Json& project, const Json& effective, const Json& shader,
                      const std::string& shader_id, const Json& role)
{
    const bool custom = effective.at("custom").get<bool>();
    Json uniforms = Json::object(), textures = Json::object();
    const auto& parameter_values =
        custom ? effective.at("authoredParameters") : effective.at("parameters");
    for (const auto& [name, parameter] : parameter_values.items()) {
        if (!shader.at("uniforms").contains(name))
            continue;
        const auto& declaration = shader.at("uniforms").at(name);
        if (declaration.contains("binding") || !parameter.contains("value") ||
            parameter.at("value").is_null())
            continue;
        uniforms[name] = parameter.at("value");
    }
    for (const auto& [name, texture] : effective.at("textures").items()) {
        if (!shader.at("samplers").contains(name))
            continue;
        bool renderer_owned = false;
        for (const auto& sampler : role.at("reservedInterface").at("samplers"))
            if (sampler.at("name") == name && sampler.at("sourceOwnership") == "renderer")
                renderer_owned = true;
        if (!texture.contains("source") && !renderer_owned)
            continue;
        Json entry{{"address", texture.at("address")}, {"filter", texture.at("filter")}};
        if (texture.contains("source")) {
            entry["source"] = source(project, texture.at("source"));
            if (entry.at("filter") == "inherit") {
                for (const auto& [id, asset] : project.at("assets").items()) {
                    const auto& data = asset.at("data");
                    if (entry.at("source") ==
                            "project:/" + data.at("source").at("path").get<std::string>() &&
                        data.value("kind", "") == "image") {
                        entry["filter"] =
                            data.value("sampling", "linear") == "nearest" ? "nearest" : "linear";
                        break;
                    }
                }
            }
        }
        textures[name] = std::move(entry);
    }
    return {{"role", effective.at("role")},
            {"shader", shader_id},
            {"uniforms", uniforms},
            {"textures", textures}};
}
} // namespace

Json native_runtime_material_metadata(const Json& project, const Json& effective_materials)
{
    if (!effective_materials.is_object())
        throw std::runtime_error("Native Material authority is missing from artifact preparation.");
    const auto registry = Json::parse(noveltea::authoring::material_registry_json);
    Json shaders = Json::object(), materials = Json::object();
    for (const auto& [id, record] : project.at("materials").items()) {
        if (!effective_materials.contains(id))
            throw std::runtime_error("Missing native resolved Material '" + id + "'.");
        const auto& effective = effective_materials.at(id);
        const auto& preset =
            find_registry_record(registry.at("presets"), effective.at("preset").get<std::string>());
        const auto& role =
            find_registry_record(registry.at("roles"), effective.at("role").get<std::string>());
        const bool custom = effective.at("custom").get<bool>();
        const auto program = custom ? ordered_request(effective).get<std::string>()
                                    : "preset-" + preset.at("id").get<std::string>();
        const auto shader_id = custom ? program + "-material-" + id : program;
        if (!shaders.contains(shader_id))
            shaders[shader_id] = runtime_shader(effective, preset, role, shader_id);
        auto material =
            runtime_material(project, effective, shaders.at(shader_id), shader_id, role);
        material["display_name"] = record.at("label");
        materials[id] = std::move(material);
    }
    return {
        {"schema", "noveltea.shader-materials"}, {"shaders", shaders}, {"materials", materials}};
}
} // namespace noveltea::cli
