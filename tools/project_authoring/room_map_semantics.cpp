#include "contracts.hpp"
#include "room_map_semantics_internal.hpp"

#include <jsoncons/json.hpp>

#include <array>
#include <cmath>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json* field(const Json* object, std::string_view name)
{
    if (!object || !object->is_object() || !object->contains(name))
        return nullptr;
    return &object->at(name);
}

const Json* item(const Json* array, std::size_t index)
{
    return array && array->is_array() && index < array->size() ? &array->at(index) : nullptr;
}

std::string string(const Json* value)
{
    return value && value->is_string() ? value->as<std::string>() : "";
}

std::string attribute(const Json* object, std::string_view name)
{
    return string(field(object, name));
}

std::string reference(const Json* object) { return attribute(field(object, "$ref"), "id"); }

std::string path_token(std::string_view token)
{
    std::string result;
    for (const auto c : token) {
        if (c == '~')
            result += "~0";
        else if (c == '/')
            result += "~1";
        else
            result += c;
    }
    return result;
}

class SemanticValidation {
public:
    explicit SemanticValidation(const Json& project, bool normalized = false)
        : project_(project), normalized_(normalized)
    {
    }

    ValidationResult run()
    {
        for (const auto& collection : {"rooms", "maps"}) {
            const auto* records = field(&project_, collection);
            if (!records || !records->is_object())
                continue;
            for (const auto& record : records->object_range()) {
                const auto owner = std::string(record.key());
                const auto base = "/" + std::string(collection) + "/" + path_token(owner);
                const auto& value = record.value();
                if (normalized_) {
                    // The session already certified the structural contract.
                    // The untrusted standalone validator still checks it below.
                    if (value.is_object() && value.contains("data") &&
                        value.at("data").is_object()) {
                        if (std::string_view(collection) == "rooms")
                            room(owner, value.at("data"), base + "/data");
                        else
                            map(owner, value.at("data"), base + "/data");
                    }
                    continue;
                }
                const auto structural = validate_record(
                    std::string(collection) == "rooms" ? "RoomsRecord" : "MapsRecord",
                    value.to_string());
                if (!structural.accepted) {
                    for (const auto& error : structural.diagnostics)
                        report(base + error.path, error.code, error.message);
                    continue;
                }
                const auto data = Json::parse(structural.effective_json).at("data");
                if (std::string(collection) == "rooms")
                    room(owner, data, base + "/data");
                else
                    map(owner, data, base + "/data");
            }
        }
        const auto* interactables = field(&project_, "interactables");
        if (interactables && interactables->is_object())
            for (const auto& entry : interactables->object_range()) {
                const auto base = "/interactables/" + path_token(entry.key());
                const auto* value = field(&entry.value(), "data");
                if (value)
                    interactable_hotspots(*value, base + "/data/presentation",
                                          std::string(entry.key()));
            }
        ValidationResult result;
        result.diagnostics = std::move(diagnostics_);
        result.accepted = true;
        for (const auto& error : result.diagnostics)
            if (error.severity == "error")
                result.accepted = false;
        if (result.accepted)
            result.effective_json = project_.to_string();
        return result;
    }

private:
    const Json& project_;
    bool normalized_ = false;
    std::vector<Diagnostic> diagnostics_;

    const Json* record(std::string_view collection, std::string_view id) const
    {
        return field(field(&project_, collection), id);
    }

    const Json* data(std::string_view collection, std::string_view id) const
    {
        return field(record(collection, id), "data");
    }

    bool exists(std::string_view collection, std::string_view id) const
    {
        return record(collection, id) != nullptr;
    }

    void report(std::string path, std::string code, std::string message,
                std::string severity = "error")
    {
        diagnostics_.push_back(
            {std::move(path), std::move(code), std::move(message), std::move(severity)});
    }

    void missing_ref(const Json* ref, std::string_view collection, const std::string& path,
                     std::string_view label)
    {
        if (ref && !ref->is_null() && !exists(collection, reference(ref)))
            report(path + "/$ref", "reference.missing",
                   "Missing " + std::string(label) + " '" + reference(ref) + "'.");
    }

    void unique(const Json* values, const std::string& base, std::string_view label)
    {
        if (!values || !values->is_array())
            return;
        std::set<std::string> seen;
        for (std::size_t i = 0; i < values->size(); ++i) {
            const auto id = attribute(item(values, i), "id");
            if (!seen.insert(id).second)
                report(base + "/" + std::to_string(i) + "/id", "id.duplicate",
                       "Duplicate " + std::string(label) + " ID '" + id + "'.");
        }
    }

