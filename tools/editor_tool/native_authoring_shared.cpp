#include "native_authoring_shared.hpp"
#include "native_authoring_messages.hpp"
#include "native_authoring_resources.hpp"
#include "embedded_material_registry.hpp"

#include <algorithm>
#include <functional>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& object(const Json& value, std::string_view key)
{
    static const Json empty = Json::object();
    auto it = value.is_object() ? value.find(std::string(key)) : value.end();
    return it != value.end() && it->is_object() ? *it : empty;
}

const Json& array(const Json& value, std::string_view key)
{
    static const Json empty = Json::array();
    auto it = value.is_object() ? value.find(std::string(key)) : value.end();
    return it != value.end() && it->is_array() ? *it : empty;
}

Json optional(const Json& value, std::string_view key)
{
    return value.is_object() && value.contains(std::string(key)) ? value.at(std::string(key))
                                                                 : Json(nullptr);
}

std::string string(const Json& value, std::string_view key)
{
    const auto item = optional(value, key);
    return item.is_string() ? item.get<std::string>() : std::string{};
}

std::string escape(std::string_view text)
{
    std::string result;
    for (char ch : text) {
        if (ch == '~')
            result += "~0";
        else if (ch == '/')
            result += "~1";
        else
            result += ch;
    }
    return result;
}

Json reference(const Json& ref, std::string_view kind)
{
    if (ref.is_null())
        return nullptr;
    if (!ref.is_object() || !object(ref, "$ref").contains("id"))
        throw std::runtime_error("Expected a normalized " + std::string(kind) + " reference.");
    return {{"kind", kind}, {"id", object(ref, "$ref").at("id")}};
}

Json with_ref(const Json& original, std::string_view field, std::string_view kind)
{
    Json result = original;
    result[std::string(field)] = reference(original.at(std::string(field)), kind);
    return result;
}

Json map_array(const Json& source, const std::function<Json(const Json&)>& transform)
{
    Json result = Json::array();
    for (const auto& element : source)
        result.push_back(transform(element));
    return result;
}

Json sorted_strings(const Json& values)
{
    Json output = values;
    std::sort(output.begin(), output.end());
    return output;
}

Json text(const Json& project, const NativeMessageProjection& messages, const Json& value,
          const std::string& path)
{
    return lower_authoring_text(project, messages, value, path);
}

Json label_text(const Json& project, const NativeMessageProjection& messages, const Json& label,
                const std::string& path)
{
    return text(project, messages,
                {{"markup", "plain"}, {"source", {{"kind", "inline"}, {"text", label}}}}, path);
}

Json property_value(const Json& project, const NativeMessageProjection& messages, const Json& value)
{
    return lower_authoring_message_value(project, messages, value);
}

Json material_overrides(const Json& app)
{
    Json result = Json::object();
    Json parameters = Json::array();
    for (const auto& [name, override] : object(app, "parameters").items()) {
        Json source = override.at("source");
        if (source.at("kind") == "literal") {
            if (source.at("value").is_null())
                throw std::runtime_error("Validated Material literal cannot lower a null value.");
            Json value = source.at("value");
            if (override.at("type") == "color" && value.is_array() && value.size() == 4)
                value = {
                    {"r", value.at(0)}, {"g", value.at(1)}, {"b", value.at(2)}, {"a", value.at(3)}};
            source["value"] = {{"type", override.at("type")}, {"value", value}};
        }
        parameters.push_back({{"name", name}, {"type", override.at("type")}, {"source", source}});
    }
    if (!parameters.empty())
        result["materialParameters"] = std::move(parameters);
    Json textures = Json::array();
    for (const auto& [name, override] : object(app, "textures").items())
        textures.push_back({{"name", name}, {"source", reference(override.at("source"), "asset")}});
    if (!textures.empty())
        result["materialTextures"] = std::move(textures);
    return result;
}

Json material_application(const Json& app)
{
    Json result = material_overrides(app);
    result["material"] =
        app.is_null() ? Json(nullptr) : reference(optional(app, "material"), "material");
    return result;
}

Json visual(const Json& source)
{
    if (source.is_null())
        return nullptr;
    if (string(source, "kind") == "image")
        return {{"kind", "image"}, {"image", reference(source.at("image"), "asset")}};
    if (string(source, "kind") == "animation")
        return {{"kind", "animation"},
                {"animation", reference(source.at("animation"), "animation")},
                {"motionId", optional(source, "motionId")},
                {"playback", optional(source, "playback")}};
    throw std::runtime_error("Invalid normalized visual kind.");
}

Json condition(const Json& source);

Json operand(const Json& source)
{
    if (source.is_null() || !source.is_object())
        return source;
    Json result = source;
    for (const auto& [field, kind] : {std::pair{"room", "room"},
                                      {"character", "character"},
                                      {"interactable", "interactable"},
                                      {"trait", "trait"},
                                      {"variable", "property"}})
        if (result.contains(field) && result.at(field).is_object() &&
            result.at(field).contains("$ref"))
            result[field] = reference(result.at(field), kind);
    for (auto& [key, value] : result.items()) {
        if (key != "kind" && value.is_object() && !value.contains("$ref"))
            value = operand(value);
    }
    return result;
}

Json condition(const Json& source)
{
    const auto kind = string(source, "kind");
    if (kind == "always")
        return source;
    if (kind == "lua-predicate")
        return {{"kind", "lua-predicate"}, {"source", source.at("source")}};
    if (kind == "not")
        return {{"kind", "not"}, {"condition", condition(source.at("condition"))}};
    if (kind == "all" || kind == "any") {
        return {{"kind", kind}, {"conditions", map_array(array(source, "conditions"), condition)}};
    }
    if (kind == "variable-comparison") {
        Json result{{"kind", "global-property-comparison"},
                    {"property", reference(source.at("variable"), "property")},
                    {"operator", source.at("operator")}};
        if (source.contains("value"))
            result["value"] = source.at("value");
        return result;
    }
    if (kind == "property-comparison" || kind == "trait-presence" ||
        kind == "location-comparison" || kind == "inventory-quantity-comparison") {
        Json result = operand(source);
        if (kind == "inventory-quantity-comparison") {
            auto& matcher = result["matcher"];
            if (matcher.contains("definition") && !matcher["definition"].is_null())
                matcher["definition"] =
                    reference(source.at("matcher").at("definition"), "interactable-definition");
            matcher["traits"] =
                map_array(array(source.at("matcher"), "traits"),
                          [](const Json& item) { return reference(item, "trait"); });
        }
        return result;
    }
    throw std::runtime_error("Invalid normalized Condition kind '" + kind + "'.");
}

Json selector(const Json& original)
{
    const auto kind = string(original, "kind");
    if (kind == "trait")
        return with_ref(original, "trait", "trait");
    if (kind == "interactable-definition" || kind == "interactable-feature")
        return with_ref(original, "interactableDefinition", "interactable-definition");
    if (kind == "exact") {
        Json result = original;
        result["subject"] = operand(original.at("subject"));
        return result;
    }
    return original;
}

Json owner_contract(const Json& project, const NativeMessageProjection& messages, const Json& prop,
                    bool include_default)
{
    Json result{{"id", prop.at("id")},
                {"label", prop.value("label", string(prop, "id"))},
                {"description", prop.value("description", "")},
                {"type", prop.at("type")},
                {"nullable", prop.at("nullable")},
                {"enumValues", array(prop, "enumValues")}};
    if (include_default && prop.contains("defaultValue"))
        result["defaultValue"] = property_value(project, messages, prop.at("defaultValue"));
    return result;
}

Json property_base(const Json& project, const NativeMessageProjection& messages,
                   const std::string& id, const Json& record)
{
    Json assignments = Json::array();
    for (const auto& p : array(record, "localProperties"))
        assignments.push_back({{"propertyId", p.at("id")},
                               {"value", property_value(project, messages, p.at("value"))}});
    return {{"id", id},
            {"traits", sorted_strings(array(record, "traits"))},
            {"propertyAssignments", assignments}};
}

