#include "material_semantics.hpp"
#include "embedded_material_registry.hpp"
#include "../../engine/src/render/material_contract_registry.generated.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <cmath>
#include <set>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json& registry()
{
    static const auto value = Json::parse(material_registry_json);
    return value;
}

const Json* member(const Json* object, std::string_view key)
{
    return object && object->is_object() && object->contains(key) ? &object->at(key) : nullptr;
}

std::string string_of(const Json* value)
{
    return value && value->is_string() ? value->as<std::string>() : std::string{};
}

std::string text(const Json* object, std::string_view key)
{
    return string_of(member(object, key));
}

std::string escape(std::string_view value)
{
    std::string result;
    for (const char c : value) {
        if (c == '~')
            result += "~0";
        else if (c == '/')
            result += "~1";
        else
            result += c;
    }
    return result;
}

void add(ValidationResult& result, const std::string& path, std::string code, std::string message,
         std::string severity = "error")
{
    result.diagnostics.push_back({path, std::move(code), std::move(message), severity});
    if (severity == "error")
        result.accepted = false;
}

const Json* find_by_id(const Json& items, std::string_view id)
{
    for (const auto& item : items.array_range())
        if (text(&item, "id") == id)
            return &item;
    return nullptr;
}

Json shallow_merge(Json lhs, const Json& rhs)
{
    for (const auto& entry : rhs.object_range())
        lhs.insert_or_assign(entry.key(), entry.value());
    return lhs;
}

bool compatible(std::string_view type, const Json& value)
{
    if (value.is_null())
        return true;
    if (type == "float")
        return value.is_number() && std::isfinite(value.as<double>());
    if (type == "int")
        return value.is_number() && std::isfinite(value.as<double>()) &&
               std::trunc(value.as<double>()) == value.as<double>() &&
               std::abs(value.as<double>()) <= 16777216;
    if (type == "bool")
        return value.is_bool();
    if (type == "color" && value.is_object()) {
        for (const auto* key : {"r", "g", "b", "a"})
            if (!value.contains(key) || !value.at(key).is_number())
                return false;
        return true;
    }
    std::size_t count = 0;
    if (type == "vec2")
        count = 2;
    if (type == "vec3")
        count = 3;
    if (type == "vec4" || type == "color")
        count = 4;
    if (!count || !value.is_array() || value.size() != count)
        return false;
    return std::all_of(value.array_range().begin(), value.array_range().end(),
                       [](const auto& entry) {
                           return entry.is_number() && std::isfinite(entry.template as<double>());
                       });
}

bool project_shader_path(std::string_view path)
{
    if (!path.starts_with("shaders/") || path.find_first_of("\\:") != path.npos ||
        path.find("//") != path.npos)
        return false;
    const std::filesystem::path value{path};
    if (value != value.lexically_normal())
        return false;
    for (const auto& part : value)
        if (part == "." || part == "..")
            return false;
    return true;
}

const Json* preset_for(std::string_view id) { return find_by_id(registry().at("presets"), id); }

const Json* role_for(std::string_view id) { return find_by_id(registry().at("roles"), id); }

struct MaterialChain {
    const Json* preset = nullptr;
    std::vector<Json> records; // derived owner first, terminal preset last
};

MaterialChain chain_for(const std::string& id, const Json& initial,
                        const AuthoringRecordResolver& resolve, ValidationResult& result)
{
    MaterialChain chain;
    std::set<std::string> seen;
    auto current = initial;
    std::string current_id = id;
    for (std::size_t depth = 0; depth < 128; ++depth) {
        if (!seen.insert(current_id).second) {
            add(result, "/data/base", "material.inheritance.cycle",
                "Material inheritance chain contains a cycle.");
            return chain;
        }
        chain.records.push_back(current);
        const auto& base = current.at("data").at("base");
        if (base.at("kind") == "preset") {
            chain.preset = preset_for(base.at("preset").as<std::string>());
            if (!chain.preset)
                add(result, "/data/base/preset", "material.preset.missing",
                    "Unknown Material Preset.");
            return chain;
        }
        current_id = base.at("material").at("$ref").at("id").as<std::string>();
        if (current_id == id) {
            add(result, "/data/base/material/$ref", "material.inheritance.cycle",
                "Material cannot inherit from itself.");
            return chain;
        }
        const auto parent = resolve("materials", current_id);
        if (!parent) {
            add(result, "/data/base/material/$ref", "material.base.missing",
                "Missing base material '" + current_id + "'.");
            return chain;
        }
        current = Json::parse(*parent);
    }
    add(result, "/data/base", "material.inheritance.limit",
        "Material inheritance exceeds the allowed depth.");
    return chain;
}

} // namespace