    void source_image(const std::string& id, const std::string& path, bool alpha = false)
    {
        if (id.empty()) {
            report(path, "hotspot.authoring.source-image-required",
                   "Clickable hotspots require an image source.");
            return;
        }
        const auto* asset = data("assets", id);
        if (!asset || attribute(asset, "kind") != "image") {
            report(path, "hotspot.authoring.source-image-invalid",
                   "Hotspot source '" + id + "' must be a valid image Asset.");
            return;
        }
        const auto* metadata = field(asset, "imageMetadata");
        if (!metadata || metadata->is_null()) {
            report(path, "hotspot.authoring.image-metadata-required",
                   "Hotspot source image requires valid image metadata.");
            return;
        }
        if (const auto* orientation = field(metadata, "orientation");
            orientation && *orientation != 1)
            report(path, "hotspot.authoring.image-orientation",
                   "Hotspot source image must use identity EXIF orientation.");
        if (alpha && field(metadata, "hasAlpha") && metadata->at("hasAlpha") == false)
            report(path, "hotspot.authoring.alpha.opaque-image", "Sprite has no alpha channel.",
                   "warning");
    }

    void subject(const Json* value, const std::string& path)
    {
        const auto kind = attribute(value, "kind");
        if (kind == "character")
            missing_ref(field(value, "character"), "characters", path + "/character", "Character");
        else if (kind == "interactable")
            missing_ref(field(value, "interactable"), "interactableInstances",
                        path + "/interactable", "Interactable Instance");
        else if (kind == "feature") {
            const auto* feature = field(value, "feature");
            const auto owner_kind = attribute(feature, "ownerKind");
            if (owner_kind == "room") {
                const auto owner = reference(field(feature, "room"));
                const auto* owner_data = data("rooms", owner);
                if (!owner_data)
                    report(path + "/feature/room/$ref",
                           "hotspot.authoring.target.feature-owner-missing",
                           "Missing Room '" + owner + "' for Feature target.");
                else if (!has_id(field(owner_data, "features"), attribute(feature, "featureId")))
                    report(path + "/feature/featureId", "hotspot.authoring.target.feature-missing",
                           "Missing Feature '" + attribute(feature, "featureId") + "'.");
            } else {
                const auto instance_id = reference(field(feature, "interactable"));
                const auto* instance = record("interactableInstances", instance_id);
                const auto* definition =
                    instance ? data("interactables", reference(field(instance, "definition")))
                             : nullptr;
                if (!definition)
                    report(path + "/feature/interactable/$ref",
                           "hotspot.authoring.target.feature-owner-missing",
                           "Missing Interactable Instance '" + instance_id +
                               "' for Feature target.");
                else if (!has_id(field(definition, "features"), attribute(feature, "featureId")))
                    report(path + "/feature/featureId", "hotspot.authoring.target.feature-missing",
                           "Missing Feature '" + attribute(feature, "featureId") + "'.");
            }
        }
    }

    static bool has_id(const Json* entries, std::string_view id)
    {
        if (entries && entries->is_array())
            for (const auto& entry : entries->array_range())
                if (attribute(&entry, "id") == id)
                    return true;
        return false;
    }

    static const Json* find_id(const Json* entries, std::string_view id)
    {
        if (entries && entries->is_array())
            for (const auto& entry : entries->array_range())
                if (attribute(&entry, "id") == id)
                    return &entry;
        return nullptr;
    }

    void cast_selectors(const Json* entry, const std::string& path)
    {
        const auto character_id = reference(field(entry, "character"));
        const auto* character = data("characters", character_id);
        const auto* defaults = field(character, "defaults");
        const auto selected_profile = attribute(entry, "profileId");
        const auto effective_profile =
            selected_profile.empty() ? attribute(defaults, "profileId") : selected_profile;
        const auto* profile = find_id(field(character, "profiles"), effective_profile);
        const auto selected_pose = attribute(entry, "poseId");
        const auto effective_pose =
            selected_pose.empty() ? attribute(profile, "defaultPoseId") : selected_pose;
        if (!selected_profile.empty() && !profile)
            report(path + "/profileId", "room.cast.profile-missing",
                   "Missing profile '" + selected_profile + "'.");
        if (!selected_pose.empty() && !find_id(field(profile, "poses"), effective_pose))
            report(path + "/poseId", "room.cast.pose-missing",
                   "Missing pose '" + selected_pose + "'.");
        for (const auto& [selector, collection] :
             std::array<std::pair<std::string_view, std::string_view>, 3>{
                 {{"expressionId", "expressions"},
                  {"appearanceId", "appearances"},
                  {"idleId", "idles"}}}) {
            const auto selected = attribute(entry, selector);
            if (!selected.empty() && !find_id(field(character, collection), selected))
                report(path + "/" + std::string(selector), "room.cast.selector-missing",
                       "Missing " + std::string(selector.substr(0, selector.size() - 2)) + " '" +
                           selected + "'.");
        }
    }