Json inventory(const Json& value)
{
    auto owner = operand(value.at("owner"));
    return {{"owner", owner},
            {"inventoryId",
             string(owner, "kind") == "project" ? Json("player") : value.at("inventoryId")}};
}

Json location(const Json& value)
{
    const auto kind = string(value, "kind");
    if (kind == "unplaced")
        return {{"kind", kind}};
    if (kind == "room")
        return {{"kind", kind}, {"room", reference(value.at("room"), "room")}};
    if (kind == "inventory")
        return {{"kind", kind}, {"inventory", inventory(value.at("inventory"))}};
    throw std::runtime_error("Invalid normalized location.");
}

Json highlight(const Json& source)
{
    if (string(source, "kind") != "material")
        return source;
    Json result = material_application(source.at("materialApplication"));
    result["kind"] = "material";
    return result;
}

Json hotspot_target(const Json& source)
{
    if (string(source, "kind") != "subject")
        return source;
    Json result = source;
    result["subject"] = operand(source.at("subject"));
    return result;
}

Json hotspot(const Json& source, bool room)
{
    Json result = source;
    result["condition"] = condition(source.at("condition"));
    result["highlight"] = highlight(source.at("highlight"));
    result["target"] = hotspot_target(source.at("target"));
    if (room)
        result["shape"] = {{"kind", "rect"}, {"bounds", source.at("shape").at("bounds")}};
    else if (result.contains("shape"))
        result["shape"]["motionTracks"] = array(source.at("shape"), "motionTracks");
    if (!result.contains("cursor"))
        result["cursor"] = nullptr;
    return result;
}

Json interactable_hotspots(const Json& source)
{
    const auto kind = string(source, "kind");
    if (kind == "none")
        return {{"kind", "none"}};
    if (kind == "visual-alpha") {
        Json value = hotspot(source.at("hotspot"), false);
        value["cursor"] = nullptr;
        return {{"kind", kind}, {"hotspot", value}};
    }
    return {{"kind", "custom"},
            {"hotspots", map_array(array(source, "hotspots"),
                                   [](const Json& h) { return hotspot(h, false); })}};
}

Json feature(const Json& project, const NativeMessageProjection& messages, const Json& source,
             bool defaults)
{
    Json result = property_base(project, messages, string(source, "id"), source);
    result["properties"] = map_array(
        array(source, defaults ? "defaultProperties" : "localProperties"),
        [&](const Json& prop) { return owner_contract(project, messages, prop, defaults); });
    result["label"] = source.at("label");
    result["inventories"] = array(source, "inventories");
    return result;
}

Json navigation_transition(const Json& value)
{
    Json result = value;
    result["durationMs"] = string(value, "kind") == "cut" ? Json(0) : value.at("durationMs");
    result["color"] = string(value, "kind") == "fade" ? value.at("color") : Json(nullptr);
    return result;
}

Json layout_source(const Json& source)
{
    if (string(source, "sourceMode") == "asset" && !optional(source, "sourceAsset").is_null())
        return {{"kind", "asset"}, {"asset", reference(source.at("sourceAsset"), "asset")}};
    return {{"kind", "inline"}, {"text", source.at("sourceText")}};
}

Json state_shape(const Json& source)
{
    Json result{{"type", source.at("type")},
                {"nullable", source.at("nullable")},
                {"hasDefault", source.contains("defaultValue")},
                {"defaultValue", optional(source, "defaultValue")}};
    if (string(source, "type") == "array")
        result["items"] = state_shape(source.at("items"));
    else if (string(source, "type") == "object") {
        Json fields = Json::array();
        for (const auto& [id, field] : object(source, "fields").items())
            fields.push_back({{"id", id},
                              {"required", field.at("required")},
                              {"shape", state_shape(field.at("shape"))}});
        result["fields"] = std::move(fields);
    }
    return result;
}

Json layout_contract(const Json& source)
{
    Json inputs = Json::array(), signals = Json::array();
    for (const auto& [id, input] : object(source, "inputs").items())
        inputs.push_back({{"id", id},
                          {"type", input.at("type")},
                          {"nullable", input.at("nullable")},
                          {"hasDefault", input.contains("defaultValue")},
                          {"defaultValue", optional(input, "defaultValue")}});
    for (const auto& [id, signal] : object(source, "signals").items()) {
        Json fields = Json::array();
        for (const auto& [field_id, field] : object(signal, "fields").items())
            fields.push_back({{"id", field_id},
                              {"type", field.at("type")},
                              {"nullable", field.at("nullable")},
                              {"required", field.at("required")}});
        signals.push_back({{"id", id}, {"fields", fields}});
    }
    return {{"inputs", inputs},
            {"signals", signals},
            {"state", optional(source, "state").is_null() ? Json(nullptr)
                                                          : state_shape(source.at("state"))}};
}

Json layouts(const Json& project, const NativeMessageProjection& messages)
{
    Json result = Json::array();
    for (const auto& [id, record] : object(project, "layouts").items()) {
        const auto& data = record.at("data");
        const auto contract = layout_contract(object(data, "contract"));
        Json entry{{"id", id},
                   {"kind", data.at("layoutKind")},
                   {"target", data.at("target")},
                   {"scalePolicy", optional(data, "scalePolicy").is_null()
                                       ? Json{{"ui", (string(data, "target") == "scene-overlay" ||
                                                      string(data, "target") == "room-overlay" ||
                                                      string(data, "target") == "custom-overlay")
                                                         ? "ignore"
                                                         : "inherit"},
                                              {"text", "inherit"}}
                                       : data.at("scalePolicy")},
                   {"rml", layout_source(data.at("rml"))},
                   {"rcss", layout_source(data.at("rcss"))},
                   {"lua", {{"kind", "inline"}, {"text", data.at("lua").at("sourceText")}}},
                   {"script",
                    {{"enabled", data.at("script").at("enabled")},
                     {"namespace", optional(data.at("script"), "namespace")}}},
                   {"mount",
                    {{"defaultParent", optional(data.at("mount"), "defaultParent")},
                     {"scopedStyles", data.at("mount").at("scopedStyles")}}}};
        if (!contract.at("inputs").empty() || !contract.at("signals").empty() ||
            !contract.at("state").is_null())
            entry["contract"] = contract;
        const auto rml_path = "/layouts/" + escape(id) + "/data/rml/sourceText";
        if (entry["rml"].at("kind") == "inline" && messages.rewritten_rml.contains(rml_path))
            entry["rml"]["text"] = messages.rewritten_rml.at(rml_path);
        const auto lua_path = "/layouts/" + escape(id) + "/data/lua/sourceText";
        if (messages.rewritten_sources.contains(lua_path))
            entry["lua"]["text"] = messages.rewritten_sources.at(lua_path);
        Json dependencies{{"scripts", Json::array()}};
        const auto& authored = object(data, "dependencies");
        for (const auto* name : {"images", "fonts", "stylesheets", "data"})
            dependencies[name] = map_array(array(authored, name),
                                           [](const Json& ref) { return reference(ref, "asset"); });
        dependencies["materials"] = map_array(array(authored, "materials"), [](const Json& app) {
            return material_application(app);
        });
        for (const auto& path : array(authored, "scripts"))
            dependencies["scripts"].push_back("project:/" + path.get<std::string>());
        entry["dependencies"] = std::move(dependencies);
        result.push_back(std::move(entry));
    }
    return result;
}

