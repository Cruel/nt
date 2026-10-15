#include "contracts.hpp"
#include "embedded_contracts.hpp"
#include "generated/operations.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonschema/jsonschema.hpp>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
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

const std::set<std::string> implemented_operations{"value.default", "string.trim",
                                                   "string.utf16-length", "lua.dependencies.unique",
                                                   "lua.dependencies.empty"};

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
                if (!seen.insert(target.to_string()).second)
                    issue(errors, path + "/targets/" + std::to_string(index), "semantic." + id,
                          "Duplicate explicit Lua dependency target.");
                ++index;
            }
        } else {
            throw std::runtime_error("Native operation is not implemented: " + id);
        }
    }

    const Json& unwrap(const Json& current) const
    {
        const auto type = current.at("type").as<std::string>();
        if (type == "lazy" || type == "optional" || type == "default")
            return unwrap(node(current.at("children").at("inner").as<std::string>()));
        return current;
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
            if (current.contains("discriminator") && value && value->is_object()) {
                const auto key = current.at("discriminator").as<std::string>();
                bool selected = false;
                if (value->contains(key)) {
                    for (const auto& child : children.object_range()) {
                        const auto& branch = unwrap(node(child.value().as<std::string>()));
                        const auto& tag =
                            unwrap(node(branch.at("children").at(key).as<std::string>()));
                        for (const auto& choice : tag.at("values").array_range()) {
                            if (choice == value->at(key)) {
                                parse(child.value().as<std::string>(), value, path, errors,
                                      depth + 1);
                                selected = true;
                                break;
                            }
                        }
                        if (selected)
                            break;
                    }
                }
                if (!selected)
                    issue(errors, path + "/" + pointer_token(key), "schema.discriminator",
                          "Unknown or missing union discriminator.");
            } else {
                std::vector<Diagnostic> best;
                bool accepted = false;
                for (const auto& child : children.object_range()) {
                    auto candidate = value;
                    std::vector<Diagnostic> branch_errors;
                    parse(child.value().as<std::string>(), candidate, path, branch_errors,
                          depth + 1);
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
            if (errors.size() != before)
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
        result.accepted = result.diagnostics.empty();
        if (result.accepted && value)
            result.effective_json = value->to_string();
    } catch (const std::exception& error) {
        result.diagnostics.push_back({"", "contract.failure", error.what()});
    }
    return result;
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