    static bool variable_value_compatible(const Json& variable, const Json& value)
    {
        if (value.is_null())
            return field(&variable, "nullable") && variable.at("nullable") == true;
        const auto type = attribute(&variable, "type");
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
            return value.is_object() && value.size() == 1 && field(&value, "$message") &&
                   value.at("$message").is_string();
        if (type == "enum") {
            const auto* choices = field(&variable, "enumValues");
            if (!value.is_string() || !choices || !choices->is_array())
                return false;
            for (const auto& choice : choices->array_range()) {
                if (!choice.is_string())
                    continue;
                const auto text = trim_ecmascript(choice.as<std::string>());
                if (!text.empty() && text == value.as<std::string>())
                    return true;
            }
        }
        return false;
    }

    std::optional<MaterialPresetContract> resolve_material(std::string id) const
    {
        std::set<std::string> visited;
        while (!id.empty() && visited.insert(id).second) {
            const auto* material = data("materials", id);
            const auto* base = field(material, "base");
            const auto kind = attribute(base, "kind");
            if (kind == "preset")
                return material_preset_contract(attribute(base, "preset"));
            if (kind != "material")
                return std::nullopt;
            id = reference(field(base, "material"));
        }
        return std::nullopt;
    }

    void highlight(const Json* value, const std::string& path, std::string_view mode)
    {
        if (attribute(value, "kind") != "material")
            return;
        const auto* application = field(value, "materialApplication");
        const auto material_id = reference(field(application, "material"));
        const auto material = resolve_material(material_id);
        if (!material) {
            report(path + "/materialApplication/material/$ref",
                   "hotspot.authoring.highlight.material-missing",
                   "Missing or invalid hotspot highlight Material '" + material_id + "'.");
            return;
        }
        if (material->role != "hotspot-overlay") {
            report(path + "/materialApplication/material/$ref",
                   "hotspot.authoring.highlight.material-role",
                   "Hotspot highlight Material '" + material_id +
                       "' must use role 'hotspot-overlay'.");
            return;
        }
        const auto* textures = field(application, "textures");
        if (textures && textures->is_object())
            for (const auto& entry : textures->object_range()) {
                const auto name = std::string(entry.key());
                const auto target = path + "/materialApplication/textures/" + path_token(name);
                if (name == "s_hotspotImage" || name == "s_hotspotMask")
                    report(target, "hotspot.authoring.highlight.renderer-texture-override",
                           "Renderer-owned hotspot sampler cannot be overridden.");
                else if (const auto id = reference(field(&entry.value(), "source"));
                         attribute(data("assets", id), "kind") != "image")
                    report(target + "/source/$ref", "hotspot.authoring.highlight.texture-invalid",
                           "Hotspot Material texture must reference an image Asset.");
            }
        if (material->hotspot_image != "required" ||
            material->hotspot_mask != (mode == "visual-alpha" ? "disabled" : "required"))
            report(path + "/materialApplication/material/$ref",
                   "hotspot.authoring.highlight.sampler-interface",
                   mode == "visual-alpha" ? "Default-alpha hotspot highlights require the alpha "
                                            "hotspot Material contract."
                                          : "Custom hotspot highlights require the custom-mask "
                                            "hotspot Material contract.");
    }

    void interactable_hotspots(const Json& interactable, const std::string& base,
                               const std::string& owner_id)
    {
        const auto* presentation = field(&interactable, "presentation");
        const auto* definition = field(presentation, "hotspots");
        const auto kind = attribute(definition, "kind");
        const auto* entries = field(definition, "hotspots");
        const auto* alpha = field(definition, "hotspot");
        if (kind == "none")
            return;
        std::set<std::string> ids;
        const auto count = kind == "visual-alpha"           ? std::size_t{1}
                           : entries && entries->is_array() ? entries->size()
                                                            : 0;
        for (std::size_t i = 0; i < count; ++i) {
            const auto* hotspot = kind == "visual-alpha" ? alpha : item(entries, i);
            if (!hotspot)
                continue;
            const auto path =
                base + (kind == "visual-alpha" ? "/hotspots/hotspot"
                                               : "/hotspots/hotspots/" + std::to_string(i));
            const auto hotspot_id = attribute(hotspot, "id");
            if (!ids.insert(hotspot_id).second)
                report(path + "/id", "hotspot.authoring.id.duplicate",
                       "Duplicate hotspot ID '" + hotspot_id + "'.");
            const auto* target = field(hotspot, "target");
            const auto target_kind = attribute(target, "kind");
            if (target_kind == "none")
                report(path + "/target", "hotspot.authoring.target.none",
                       "Hotspot has no target and will not be interactive.", "info");
            else if (target_kind == "owner-feature") {
                const auto feature = attribute(target, "featureId");
                if (!has_id(field(&interactable, "features"), feature))
                    report(path + "/target/featureId", "hotspot.authoring.target.feature-missing",
                           "Interactable Feature '" + feature +
                               "' does not belong to Interactable '" + owner_id + "'.");
            } else if (target_kind == "subject")
                subject(field(target, "subject"), path + "/target/subject");
            highlight(field(hotspot, "highlight"), path + "/highlight", kind);
        }
        if (kind == "custom" && count == 0)
            return;
        const auto* visual = field(presentation, "visual");
        const auto visual_kind = attribute(visual, "kind");
        if (visual_kind == "animation") {
            const auto* animation = data("animations", reference(field(visual, "animation")));
            const auto* motions = field(animation, "motions");
            std::string motion_id = attribute(visual, "motionId");
            if (motion_id.empty())
                motion_id = attribute(animation, "defaultMotionId");
            const Json* motion = nullptr;
            if (motions && motions->is_array())
                for (const auto& entry : motions->array_range())
                    if (attribute(&entry, "id") == motion_id) {
                        motion = &entry;
                        break;
                    }
            if (!motion)
                report(base + "/visual", "hotspot.authoring.visual-invalid",
                       "Hotspots require a valid raster Animation motion.");
            else if (attribute(motion, "kind") == "sprite-sequence") {
                const auto* frames = field(motion, "frames");
                if (frames && frames->is_array())
                    for (const auto& frame : frames->array_range())
                        source_image(reference(field(&frame, "image")), base + "/visual",
                                     kind == "visual-alpha");
            }
        } else
            source_image(reference(field(visual, "image")), base + "/visual",
                         kind == "visual-alpha");
    }