Json settings(const Json& project, const NativeMessageProjection& messages)
{
    const auto& source = project.at("settings");
    Json result;
    for (const auto* key : {"display", "accessibility", "audio"})
        result[key] = source.at(key);
    result["cursors"] = source.at("cursors");
    for (auto& cursor : result["cursors"]["named"])
        cursor["image"] = reference(cursor.at("image"), "asset");
    const auto& inventory_settings = source.at("inventory");
    result["inventory"] = {
        {"playerInventory", nullptr},
        {"defaultLayout", reference(optional(inventory_settings, "defaultLayout"), "layout")}};
    result["interaction"] = {
        {"defaultVerbMenuLayout",
         reference(optional(source.at("interaction"), "defaultVerbMenuLayout"), "layout")}};
    result["text"] = {
        {"defaultFont", reference(optional(source.at("text"), "defaultFont"), "asset")},
        {"fontStack", map_array(array(source.at("text"), "fontStack"),
                                [](const Json& ref) { return reference(ref, "asset"); })}};
    const auto& title = source.at("titleScreen");
    result["titleScreen"] = {{"titleImage", reference(optional(title, "titleImage"), "asset")},
                             {"showProjectTitle", title.at("showProjectTitle")},
                             {"showAuthor", title.at("showAuthor")},
                             {"subtitle", label_text(project, messages, title.at("subtitle"),
                                                     "/settings/titleScreen/subtitle")},
                             {"startLabel", label_text(project, messages, title.at("startLabel"),
                                                       "/settings/titleScreen/startLabel")}};
    result["roomNavigationTransition"] =
        navigation_transition(source.at("presentation").at("roomNavigationTransition"));
    Json system = Json::array();
    const auto& system_layouts = object(source.at("ui"), "systemLayouts");
    for (const auto* role :
         {"title", "game-hud", "pause-menu", "save-menu", "load-menu", "settings-menu", "text-log",
          "modal", "debug-overlay", "command-builder", "scene-text", "scene-choice", "licenses"})
        system.push_back(
            {{"role", role}, {"layout", reference(optional(system_layouts, role), "layout")}});
    result["systemLayouts"] = std::move(system);
    return result;
}

Json traits(const Json& project, const NativeMessageProjection& messages)
{
    Json result = Json::array();
    for (const auto& [id, trait] : object(project, "traits").items())
        result.push_back(
            {{"id", id},
             {"label", trait.at("label")},
             {"description", trait.value("description", "")},
             {"ownerKinds", sorted_strings(array(trait, "ownerKinds"))},
             {"properties", map_array(array(trait, "properties"), [&](const Json& prop) {
                  return owner_contract(project, messages, prop, true);
              })}});
    return result;
}

Json properties(const Json& project, const NativeMessageProjection& messages)
{
    Json result = Json::array();
    for (const auto& [family, kind] : {std::pair{"rooms", "room"}, {"characters", "character"}})
        for (const auto& [id, record] : object(project, family).items()) {
            std::set<std::string> seen;
            const auto add = [&](const Json& prop) {
                const auto property_id = prop.at("id").get<std::string>();
                if (!seen.insert(property_id).second)
                    return;
                Json owner{{"kind", kind}, {kind, Json{{"kind", kind}, {"id", id}}}};
                Json item = owner_contract(project, messages, prop, false);
                item.erase("defaultValue");
                item["owner"] = std::move(owner);
                item["scope"] = "identity";
                result.push_back(std::move(item));
            };
            for (const auto& prop : array(record, "localProperties"))
                add(prop);
            for (const auto& trait_id : array(record, "traits")) {
                const auto& trait = object(object(project, "traits"), trait_id.get<std::string>());
                const auto& allowed = array(trait, "ownerKinds");
                if (std::find(allowed.begin(), allowed.end(), Json(kind)) == allowed.end())
                    continue;
                for (const auto& prop : array(trait, "properties"))
                    add(prop);
            }
        }
    return result;
}

Json scene(const Json& project, const NativeMessageProjection& messages, const std::string& id,
           const Json& data)
{
    Json inputs = Json::array();
    for (const auto& input : array(data, "inputs")) {
        Json item{{"id", input.at("id")},
                  {"label", input.at("label")},
                  {"type", input.at("type")},
                  {"nullable", input.at("nullable")}};
        if (input.contains("defaultValue"))
            item["defaultValue"] = input.at("defaultValue");
        inputs.push_back(std::move(item));
    }
    const auto& stage = data.at("stage");
    Json lowered_stage;
    if (stage.at("kind") == "inherited")
        lowered_stage = {{"kind", "inherited"}};
    else if (stage.at("kind") == "staged-room")
        lowered_stage = {{"kind", "staged-room"}, {"room", reference(stage.at("room"), "room")}};
    else {
        const auto& background = stage.at("background");
        Json lowered_background = material_application(optional(background, "materialApplication"));
        lowered_background["asset"] = reference(optional(background, "asset"), "asset");
        lowered_background["color"] = background.at("color");
        lowered_background["fit"] = background.at("fit");
        lowered_stage = {{"kind", "blank"},
                         {"background", lowered_background},
                         {"layout", reference(optional(stage, "layout"), "layout")}};
    }
    return {{"id", id},
            {"displayName", label_text(project, messages, data.at("displayName"),
                                       "/scenes/" + escape(id) + "/data/displayName")},
            {"inputs", inputs},
            {"outcomes", array(data, "outcomes")},
            {"stage", lowered_stage}};
}

Json dialogue(const Json& project, const NativeMessageProjection& messages, const std::string& id,
              const Json& data)
{
    return {{"id", id},
            {"displayName", label_text(project, messages, data.at("displayName"),
                                       "/dialogues/" + escape(id) + "/data/displayName")},
            {"defaultSpeaker", reference(optional(data, "defaultSpeaker"), "character")},
            {"stageSlots", Json::array()},
            {"mediaSlots", Json::array()},
            {"settings", data.at("settings")}};
}

Json verb(const Json& project, const NativeMessageProjection& messages, const std::string& id,
          const Json& data)
{
    Json slots = Json::array(), offers = Json::array();
    const auto root = "/verbs/" + escape(id) + "/data/";
    for (const auto& slot : array(data, "slots")) {
        const auto prefix = root + "slots/@" + string(slot, "id") + "/";
        slots.push_back({{"id", slot.at("id")},
                         {"label", text(project, messages, slot.at("label"), prefix + "label")},
                         {"prompt", text(project, messages, slot.at("prompt"), prefix + "prompt")},
                         {"selectors", map_array(array(slot, "selectors"), selector)}});
    }
    for (const auto& offer : array(data, "offers"))
        offers.push_back({{"id", offer.at("id")},
                          {"slotId", offer.at("slotId")},
                          {"selectors", map_array(array(offer, "selectors"), selector)},
                          {"rank", offer.at("rank")},
                          {"primary", offer.at("primary")}});
    return {{"id", id},
            {"slots", slots},
            {"bindingOrder", array(data, "bindingOrder")},
            {"actionText", text(project, messages, data.at("actionText"), root + "actionText")},
            {"completedCommandText", text(project, messages, data.at("completedCommandText"),
                                          root + "completedCommandText")},
            {"offers", offers}};
}

Json layer(const Json& source, bool optional_fields = false)
{
    Json result{{"layerId", source.at("layerId")}};
    for (const auto* field : {"offset", "scale", "anchor", "visible"})
        if (!optional_fields || source.contains(field))
            result[field] = source.at(field);
    if (!optional_fields || source.contains("visual"))
        result["visual"] = visual(optional(source, "visual"));
    if (!optional_fields || source.contains("materialApplication"))
        result.update(material_application(optional(source, "materialApplication")));
    return result;
}