ValidationResult resolve_material(std::string_view material_id, std::string_view normalized_record,
                                  const AuthoringRecordResolver& resolve,
                                  const std::filesystem::path& project_root,
                                  const std::map<std::string, std::string>& shader_overlays)
{
    ValidationResult result{true, {}, {}};
    const auto initial = Json::parse(normalized_record);
    const auto chain = chain_for(std::string(material_id), initial, resolve, result);
    if (!chain.preset)
        return result;
    const auto& preset = *chain.preset;
    const auto* role = role_for(text(&preset, "role"));
    if (!role) {
        add(result, "/data/base", "material.role.missing", "Missing renderer role contract.");
        return result;
    }

    Json parameters = Json::object();
    Json textures = Json::object();
    Json authored_parameters = Json::object();
    Json authored_textures = Json::object();
    Json declared_parameters = Json::object();
    const auto& role_samplers = role->at("reservedInterface").at("samplers");
    for (const auto& entry : preset.at("defaultParameters").object_range()) {
        Json value = Json::object();
        value["type"] = entry.value().at("type");
        if (entry.value().contains("default"))
            value["value"] = entry.value().at("default");
        if (entry.value().contains("binding"))
            value["binding"] = entry.value().at("binding");
        parameters.insert_or_assign(entry.key(), value);
        declared_parameters.insert_or_assign(entry.key(), value);
    }
    for (const auto& entry : preset.at("shader").at("standardUniforms").object_range()) {
        if (parameters.contains(entry.key()))
            continue;
        for (const auto& semantic : role->at("standardSemanticAvailability").array_range())
            if (semantic.at("semantic") == entry.value()) {
                Json value = Json::object();
                value["type"] = semantic.at("logicalType");
                value["binding"] = entry.value();
                parameters.insert_or_assign(entry.key(), value);
                declared_parameters.insert_or_assign(entry.key(), value);
                break;
            }
    }
    const auto& capabilities = preset.at("capabilities").at("samplers");
    for (const auto& sampler : capabilities.object_range()) {
        if (sampler.value() == "disabled")
            continue;
        Json value = Json::object();
        value["address"] = "clamp";
        value["filter"] = "inherit";
        for (const auto& slot : role_samplers.array_range())
            if (slot.at("name") == sampler.key()) {
                const auto& addresses = slot.at("addressPolicy");
                if (std::find(addresses.array_range().begin(), addresses.array_range().end(),
                              Json("clamp")) == addresses.array_range().end())
                    value["address"] = addresses.at(0);
                const auto& filters = slot.at("filterPolicy");
                if (std::find(filters.array_range().begin(), filters.array_range().end(),
                              Json("inherit")) == filters.array_range().end())
                    value["filter"] = filters.at(0);
                if (slot.contains("semantic"))
                    value["binding"] = slot.at("semantic");
                break;
            }
        textures.insert_or_assign(sampler.key(), value);
    }
    Json sources = preset.at("shader");
    Json preview = preset.at("preview");
    const auto base_sources = sources;

    for (auto it = chain.records.rbegin(); it != chain.records.rend(); ++it) {
        const auto& data = it->at("data");
        if (const auto* shader = member(&data, "shader"))
            for (const auto& source : shader->object_range()) {
                if (source.key() != "vertex" && source.key() != "fragment" &&
                    source.key() != "varying")
                    continue;
                const auto field = source.key() == "vertex"     ? "vertexSource"
                                   : source.key() == "fragment" ? "fragmentSource"
                                                                : "varyingDefinition";
                const auto kind = text(&source.value(), "kind");
                const auto path = text(&source.value(), "path");
                sources[field] = kind == "project" ? "project:/" + path : path;
            }
        for (const auto& entry : data.at("parameters").object_range()) {
            Json value =
                parameters.contains(entry.key()) ? parameters.at(entry.key()) : Json::object();
            value = shallow_merge(std::move(value), entry.value());
            parameters.insert_or_assign(entry.key(), std::move(value));
            Json authored = authored_parameters.contains(entry.key())
                                ? authored_parameters.at(entry.key())
                                : Json::object();
            authored_parameters.insert_or_assign(entry.key(),
                                                 shallow_merge(std::move(authored), entry.value()));
        }
        for (const auto& entry : data.at("textures").object_range()) {
            Json value = textures.contains(entry.key())
                             ? textures.at(entry.key())
                             : Json::parse(R"({"address":"clamp","filter":"linear"})");
            textures.insert_or_assign(entry.key(), shallow_merge(std::move(value), entry.value()));
            Json authored = authored_textures.contains(entry.key())
                                ? authored_textures.at(entry.key())
                                : Json::object();
            authored_textures.insert_or_assign(entry.key(),
                                               shallow_merge(std::move(authored), entry.value()));
        }
        if (const auto* local_preview = member(&data, "preview"))
            preview = shallow_merge(std::move(preview), *local_preview);
    }
    const bool custom = sources.at("vertexSource") != base_sources.at("vertexSource") ||
                        sources.at("fragmentSource") != base_sources.at("fragmentSource") ||
                        sources.at("varyingDefinition") != base_sources.at("varyingDefinition");
    const auto& data = initial.at("data");
    const auto base = std::string("/data");
    if (data.at("base").at("kind") == "material" && chain.records.size() >= 2) {
        // Inherited effective values, not just immediately authored fields, are
        // immutable for logical types and renderer ownership.
        Json inherited = Json::object();
        for (const auto& entry : declared_parameters.object_range())
            inherited.insert_or_assign(entry.key(), entry.value());
        for (auto it = chain.records.rbegin(); it != chain.records.rend() - 1; ++it)
            for (const auto& entry : it->at("data").at("parameters").object_range()) {
                Json item =
                    inherited.contains(entry.key()) ? inherited.at(entry.key()) : Json::object();
                inherited.insert_or_assign(entry.key(),
                                           shallow_merge(std::move(item), entry.value()));
            }
        for (const auto& entry : data.at("parameters").object_range()) {
            const auto* prior = member(&inherited, entry.key());
            const auto path = base + "/parameters/" + escape(entry.key());
            for (const auto* field : {"type", "binding"})
                if (prior && prior->contains(field) && entry.value().contains(field) &&
                    prior->at(field) != entry.value().at(field))
                    add(result, path + "/" + field, "material.inherited.immutable",
                        "Inherited Material parameter cannot reinterpret " + std::string(field) +
                            ".");
        }
    }

    for (const auto& entry : data.at("parameters").object_range()) {
        const auto path = base + "/parameters/" + escape(entry.key());
        const auto& override = entry.value();
        if (!custom && !declared_parameters.contains(entry.key())) {
            add(result, path, "material.parameter.orphan",
                "Parameter is absent from Preset interface.", "warning");
            continue;
        }
        const auto& effective = parameters.at(entry.key());
        const auto type = text(&effective, "type");
        if (override.contains("value") && !type.empty() && !compatible(type, override.at("value")))
            add(result, path + "/value", "material.parameter.value",
                "Material parameter value does not match its logical type.");
        if (override.contains("value") &&
            ((!custom && member(member(&declared_parameters, entry.key()), "binding")) ||
             (custom && member(&override, "binding") && !override.at("binding").is_null())))
            add(result, path + "/value", "material.parameter.renderer-owned",
                "Renderer-bound parameter cannot have an authored value.");
        if (!custom && override.contains("binding")) {
            const auto* declaration = member(&declared_parameters, entry.key());
            const auto* binding = member(declaration, "binding");
            if (!binding || *binding != override.at("binding"))
                add(result, path + "/binding", "material.parameter.binding",
                    "Parameter binding disagrees with preset contract.");
        }
    }
    for (const auto& entry : data.at("textures").object_range()) {
        const auto path = base + "/textures/" + escape(entry.key());
        const auto* capability = member(&capabilities, entry.key());
        const bool declared = capability && *capability != "disabled";
        if (!custom && !declared)
            add(result, path, "material.texture.orphan", "Texture is absent from Preset interface.",
                "warning");
        const Json* sampler = nullptr;
        for (const auto& candidate : role_samplers.array_range())
            if (candidate.at("name") == entry.key()) {
                sampler = &candidate;
                break;
            }
        const auto& texture = entry.value();
        const bool renderer_owned = sampler && text(sampler, "sourceOwnership") == "renderer";
        if (texture.contains("source") &&
            (renderer_owned ||
             (custom && member(&texture, "binding") && !texture.at("binding").is_null())))
            add(result, path + "/source", "material.texture.renderer-owned",
                "Renderer-bound texture cannot have an authored source.");
        if (sampler && (custom || declared)) {
            for (const auto* field : {"address", "filter"}) {
                if (!texture.contains(field))
                    continue;
                const auto& allowed = sampler->at(std::string(field) + "Policy");
                if (std::none_of(
                        allowed.array_range().begin(), allowed.array_range().end(),
                        [&](const Json& candidate) { return candidate == texture.at(field); }))
                    add(result, path + "/" + field, "material.texture.policy",
                        "Texture sampling policy is disallowed by renderer contract.");
            }
            if (!custom && texture.contains("binding") &&
                (!sampler->contains("semantic") ||
                 texture.at("binding") != sampler->at("semantic")))
                add(result, path + "/binding", "material.texture.binding",
                    "Texture binding disagrees with preset contract.");
        }
        if (const auto* source = member(&texture, "source")) {
            if (const auto* reference = member(source, "$ref")) {
                const auto id = text(reference, "id");
                const auto asset = resolve("assets", id);
                if (!asset)
                    add(result, path + "/source/$ref", "material.texture.asset-missing",
                        "Missing texture Asset '" + id + "'.");
                else if (const auto parsed = Json::parse(*asset);
                         parsed.at("data").at("kind") != "image")
                    add(result, path + "/source/$ref", "material.texture.asset-kind",
                        "Texture Asset is not an image.", "warning");
            }
        }
    }
    for (const auto* field : {"vertexSource", "fragmentSource", "varyingDefinition"}) {
        const auto source = sources.at(field).as<std::string>();
        if (!source.starts_with("project:/"))
            continue;
        const auto path = source.substr(9);
        const auto stage = std::string(field) == "vertexSource"     ? "vertex"
                           : std::string(field) == "fragmentSource" ? "fragment"
                                                                    : "varying";
        if (!project_shader_path(path)) {
            add(result, base + "/shader/" + stage + "/path", "material.shader.path",
                "Shader path must be a canonical Project shader source.");
            continue;
        }
        const auto root = std::filesystem::canonical(project_root);
        const auto absolute = std::filesystem::weakly_canonical(project_root / path);
        const auto relative = absolute.lexically_relative(root);
        if (relative.empty() || relative == "." || *relative.begin() == ".." ||
            (!std::filesystem::is_regular_file(absolute) && !shader_overlays.contains(path)))
            add(result, base + "/shader/" + stage + "/path", "material.shader.source-missing",
                "Shader source does not exist in this Project.");
    }

    Json effective = Json::object();
    effective["preset"] = preset.at("id");
    effective["role"] = preset.at("role");
    for (const auto& contract : noveltea::generated_material_contracts::presets)
        if (contract.id == text(&preset, "id")) {
            effective["interfaceContract"] = std::string(contract.contract_identity);
            effective["interfaceFingerprint"] = std::string(contract.contract_fingerprint);
            break;
        }
    effective["shader"] = sources;
    effective["parameters"] = parameters;
    effective["textures"] = textures;
    effective["authoredParameters"] = authored_parameters;
    effective["authoredTextures"] = authored_textures;
    effective["preview"] = preview;
    effective["custom"] = custom;
    result.effective_json = effective.to_string();
    return result;
}