    void hotspot(const Json& value, const std::string& path, const std::string& owner_id,
                 const Json& room_data)
    {
        const auto* target = field(&value, "target");
        const auto kind = attribute(target, "kind");
        if (kind == "none")
            report(path + "/target", "hotspot.authoring.target.none",
                   "Hotspot has no target and will not be interactive.", "info");
        else if (kind == "owner-feature") {
            const auto id = attribute(target, "featureId");
            if (!has_id(field(&room_data, "features"), id))
                report(path + "/target/featureId", "hotspot.authoring.target.feature-missing",
                       "Room Feature '" + id + "' does not belong to Room '" + owner_id + "'.");
        } else if (kind == "exit") {
            const auto id = attribute(target, "exitId");
            if (!has_id(field(&room_data, "exits"), id))
                report(path + "/target/exitId", "hotspot.authoring.exit.foreign",
                       "Room hotspot exit '" + id + "' does not belong to Room '" + owner_id +
                           "'.");
        } else if (kind == "subject")
            subject(field(target, "subject"), path + "/target/subject");
        highlight(field(&value, "highlight"), path + "/highlight", "custom");
    }

    void before_commands(const Json* commands, const std::string& base)
    {
        if (!commands || !commands->is_array())
            return;
        for (std::size_t i = 0; i < commands->size(); ++i) {
            const auto* command = item(commands, i);
            const auto path = base + "/" + std::to_string(i);
            const auto kind = attribute(command, "kind");
            if (kind == "if") {
                before_commands(field(command, "then"), path + "/then");
                before_commands(field(command, "else"), path + "/else");
            } else if (kind == "call-scene" || kind == "call-dialogue" || kind == "notify" ||
                       kind == "run-lua")
                report(path, "room.lifecycle.non-immediate-command",
                       "Before Leave and Before Enter admit only immediate Gameplay Commands.");
        }
    }

    void condition(const Json* value, const std::string& path, bool allow_current_room = false)
    {
        if (!value || !value->is_object())
            return;
        const auto kind = attribute(value, "kind");
        if (kind == "all" || kind == "any") {
            const auto* children = field(value, "conditions");
            if (children && children->is_array())
                for (std::size_t i = 0; i < children->size(); ++i)
                    condition(item(children, i), path + "/conditions/" + std::to_string(i),
                              allow_current_room);
        } else if (kind == "not") {
            condition(field(value, "condition"), path + "/condition", allow_current_room);
        } else if (kind == "variable-comparison") {
            const auto id = reference(field(value, "variable"));
            const auto* variable = data("variables", id);
            if (!variable)
                report(path + "/variable/$ref", "authoring.condition.variable-missing",
                       "Missing variable '" + id + "'.");
            else if (const auto* comparison = field(value, "value");
                     comparison && !variable_value_compatible(*variable, *comparison))
                report(path + "/value", "authoring.condition.variable-type-mismatch",
                       "Value does not match variable '" + id + "'.");
        } else if (kind == "trait-presence") {
            missing_ref(field(value, "trait"), "traits", path + "/trait", "Trait");
            identity_condition(field(value, "owner"), path + "/owner", allow_current_room);
        } else if (kind == "property-comparison") {
            identity_condition(field(value, "owner"), path + "/owner", allow_current_room);
        } else if (kind == "location-comparison") {
            identity_condition(field(value, "subject"), path + "/subject", allow_current_room);
            const auto* location = field(value, "location");
            if (attribute(location, "kind") == "room")
                identity_condition(field(location, "room"), path + "/location/room",
                                   allow_current_room);
        }
    }