Json profile(const Json& source)
{
    Json layers = Json::array(), poses = Json::array();
    for (const auto& item : array(source, "layers"))
        layers.push_back({{"id", item.at("id")}, {"role", item.at("role")}});
    for (const auto& pose : array(source, "poses"))
        poses.push_back({{"id", pose.at("id")},
                         {"layers", map_array(array(pose, "layers"),
                                              [](const Json& item) { return layer(item); })}});
    Json result{{"id", source.at("id")},
                {"layers", layers},
                {"defaultPoseId", source.at("defaultPoseId")},
                {"poses", poses}};
    if (!array(source, "animationClips").empty()) {
        result["animationClips"] = map_array(array(source, "animationClips"), [](const Json& clip) {
            Json frames = Json::array();
            for (const auto& frame : array(clip, "frames"))
                frames.push_back(
                    {{"durationMs", frame.at("durationMs")},
                     {"layers", map_array(array(frame, "layers"),
                                          [](const Json& item) { return layer(item, true); })}});
            return Json{{"id", clip.at("id")}, {"clock", clip.at("clock")}, {"frames", frames}};
        });
    }
    const auto& automatic = object(source, "automaticAnimations");
    if (!optional(automatic, "blink").is_null() || !optional(automatic, "speaking").is_null())
        result["automaticAnimations"] = {{"blink", optional(automatic, "blink")},
                                         {"speaking", optional(automatic, "speaking")}};
    return result;
}

Json appearance(const Json& source)
{
    Json profiles = Json::array();
    for (const auto& profile : array(source, "profiles")) {
        Json layers = Json::array();
        for (const auto& layer_source : array(profile, "layers")) {
            Json value{{"layerId", layer_source.at("layerId")}};
            if (layer_source.contains("visual"))
                value["visual"] = visual(layer_source.at("visual"));
            if (layer_source.contains("materialApplication"))
                value.update(material_application(layer_source.at("materialApplication")));
            if (layer_source.contains("visible"))
                value["visible"] = layer_source.at("visible");
            layers.push_back(std::move(value));
        }
        profiles.push_back({{"profileId", profile.at("profileId")}, {"layers", layers}});
    }
    return {{"id", source.at("id")}, {"profiles", profiles}};
}

Json character_data(const Json& project, const NativeMessageProjection& messages,
                    const std::string& path, const Json& data, bool archetype)
{
    Json defaults{{"profileId", data.at("defaults").at("profileId")},
                  {"expressionId", data.at("defaults").at("expressionId")},
                  {"appearanceId", data.at("defaults").at("appearanceId")}};
    const auto idle = optional(data.at("defaults"), "idleId");
    if (idle.is_string() && !idle.get<std::string>().empty())
        defaults["idleId"] = idle;
    Json result{{"displayName",
                 label_text(project, messages, data.at("displayName"), path + "/displayName")},
                {"dialogue", data.at("dialogue")},
                {"defaults", defaults},
                {"profiles", map_array(array(data, "profiles"), profile)},
                {"expressions", map_array(array(data, "expressions"), appearance)},
                {"appearances", map_array(array(data, "appearances"), appearance)},
                {"inventories", array(data, "inventories")}};
    if (!array(data, "gestures").empty()) {
        result["gestures"] = map_array(array(data, "gestures"), [](const Json& gesture) {
            Json profiles = Json::array();
            for (const auto& p : array(gesture, "profiles")) {
                Json cues = Json::array();
                for (const auto& cue : array(p, "cues")) {
                    if (cue.at("kind") == "presentation")
                        cues.push_back({{"kind", "presentation"},
                                        {"id", cue.at("id")},
                                        {"atMs", cue.at("atMs")},
                                        {"event", cue.at("event")}});
                    else
                        cues.push_back({{"kind", "audio"},
                                        {"id", cue.at("id")},
                                        {"atMs", cue.at("atMs")},
                                        {"asset", reference(cue.at("asset"), "asset")},
                                        {"gain", cue.at("gain")},
                                        {"pan", cue.at("pan")}});
                }
                profiles.push_back(
                    {{"profileId", p.at("profileId")}, {"clipId", p.at("clipId")}, {"cues", cues}});
            }
            return Json{{"id", gesture.at("id")}, {"profiles", profiles}};
        });
    }
    if (!array(data, "idles").empty()) {
        result["idles"] = map_array(array(data, "idles"), [](const Json& idle) {
            return Json{{"id", idle.at("id")},
                        {"kind", idle.at("kind")},
                        {"amplitude", idle.at("amplitude")},
                        {"periodMs", idle.at("periodMs")},
                        {"clock", idle.at("clock")}};
        });
    }
    if (!archetype) {
        auto state = data.at("initialWorldState");
        state["location"] = location(state.at("location"));
        result["initialWorldState"] = std::move(state);
    }
    return result;
}

Json room_data(const Json& project, const NativeMessageProjection& messages,
               const std::string& path, const Json& data, bool archetype)
{
    const auto& background = data.at("background");
    Json lowered_background = material_application(optional(background, "materialApplication"));
    lowered_background["asset"] = reference(optional(background, "asset"), "asset");
    lowered_background["fit"] = background.at("fit");
    lowered_background["color"] = background.at("color");
    Json result{
        {"displayName",
         label_text(project, messages, data.at("displayName"), path + "/displayName")},
        {"background", lowered_background},
        {"description", text(project, messages, data.at("description"), path + "/description")},
        {"presentationSpace", data.at("presentationSpace")},
        {"anchors", array(data, "anchors")},
        {"fallbackInteractablePlacementId", optional(data, "fallbackInteractablePlacementId")}};
    Json overlays = Json::array();
    for (const auto& entry : array(data, "overlays"))
        overlays.push_back({{"id", entry.at("id")},
                            {"layout", reference(entry.at("layout"), "layout")},
                            {"condition", condition(entry.at("condition"))},
                            {"visible", entry.at("visible")},
                            {"order", entry.at("order")}});
    result["overlays"] = overlays;
    Json placements = Json::array();
    for (const auto& placement : array(data, "placements")) {
        const auto& source = placement.at("presentation");
        placements.push_back(
            {{"id", placement.at("id")},
             {"bounds", placement.at("bounds")},
             {"presentation",
              {{"label", optional(source, "label").is_null()
                             ? Json(nullptr)
                             : text(project, messages, source.at("label"),
                                    path + "/placements/@" + string(placement, "id") +
                                        "/presentation/label")},
               {"layout", reference(optional(source, "layout"), "layout")},
               {"layoutOrder", optional(source, "layout").is_null()
                                   ? Json(nullptr)
                                   : optional(source, "layoutOrder")}}}});
    }
    result["placements"] = placements;
    result["features"] = map_array(array(data, "features"), [&](const Json& f) {
        return feature(project, messages, f, false);
    });
    result["hotspots"] =
        map_array(array(data, "hotspots"), [](const Json& h) { return hotspot(h, true); });
    Json cast = Json::array();
    for (const auto& c : array(data, "cast")) {
        Json item{{"id", c.at("id")},
                  {"character", reference(c.at("character"), "character")},
                  {"condition", condition(c.at("condition"))},
                  {"placementId", c.at("placementId")},
                  {"profileId", optional(c, "profileId")},
                  {"poseId", c.at("poseId")},
                  {"expressionId", c.at("expressionId")},
                  {"appearanceId", optional(c, "appearanceId")},
                  {"visible", c.at("visible")},
                  {"order", c.at("order")}};
        if (optional(c, "idleId").is_string() && !string(c, "idleId").empty())
            item["idleId"] = c.at("idleId");
        cast.push_back(std::move(item));
    }
    result["cast"] = cast;
    Json props = Json::array();
    for (const auto& p : array(data, "props")) {
        Json item = material_application(optional(p, "materialApplication"));
        item.update({{"id", p.at("id")},
                     {"condition", condition(p.at("condition"))},
                     {"placementId", p.at("placementId")},
                     {"asset", reference(optional(p, "asset"), "asset")},
                     {"visible", p.at("visible")},
                     {"order", p.at("order")}});
        props.push_back(std::move(item));
    }
    result["props"] = props;
    Json interactables = Json::array();
    for (const auto& instance : array(data, "interactables"))
        interactables.push_back(
            {{"id", instance.at("id")},
             {"interactable", reference(instance.at("interactable"), "interactable")},
             {"condition", condition(instance.at("condition"))},
             {"placementId", instance.at("placementId")},
             {"visible", instance.at("visible")},
             {"order", instance.at("order")}});
    result["interactables"] = interactables;
    Json environments = Json::array();
    for (const auto& e : array(data, "environments")) {
        Json item = material_application(e.at("materialApplication"));
        item.update({{"id", e.at("id")},
                     {"condition", condition(e.at("condition"))},
                     {"visual", visual(optional(e, "visual"))},
                     {"bounds", e.at("bounds")},
                     {"plane", e.at("plane")},
                     {"order", e.at("order")},
                     {"clock", e.at("clock")},
                     {"scrollPerSecond", e.at("scrollPerSecond")},
                     {"opacity", e.at("opacity")},
                     {"visible", e.at("visible")}});
        environments.push_back(std::move(item));
    }
    if (archetype || !environments.empty())
        result["environments"] = environments;
    Json script_hooks = Json::array();
    for (const auto& hook : array(data, "scriptHooks")) {
        auto exported = string(hook.at("handler"), "export");
        const auto first = exported.find_first_not_of(" \t\r\n");
        const auto last = exported.find_last_not_of(" \t\r\n");
        exported = first == std::string::npos ? "" : exported.substr(first, last - first + 1);
        script_hooks.push_back({{"hook", hook.at("hook")},
                                {"handler",
                                 {{"module", reference(hook.at("handler").at("module"), "script")},
                                  {"export", exported}}}});
    }
    result["scriptHooks"] = script_hooks;
    Json exits = Json::array();
    for (const auto& exit : array(data, "exits")) {
        Json transition = optional(exit, "transition");
        exits.push_back({{"id", exit.at("id")},
                         {"label", label_text(project, messages, exit.at("label"),
                                              path + "/exits/@" + string(exit, "id") + "/label")},
                         {"direction", exit.at("direction")},
                         {"target", reference(exit.at("target"), "room")},
                         {"condition", condition(exit.at("condition"))},
                         {"transition",
                          transition.is_null() ? Json(nullptr) : navigation_transition(transition)},
                         {"onRejected", Json::array()}});
    }
    result["exits"] = exits;
    const auto& lifecycle = data.at("lifecycle");
    result["lifecycle"] = {{"canEnter", condition(lifecycle.at("canEnter"))},
                           {"canLeave", condition(lifecycle.at("canLeave"))},
                           {"beforeEnter", Json::array()},
                           {"afterEnter", Json::array()},
                           {"beforeLeave", Json::array()},
                           {"afterLeave", Json::array()},
                           {"onEnterRejected", Json::array()},
                           {"onLeaveRejected", Json::array()}};
    return result;
}