ValidationResult validate_material_shader_compiler_result(std::string_view result_json,
                                                          std::string_view material_id,
                                                          std::string_view effective_material_json)
{
    ValidationResult result{true, {}, {}};
    const auto document = Json::parse(result_json);
    if (!document.is_object() || !document.contains("diagnostics") ||
        !document.at("diagnostics").is_array()) {
        add(result, "/materials/" + escape(material_id) + "/data/shader",
            "material.shader.compiler-response", "Native shader compiler response is malformed.");
        return result;
    }
    if ((document.contains("ok") && document.at("ok") == false) ||
        (document.contains("success") && document.at("success") == false &&
         document.at("diagnostics").empty()))
        add(result, "/materials/" + escape(material_id) + "/data/shader",
            "material.shader.compiler-failure", "Native shader compiler rejected the program.");
    for (const auto& diagnostic : document.at("diagnostics").array_range()) {
        const auto severity = text(&diagnostic, "severity");
        const auto source = text(&diagnostic, "sourcePath");
        const auto code = text(&diagnostic, "code");
        const auto message = text(&diagnostic, "message");
        const auto line = member(&diagnostic, "line");
        add(result, "/materials/" + escape(material_id) + "/data/shader",
            code.empty() ? "material.shader.compiler" : code,
            (source.empty()
                 ? std::string{}
                 : source +
                       (line && line->is_number() ? ":" + std::to_string(line->as<int>()) : "") +
                       ": ") +
                message,
            severity == "warning" || severity == "info" ? severity : "error");
        result.diagnostics.back().source_path = source;
    }
    if (document.contains("success") && document.at("success") == false && result.accepted)
        add(result, "/materials/" + escape(material_id) + "/data/shader",
            "material.shader.compiler-failure", "Native shader compilation did not succeed.");
    if (effective_material_json.empty() || !document.contains("outputs") ||
        !document.at("outputs").is_array() || document.at("outputs").empty())
        return result;
    const auto material = Json::parse(effective_material_json);
    if (!material.at("custom").as<bool>())
        return result;
    const auto prefix = "/materials/" + escape(material_id) + "/data";
    std::map<std::string, Json> reflected;
    std::set<std::string> conflicts;
    for (const auto& output : document.at("outputs").array_range()) {
        if (!output.contains("reflectedInputs") || !output.at("reflectedInputs").is_array())
            continue;
        for (const auto& input : output.at("reflectedInputs").array_range()) {
            const auto name = text(&input, "name");
            if (name.empty() || name == "u_modelViewProj" || name == "u_modelView" ||
                name == "u_viewProj" || name == "u_view" || name == "u_proj" || name == "u_model" ||
                name == "u_invView" || name == "u_invProj" || name == "u_invViewProj" ||
                name == "u_viewRect" || name == "u_viewTexel" || name == "u_alphaRef4")
                continue;
            const auto found = reflected.find(name);
            if (found != reflected.end()) {
                if ((found->second.at("kind") != input.at("kind") ||
                     found->second.at("type") != input.at("type") ||
                     found->second.at("arraySize") != input.at("arraySize") ||
                     (input.at("kind") == "sampled-image" &&
                      (found->second.at("registerIndex") != input.at("registerIndex") ||
                       found->second.at("registerCount") != input.at("registerCount")))) &&
                    conflicts.insert(name).second)
                    add(result, prefix + "/parameters/" + escape(name),
                        "material.shader.reflection-conflict",
                        "Inconsistent reflected input across shader stages or variants.");
            } else {
                reflected.emplace(name, input);
            }
        }
    }
    for (const auto& [name, input] : reflected) {
        const bool sampler = input.at("kind") == "sampled-image";
        const auto path = prefix + (sampler ? "/textures/" : "/parameters/") + escape(name);
        if (input.at("arraySize").as<std::size_t>() != 1)
            add(result, path, "material.shader.reflected-array",
                "Reflected Shader arrays are not supported.");
        if (!sampler && text(&input, "type") != "vec4") {
            add(result, path, "material.shader.reflected-type",
                "Authored shader uniform must use the physical vec4 ABI.");
        }
        if (sampler && !input.contains("registerIndex"))
            add(result, path, "material.shader.sampler-stage",
                "Reflected sampler does not declare its compiled stage.");
    }
    for (const auto* key : {"authoredParameters", "authoredTextures"}) {
        const auto field =
            std::string_view(key) == "authoredParameters" ? "parameters" : "textures";
        for (const auto& entry : material.at(key).object_range())
            if (!reflected.contains(std::string(entry.key())))
                add(result, prefix + "/" + field + "/" + escape(entry.key()),
                    "material.shader.orphan", "Authored override has no reflected Shader input.",
                    "warning");
    }
    return result;
}

std::string material_shader_program_request(std::string_view material_id,
                                            std::string_view effective_material_json)
{
    const auto effective = Json::parse(effective_material_json);
    Json project = Json::object();
    project["schema"] = "noveltea.shader-source-programs";
    project["programs"] = Json::object();
    if (effective.at("custom").as<bool>()) {
        Json program = Json::object();
        const auto& shader = effective.at("shader");
        for (const auto* key : {"vertexSource", "fragmentSource", "varyingDefinition"})
            program[key] = shader.at(key);
        program["interfaceContract"] = effective.at("interfaceContract");
        program["interfaceFingerprint"] = effective.at("interfaceFingerprint");
        project["programs"][std::string(material_id)] = std::move(program);
    }
    return project.to_string();
}

} // namespace noveltea::authoring