    void identity_condition(const Json* operand, const std::string& path, bool allow_current_room)
    {
        const auto kind = attribute(operand, "kind");
        if (kind == "room" || kind == "room-feature")
            missing_ref(field(operand, "room"), "rooms", path + "/room", "Room");
        else if (kind == "character")
            missing_ref(field(operand, "character"), "characters", path + "/character",
                        "Character");
        else if (kind == "interactable" || kind == "interactable-feature")
            missing_ref(field(operand, "interactable"), "interactableInstances",
                        path + "/interactable", "Interactable Instance");
        else if (kind == "current-room" && !allow_current_room)
            report(path, "authoring.condition.current-room-out-of-scope",
                   "Current Room is not available in this Condition host.");
        else if (kind == "interaction-slot")
            report(path + "/slotId", "authoring.condition.slot-out-of-scope",
                   "Interaction slot is not in scope here.");
        else if (kind == "command-result")
            report(path + "/bindingId", "authoring.condition.result-out-of-scope",
                   "Command result is not in scope here.");
    }

    void material_application(const Json* application, const std::string& path,
                              std::string_view label)
    {
        if (!application || application->is_null())
            return;
        const auto material_id = reference(field(application, "material"));
        const auto material = resolve_material(material_id);
        if (!material)
            report(path + "/material/$ref", "reference.missing",
                   "Missing material '" + material_id + "'.");
        else if (material->role != "engine-2d")
            report(path + "/material/$ref", "room.material.role",
                   std::string(label) + " Material must use the engine-2d role.");
    }

    void presentation_orders(const Json& value, const std::string& base)
    {
        std::map<std::pair<std::string, std::int64_t>, std::string> seen;
        auto register_order = [&](const Json* entry, std::string plane, const std::string& path,
                                  std::string_view property) {
            const auto* number = field(entry, property);
            if (!number || !number->is_number())
                return;
            const auto order = number->as<std::int64_t>();
            const auto key = std::make_pair(plane, order);
            if (const auto found = seen.find(key); found != seen.end())
                report(path, "room.presentation-order-duplicate",
                       "Presentation order " + std::to_string(order) + " is already used in '" +
                           plane + "' by '" + found->second + "'.");
            else
                seen.emplace(key, path);
        };
        for (const auto& name : {"cast", "props", "interactables", "environments", "overlays"}) {
            const auto* list = field(&value, name);
            if (!list || !list->is_array())
                continue;
            for (std::size_t i = 0; i < list->size(); ++i) {
                const auto* entry = item(list, i);
                const std::string plane = std::string_view(name) == "overlays" ? "world-overlay"
                                          : std::string_view(name) == "environments"
                                              ? attribute(entry, "plane")
                                              : "world-content";
                register_order(entry, plane, base + "/" + name + "/" + std::to_string(i) + "/order",
                               "order");
            }
        }
        const auto* placements = field(&value, "placements");
        if (placements && placements->is_array())
            for (std::size_t i = 0; i < placements->size(); ++i) {
                const auto* presentation = field(item(placements, i), "presentation");
                const auto* layout = field(presentation, "layout");
                if (layout && !layout->is_null())
                    register_order(presentation, "world-overlay",
                                   base + "/placements/" + std::to_string(i) +
                                       "/presentation/layoutOrder",
                                   "layoutOrder");
            }
    }