Json interactable_data(const Json& project, const NativeMessageProjection& messages,
                       const std::string& path, const Json& data)
{
    const auto& presentation = data.at("presentation");
    Json compiled_presentation =
        material_application(optional(presentation, "materialApplication"));
    compiled_presentation["visual"] = visual(optional(presentation, "visual"));
    compiled_presentation["cursor"] = optional(presentation, "cursor");
    compiled_presentation["hotspots"] = interactable_hotspots(presentation.at("hotspots"));
    return {
        {"displayName",
         label_text(project, messages, data.at("displayName"), path + "/displayName")},
        {"stackable", data.at("stackable")},
        {"stackLimit", optional(data, "stackLimit")},
        {"features", map_array(array(data, "features"),
                               [&](const Json& f) { return feature(project, messages, f, true); })},
        {"inventories", array(data, "inventories")},
        {"presentation", compiled_presentation}};
}

Json map_data(const Json& project, const NativeMessageProjection& messages, const std::string& id,
              const Json& data)
{
    const auto base = "/maps/" + escape(id) + "/data/";
    const auto& presentation = data.at("presentation");
    Json lowered_presentation{
        {"title",
         optional(presentation, "title").is_null()
             ? Json(nullptr)
             : text(project, messages, presentation.at("title"), base + "presentation/title")},
        {"background", reference(optional(presentation, "background"), "asset")},
        {"layout", reference(optional(presentation, "layout"), "layout")},
        {"initialMode", presentation.at("initialMode")}};
    std::map<std::string, std::string> location_ids;
    Json locations = Json::array(), connections = Json::array();
    for (const auto& loc : array(data, "locations")) {
        location_ids[object(loc.at("room"), "$ref").at("id").get<std::string>()] =
            loc.at("id").get<std::string>();
        Json item{{"id", loc.at("id")},
                  {"room", reference(loc.at("room"), "room")},
                  {"regions", array(loc, "regions")},
                  {"label", optional(loc, "label").is_null()
                                ? Json(nullptr)
                                : text(project, messages, loc.at("label"),
                                       base + "locations/@" + string(loc, "id") + "/label")},
                  {"icon", reference(optional(loc, "icon"), "asset")},
                  {"style", loc.at("style")},
                  {"labelAnchor", optional(loc, "labelAnchor")},
                  {"connectionAnchor", optional(loc, "connectionAnchor")},
                  {"visibility", condition(loc.at("visibility"))},
                  {"pickOrder", loc.at("pickOrder")},
                  {"logicalOrder", loc.at("logicalOrder")}};
        locations.push_back(std::move(item));
    }
    for (const auto& connection : array(data, "connections")) {
        Json exits = Json::array();
        for (const auto& exit : array(connection, "exits"))
            exits.push_back({{"room", {{"kind", "room"}, {"id", exit.at("room")}}},
                             {"exitId", exit.at("exit")}});
        const auto& first = connection.at("exits").at(0);
        const auto source_room = first.at("room").get<std::string>();
        std::string target_room;
        const auto& room = object(object(project, "rooms"), source_room);
        for (const auto& exit : array(object(room, "data"), "exits"))
            if (exit.at("id") == first.at("exit")) {
                target_room = object(exit.at("target"), "$ref").at("id").get<std::string>();
                break;
            }
        const auto location_id = [&](const std::string& room_id) {
            auto it = location_ids.find(room_id);
            return it != location_ids.end() ? it->second : std::string{};
        };
        connections.push_back(
            {{"id", connection.at("id")},
             {"exits", exits},
             {"sourceLocationId", location_id(source_room)},
             {"targetLocationId", location_id(target_room)},
             {"label", optional(connection, "label").is_null()
                           ? Json(nullptr)
                           : text(project, messages, connection.at("label"),
                                  base + "connections/@" + string(connection, "id") + "/label")},
             {"icon", reference(optional(connection, "icon"), "asset")},
             {"style", connection.at("style")},
             {"visibility", condition(connection.at("visibility"))},
             {"logicalOrder", connection.at("logicalOrder")},
             {"path", array(connection, "path")},
             {"hitRegions", array(connection, "hitRegions")}});
    }
    return {{"id", id},
            {"presentation", lowered_presentation},
            {"locations", locations},
            {"connections", connections}};
}

