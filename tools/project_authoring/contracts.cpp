#include "contracts.hpp"
#include "embedded_contracts.hpp"
#include "generated/operations.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonschema/jsonschema.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace noveltea::authoring {
namespace {
// Preserve source key order so overwrites after record-key normalization match Zod.
using Json = jsoncons::ojson;
using Value = std::optional<Json>;
using CompiledSchema = jsoncons::jsonschema::json_schema<Json>;

std::string pointer_token(std::string_view token)
{
    std::string result;
    for (char c : token) {
        if (c == '~')
            result += "~0";
        else if (c == '/')
            result += "~1";
        else
            result += c;
    }
    return result;
}

std::optional<std::uint32_t> javascript_array_index(std::string_view key)
{
    // Object.keys() enumerates canonical array-index names first, in numeric order.
    if (key.empty() || (key.size() > 1 && key.front() == '0'))
        return std::nullopt;
    std::uint64_t number = 0;
    for (const auto digit : key) {
        if (digit < '0' || digit > '9')
            return std::nullopt;
        number = number * 10 + static_cast<unsigned>(digit - '0');
        if (number >= std::numeric_limits<std::uint32_t>::max())
            return std::nullopt;
    }
    return static_cast<std::uint32_t>(number);
}

std::string lua_dependency_key(const Json& target)
{
    // Match serializeLuaExplicitDependencyTarget: semantic fields, not JSON object ordering.
    const auto kind = target.at("kind").as<std::string>();
    Json fields = Json::array();
    fields.push_back(kind);
    if (kind == "record") {
        fields.push_back(target.at("collection"));
        fields.push_back(target.at("id"));
    } else if (kind == "property-value") {
        const auto& owner = target.at("owner");
        fields.push_back(owner.at("kind"));
        fields.push_back(owner.at("id"));
        fields.push_back(target.at("propertyId"));
    } else if (kind == "room-placement") {
        fields.push_back(target.at("roomId"));
        fields.push_back(target.at("placementId"));
    } else if (kind == "room-exit") {
        fields.push_back(target.at("roomId"));
        fields.push_back(target.at("exitId"));
    } else {
        throw std::runtime_error("Unknown explicit Lua dependency target kind: " + kind);
    }
    return fields.to_string();
}

const std::set<std::string> implemented_operations{"value.default",
                                                   "string.trim",
                                                   "string.utf16-length",
                                                   "lua.dependencies.unique",
                                                   "lua.dependencies.empty",
                                                   "animation.loop-range",
                                                   "animation.source-range",
                                                   "asset.attachment-path",
                                                   "asset.validate",
                                                   "hotspot.bounds",
                                                   "hotspot.motion-track",
                                                   "material.application-parameter",
                                                   "property.default-unique",
                                                   "property.default-value",
                                                   "property.local-unique",
                                                   "property.local-value",
                                                   "trait.property",
                                                   "trait.definition",
                                                   "workspace.trait-key",
                                                   "project.canonical-inventory",
                                                   "project.notice-path",
                                                   "project.notice-extension",
                                                   "export.localization-policy",
                                                   "export.android-profile"};

bool safe_notice_path(std::string_view path)
{
    if (path.empty() || path.size() > 2048 || path.front() == '/' || path.front() == '\\' ||
        path.find_first_of(":\\") != std::string_view::npos)
        return false;
    static const std::set<std::string> blocked{".git",  ".hg",  ".svn", ".noveltea", "node_modules",
                                               "build", "dist", "out",  ".cache"};
    static const std::set<std::string> reserved_root{"project.yaml", ".gitignore", ".gitattributes",
                                                     ".gitmodules", "ntproject.json"};
    auto lower_path = std::string(path);
    std::transform(lower_path.begin(), lower_path.end(), lower_path.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (reserved_root.contains(lower_path))
        return false;
    std::size_t start = 0;
    while (start < path.size()) {
        const auto end = path.find('/', start);
        auto segment =
            std::string(path.substr(start, end == std::string_view::npos ? end : end - start));
        std::transform(segment.begin(), segment.end(), segment.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (segment.empty() || segment == "." || segment == ".." || blocked.contains(segment))
            return false;
        if (end == std::string_view::npos)
            return true;
        start = end + 1;
    }
    return false;
}

bool property_value_compatible(const Json& property, const Json& value)
{
    if (value.is_null())
        return property.at("nullable").as<bool>();
    const auto type = property.at("type").as<std::string>();
    if (type == "boolean")
        return value.is_bool();
    if (type == "integer")
        return value.is_number() && std::isfinite(value.as<double>()) &&
               std::trunc(value.as<double>()) == value.as<double>();
    if (type == "number")
        return value.is_number() && std::isfinite(value.as<double>());
    if (type == "string")
        return value.is_string();
    if (type == "message")
        return value.is_object() && value.size() == 1 && value.contains("$message") &&
               value.at("$message").is_string();
    if (type == "enum") {
        if (!value.is_string() || !property.contains("enumValues"))
            return false;
        for (const auto& option : property.at("enumValues").array_range())
            if (option == value)
                return true;
    }
    return false;
}

bool uniform_value_compatible(std::string_view type, const Json& value)
{
    if (value.is_null())
        return true;
    if (type == "bool")
        return value.is_bool();
    if (type == "float")
        return value.is_number() && std::isfinite(value.as<double>());
    if (type == "int")
        return value.is_number() && std::isfinite(value.as<double>()) &&
               std::trunc(value.as<double>()) == value.as<double>() &&
               std::abs(value.as<double>()) <= 16777216;
    const auto expected = type == "vec2" ? 2U : type == "vec3" ? 3U : 4U;
    if ((type == "vec2" || type == "vec3" || type == "vec4" || type == "color") &&
        value.is_array() && value.size() == expected) {
        for (const auto& member : value.array_range())
            if (!member.is_number() || !std::isfinite(member.as<double>()))
                return false;
        return true;
    }
    if (type == "color" && value.is_object() && value.size() == 4) {
        for (const auto* component : {"r", "g", "b", "a"})
            if (!value.contains(component) || !value.at(component).is_number() ||
                !std::isfinite(value.at(component).as<double>()))
                return false;
        return true;
    }
    return false;
}

} // namespace

std::string trim_ecmascript(std::string value)
{
    // ECMAScript WhiteSpace + LineTerminator, not locale-dependent C isspace.
    static const std::vector<std::string> whitespace{"\x09",         "\x0a",         "\x0b",
                                                     "\x0c",         "\x0d",         " ",
                                                     "\xc2\xa0",     "\xe1\x9a\x80", "\xe2\x80\x80",
                                                     "\xe2\x80\x81", "\xe2\x80\x82", "\xe2\x80\x83",
                                                     "\xe2\x80\x84", "\xe2\x80\x85", "\xe2\x80\x86",
                                                     "\xe2\x80\x87", "\xe2\x80\x88", "\xe2\x80\x89",
                                                     "\xe2\x80\x8a", "\xe2\x80\xa8", "\xe2\x80\xa9",
                                                     "\xe2\x80\xaf", "\xe2\x81\x9f", "\xe3\x80\x80",
                                                     "\xef\xbb\xbf"};
    bool changed = true;
    while (changed) {
        changed = false;
        for (const auto& space : whitespace) {
            if (value.starts_with(space)) {
                value.erase(0, space.size());
                changed = true;
            }
            if (value.ends_with(space)) {
                value.resize(value.size() - space.size());
                changed = true;
            }
        }
    }
    return value;
}

namespace {

Json embedded_document()
{
    std::string bytes;
    for (const auto chunk : contract_chunks)
        bytes.append(chunk);
    return Json::parse(bytes);
}

struct Contracts {
    Json document = embedded_document();
    std::map<std::string, CompiledSchema> validators;

    Contracts()
    {
        if (document.at("schema") != "noveltea.native-authoring-contracts")
            throw std::runtime_error("Invalid embedded contract identity");
        auto options = jsoncons::jsonschema::evaluation_options{}.require_format_validation(true);
        for (const auto& item : document.at("nodes").object_range()) {
            const auto id = std::string(item.key());
            const auto& node = item.value();
            if (node.contains("validation"))
                validators.emplace(
                    id, jsoncons::jsonschema::make_json_schema(node.at("validation"), options));
            std::size_t index = 0;
            for (const auto& step : node.at("steps").array_range()) {
                if (step.contains("validation"))
                    validators.emplace(
                        id + ":" + std::to_string(index),
                        jsoncons::jsonschema::make_json_schema(step.at("validation"), options));
                ++index;
            }
        }
        for (const auto& id : implemented_operations) {
            if (std::none_of(generated::operations.begin(), generated::operations.end(),
                             [&](const auto& registration) { return registration.id == id; }))
                throw std::runtime_error("Native implementation has no generated registration: " +
                                         id);
        }
    }
};

// Select only tagged branches of an otherwise ordinary union. Gameplay Commands
// use z.union (rather than z.discriminatedUnion), and transfer/consume have an
// additional `mode` literal. Selecting by both tags is necessary to report an
// error at the offending nested field instead of at an unrelated alternative.
const Json& unwrapped_node(const Contracts& contracts, std::string id)
{
    for (unsigned int depth = 0; depth < 64; ++depth) {
        const auto& current = contracts.document.at("nodes").at(id);
        const auto type = current.at("type").as<std::string>();
        if (type == "lazy" || type == "optional" || type == "nullable" || type == "default")
            id = current.at("children").at("inner").as<std::string>();
        else if (type == "pipe")
            id = current.at("children").at("in").as<std::string>();
        else
            return current;
    }
    throw std::runtime_error("Union branch wrapper depth exceeded.");
}

struct UnionBranches {
    std::vector<std::string> ids;
    std::string invalid_tag;
};

UnionBranches tagged_union_branches(const Contracts& contracts, const Json& union_node,
                                    const Json& value)
{
    UnionBranches result;
    for (const auto& item : union_node.at("children").object_range())
        result.ids.push_back(item.value().as<std::string>());
    if (!value.is_object())
        return result;
    for (const auto* tag : {"kind", "mode"}) {
        // `mode` is relevant only after matching `kind`, and only if every
        // remaining branch supplies a literal for this field.
        if (result.ids.empty())
            return result;
        bool all_tagged = true;
        for (const auto& id : result.ids) {
            const auto& branch = unwrapped_node(contracts, id);
            if (branch.at("type") != "object" || !branch.at("children").contains(tag) ||
                unwrapped_node(contracts, branch.at("children").at(tag).as<std::string>())
                        .at("type") != "literal") {
                all_tagged = false;
                break;
            }
        }
        if (!all_tagged)
            continue;
        std::vector<std::string> matched;
        for (const auto& id : result.ids) {
            const auto& branch = unwrapped_node(contracts, id);
            const auto& literal =
                unwrapped_node(contracts, branch.at("children").at(tag).as<std::string>());
            for (const auto& option : literal.at("values").array_range())
                if (value.contains(tag) && option == value.at(tag)) {
                    matched.push_back(id);
                    break;
                }
        }
        if (matched.empty()) {
            result.ids.clear();
            result.invalid_tag = tag;
            return result;
        }
        result.ids = std::move(matched);
    }
    return result;
}

class Validator {
    const Contracts& contracts_;
    std::size_t visits_ = 0;

    const Json& node(const std::string& id) const { return contracts_.document.at("nodes").at(id); }

    void issue(std::vector<Diagnostic>& errors, const std::string& path, std::string code,
               std::string message) const
    {
        errors.push_back({path, std::move(code), std::move(message)});
    }

    void structural(const std::string& key, const Json& value, const std::string& path,
                    std::vector<Diagnostic>& errors) const
    {
        auto found = contracts_.validators.find(key);
        if (found == contracts_.validators.end())
            return;
        found->second.validate(value, [&](const jsoncons::jsonschema::validation_message& message) {
            issue(errors, path + message.instance_location().string(),
                  "schema." + message.keyword(), message.message());
            return jsoncons::jsonschema::walk_result::advance;
        });
    }

    void operation(const Json& registration, Value& value, const std::string& path,
                   std::vector<Diagnostic>& errors) const
    {
        const auto id = registration.at("id").as<std::string>();
        if (id == "string.utf16-length") {
            if (!value || !value->is_string())
                return;
            std::size_t length = 0;
            for (unsigned char c : value->as<std::string>()) {
                if ((c & 0xc0) != 0x80)
                    length += c >= 0xf0 ? 2 : 1;
            }
            const auto& limits = registration.at("value");
            if (length < limits.at("minimum").as<std::size_t>() ||
                (!limits.at("maximum").is_null() &&
                 length > limits.at("maximum").as<std::size_t>()))
                issue(errors, path, "semantic.string.utf16-length",
                      "String length is outside the authored UTF-16 bounds.");
        } else if (id == "string.trim") {
            if (value && value->is_string())
                value = trim_ecmascript(value->as<std::string>());
        } else if (id == "lua.dependencies.empty") {
            if (!value)
                value = Json::parse(R"({"targets":[]})");
        } else if (id == "lua.dependencies.unique") {
            if (!value || !value->is_object() || !value->contains("targets") ||
                !value->at("targets").is_array())
                return;
            std::set<std::string> seen;
            std::size_t index = 0;
            for (const auto& target : value->at("targets").array_range()) {
                if (!seen.insert(lua_dependency_key(target)).second)
                    issue(errors, path + "/targets/" + std::to_string(index), "semantic." + id,
                          "Duplicate explicit Lua dependency target.");
                ++index;
            }
        } else if (id == "animation.loop-range") {
            if (value && value->is_object() && value->contains("loopRange") &&
                value->at("repeat") != "loop")
                issue(errors, path + "/loopRange", "semantic." + id,
                      "A loop range requires loop playback.");
        } else if (id == "animation.source-range") {
            if (value && value->is_object() &&
                value->at("endMs").as<std::int64_t>() <= value->at("startMs").as<std::int64_t>())
                issue(errors, path + "/endMs", "semantic." + id,
                      "Video source range end must be after its start.");
        } else if (id == "asset.attachment-path") {
            if (value && value->is_string() && !safe_notice_path(value->as<std::string>()))
                issue(errors, path, "semantic." + id,
                      "Attachment must be a portable Project-contained path.");
        } else if (id == "asset.validate") {
            if (!value || !value->is_object())
                return;
            const auto& data = *value;
            if (data.contains("attachments") && data.at("attachments").is_array()) {
                std::set<std::string> seen;
                for (std::size_t i = 0; i < data.at("attachments").size(); ++i) {
                    const auto& attachment = data.at("attachments").at(i);
                    if (!seen.insert(attachment.at("path").as<std::string>()).second)
                        issue(errors, path + "/attachments/" + std::to_string(i) + "/path",
                              "semantic." + id,
                              "Attachment file is already associated with this Asset.");
                }
            }
            const auto image = data.at("kind") == "image";
            const auto has_metadata = !data.at("imageMetadata").is_null();
            if (image != has_metadata)
                issue(errors, path + "/imageMetadata", "semantic." + id,
                      image ? "Image metadata is required."
                            : "Only image assets may have image metadata.");
        } else if (id == "hotspot.bounds") {
            if (!value || !value->is_object())
                return;
            const auto& bounds = *value;
            if (bounds.at("x").as<double>() + bounds.at("width").as<double>() > 1)
                issue(errors, path + "/width", "semantic." + id, "Rectangle exceeds image width.");
            if (bounds.at("y").as<double>() + bounds.at("height").as<double>() > 1)
                issue(errors, path + "/height", "semantic." + id,
                      "Rectangle exceeds image height.");
        } else if (id == "hotspot.motion-track") {
            if (!value || !value->is_object() || !value->contains("keyframes"))
                return;
            const auto& frames = value->at("keyframes");
            for (std::size_t i = 1; i < frames.size(); ++i)
                if (frames.at(i).at("timeMs").as<std::int64_t>() <=
                    frames.at(i - 1).at("timeMs").as<std::int64_t>())
                    issue(errors, path + "/keyframes/" + std::to_string(i) + "/timeMs",
                          "semantic." + id,
                          "Hotspot motion keyframe times must be strictly increasing.");
        } else if (id == "material.application-parameter") {
            if (!value || !value->is_object())
                return;
            const auto& source = value->at("source");
            if (source.at("kind") == "literal" &&
                !uniform_value_compatible(value->at("type").as<std::string>(), source.at("value")))
                issue(errors, path + "/source/value", "semantic." + id,
                      "Literal value is incompatible with the Material parameter type.");
        } else if (id == "property.default-unique" || id == "property.local-unique") {
            if (!value || !value->is_array())
                return;
            std::set<std::string> seen;
            std::size_t index = 0;
            for (const auto& property : value->array_range()) {
                const auto property_id = property.at("id").as<std::string>();
                if (!seen.insert(property_id).second)
                    issue(errors, path + "/" + std::to_string(index) + "/id", "semantic." + id,
                          "Property is declared more than once on this owner.");
                ++index;
            }
        } else if (id == "property.default-value" || id == "property.local-value" ||
                   id == "trait.property") {
            if (!value || !value->is_object())
                return;
            const auto& property = *value;
            const auto type = property.at("type").as<std::string>();
            if (type == "enum") {
                if (!property.contains("enumValues") || property.at("enumValues").empty())
                    issue(errors, path + "/enumValues", "semantic." + id,
                          "Enum properties require at least one enum value.");
                else {
                    std::set<std::string> seen;
                    for (const auto& entry : property.at("enumValues").array_range())
                        if (!seen.insert(entry.as<std::string>()).second) {
                            issue(errors, path + "/enumValues", "semantic." + id,
                                  "Enum property values must be unique.");
                            break;
                        }
                }
            } else if (property.contains("enumValues")) {
                issue(errors, path + "/enumValues", "semantic." + id,
                      "enumValues is valid only for enum properties.");
            }
            const auto key = id == "property.local-value" ? "value" : "defaultValue";
            if (property.contains(key) && !property_value_compatible(property, property.at(key)))
                issue(errors, path + "/" + key, "semantic." + id,
                      "Property value does not match its declaration.");
        } else if (id == "trait.definition") {
            if (!value || !value->is_object())
                return;
            for (const auto* key : {"ownerKinds", "properties"}) {
                std::set<std::string> seen;
                for (const auto& entry : value->at(key).array_range()) {
                    const auto member = std::string(key) == "ownerKinds"
                                            ? entry.as<std::string>()
                                            : entry.at("id").as<std::string>();
                    if (!seen.insert(member).second) {
                        issue(errors, path + "/" + key, "semantic." + id,
                              std::string(key) == "ownerKinds"
                                  ? "Trait owner kinds must be unique."
                                  : "Trait properties must be unique.");
                        break;
                    }
                }
            }
        } else if (id == "workspace.trait-key") {
            if (!value || !value->is_object())
                return;
            for (const auto& trait : value->object_range()) {
                if (trait.value().at("id") != trait.key())
                    issue(errors, path + "/" + pointer_token(trait.key()) + "/id", "semantic." + id,
                          "Trait ID must match its map key.");
            }
        } else if (id == "project.canonical-inventory") {
            if (value && value->is_array() && value->size() == 1 &&
                (value->at(0).at("id") != "inventory" || value->at(0).at("label") != "Inventory"))
                issue(errors, path, "semantic." + id,
                      "Project Inventory must use the canonical inventory/Inventory identity.");
        } else if (id == "project.notice-path") {
            if (value && value->is_string() && !safe_notice_path(value->as<std::string>()))
                issue(errors, path, "semantic." + id, "Notice must have a safe Project path.");
        } else if (id == "project.notice-extension") {
            if (value && value->is_string()) {
                auto suffix = value->as<std::string>();
                std::transform(suffix.begin(), suffix.end(), suffix.begin(),
                               [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                if (!suffix.ends_with(".txt") && !suffix.ends_with(".md"))
                    issue(errors, path, "semantic." + id, "Notice must be .txt or .md.");
            }
        } else if (id == "export.localization-policy") {
            if (value && value->is_object()) {
                const auto& locales = value->at("locales");
                const auto& default_locale = value->at("defaultLocale");
                bool found = false;
                for (const auto& locale : locales.array_range())
                    found |= locale == default_locale;
                if (!found)
                    issue(errors, path + "/defaultLocale", "semantic." + id,
                          "Export default locale must be included in the export locale set.");
            }
        } else if (id == "export.android-profile") {
            if (value && value->is_object()) {
                const auto& profile = *value;
                const auto expected =
                    profile.at("architecture") == "arm64" ? "arm64-v8a" : "x86_64";
                if (profile.at("android").at("abi") != expected)
                    issue(errors, path + "/android/abi", "semantic." + id,
                          "Android architecture requires the matching ABI.");
                if ((profile.at("android").at("artifact") == "aab" ||
                     profile.at("android").at("artifact") == "both") &&
                    profile.at("buildFlavor") == "release" &&
                    profile.at("android").at("abi") != "arm64-v8a")
                    issue(errors, path + "/android/abi", "semantic." + id,
                          "Release AAB exports require the arm64-v8a ABI.");
            }
        } else {
            throw std::runtime_error("Native operation is not implemented: " + id);
        }
    }

public:
    explicit Validator(const Contracts& contracts) : contracts_(contracts) {}

    void check_support(const std::string& id, std::set<std::string>& seen,
                       std::vector<Diagnostic>& errors) const
    {
        if (!seen.insert(id).second)
            return;
        const auto& current = node(id);
        for (const auto& op : current.at("operations").array_range()) {
            const auto name = op.at("id").as<std::string>();
            if (!implemented_operations.contains(name))
                issue(errors, "", "contract.unsupported_operation",
                      "Native operation is registered but not implemented: " + name);
        }
        for (const auto& child : current.at("children").object_range())
            check_support(child.value().as<std::string>(), seen, errors);
    }

    void parse(const std::string& id, Value& value, const std::string& path,
               std::vector<Diagnostic>& errors, std::size_t depth = 0)
    {
        if (++visits_ > 200000 || depth > 256) {
            issue(errors, path, "contract.limit", "Native certification traversal limit exceeded.");
            return;
        }
        const auto& current = node(id);
        const auto type = current.at("type").as<std::string>();
        const auto& children = current.at("children");
        auto descend = [&](const std::string& key, Value& nested, const std::string& nested_path) {
            parse(children.at(key).as<std::string>(), nested, nested_path, errors, depth + 1);
        };
        const auto before = errors.size();
        if (type == "default" && !value) {
            value = current.at("operations").at(0).at("value");
        } else if (type == "optional" && !value) {
            // Inner defaults/overwrites may materialize an omitted optional value.
            Value candidate;
            std::vector<Diagnostic> inner_errors;
            parse(children.at("inner").as<std::string>(), candidate, path, inner_errors, depth + 1);
            if (inner_errors.empty())
                value = std::move(candidate);
            for (const auto& error : inner_errors)
                if (error.code.starts_with("contract."))
                    errors.push_back(error);
        } else if (type == "nullable" && value && value->is_null()) {
        } else if (type == "lazy" || type == "default" || type == "optional" ||
                   type == "nullable") {
            descend("inner", value, path);
        } else if (type == "pipe") {
            descend("in", value, path);
            if (errors.size() == before)
                descend("out", value, path);
        } else if (type == "transform") {
            for (const auto& op : current.at("operations").array_range())
                operation(op, value, path, errors);
        } else if (type == "union") {
            const auto branches =
                tagged_union_branches(contracts_, current, value ? *value : Json::null());
            if (!branches.invalid_tag.empty()) {
                issue(errors, path + "/" + pointer_token(branches.invalid_tag),
                      "schema.discriminator", "Unknown or missing union discriminator.");
            } else if (value && branches.ids.size() == 1) {
                parse(branches.ids.front(), value, path, errors, depth + 1);
            } else {
                std::vector<Diagnostic> best;
                bool accepted = false;
                for (const auto& branch_id : branches.ids) {
                    auto candidate = value;
                    std::vector<Diagnostic> branch_errors;
                    parse(branch_id, candidate, path, branch_errors, depth + 1);
                    if (branch_errors.empty()) {
                        value = std::move(candidate);
                        accepted = true;
                        break;
                    }
                    if (best.empty() || branch_errors.size() < best.size())
                        best = std::move(branch_errors);
                }
                if (!accepted)
                    errors.insert(errors.end(), best.begin(), best.end());
            }
        } else if (!value) {
            issue(errors, path, "schema.required", "Required value is missing.");
        } else {
            structural(id, *value, path, errors);
            // A strict object's unknown-key issue must not hide a missing or
            // invalid *known* field. Zod reports both in one parse, and the
            // actionable nested field is important for Gameplay Commands.
            if (errors.size() != before && type != "object")
                return;
            if (type == "object") {
                for (const auto& child : children.object_range()) {
                    const std::string key(child.key());
                    if (key == "$catchall")
                        continue;
                    Value nested;
                    if (value->contains(key))
                        nested = value->at(key);
                    descend(key, nested, path + "/" + pointer_token(key));
                    if (nested)
                        value->insert_or_assign(key, std::move(*nested));
                }
                std::vector<std::string> unknown;
                for (const auto& entry : value->object_range())
                    if (!children.contains(entry.key()))
                        unknown.emplace_back(entry.key());
                for (const auto& key : unknown) {
                    if (children.contains("$catchall")) {
                        Value nested = value->at(key);
                        descend("$catchall", nested, path + "/" + pointer_token(key));
                        if (nested)
                            value->insert_or_assign(key, std::move(*nested));
                    } else
                        value->erase(key);
                }
            } else if (type == "array" || type == "tuple") {
                if (!value->is_array()) {
                    issue(errors, path, "schema.type", "Expected array.");
                    return;
                }
                std::size_t fixed = children.size() - (children.contains("rest") ? 1 : 0);
                if (type == "tuple" && !children.contains("rest") && value->size() > fixed)
                    issue(errors, path, "schema.maxItems", "Too many tuple elements.");
                const auto count = type == "tuple" ? std::max(fixed, value->size()) : value->size();
                for (std::size_t index = 0; index < count; ++index) {
                    const auto key = type == "array" ? "element"
                                     : index < fixed ? std::to_string(index)
                                                     : "rest";
                    if (!children.contains(key))
                        continue;
                    Value nested;
                    if (index < value->size())
                        nested = value->at(index);
                    descend(key, nested, path + "/" + std::to_string(index));
                    if (nested && index < value->size())
                        value->at(index) = std::move(*nested);
                    else if (nested)
                        value->push_back(std::move(*nested));
                }
            } else if (type == "record") {
                if (!value->is_object()) {
                    issue(errors, path, "schema.type", "Expected object.");
                    return;
                }
                Json normalized = Json::object();
                std::vector<std::string> keys;
                keys.reserve(value->size());
                for (const auto& entry : value->object_range())
                    keys.emplace_back(entry.key());
                std::stable_sort(keys.begin(), keys.end(), [](const auto& a, const auto& b) {
                    const auto left = javascript_array_index(a);
                    const auto right = javascript_array_index(b);
                    return left ? (!right || *left < *right) : false;
                });
                for (const auto& key : keys) {
                    Value parsed_key = key;
                    descend("key", parsed_key, path + "/" + pointer_token(key));
                    Value nested = value->at(key);
                    descend("value", nested, path + "/" + pointer_token(key));
                    if (!parsed_key || !parsed_key->is_string()) {
                        issue(errors, path + "/" + pointer_token(key), "schema.key",
                              "Record key must normalize to a string.");
                    } else if (nested) {
                        // Like Zod, the last input key to normalize to a name wins.
                        normalized.insert_or_assign(parsed_key->as<std::string>(),
                                                    std::move(*nested));
                    }
                }
                if (errors.size() == before)
                    value = std::move(normalized);
            }
        }
        if (errors.size() != before)
            return;
        std::size_t index = 0;
        for (const auto& step : current.at("steps").array_range()) {
            if (step.contains("operation"))
                operation(step.at("operation"), value, path, errors);
            else if (value)
                structural(id + ":" + std::to_string(index), *value, path, errors);
            ++index;
        }
    }
};

// Source-only Room projection uses metadata generated from the TypeScript sparse
// YAML contract and the same generated schema graph as the native validator.
// No independent handwritten Room type hierarchy or default table lives here.
class SparseSourceProjection {
    const Contracts& contracts_;
    const Json& defaults_;
    const std::string root_id_;
    const std::string family_kind_;
    const std::string condition_id_;

    const Json& node(std::string_view id) const { return contracts_.document.at("nodes").at(id); }

    std::string unwrap(std::string id) const
    {
        for (unsigned int i = 0; i < 64; ++i) {
            const auto& current = node(id);
            const auto kind = current.at("type").as<std::string>();
            if (kind == "lazy" || kind == "optional" || kind == "nullable" || kind == "default")
                id = current.at("children").at("inner").as<std::string>();
            else if (kind == "pipe")
                id = current.at("children").at("in").as<std::string>();
            else
                return id;
        }
        throw std::runtime_error("Room projection wrapper depth exceeded.");
    }

    Value fallback(const std::vector<std::string>& path) const
    {
        for (std::size_t prefix = path.size(); prefix > 0; --prefix) {
            std::string key;
            for (std::size_t i = 0; i < prefix; ++i) {
                if (i)
                    key += '.';
                key += path[i];
            }
            if (!defaults_.contains(key))
                continue;
            const Json* current = &defaults_.at(key);
            for (std::size_t i = prefix; i < path.size(); ++i) {
                if (!current->is_object() || !current->contains(path[i])) {
                    current = nullptr;
                    break;
                }
                current = &current->at(path[i]);
            }
            if (current)
                return *current;
        }
        return std::nullopt;
    }

    std::optional<std::string> reference_collection(const Json& definition) const
    {
        if (definition.at("type") != "object" || !definition.at("children").contains("$ref"))
            return std::nullopt;
        const auto& ref = node(unwrap(definition.at("children").at("$ref").as<std::string>()));
        if (ref.at("type") != "object" || !ref.at("children").contains("collection"))
            return std::nullopt;
        const auto& collection =
            node(unwrap(ref.at("children").at("collection").as<std::string>()));
        if (collection.at("type") == "literal" && collection.at("values").size() == 1 &&
            collection.at("values").at(0).is_string())
            return collection.at("values").at(0).as<std::string>();
        return std::nullopt;
    }

    std::optional<std::string> union_choice(const Json& definition, const Json& value) const
    {
        const auto branches = tagged_union_branches(contracts_, definition, value);
        return branches.ids.size() == 1 ? std::optional<std::string>{branches.ids.front()}
                                        : std::nullopt;
    }

    void project(Value& value, const std::string& id, std::vector<std::string>& path,
                 unsigned int depth) const
    {
        if (depth > 128)
            throw std::runtime_error("Sparse source projection depth exceeded.");
        if (!value)
            value = fallback(path);
        if (!value)
            return;
        if (id == condition_id_ && value->is_string() && *value == "always") {
            value = Json::parse(R"({"kind":"always"})");
            return;
        }
        const auto& current = node(id);
        const auto kind = current.at("type").as<std::string>();
        const auto& children = current.at("children");
        if (kind == "lazy" || kind == "optional" || kind == "nullable" || kind == "default") {
            if (!value->is_null())
                project(value, children.at("inner").as<std::string>(), path, depth + 1);
            return;
        }
        if (kind == "pipe") {
            project(value, children.at("in").as<std::string>(), path, depth + 1);
            return;
        }
        if (const auto collection = reference_collection(current);
            collection && value->is_string()) {
            Json reference = Json::object();
            reference["collection"] = *collection;
            reference["id"] = *value;
            Json expanded = Json::object();
            expanded["$ref"] = std::move(reference);
            value = std::move(expanded);
            return;
        }
        if (kind == "union") {
            if (const auto branch = union_choice(current, *value))
                project(value, *branch, path, depth + 1);
            return;
        }
        if (kind == "object" && value->is_object()) {
            if (path.size() == 1 && path[0] == "data")
                value->insert_or_assign("kind", family_kind_);
            for (const auto& child : children.object_range()) {
                if (child.key() == "$catchall")
                    continue;
                Value member;
                if (value->contains(child.key()))
                    member = value->at(child.key());
                path.emplace_back(child.key());
                project(member, child.value().as<std::string>(), path, depth + 1);
                path.pop_back();
                if (member)
                    value->insert_or_assign(child.key(), *member);
            }
        } else if (kind == "array" && value->is_array()) {
            path.emplace_back("*");
            for (auto& entry : value->array_range()) {
                Value member = entry;
                project(member, children.at("element").as<std::string>(), path, depth + 1);
                if (member)
                    entry = *member;
            }
            path.pop_back();
        } else if (kind == "record" && value->is_object()) {
            path.emplace_back("*");
            for (auto& entry : value->object_range()) {
                Value member = entry.value();
                project(member, children.at("value").as<std::string>(), path, depth + 1);
                if (member)
                    entry.value() = *member;
            }
            path.pop_back();
        }
    }

public:
    SparseSourceProjection(const Contracts& contracts, std::string_view family,
                           std::string_view contract, std::string_view kind)
        : contracts_(contracts), defaults_(contracts.document.at("sourceDefaults").at(family)),
          root_id_(contracts.document.at("roots").at(contract).as<std::string>()),
          family_kind_(kind),
          condition_id_(contracts.document.at("roots").at("Condition").as<std::string>())
    {
    }

    Json project(Json source) const
    {
        Value value = std::move(source);
        std::vector<std::string> path;
        project(value, root_id_, path, 0);
        return std::move(*value);
    }
};
} // namespace

ValidationResult validate_record(std::string_view contract, std::string_view source_json)
{
    ValidationResult result;
    try {
        static const Contracts contracts;
        if (!contracts.document.at("roots").contains(contract)) {
            result.diagnostics.push_back({"", "contract.unknown", "Unknown generated contract."});
            return result;
        }
        Validator validator(contracts);
        const auto id = contracts.document.at("roots").at(contract).as<std::string>();
        std::set<std::string> visited;
        validator.check_support(id, visited, result.diagnostics);
        if (!result.diagnostics.empty())
            return result;
        Value value = Json::parse(source_json);
        validator.parse(id, value, "", result.diagnostics);
        if (contract == "WorkspaceTrackedEditor" && value && value->is_object() &&
            value->contains("recordMetadata") && value->at("recordMetadata").is_object()) {
            for (const auto& collection : value->at("recordMetadata").object_range()) {
                const auto prefix = "/recordMetadata/" + pointer_token(collection.key());
                if (collection.key() == "__proto__")
                    result.diagnostics.push_back(
                        {prefix, "schema.record_key", "Prototype record metadata key is invalid."});
                if (collection.value().is_object())
                    for (const auto& record : collection.value().object_range())
                        if (record.key() == "__proto__")
                            result.diagnostics.push_back(
                                {prefix + "/__proto__", "schema.record_key",
                                 "Prototype record metadata key is invalid."});
            }
        }
        result.accepted = result.diagnostics.empty();
        if (result.accepted && value)
            result.effective_json = value->to_string();
    } catch (const std::exception& error) {
        result.diagnostics.push_back({"", "contract.failure", error.what()});
    }
    return result;
}

ValidationResult validate_room_source(std::string_view source_json)
{
    try {
        static const Contracts contracts;
        Json source = Json::parse(source_json);
        if (source.is_object() && source.contains("data") && source.at("data").is_object() &&
            source.at("data").contains("kind")) {
            ValidationResult invalid;
            invalid.diagnostics.push_back({"/data/kind", "source.redundant_kind",
                                           "Room YAML must omit the inferred data.kind field."});
            return invalid;
        }
        return validate_record("RoomsRecord",
                               SparseSourceProjection(contracts, "rooms", "RoomsRecord", "room")
                                   .project(source)
                                   .to_string());
    } catch (const std::exception& error) {
        ValidationResult invalid;
        invalid.diagnostics.push_back({"", "source.projection", error.what()});
        return invalid;
    }
}

ValidationResult validate_map_source(std::string_view source_json)
{
    try {
        static const Contracts contracts;
        Json source = Json::parse(source_json);
        if (source.is_object() && source.contains("data") && source.at("data").is_object() &&
            source.at("data").contains("kind")) {
            ValidationResult invalid;
            invalid.diagnostics.push_back({"/data/kind", "source.redundant_kind",
                                           "Map YAML must omit the inferred data.kind field."});
            return invalid;
        }
        return validate_record("MapsRecord",
                               SparseSourceProjection(contracts, "maps", "MapsRecord", "map")
                                   .project(source)
                                   .to_string());
    } catch (const std::exception& error) {
        ValidationResult invalid;
        invalid.diagnostics.push_back({"", "source.projection", error.what()});
        return invalid;
    }
}

namespace {
ValidationResult validate_sparse_record_source(std::string_view source_json,
                                               std::string_view family, std::string_view contract,
                                               std::string_view kind)
{
    try {
        static const Contracts contracts;
        Json source = Json::parse(source_json);
        if (source.is_object() && source.contains("data") && source.at("data").is_object() &&
            source.at("data").contains("kind")) {
            ValidationResult invalid;
            invalid.diagnostics.push_back({"/data/kind", "source.redundant_kind",
                                           "Record YAML must omit the inferred data.kind field."});
            return invalid;
        }
        return validate_record(contract, SparseSourceProjection(contracts, family, contract, kind)
                                             .project(std::move(source))
                                             .to_string());
    } catch (const std::exception& error) {
        ValidationResult invalid;
        invalid.diagnostics.push_back({"", "source.projection", error.what()});
        return invalid;
    }
}
} // namespace

ValidationResult validate_character_source(std::string_view source_json)
{
    return validate_sparse_record_source(source_json, "characters", "CharactersRecord",
                                         "character");
}

ValidationResult validate_archetype_source(std::string_view source_json)
{
    return validate_sparse_record_source(source_json, "archetypes", "ArchetypesRecord",
                                         "archetype");
}

ValidationResult validate_animation_source(std::string_view source_json)
{
    return validate_sparse_record_source(source_json, "animations", "AnimationsRecord",
                                         "animation");
}

ValidationResult validate_asset_source(std::string_view source_json)
{
    // Unlike Animations, Asset kind is explicit physical metadata, not an inferred record kind.
    return validate_record("AssetsRecord", source_json);
}

ValidationResult validate_material_source(std::string_view source_json)
{
    return validate_sparse_record_source(source_json, "materials", "MaterialsRecord", "material");
}

std::optional<std::string> archetype_template_json(std::string_view instance_kind)
{
    static const Contracts contracts;
    const auto& templates = contracts.document.at("archetypeTemplates");
    if (!templates.contains(instance_kind))
        return std::nullopt;
    return templates.at(instance_kind).to_string();
}

std::optional<MaterialPresetContract> material_preset_contract(std::string_view preset_id)
{
    static const Contracts contracts;
    const auto& presets = contracts.document.at("materialPresets");
    if (!presets.contains(preset_id))
        return std::nullopt;
    const auto& value = presets.at(preset_id);
    const auto sampler = [&](std::string_view name) {
        return value.at(name).is_string() ? value.at(name).as<std::string>() : "";
    };
    return MaterialPresetContract{value.at("role").as<std::string>(), sampler("hotspotImage"),
                                  sampler("hotspotMask")};
}

std::string validation_result_json(const ValidationResult& result)
{
    Json output;
    output["accepted"] = result.accepted;
    output["diagnostics"] = Json::array();
    for (const auto& error : result.diagnostics) {
        Json entry;
        entry["path"] = error.path;
        entry["code"] = error.code;
        entry["message"] = error.message;
        output["diagnostics"].push_back(std::move(entry));
    }
    if (result.accepted && !result.effective_json.empty())
        output["value"] = Json::parse(result.effective_json);
    return output.to_string();
}
} // namespace noveltea::authoring