    void room(const std::string& id, const Json& value, const std::string& base)
    {
        for (const auto& entry : std::array<std::pair<const char*, const char*>, 12>{
                 {{"presentationSpace.views", "Camera View"},
                  {"anchors", "Anchor"},
                  {"overlays", "overlay"},
                  {"exits", "exit"},
                  {"placements", "placement"},
                  {"cast", "cast"},
                  {"props", "prop"},
                  {"interactables", "Interactable instance"},
                  {"environments", "environment"},
                  {"features", "Feature"},
                  {"hotspots", "hotspot"},
                  {"scriptHooks", "script hook"}}}) {
            if (std::string_view(entry.first) == "presentationSpace.views")
                unique(field(field(&value, "presentationSpace"), "views"),
                       base + "/presentationSpace/views", entry.second);
            else if (std::string_view(entry.first) != "scriptHooks")
                unique(field(&value, entry.first), base + "/" + entry.first, entry.second);
        }
        const auto* exits = field(&value, "exits");
        std::set<std::string> directions;
        if (exits)
            for (std::size_t i = 0; i < exits->size(); ++i) {
                const auto* exit = item(exits, i);
                const auto path = base + "/exits/" + std::to_string(i);
                const auto direction = attribute(exit, "direction");
                if (!directions.insert(direction).second)
                    report(path + "/direction", "room.exit.direction-duplicate",
                           "Duplicate exit direction '" + direction +
                               "'. Each Room direction may be used once.");
                missing_ref(field(exit, "target"), "rooms", path + "/target", "target room");
                condition(field(exit, "condition"), path + "/condition", true);
                const auto* transition = field(exit, "transition");
                if (transition && !transition->is_null() &&
                    attribute(transition, "kind") != "cut" && field(transition, "durationMs") &&
                    transition->at("durationMs") == 0)
                    report(path + "/transition/durationMs", "room.transition.duration",
                           "Animated transitions require a positive duration.");
            }
        const auto* space = field(&value, "presentationSpace");
        const auto* size = field(space, "size");
        const auto* bounds = field(space, "bounds");
        const double width = size->at("width").as<double>();
        const double height = size->at("height").as<double>();
        double x = 0, y = 0, w = width, h = height;
        if (bounds && !bounds->is_null()) {
            x = bounds->at("x").as<double>();
            y = bounds->at("y").as<double>();
            w = bounds->at("width").as<double>();
            h = bounds->at("height").as<double>();
            if (x < 0 || y < 0 || x + w > width || y + h > height)
                report(base + "/presentationSpace/bounds", "room.bounds.outside",
                       "Presentation bounds must stay inside World Presentation Space size.");
        }
        auto view = [&](const Json* entry, const std::string& path) {
            const auto* center = field(entry, "center");
            if (!center)
                return;
            const auto cx = center->at("x").as<double>();
            const auto cy = center->at("y").as<double>();
            if (cx < x || cy < y || cx > x + w || cy > y + h)
                report(path + "/center", "room.camera.outside",
                       "Camera View center must stay inside presentation bounds.");
        };
        view(field(space, "defaultView"), base + "/presentationSpace/defaultView");
        const auto* views = field(space, "views");
        if (views)
            for (std::size_t i = 0; i < views->size(); ++i)
                view(field(item(views, i), "view"),
                     base + "/presentationSpace/views/" + std::to_string(i) + "/view");
        const auto* placements = field(&value, "placements");
        const auto fallback = field(&value, "fallbackInteractablePlacementId");
        if (fallback && fallback->is_string() && !has_id(placements, string(fallback)))
            report(base + "/fallbackInteractablePlacementId", "room.placement.missing",
                   "Missing fallback Interactable placement '" + string(fallback) + "'.");
        for (const auto& name : {"cast", "props", "interactables"}) {
            const auto* list = field(&value, name);
            if (!list)
                continue;
            for (std::size_t i = 0; i < list->size(); ++i) {
                const auto* entry = item(list, i);
                if (!has_id(placements, attribute(entry, "placementId")))
                    report(base + "/" + name + "/" + std::to_string(i) + "/placementId",
                           "room.placement.missing",
                           "Missing placement '" + attribute(entry, "placementId") + "'.");
            }
        }
        const auto* background = field(&value, "background");
        missing_ref(field(background, "asset"), "assets", base + "/background/asset",
                    "background asset");
        material_application(field(background, "materialApplication"),
                             base + "/background/materialApplication", "Room background");
        const auto* description = field(&value, "description");
        const auto* source = field(description, "source");
        if (!source || source->is_null() ||
            (attribute(source, "kind") == "inline" &&
             attribute(source, "text").find_first_not_of(" \r\n\t") == std::string::npos))
            report(base + "/description", "room.description.empty", "Room description is empty.",
                   "warning");
        const auto* overlays = field(&value, "overlays");
        if (overlays && overlays->is_array())
            for (std::size_t i = 0; i < overlays->size(); ++i) {
                const auto* overlay = item(overlays, i);
                const auto path = base + "/overlays/" + std::to_string(i);
                missing_ref(field(overlay, "layout"), "layouts", path + "/layout", "layout");
                condition(field(overlay, "condition"), path + "/condition", true);
            }
        if (placements && placements->is_array())
            for (std::size_t i = 0; i < placements->size(); ++i)
                missing_ref(field(field(item(placements, i), "presentation"), "layout"), "layouts",
                            base + "/placements/" + std::to_string(i) + "/presentation/layout",
                            "layout");
        for (const auto& name : {"cast", "props", "interactables", "environments"}) {
            const auto* entries = field(&value, name);
            if (!entries || !entries->is_array())
                continue;
            for (std::size_t i = 0; i < entries->size(); ++i) {
                const auto* entry = item(entries, i);
                const auto path = base + "/" + name + "/" + std::to_string(i);
                condition(field(entry, "condition"), path + "/condition", true);
                if (std::string_view(name) == "cast") {
                    missing_ref(field(entry, "character"), "characters", path + "/character",
                                "character");
                    cast_selectors(entry, path);
                } else if (std::string_view(name) == "props") {
                    const auto* asset = field(entry, "asset");
                    const auto* material = field(entry, "materialApplication");
                    if ((!asset || asset->is_null()) && (!material || material->is_null()))
                        report(path, "room.prop.empty",
                               "Room prop requires an asset and/or Material.");
                    missing_ref(asset, "assets", path + "/asset", "asset");
                    material_application(material, path + "/materialApplication", "Room prop");
                } else if (std::string_view(name) == "interactables") {
                    const auto instance_id = reference(field(entry, "interactable"));
                    const auto* instance = record("interactableInstances", instance_id);
                    if (!instance)
                        report(path + "/interactable/$ref", "reference.missing",
                               "Missing Interactable Instance '" + instance_id + "'.");
                    else if (!exists("interactables", reference(field(instance, "definition"))))
                        report(path + "/interactable/$ref", "room.interactable.definition-missing",
                               "Interactable Instance '" + instance_id +
                                   "' has no valid definition.");
                } else if (std::string_view(name) == "environments") {
                    const auto* visual = field(entry, "visual");
                    if (attribute(visual, "kind") == "image") {
                        const auto id = reference(field(visual, "image"));
                        missing_ref(field(visual, "image"), "assets", path + "/visual/image",
                                    "asset");
                        if (const auto* asset = data("assets", id);
                            asset && attribute(asset, "kind") != "image")
                            report(path + "/visual/image/$ref", "room.visual.not-image",
                                   "Visual Asset '" + id + "' must be an image.");
                    } else if (attribute(visual, "kind") == "animation") {
                        const auto animation_id = reference(field(visual, "animation"));
                        missing_ref(field(visual, "animation"), "animations",
                                    path + "/visual/animation", "Animation");
                        const auto selected_motion = attribute(visual, "motionId");
                        const auto* animation = data("animations", animation_id);
                        if (animation && !selected_motion.empty() &&
                            !has_id(field(animation, "motions"), selected_motion))
                            report(path + "/visual/motionId", "room.environment.motion-missing",
                                   "Animation '" + animation_id + "' has no motion '" +
                                       selected_motion + "'.");
                    }
                    material_application(field(entry, "materialApplication"),
                                         path + "/materialApplication", "Room environment");
                }
            }
        }
        presentation_orders(value, base);
        const auto* hotspots = field(&value, "hotspots");
        if (hotspots && !hotspots->empty())
            source_image(reference(field(background, "asset")), base + "/background/asset");
        if (hotspots)
            for (std::size_t i = 0; i < hotspots->size(); ++i) {
                const auto* entry = item(hotspots, i);
                hotspot(*entry, base + "/hotspots/" + std::to_string(i), id, value);
                const auto* cursor = field(entry, "cursor");
                if (attribute(cursor, "kind") == "named") {
                    const auto* settings = field(&project_, "settings");
                    const auto* named = field(field(settings, "cursors"), "named");
                    if (!has_id(named, attribute(cursor, "id")))
                        report(base + "/hotspots/" + std::to_string(i) + "/cursor",
                               "room.hotspot.cursor-missing",
                               "Hotspot cursor references missing named cursor '" +
                                   attribute(cursor, "id") + "'.");
                }
            }
        const auto* lifecycle = field(&value, "lifecycle");
        condition(field(lifecycle, "canEnter"), base + "/lifecycle/canEnter", true);
        condition(field(lifecycle, "canLeave"), base + "/lifecycle/canLeave", true);
        before_commands(field(lifecycle, "beforeEnter"), base + "/lifecycle/beforeEnter");
        before_commands(field(lifecycle, "beforeLeave"), base + "/lifecycle/beforeLeave");
        const auto* hooks = field(&value, "scriptHooks");
        if (hooks && hooks->is_array()) {
            std::set<std::string> seen;
            for (std::size_t i = 0; i < hooks->size(); ++i) {
                const auto* hook = item(hooks, i);
                const auto path = base + "/scriptHooks/" + std::to_string(i);
                const auto kind = attribute(hook, "hook");
                if (!seen.insert(kind).second)
                    report(path + "/hook", "room.script-hook.duplicate",
                           "Duplicate Room script hook mapping '" + kind + "'.");
                missing_ref(field(field(hook, "handler"), "module"), "scripts",
                            path + "/handler/module", "Script Module");
            }
        }
    }