Json material_interfaces(const Json& project)
{
    // Use the same generated registry shipped to the native shader compiler.
    // This is immutable build-time input, not an authored or on-disk registry.
    static const Json registry = Json::parse(authoring::material_registry_json);
    Json result = Json::array();
    for (const auto& [id, record] : object(project, "materials").items()) {
        std::set<std::string> seen;
        const Json* data = &record.at("data");
        std::vector<const Json*> chain;
        const Json* preset = nullptr;
        while (data) {
            const auto& base = data->at("base");
            const auto kind = string(base, "kind");
            chain.push_back(data);
            if (kind == "preset") {
                const auto name = string(base, "preset");
                for (const auto& candidate : registry.at("presets"))
                    if (candidate.at("id") == name) {
                        preset = &candidate;
                        break;
                    }
                break;
            }
            const auto target = object(base.at("material"), "$ref").at("id").get<std::string>();
            if (!seen.insert(target).second || !object(project, "materials").contains(target))
                break;
            data = &project.at("materials").at(target).at("data");
        }
        if (!preset)
            throw std::runtime_error("at /materials/" + id +
                                     "/data/base: Material runtime interface cannot resolve.");
        Json effective = Json::object();
        const auto& defaults = object(*preset, "defaultParameters");
        for (const auto& [name, param] : defaults.items())
            effective[name] = param;
        for (const auto& [name, binding] :
             object(preset->at("shader"), "standardUniforms").items()) {
            if (effective.contains(name))
                continue;
            for (const auto& role : registry.at("roles"))
                if (role.at("id") == preset->at("role"))
                    for (const auto& semantic : role.at("standardSemanticAvailability"))
                        if (semantic.at("semantic") == binding)
                            effective[name] = {{"type", semantic.at("logicalType")},
                                               {"binding", binding}};
        }
        for (auto it = chain.rbegin(); it != chain.rend(); ++it)
            for (const auto& [name, override] : object(**it, "parameters").items()) {
                Json merged = effective.value(name, Json::object());
                merged.update(override);
                effective[name] = std::move(merged);
            }
        Json parameters = Json::array();
        std::set<std::string> names;
        for (const auto& [name, value] : defaults.items())
            names.insert(name);
        for (const auto& [name, value] : object(preset->at("shader"), "standardUniforms").items())
            names.insert(name);
        for (const auto& name : names)
            if (effective.contains(name) && effective.at(name).contains("type")) {
                const auto& param = effective.at(name);
                parameters.push_back({{"name", name},
                                      {"type", param.at("type")},
                                      {"rendererBinding", optional(param, "binding")}});
            }
        result.push_back({{"id", id}, {"role", preset->at("role")}, {"parameters", parameters}});
    }
    return result;
}

Json archetype_default_data(const std::string& kind)
{
    if (kind == "interactable")
        return {{"kind", "interactable"},
                {"displayName", "Interactable"},
                {"stackable", false},
                {"stackLimit", nullptr},
                {"presentation",
                 {{"visual", nullptr},
                  {"materialApplication", nullptr},
                  {"cursor", nullptr},
                  {"hotspots", {{"kind", "none"}}}}},
                {"features", Json::array()},
                {"inventories", Json::array()}};
    if (kind == "character") {
        return {
            {"kind", "character"},
            {"displayName", "Character"},
            {"dialogue",
             {{"name", "Character"},
              {"nameColor", nullptr},
              {"textColor", nullptr},
              {"styleClass", ""}}},
            {"defaults",
             {{"profileId", "stage"},
              {"expressionId", "neutral"},
              {"appearanceId", nullptr},
              {"idleId", nullptr}}},
            {"profiles",
             Json::array(
                 {{{"id", "stage"},
                   {"label", "Stage"},
                   {"layers", Json::array({{{"id", "body"}, {"label", "Body"}, {"role", "body"}}})},
                   {"defaultPoseId", "default"},
                   {"animationClips", Json::array()},
                   {"automaticAnimations", {{"blink", nullptr}, {"speaking", nullptr}}},
                   {"poses",
                    Json::array({{{"id", "default"},
                                  {"label", "Default"},
                                  {"layers", Json::array({{{"layerId", "body"},
                                                           {"visual", nullptr},
                                                           {"materialApplication", nullptr},
                                                           {"offset", {{"x", 0}, {"y", 0}}},
                                                           {"scale", 1},
                                                           {"anchor", {{"x", 0.5}, {"y", 1}}},
                                                           {"visible", true}}})}}})}}})},
            {"expressions",
             Json::array({{{"id", "neutral"}, {"label", "Neutral"}, {"profiles", Json::array()}}})},
            {"appearances", Json::array()},
            {"gestures", Json::array()},
            {"idles", Json::array()},
            {"inventories", Json::array()}};
    }
    if (kind == "room")
        return {{"kind", "room"},
                {"displayName", "Room"},
                {"background",
                 {{"asset", nullptr},
                  {"materialApplication", nullptr},
                  {"fit", "cover"},
                  {"color", nullptr}}},
                {"description",
                 {{"markup", "active-text"}, {"source", {{"kind", "inline"}, {"text", ""}}}}},
                {"presentationSpace",
                 {{"size", {{"width", 1920}, {"height", 1080}}},
                  {"bounds", nullptr},
                  {"edgePolicy", "contain"},
                  {"defaultView",
                   {{"center", {{"x", 960}, {"y", 540}}}, {"zoom", 1}, {"rotationDegrees", 0}}},
                  {"views", Json::array()}}},
                {"anchors", Json::array()},
                {"overlays", Json::array()},
                {"placements", Json::array()},
                {"fallbackInteractablePlacementId", nullptr},
                {"cast", Json::array()},
                {"props", Json::array()},
                {"interactables", Json::array()},
                {"environments", Json::array()},
                {"scriptHooks", Json::array()},
                {"exits", Json::array()},
                {"features", Json::array()},
                {"hotspots", Json::array()},
                {"lifecycle",
                 {{"canEnter", {{"kind", "always"}}},
                  {"canLeave", {{"kind", "always"}}},
                  {"beforeEnter", Json::array()},
                  {"afterEnter", Json::array()},
                  {"beforeLeave", Json::array()},
                  {"afterLeave", Json::array()},
                  {"onEnterRejected", Json::array()},
                  {"onLeaveRejected", Json::array()}}}};
    throw std::runtime_error("Unknown Archetype kind '" + kind + "'.");
}

Json archetype_configuration(const Json& project, const std::string& id,
                             std::set<std::string>& active)
{
    if (!active.insert(id).second)
        throw std::runtime_error("at /archetypes/" + id + ": Archetype inheritance cycle.");
    const auto& record = object(object(project, "archetypes"), id);
    if (record.empty())
        throw std::runtime_error("at /archetypes/" + id + ": Missing Archetype.");
    const auto& data = record.at("data");
    const auto kind = string(data, "instanceKind");
    Json configuration{{"traits", Json::array()},
                       {"defaultProperties", Json::array()},
                       {"data", archetype_default_data(kind)}};
    if (!optional(data, "base").is_null()) {
        const auto parent = object(data.at("base"), "$ref").at("id").get<std::string>();
        configuration = archetype_configuration(project, parent, active);
        if (string(configuration.at("data"), "kind") != kind)
            throw std::runtime_error("Archetype parent kind differs from child kind.");
    }
    for (const auto& [pointer, value] : object(data, "overrides").items()) {
        try {
            const auto path = Json::json_pointer(pointer);
            if (pointer != "/traits" && pointer != "/defaultProperties" && pointer != "/data" &&
                !pointer.starts_with("/traits/") && !pointer.starts_with("/defaultProperties/") &&
                !pointer.starts_with("/data/"))
                throw std::runtime_error("Disallowed override root.");
            configuration[path] = value;
        } catch (const std::exception&) {
            throw std::runtime_error("at /archetypes/" + id + "/data/overrides: Invalid '" +
                                     pointer + "' override.");
        }
    }
    active.erase(id);
    return configuration;
}

Json effective_record(const Json& project, const std::string& kind, const Json& record,
                      Json* inherited_properties = nullptr)
{
    const auto& archetype = optional(record, "archetype");
    if (archetype.is_null()) {
        if (inherited_properties)
            *inherited_properties = Json::array();
        return record;
    }
    const auto id = object(archetype, "$ref").at("id").get<std::string>();
    std::set<std::string> active;
    Json configuration = archetype_configuration(project, id, active);
    const auto instance_kind = string(configuration.at("data"), "kind");
    if (instance_kind != kind)
        throw std::runtime_error("Instance Archetype kind mismatch.");
    for (const auto& [pointer, value] : object(record, "archetypeOverrides").items())
        configuration[Json::json_pointer(pointer)] = value;
    if (inherited_properties)
        *inherited_properties = configuration.at("defaultProperties");
    Json effective = record;
    effective["data"] = configuration.at("data");
    if (kind == "character")
        effective["data"]["initialWorldState"] = record.at("data").at("initialWorldState");
    Json traits = array(configuration, "traits");
    for (const auto& local : array(record, "traits"))
        if (std::find(traits.begin(), traits.end(), local) == traits.end())
            traits.push_back(local);
    effective["traits"] = std::move(traits);
    if (kind == "interactable") {
        Json defaults = configuration.at("defaultProperties");
        for (const auto& local : array(record, "defaultProperties")) {
            auto it = std::find_if(defaults.begin(), defaults.end(),
                                   [&](const Json& p) { return p.at("id") == local.at("id"); });
            if (it != defaults.end())
                *it = local;
            else
                defaults.push_back(local);
        }
        effective["defaultProperties"] = std::move(defaults);
    }
    return effective;
}

Json archetype_definition(const Json& project, const NativeMessageProjection& messages,
                          const std::string& id, const Json& record)
{
    std::set<std::string> active;
    const auto configuration = archetype_configuration(project, id, active);
    const auto kind = string(record.at("data"), "instanceKind");
    Json identity{
        {"traits", sorted_strings(array(configuration, "traits"))},
        {"propertyAssignments", Json::array()},
        {"properties", map_array(array(configuration, "defaultProperties"), [&](const Json& prop) {
             return owner_contract(project, messages, prop, true);
         })}};
    for (const auto& prop : array(configuration, "defaultProperties"))
        if (prop.contains("defaultValue"))
            identity["propertyAssignments"].push_back(
                {{"propertyId", prop.at("id")},
                 {"value", property_value(project, messages, prop.at("defaultValue"))}});
    const std::string path = "/archetypes/" + escape(id) + "/configuration";
    Json lowered;
    if (kind == "room")
        lowered = room_data(project, messages, path, configuration.at("data"), true);
    else if (kind == "character")
        lowered = character_data(project, messages, path, configuration.at("data"), true);
    else
        lowered = interactable_data(project, messages, path, configuration.at("data"));
    lowered.update(identity);
    return {{"id", id}, {"instanceKind", kind}, {"configuration", lowered}};
}

Json property_contracts(const Json& project, const NativeMessageProjection& messages,
                        const Json& inherited, const Json& local)
{
    Json result = Json::array();
    std::map<std::string, Json> inherited_by_id;
    std::set<std::string> local_ids;
    for (const auto& p : inherited)
        inherited_by_id[string(p, "id")] = p;
    for (const auto& p : local)
        local_ids.insert(string(p, "id"));
    for (const auto& p : inherited)
        if (!local_ids.contains(string(p, "id")))
            result.push_back(owner_contract(project, messages, p, true));
    for (const auto& p : local) {
        auto found = inherited_by_id.find(string(p, "id"));
        Json merged = found == inherited_by_id.end() ? p : found->second;
        merged.update(p);
        result.push_back(owner_contract(project, messages, merged, found != inherited_by_id.end()));
    }
    return result;
}

struct EffectiveProperty {
    std::string id;
    Json contract;
    Json default_value;
    bool has_default = false;
    std::string source;
};

using EffectiveProperties = std::vector<EffectiveProperty>;

EffectiveProperty* property_by_id(EffectiveProperties& properties, const std::string& id)
{
    for (auto& property : properties)
        if (property.id == id)
            return &property;
    return nullptr;
}

bool compatible_property(const Json& a, const Json& b)
{
    return optional(a, "type") == optional(b, "type") &&
           optional(a, "nullable") == optional(b, "nullable") &&
           array(a, "enumValues") == array(b, "enumValues");
}

EffectiveProperties trait_properties(const Json& project, const Json& trait_ids,
                                     const std::string& owner_kind = "interactable")
{
    EffectiveProperties result;
    for (const auto& trait_id : trait_ids) {
        const auto& trait = object(object(project, "traits"), trait_id.get<std::string>());
        const auto& kinds = array(trait, "ownerKinds");
        if (std::find(kinds.begin(), kinds.end(), Json(owner_kind)) == kinds.end())
            continue;
        for (const auto& property : array(trait, "properties")) {
            const auto id = string(property, "id");
            auto* existing = property_by_id(result, id);
            if (!existing) {
                result.push_back({id, property, optional(property, "defaultValue"),
                                  property.contains("defaultValue"), "trait"});
                continue;
            }
            if (!compatible_property(existing->contract, property))
                continue;
            if (!existing->has_default && property.contains("defaultValue")) {
                existing->has_default = true;
                existing->default_value = property.at("defaultValue");
            } else if (existing->has_default && property.contains("defaultValue") &&
                       existing->default_value != property.at("defaultValue")) {
                existing->has_default = false;
                existing->default_value = nullptr;
            }
        }
    }
    return result;
}

EffectiveProperties effective_definition_properties(const Json& project, const std::string& id)
{
    const auto& record = object(object(project, "interactables"), id);
    if (record.empty())
        return {};
    const auto effective = effective_record(project, "interactable", record);
    auto result = trait_properties(project, array(effective, "traits"));
    const auto& archetype = optional(record, "archetype");
    if (!archetype.is_null()) {
        std::set<std::string> active;
        const auto inherited = archetype_configuration(
            project, object(archetype, "$ref").at("id").get<std::string>(), active);
        for (const auto& prop : array(inherited, "defaultProperties")) {
            const auto id = string(prop, "id");
            auto* existing = property_by_id(result, id);
            if (existing && !compatible_property(existing->contract, prop))
                continue;
            EffectiveProperty replacement{id, prop, optional(prop, "defaultValue"),
                                          prop.contains("defaultValue"), "archetype"};
            if (!replacement.has_default && existing && existing->has_default) {
                replacement.has_default = true;
                replacement.default_value = existing->default_value;
            }
            if (existing)
                *existing = std::move(replacement);
            else
                result.push_back(std::move(replacement));
        }
    }
    for (const auto& prop : array(record, "defaultProperties")) {
        const auto id = string(prop, "id");
        auto* existing = property_by_id(result, id);
        EffectiveProperty replacement{id, prop, optional(prop, "defaultValue"),
                                      prop.contains("defaultValue"), "definition"};
        if (!replacement.has_default && existing && existing->has_default) {
            replacement.has_default = true;
            replacement.default_value = existing->default_value;
        }
        if (existing)
            *existing = std::move(replacement);
        else
            result.push_back(std::move(replacement));
    }
    return result;
}

EffectiveProperties effective_instance_properties(const Json& project, const Json& instance,
                                                  const EffectiveProperties& definition)
{
    const auto definition_id =
        object(instance.at("definition"), "$ref").at("id").get<std::string>();
    const auto& record = object(object(project, "interactables"), definition_id);
    Json traits = array(effective_record(project, "interactable", record), "traits");
    for (const auto& remove : array(instance.at("traits"), "remove"))
        traits.erase(std::remove(traits.begin(), traits.end(), remove), traits.end());
    for (const auto& add : array(instance.at("traits"), "add"))
        if (std::find(traits.begin(), traits.end(), add) == traits.end())
            traits.push_back(add);
    auto result = trait_properties(project, traits);
    for (const auto& p : definition) {
        if (p.source == "trait")
            continue;
        auto* existing = property_by_id(result, p.id);
        if (existing)
            *existing = p;
        else
            result.push_back(p);
    }
    for (const auto& local : array(instance, "localProperties")) {
        const auto id = string(local, "id");
        if (!property_by_id(result, id))
            result.push_back({id, local, optional(local, "value"), true, "local"});
    }
    return result;
}