    void map(const std::string& id, const Json& value, const std::string& base)
    {
        (void)id;
        const auto* locations = field(&value, "locations");
        const auto* connections = field(&value, "connections");
        unique(locations, base + "/locations", "map location");
        unique(connections, base + "/connections", "map connection");
        std::set<std::string> room_locations;
        if (locations)
            for (std::size_t i = 0; i < locations->size(); ++i) {
                const auto* location = item(locations, i);
                const auto path = base + "/locations/" + std::to_string(i);
                const auto room_id = reference(field(location, "room"));
                missing_ref(field(location, "room"), "rooms", path + "/room", "room");
                if (!room_locations.insert(room_id).second)
                    report(path + "/room/$ref", "map.location.room-duplicate",
                           "Room '" + room_id + "' already has a Map Location.");
                missing_ref(field(location, "icon"), "assets", path + "/icon", "asset");
                condition(field(location, "visibility"), path + "/visibility");
            }
        const auto* presentation = field(&value, "presentation");
        missing_ref(field(presentation, "background"), "assets", base + "/presentation/background",
                    "asset");
        missing_ref(field(presentation, "layout"), "layouts", base + "/presentation/layout",
                    "layout");
        if (!connections)
            return;
        for (std::size_t i = 0; i < connections->size(); ++i) {
            const auto* connection = item(connections, i);
            const auto path = base + "/connections/" + std::to_string(i);
            missing_ref(field(connection, "icon"), "assets", path + "/icon", "asset");
            condition(field(connection, "visibility"), path + "/visibility");
            const auto* exits = field(connection, "exits");
            std::vector<std::pair<std::string, std::string>> linked;
            for (std::size_t j = 0; j < exits->size(); ++j) {
                const auto* target = item(exits, j);
                const auto room_id = attribute(target, "room");
                const auto exit_id = attribute(target, "exit");
                const auto owner = data("rooms", room_id);
                const auto subpath = path + "/exits/" + std::to_string(j);
                if (!owner) {
                    report(subpath + "/room", "map.connection.room-missing",
                           "Missing room '" + room_id + "'.");
                    continue;
                }
                const auto* room_exits = field(owner, "exits");
                const Json* found = nullptr;
                if (room_exits && room_exits->is_array())
                    for (const auto& candidate : room_exits->array_range())
                        if (attribute(&candidate, "id") == exit_id) {
                            found = &candidate;
                            break;
                        }
                if (!found) {
                    report(subpath + "/exit", "map.connection.exit-missing",
                           "Missing exit '" + exit_id + "' in room '" + room_id + "'.");
                    continue;
                }
                const auto destination = reference(field(found, "target"));
                linked.emplace_back(room_id, destination);
                if (!room_locations.contains(room_id))
                    report(path + "/exits", "map.connection.location-missing",
                           "Connection source room '" + room_id + "' has no Map Location.");
                if (!room_locations.contains(destination))
                    report(path + "/exits", "map.connection.location-missing",
                           "Connection target room '" + destination + "' has no Map Location.");
            }
            if (exits->size() == 2 && linked.size() == 2 &&
                (linked[0].first != linked[1].second || linked[1].first != linked[0].second ||
                 linked[0].first == linked[1].first))
                report(path + "/exits", "map.connection.nonreciprocal",
                       "A two-exit Map Connection must reference reciprocal exits between the same "
                       "two Rooms.");
        }
    }
};
} // namespace