Json compiled_instance(const Json& project, const NativeMessageProjection& messages,
                       const std::string& id, const Json& instance,
                       const std::map<std::string, EffectiveProperties>& definition_properties)
{
    Json result{{"id", id},
                {"definition", reference(instance.at("definition"), "interactable-definition")},
                {"location", location(instance.at("location"))},
                {"enabled", instance.at("enabled")},
                {"visible", instance.at("visible")},
                {"quantity", instance.at("quantity")},
                {"traitAdds", sorted_strings(array(instance.at("traits"), "add"))},
                {"traitRemoves", sorted_strings(array(instance.at("traits"), "remove"))}};
    Json property_overrides = Json::array(), local = Json::array();
    const auto definition_id =
        object(instance.at("definition"), "$ref").at("id").get<std::string>();
    const auto it = definition_properties.find(definition_id);
    const auto effective = effective_instance_properties(
        project, instance, it != definition_properties.end() ? it->second : EffectiveProperties{});
    std::set<std::string> defined;
    for (const auto& property : effective)
        if (property.source != "local")
            defined.insert(property.id);
    for (const auto& prop : array(instance, "localProperties")) {
        const auto property_id = string(prop, "id");
        if (defined.contains(property_id))
            property_overrides.push_back(
                {{"propertyId", prop.at("id")},
                 {"value", property_value(project, messages, prop.at("value"))}});
        else {
            Json contract = owner_contract(project, messages, prop, false);
            contract["value"] = property_value(project, messages, prop.at("value"));
            local.push_back(std::move(contract));
        }
    }
    std::sort(
        property_overrides.begin(), property_overrides.end(), [](const Json& a, const Json& b) {
            return a.at("propertyId").get<std::string>() < b.at("propertyId").get<std::string>();
        });
    result["propertyOverrides"] = property_overrides;
    result["localProperties"] = local;
    const auto& material = instance.at("materialApplication");
    if (!optional(material, "material").is_null())
        result["materialOverride"] = reference(material.at("material"), "material");
    result.update(material_overrides(material));
    Json features = Json::array();
    for (const auto& override : array(instance, "featureOverrides")) {
        Json properties = Json::array();
        for (const auto& prop : array(override, "properties"))
            properties.push_back({{"propertyId", prop.at("propertyId")},
                                  {"value", property_value(project, messages, prop.at("value"))}});
        std::sort(properties.begin(), properties.end(), [](const Json& a, const Json& b) {
            return a.at("propertyId").get<std::string>() < b.at("propertyId").get<std::string>();
        });
        features.push_back(
            {{"featureId", override.at("featureId")},
             {"traitAdds", sorted_strings(array(override.at("traits"), "add"))},
             {"traitRemoves", sorted_strings(array(override.at("traits"), "remove"))},
             {"propertyOverrides", properties}});
    }
    result["featureOverrides"] = features;
    return result;
}
} // namespace

Json lower_shared_authoring_project(const Json& admitted_project,
                                    const NativeMessageProjection& messages)
{
    const Json& project = messages.lowered_project;
    Json definitions{{"characters", Json::array()},    {"rooms", Json::array()},
                     {"interactables", Json::array()}, {"verbs", Json::array()},
                     {"interactions", Json::array()},  {"scenes", Json::array()},
                     {"dialogues", Json::array()},     {"maps", Json::array()}};
    std::map<std::string, EffectiveProperties> definition_properties;
    for (const auto& [id, record] : object(project, "characters").items()) {
        Json inherited;
        const Json effective = effective_record(project, "character", record, &inherited);
        Json item = property_base(project, messages, id, effective);
        item["properties"] =
            property_contracts(project, messages, inherited, array(record, "localProperties"));
        item.update(character_data(admitted_project, messages,
                                   "/characters/" + escape(id) + "/data", effective.at("data"),
                                   false));
        definitions["characters"].push_back(std::move(item));
    }
    for (const auto& [id, record] : object(project, "rooms").items()) {
        Json inherited;
        const Json effective = effective_record(project, "room", record, &inherited);
        Json item = property_base(project, messages, id, effective);
        item["properties"] =
            property_contracts(project, messages, inherited, array(record, "localProperties"));
        item.update(room_data(admitted_project, messages, "/rooms/" + escape(id) + "/data",
                              effective.at("data"), false));
        definitions["rooms"].push_back(std::move(item));
    }
    for (const auto& [id, record] : object(project, "interactables").items()) {
        const auto effective = effective_record(project, "interactable", record);
        Json item{{"id", id},
                  {"traits", sorted_strings(array(effective, "traits"))},
                  {"propertyAssignments", Json::array()}};
        auto effective_properties = effective_definition_properties(project, id);
        item["properties"] = Json::array();
        for (const auto& prop : effective_properties)
            if (prop.source != "trait") {
                Json compiled = owner_contract(admitted_project, messages, prop.contract, false);
                if (prop.has_default)
                    compiled["defaultValue"] =
                        property_value(admitted_project, messages, prop.default_value);
                item["properties"].push_back(std::move(compiled));
            }
        definition_properties[id] = std::move(effective_properties);
        item.update(interactable_data(admitted_project, messages,
                                      "/interactables/" + escape(id) + "/data",
                                      effective.at("data")));
        definitions["interactables"].push_back(std::move(item));
    }
    for (const auto& [id, record] : object(project, "verbs").items())
        definitions["verbs"].push_back(verb(admitted_project, messages, id, record.at("data")));
    for (const auto& [id, record] : object(project, "interactions").items())
        definitions["interactions"].push_back({{"id", id}});
    for (const auto& [id, record] : object(project, "scenes").items())
        definitions["scenes"].push_back(scene(admitted_project, messages, id, record.at("data")));
    for (const auto& [id, record] : object(project, "dialogues").items())
        definitions["dialogues"].push_back(
            dialogue(admitted_project, messages, id, record.at("data")));
    for (const auto& [id, record] : object(project, "maps").items())
        definitions["maps"].push_back(map_data(admitted_project, messages, id, record.at("data")));

    Json compiled_properties = properties(admitted_project, messages);
    Json instances = Json::array();
    for (const auto& [id, value] : object(project, "interactableInstances").items()) {
        Json lowered =
            compiled_instance(admitted_project, messages, id, value, definition_properties);
        const auto definition_id =
            object(value.at("definition"), "$ref").at("id").get<std::string>();
        for (const auto& prop : effective_instance_properties(
                 project, value, definition_properties.at(definition_id))) {
            Json identity = owner_contract(admitted_project, messages, prop.contract, false);
            identity["owner"] = {{"kind", "interactable"},
                                 {"interactable", {{"kind", "interactable"}, {"id", id}}}};
            identity["scope"] = "identity";
            compiled_properties.push_back(std::move(identity));
        }
        instances.push_back(std::move(lowered));
    }
    for (const auto& property : lower_authoring_global_properties(admitted_project, messages))
        compiled_properties.push_back(property);
    Json compiled_archetypes = Json::array();
    for (const auto& [id, record] : object(project, "archetypes").items())
        compiled_archetypes.push_back(archetype_definition(admitted_project, messages, id, record));

    bool project_inventory = false, player_operand = false;
    const std::function<void(const Json&)> scan = [&](const Json& value) {
        if (value.is_array()) {
            for (const auto& item : value)
                scan(item);
        } else if (value.is_object()) {
            if (value.value("kind", Json(nullptr)) == "player-inventory") {
                project_inventory = true;
                player_operand = true;
            }
            if (optional(value, "inventoryId") == "player" &&
                string(object(value, "owner"), "kind") == "project")
                project_inventory = true;
            for (const auto& [key, item] : value.items())
                scan(item);
        }
    };
    scan(project);
    Json compiled_settings = settings(admitted_project, messages);
    if (player_operand)
        compiled_settings["inventory"]["playerInventory"] = "player";
    return {{"project", project.at("project")},
            {"settings", compiled_settings},
            {"properties", compiled_properties},
            {"traits", traits(admitted_project, messages)},
            {"archetypes", compiled_archetypes},
            {"inventories", project_inventory
                                ? Json::array({{{"id", "player"}, {"label", "Player Inventory"}}})
                                : Json::array()},
            {"interactableInstances", instances},
            {"definitions", definitions},
            {"resources",
             {{"layouts", layouts(admitted_project, messages)},
              {"materialInterfaces", material_interfaces(project)}}}};
}
} // namespace noveltea::cli