ValidationResult validate_room_map_project(std::string_view effective_project_json)
{
    try {
        const auto project = Json::parse(effective_project_json);
        if (!project.is_object())
            throw std::runtime_error("Effective Project must be an object.");
        return SemanticValidation(project).run();
    } catch (const std::exception& error) {
        ValidationResult invalid;
        invalid.diagnostics.push_back({"", "project.failure", error.what()});
        return invalid;
    }
}

ValidationResult validate_normalized_room_map_project(const Json& project)
{
    try {
        if (!project.is_object())
            throw std::runtime_error("Normalized Project must be an object.");
        return SemanticValidation(project, true).run();
    } catch (const std::exception& error) {
        ValidationResult invalid;
        invalid.diagnostics.push_back({"", "project.failure", error.what()});
        return invalid;
    }
}

ValidationResult validate_room_map_local(std::string_view family, std::string_view record_json)
{
    try {
        if (family != "rooms" && family != "maps")
            throw std::runtime_error("Only Room and Map local validation is supported.");
        auto record = Json::parse(record_json);
        if (!record.is_object() || !field(&record, "id") || !record.at("id").is_string())
            throw std::runtime_error("Local record needs a canonical ID.");
        const auto prefix =
            "/" + std::string(family) + "/" + path_token(record.at("id").as<std::string>());
        Json project = Json::object();
        project[std::string(family)] = Json::object();
        project[std::string(family)][record.at("id").as<std::string>()] = record;
        const auto full = SemanticValidation(project).run();
        static const std::set<std::string> local_codes{"id.duplicate",
                                                       "room.exit.direction-duplicate",
                                                       "room.transition.duration",
                                                       "room.bounds.outside",
                                                       "room.camera.outside",
                                                       "room.placement.missing",
                                                       "room.prop.empty",
                                                       "room.presentation-order-duplicate",
                                                       "room.script-hook.duplicate",
                                                       "room.lifecycle.non-immediate-command",
                                                       "map.location.room-duplicate",
                                                       "hotspot.authoring.target.none",
                                                       "hotspot.authoring.target.feature-missing",
                                                       "hotspot.authoring.exit.foreign"};
        ValidationResult result;
        result.accepted = true;
        result.effective_json = record.to_string();
        for (auto diagnostic : full.diagnostics)
            if (local_codes.contains(diagnostic.code) && diagnostic.path.starts_with(prefix)) {
                diagnostic.path.erase(0, prefix.size());
                if (diagnostic.severity == "error")
                    result.accepted = false;
                result.diagnostics.push_back(std::move(diagnostic));
            }
        if (!result.accepted)
            result.effective_json.clear();
        return result;
    } catch (const std::exception& error) {
        ValidationResult invalid;
        invalid.diagnostics.push_back({"", "local.failure", error.what()});
        return invalid;
    }
}
} // namespace noveltea::authoring
