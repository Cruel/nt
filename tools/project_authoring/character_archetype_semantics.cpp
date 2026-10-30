#include "character_archetype_semantics.hpp"

#include <jsoncons/json.hpp>
#include <jsoncons_ext/jsonpointer/jsonpointer.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

const Json* member(const Json* value, std::string_view key)
{
    return value && value->is_object() && value->contains(key) ? &value->at(key) : nullptr;
}

const Json* element(const Json* value, std::size_t index)
{
    return value && value->is_array() && index < value->size() ? &value->at(index) : nullptr;
}

std::string string_of(const Json* value)
{
    return value && value->is_string() ? value->as<std::string>() : std::string{};
}

std::string text(const Json* value, std::string_view key) { return string_of(member(value, key)); }

std::string ref_id(const Json* value)
{
    return value && value->is_string() ? string_of(value) : text(member(value, "$ref"), "id");
}

std::string escape(std::string_view input)
{
    std::string output;
    for (const char c : input) {
        if (c == '~')
            output += "~0";
        else if (c == '/')
            output += "~1";
        else
            output += c;
    }
    return output;
}

void add(ValidationResult& result, std::string path, std::string code, std::string message,
         std::string severity = "error")
{
    if (severity == "error")
        result.accepted = false;
    result.diagnostics.push_back(
        {std::move(path), std::move(code), std::move(message), std::move(severity)});
}

std::set<std::string> ids(const Json* values)
{
    std::set<std::string> result;
    if (values && values->is_array())
        for (const auto& item : values->array_range())
            result.insert(text(&item, "id"));
    return result;
}

void unique_ids(ValidationResult& result, const Json* values, const std::string& path,
                std::string_view label, std::string_view field = "id")
{
    std::set<std::string> seen;
    if (values && values->is_array())
        for (std::size_t i = 0; i < values->size(); ++i) {
            const auto key = text(element(values, i), field);
            if (!seen.insert(key).second)
                add(result, path + "/" + std::to_string(i) + "/" + std::string(field),
                    "character.duplicate-id",
                    "Duplicate " + std::string(label) + " ID '" + key + "'.");
        }
}

void require_member(ValidationResult& result, const Json* value, std::string_view field,
                    const std::set<std::string>& targets, const std::string& path,
                    std::string_view description, bool optional = false)
{
    const auto* candidate = member(value, field);
    if (optional && (!candidate || candidate->is_null()))
        return;
    const auto id = string_of(candidate);
    if (!targets.contains(id))
        add(result, path + "/" + std::string(field), "character.missing-local-reference",
            "Missing " + std::string(description) + " '" + id + "'.");
}

void layer_refs(ValidationResult& result, const Json* layers,
                const std::set<std::string>& layer_ids, const std::string& path,
                std::string_view name)
{
    unique_ids(result, layers, path, name, "layerId");
    if (layers && layers->is_array())
        for (std::size_t i = 0; i < layers->size(); ++i)
            require_member(result, element(layers, i), "layerId", layer_ids,
                           path + "/" + std::to_string(i), "layer");
}

void overrides(ValidationResult& result, const Json& data, std::string_view collection)
{
    const auto* entries = member(&data, collection);
    if (!entries || !entries->is_array())
        return;
    const auto* profiles = member(&data, "profiles");
    for (std::size_t i = 0; i < entries->size(); ++i) {
        const auto root =
            "/data/" + std::string(collection) + "/" + std::to_string(i) + "/profiles";
        const auto* profile_overrides = member(element(entries, i), "profiles");
        unique_ids(result, profile_overrides, root, "profile override", "profileId");
        if (!profile_overrides || !profile_overrides->is_array())
            continue;
        for (std::size_t j = 0; j < profile_overrides->size(); ++j) {
            const auto* entry = element(profile_overrides, j);
            const auto profile_id = text(entry, "profileId");
            const Json* target = nullptr;
            if (profiles && profiles->is_array())
                for (const auto& profile : profiles->array_range())
                    if (text(&profile, "id") == profile_id) {
                        target = &profile;
                        break;
                    }
            const auto path = root + "/" + std::to_string(j);
            if (!target) {
                add(result, path + "/profileId", "character.missing-local-reference",
                    "Missing profile '" + profile_id + "'.");
                continue;
            }
            layer_refs(result, member(entry, "layers"), ids(member(target, "layers")),
                       path + "/layers", "layer override");
        }
    }
}

// RFC 6901 tokens: reject malformed escapes, not merely nonempty slash-prefixed strings.
std::optional<std::vector<std::string>> pointer_segments(std::string_view path)
{
    if (path.empty() || path.front() != '/')
        return std::nullopt;
    std::vector<std::string> parts;
    for (std::size_t pos = 1; pos <= path.size();) {
        const auto slash = path.find('/', pos);
        const auto token = path.substr(pos, slash == std::string_view::npos ? slash : slash - pos);
        std::string decoded;
        for (std::size_t i = 0; i < token.size(); ++i) {
            if (token[i] == '~' && i + 1 < token.size() && token[i + 1] == '1') {
                decoded += '/';
                ++i;
            } else if (token[i] == '~' && i + 1 < token.size() && token[i + 1] == '0') {
                decoded += '~';
                ++i;
            } else {
                decoded += token[i];
            }
        }
        parts.push_back(std::move(decoded));
        if (slash == std::string_view::npos)
            break;
        pos = slash + 1;
    }
    return parts;
}

bool override_allowed(std::string_view kind, std::string_view pointer)
{
    const auto segments = pointer_segments(pointer);
    if (!segments || segments->empty())
        return false;
    const auto& root = segments->front();
    if (root != "traits" && root != "defaultProperties" && root != "data")
        return false;
    return !(kind == "character" && root == "data" && segments->size() > 1 &&
             (*segments)[1] == "initialWorldState");
}

void check_override_keys(ValidationResult& result, const Json* values, std::string_view kind,
                         const std::string& prefix, bool definition)
{
    if (!values || !values->is_object())
        return;
    for (const auto& entry : values->object_range()) {
        if (override_allowed(kind, entry.key()))
            continue;
        add(result, prefix + "/" + escape(entry.key()), "archetype.override-path",
            "Override path '" + std::string(entry.key()) + "' " +
                (definition ? "cannot be inherited by a " + std::string(kind) + " Archetype."
                            : "cannot target instance-local " + std::string(kind) + " state."));
    }
}

// Use the same replacement semantics as the TypeScript Archetype projection:
// absent object ancestors are materialized, array indexes must already exist.
bool apply_override(Json& target, std::string_view pointer, const Json& value)
{
    const auto tokens = pointer_segments(pointer);
    if (!tokens || tokens->empty())
        return false;
    Json* current = &target;
    for (std::size_t i = 0; i < tokens->size(); ++i) {
        const auto& token = (*tokens)[i];
        const bool last = i + 1 == tokens->size();
        if (current->is_object()) {
            if (last) {
                current->insert_or_assign(token, value);
                return true;
            }
            if (!current->contains(token))
                current->insert_or_assign(token, Json::object());
            current = &current->at(token);
        } else if (current->is_array()) {
            double position = 0;
            try {
                if (!token.empty()) {
                    std::size_t consumed = 0;
                    position = std::stod(token, &consumed);
                    if (consumed != token.size())
                        return false;
                }
            } catch (...) {
                return false;
            }
            if (!std::isfinite(position) || position < 0 || std::trunc(position) != position ||
                position >= static_cast<double>(current->size()))
                return false;
            const auto index = static_cast<std::size_t>(position);
            if (index >= current->size())
                return false;
            if (last) {
                current->at(index) = value;
                return true;
            }
            current = &current->at(index);
        } else {
            return false;
        }
    }
    return false;
}

std::optional<Json> fetched(const AuthoringRecordResolver& resolve, std::string_view family,
                            std::string_view id)
{
    if (id.empty())
        return std::nullopt;
    const auto result = resolve(family, id);
    if (!result)
        return std::nullopt;
    try {
        return Json::parse(*result);
    } catch (...) {
        return std::nullopt;
    }
}

void check_visual(ValidationResult& result, const Json* visual, const std::string& path,
                  const AuthoringRecordResolver& resolve)
{
    if (!visual || visual->is_null())
        return;
    if (text(visual, "kind") == "animation" && path.find("/animationClips/") != std::string::npos) {
        const auto* playback = member(visual, "playback");
        if (playback && !playback->is_null()) {
            add(result, path + "/playback", "character.visual.clip-playback",
                "Character clip Visuals use choreography timing; explicit reusable playback policy "
                "is not admitted here.");
            return;
        }
    }
    if (text(visual, "kind") == "image") {
        const auto id = ref_id(member(visual, "image"));
        const auto asset = fetched(resolve, "assets", id);
        if (!asset || text(member(&*asset, "data"), "kind") != "image")
            add(result, path + "/image/$ref", "character.visual.asset",
                "Visual must reference a valid Image Asset '" + id + "'.");
        return;
    }
    const auto id = ref_id(member(visual, "animation"));
    const auto animation = fetched(resolve, "animations", id);
    if (!animation) {
        add(result, path + "/animation/$ref", "character.visual.animation",
            "Missing or invalid Animation '" + id + "'.");
        return;
    }
    const auto* data = member(&*animation, "data");
    const auto* motions = member(data, "motions");
    const auto* motion = member(visual, "motionId");
    const auto motion_id =
        motion && !motion->is_null() ? string_of(motion) : text(data, "defaultMotionId");
    bool found = false;
    if (motions && motions->is_array())
        for (const auto& candidate : motions->array_range()) {
            if (text(&candidate, "id") != motion_id)
                continue;
            found = true;
            const auto* frames = member(&candidate, "frames");
            if (text(&candidate, "kind") == "sprite-sequence" && frames && frames->empty()) {
                add(result, path + "/motionId", "character.visual.empty-motion",
                    "An empty Animation motion cannot be used as a Visual.");
                return;
            }
            const auto marker_time = [&](std::string_view marker) -> std::optional<double> {
                if (marker == "start")
                    return 0.;
                if (marker == "end") {
                    if (text(&candidate, "kind") == "sprite-sequence") {
                        double duration = 0;
                        if (frames && frames->is_array())
                            for (const auto& frame : frames->array_range())
                                duration += member(&frame, "durationMs")->as<double>();
                        return duration;
                    }
                    const auto* range = member(&candidate, "sourceRange");
                    return range && !range->is_null()
                               ? std::optional<double>{member(range, "endMs")->as<double>() -
                                                       member(range, "startMs")->as<double>()}
                               : std::nullopt;
                }
                const auto* markers = member(&candidate, "markers");
                if (markers && markers->is_array())
                    for (const auto& entry : markers->array_range())
                        if (text(&entry, "id") == marker)
                            return member(&entry, "timeMs")->as<double>();
                return std::nullopt;
            };
            const auto* playback = member(visual, "playback");
            const auto* loop_range = member(playback, "loopRange");
            if (loop_range && !loop_range->is_null()) {
                const auto start = marker_time(text(loop_range, "start"));
                const auto end = marker_time(text(loop_range, "end"));
                const auto* range = member(&candidate, "sourceRange");
                const bool unresolved_video_end = text(&candidate, "kind") == "video" &&
                                                  (!range || range->is_null()) &&
                                                  text(loop_range, "end") == "end";
                if (!start || (!unresolved_video_end && (!end || *start >= *end))) {
                    add(result, path + "/playback/loopRange", "character.visual.loop-range",
                        "Loop markers must exist and delimit a positive forward range.");
                    return;
                }
            }
            const auto marker = text(playback, "initialMarker");
            if (!marker.empty() && marker != "start" && marker != "end" && !marker_time(marker)) {
                add(result, path + "/playback/initialMarker", "character.visual.initial-marker",
                    "Unknown Animation marker '" + marker + "'.");
                return;
            }
            break;
        }
    if (!found)
        add(result, path + "/motionId", "character.visual.motion",
            "Unknown Animation motion '" + motion_id + "'.");
}

std::optional<std::string> material_role(const Json& material,
                                         const AuthoringRecordResolver& resolve,
                                         std::set<std::string>& seen)
{
    const auto* base = member(member(&material, "data"), "base");
    if (text(base, "kind") == "preset") {
        const auto preset = material_preset_contract(text(base, "preset"));
        return preset ? std::optional<std::string>{preset->role} : std::nullopt;
    }
    const auto id = ref_id(member(base, "material"));
    if (id.empty() || !seen.insert(id).second)
        return std::nullopt;
    const auto parent = fetched(resolve, "materials", id);
    return parent ? material_role(*parent, resolve, seen) : std::nullopt;
}

void check_material(ValidationResult& result, const Json* application, const std::string& path,
                    const AuthoringRecordResolver& resolve)
{
    if (!application || application->is_null())
        return;
    const auto id = ref_id(member(application, "material"));
    const auto material = fetched(resolve, "materials", id);
    if (!material) {
        add(result, path + "/material/$ref", "character.material.missing",
            "Missing material '" + id + "'.");
        return;
    }
    std::set<std::string> visiting{id};
    const auto role = material_role(*material, resolve, visiting);
    if (!role) {
        add(result, path + "/material/$ref", "character.material.invalid",
            "Material '" + id + "' has invalid material data.", "warning");
        return;
    }
    if (*role != "engine-2d")
        add(result, path + "/material/$ref", "character.material.role",
            "Character layer Material must use the engine-2d role.");
    const auto* textures = member(application, "textures");
    if (textures && textures->is_object())
        for (const auto& texture : textures->object_range()) {
            const auto* source = member(&texture.value(), "source");
            if (!member(source, "$ref"))
                continue;
            const auto referenced_id = ref_id(source);
            const auto asset = fetched(resolve, "assets", referenced_id);
            const auto where = path + "/textures/" + escape(texture.key()) + "/source/$ref";
            if (!asset)
                add(result, where, "character.material.texture-missing",
                    "Missing texture asset '" + referenced_id + "'.");
            else if (text(member(&*asset, "data"), "kind") != "image")
                add(result, where, "character.material.texture-kind",
                    "Material texture override '" + std::string(texture.key()) +
                        "' must reference an image asset.");
        }
}

void visual_layers(ValidationResult& result, const Json* layers, const std::string& path,
                   const AuthoringRecordResolver& resolve)
{
    if (!layers || !layers->is_array())
        return;
    for (std::size_t i = 0; i < layers->size(); ++i) {
        const auto where = path + "/" + std::to_string(i);
        check_visual(result, member(element(layers, i), "visual"), where + "/visual", resolve);
        check_material(result, member(element(layers, i), "materialApplication"),
                       where + "/materialApplication", resolve);
    }
}
} // namespace

std::optional<std::string>
character_reference_resource_source(std::string_view family, std::string_view source_json,
                                    const std::vector<Diagnostic>& diagnostics)
{
    if (family != "assets" && family != "animations" && family != "materials")
        return std::nullopt;
    if (diagnostics.empty() ||
        !std::all_of(diagnostics.begin(), diagnostics.end(), [](const Diagnostic& diagnostic) {
            return diagnostic.message.starts_with(
                "Native operation is registered but not implemented:");
        }))
        return std::nullopt;
    try {
        auto record = Json::parse(source_json);
        if (!record.is_object() || !record.contains("id") || !record.at("id").is_string())
            return std::nullopt;
        auto* data = &record.at("data");
        if (!data->is_object())
            return std::nullopt;
        if (family == "animations" && !data->contains("kind"))
            data->insert_or_assign("kind", "animation");
        if (family == "materials" && !data->contains("kind"))
            data->insert_or_assign("kind", "material");
        return record.to_string();
    } catch (...) {
        return std::nullopt;
    }
}

ValidationResult validate_character_local(std::string_view normalized_record)
{
    ValidationResult result;
    result.accepted = true;
    try {
        const auto record = Json::parse(normalized_record);
        const auto* data = member(&record, "data");
        if (!data || !data->is_object())
            return result;
        const auto* profiles = member(data, "profiles");
        const auto* expressions = member(data, "expressions");
        if (!profiles || profiles->empty())
            add(result, "/data/profiles", "character.profiles.required",
                "Character requires at least one profile.");
        if (!expressions || expressions->empty())
            add(result, "/data/expressions", "character.expressions.required",
                "Character requires at least one expression.");
        for (const auto* key : {"profiles", "expressions", "appearances", "gestures", "idles"}) {
            std::string label(key);
            if (label == "profiles")
                label = "profile";
            else if (label == "expressions")
                label = "expression";
            else if (label == "appearances")
                label = "appearance";
            else if (label == "gestures")
                label = "gesture";
            else if (label == "idles")
                label = "idle";
            unique_ids(result, member(data, key), "/data/" + std::string(key), label);
        }
        const auto* defaults = member(data, "defaults");
        require_member(result, defaults, "profileId", ids(profiles), "/data/defaults",
                       "default profile");
        require_member(result, defaults, "expressionId", ids(expressions), "/data/defaults",
                       "default expression");
        require_member(result, defaults, "appearanceId", ids(member(data, "appearances")),
                       "/data/defaults", "default appearance", true);
        require_member(result, defaults, "idleId", ids(member(data, "idles")), "/data/defaults",
                       "default idle", true);
        if (profiles && profiles->is_array())
            for (std::size_t i = 0; i < profiles->size(); ++i) {
                const auto* profile = element(profiles, i);
                const auto base = "/data/profiles/" + std::to_string(i);
                const auto* layers = member(profile, "layers");
                const auto* poses = member(profile, "poses");
                const auto* clips = member(profile, "animationClips");
                if (!layers || layers->empty())
                    add(result, base + "/layers", "character.layers.required",
                        "Profile requires at least one layer.");
                if (!poses || poses->empty())
                    add(result, base + "/poses", "character.poses.required",
                        "Profile requires at least one pose.");
                unique_ids(result, layers, base + "/layers", "layer");
                unique_ids(result, poses, base + "/poses", "pose");
                unique_ids(result, clips, base + "/animationClips", "animation clip");
                const auto layer_ids = ids(layers);
                require_member(result, profile, "defaultPoseId", ids(poses), base, "default pose");
                if (poses && poses->is_array())
                    for (std::size_t j = 0; j < poses->size(); ++j)
                        layer_refs(result, member(element(poses, j), "layers"), layer_ids,
                                   base + "/poses/" + std::to_string(j) + "/layers", "pose layer");
                if (clips && clips->is_array())
                    for (std::size_t j = 0; j < clips->size(); ++j) {
                        const auto* frames = member(element(clips, j), "frames");
                        if (!frames || !frames->is_array())
                            continue;
                        for (std::size_t k = 0; k < frames->size(); ++k)
                            layer_refs(result, member(element(frames, k), "layers"), layer_ids,
                                       base + "/animationClips/" + std::to_string(j) + "/frames/" +
                                           std::to_string(k) + "/layers",
                                       "animation layer");
                    }
                const auto* automatic = member(profile, "automaticAnimations");
                std::set<std::string> roles;
                if (layers && layers->is_array())
                    for (const auto& layer : layers->array_range()) {
                        const auto* role = member(&layer, "role");
                        if (role && role->is_string())
                            roles.insert(string_of(role));
                    }
                for (const auto* name : {"blink", "speaking"}) {
                    const auto* entry = member(automatic, name);
                    if (!entry || entry->is_null())
                        continue;
                    require_member(result, entry, "clipId", ids(clips),
                                   base + "/automaticAnimations/" + name, "animation clip");
                    if (!roles.contains(text(entry, "role")))
                        add(result, base + "/automaticAnimations/" + name + "/role",
                            "character.automatic.role",
                            "No layer uses semantic role '" + text(entry, "role") + "'.");
                }
            }
        overrides(result, *data, "expressions");
        overrides(result, *data, "appearances");
        const auto* gestures = member(data, "gestures");
        if (gestures && gestures->is_array())
            for (std::size_t i = 0; i < gestures->size(); ++i) {
                const auto root = "/data/gestures/" + std::to_string(i) + "/profiles";
                const auto* profiles_in_gesture = member(element(gestures, i), "profiles");
                unique_ids(result, profiles_in_gesture, root, "gesture profile", "profileId");
                if (!profiles_in_gesture || !profiles_in_gesture->is_array())
                    continue;
                for (std::size_t j = 0; j < profiles_in_gesture->size(); ++j) {
                    const auto* entry = element(profiles_in_gesture, j);
                    const auto path = root + "/" + std::to_string(j);
                    const auto target_id = text(entry, "profileId");
                    const Json* target = nullptr;
                    if (profiles && profiles->is_array())
                        for (const auto& profile : profiles->array_range())
                            if (text(&profile, "id") == target_id) {
                                target = &profile;
                                break;
                            }
                    if (!target) {
                        add(result, path + "/profileId", "character.missing-local-reference",
                            "Missing profile '" + target_id + "'.");
                        continue;
                    }
                    const auto* clips = member(target, "animationClips");
                    require_member(result, entry, "clipId", ids(clips), path, "animation clip");
                    unique_ids(result, member(entry, "cues"), path + "/cues", "gesture cue");
                    const auto* cues = member(entry, "cues");
                    if (!cues || !cues->is_array() || !clips || !clips->is_array())
                        continue;
                    double duration = 0;
                    bool found = false;
                    for (const auto& clip : clips->array_range())
                        if (text(&clip, "id") == text(entry, "clipId")) {
                            found = true;
                            const auto* frames = member(&clip, "frames");
                            if (frames && frames->is_array())
                                for (const auto& frame : frames->array_range())
                                    duration += member(&frame, "durationMs")->as<double>();
                            break;
                        }
                    if (!found)
                        continue;
                    for (std::size_t k = 0; k < cues->size(); ++k)
                        if (member(element(cues, k), "atMs")->as<double>() > duration)
                            add(result, path + "/cues/" + std::to_string(k) + "/atMs",
                                "character.gesture.cue-time",
                                "Gesture cue occurs after animation clip '" +
                                    text(entry, "clipId") + "' ends.");
                }
            }
        const auto id = text(defaults, "profileId");
        if (profiles && profiles->is_array())
            for (const auto& profile : profiles->array_range()) {
                if (text(&profile, "id") != id)
                    continue;
                const auto* poses = member(&profile, "poses");
                if (poses && poses->is_array())
                    for (const auto& pose : poses->array_range()) {
                        if (text(&pose, "id") != text(&profile, "defaultPoseId"))
                            continue;
                        const auto* layers = member(&pose, "layers");
                        bool has_visual = false;
                        if (layers && layers->is_array())
                            for (const auto& layer : layers->array_range()) {
                                const auto* visual = member(&layer, "visual");
                                has_visual |= visual && !visual->is_null();
                            }
                        if (!has_visual)
                            add(result, "/data/preview", "character.preview.no-visual",
                                "Selected profile pose has no visual asset yet.", "warning");
                        break;
                    }
                break;
            }
    } catch (const std::exception& error) {
        add(result, "", "character.semantic.failure", error.what());
    }
    return result;
}

ValidationResult validate_archetype_local(std::string_view normalized_record)
{
    ValidationResult result;
    result.accepted = true;
    try {
        const auto record = Json::parse(normalized_record);
        const auto* data = member(&record, "data");
        check_override_keys(result, member(data, "overrides"), text(data, "instanceKind"),
                            "/data/overrides", true);
    } catch (const std::exception& error) {
        add(result, "", "archetype.semantic.failure", error.what());
    }
    return result;
}

ValidationResult validate_character_dependencies(std::string_view normalized_record,
                                                 const AuthoringRecordResolver& resolve)
{
    ValidationResult result;
    result.accepted = true;
    try {
        const auto record = Json::parse(normalized_record);
        const auto* data = member(&record, "data");
        const auto* profiles = member(data, "profiles");
        if (profiles && profiles->is_array())
            for (std::size_t i = 0; i < profiles->size(); ++i) {
                const auto* profile = element(profiles, i);
                const auto path = "/data/profiles/" + std::to_string(i);
                const auto* poses = member(profile, "poses");
                if (poses && poses->is_array())
                    for (std::size_t j = 0; j < poses->size(); ++j)
                        visual_layers(result, member(element(poses, j), "layers"),
                                      path + "/poses/" + std::to_string(j) + "/layers", resolve);
                const auto* clips = member(profile, "animationClips");
                if (clips && clips->is_array())
                    for (std::size_t j = 0; j < clips->size(); ++j) {
                        const auto* frames = member(element(clips, j), "frames");
                        if (frames && frames->is_array())
                            for (std::size_t k = 0; k < frames->size(); ++k)
                                visual_layers(result, member(element(frames, k), "layers"),
                                              path + "/animationClips/" + std::to_string(j) +
                                                  "/frames/" + std::to_string(k) + "/layers",
                                              resolve);
                    }
            }
        for (const auto* name : {"expressions", "appearances"}) {
            const auto* entries = member(data, name);
            if (!entries || !entries->is_array())
                continue;
            for (std::size_t i = 0; i < entries->size(); ++i) {
                const auto* overrides = member(element(entries, i), "profiles");
                if (!overrides || !overrides->is_array())
                    continue;
                for (std::size_t j = 0; j < overrides->size(); ++j)
                    visual_layers(result, member(element(overrides, j), "layers"),
                                  "/data/" + std::string(name) + "/" + std::to_string(i) +
                                      "/profiles/" + std::to_string(j) + "/layers",
                                  resolve);
            }
        }
        const auto* gestures = member(data, "gestures");
        if (gestures && gestures->is_array())
            for (std::size_t i = 0; i < gestures->size(); ++i) {
                const auto* profiles_in_gesture = member(element(gestures, i), "profiles");
                if (!profiles_in_gesture || !profiles_in_gesture->is_array())
                    continue;
                for (std::size_t j = 0; j < profiles_in_gesture->size(); ++j) {
                    const auto* cues = member(element(profiles_in_gesture, j), "cues");
                    if (!cues || !cues->is_array())
                        continue;
                    for (std::size_t k = 0; k < cues->size(); ++k) {
                        const auto* cue = element(cues, k);
                        if (text(cue, "kind") != "audio")
                            continue;
                        const auto id = ref_id(member(cue, "asset"));
                        const auto path = "/data/gestures/" + std::to_string(i) + "/profiles/" +
                                          std::to_string(j) + "/cues/" + std::to_string(k) +
                                          "/asset/$ref";
                        const auto asset = fetched(resolve, "assets", id);
                        if (!asset)
                            add(result, path, "character.audio.missing",
                                "Missing audio asset '" + id + "'.");
                        else if (text(member(&*asset, "data"), "kind") != "audio")
                            add(result, path, "character.audio.kind",
                                "Audio cue asset '" + id + "' is " +
                                    text(member(&*asset, "data"), "kind") + ", not audio.",
                                "warning");
                    }
                }
            }
        const auto* location = member(member(data, "initialWorldState"), "location");
        if (text(location, "kind") == "room") {
            const auto id = ref_id(member(location, "room"));
            if (!fetched(resolve, "rooms", id))
                add(result, "/data/initialWorldState/location/room/$ref", "character.location.room",
                    "Missing room '" + id + "'.");
        }
    } catch (const std::exception& error) {
        add(result, "", "character.dependencies.failure", error.what());
    }
    return result;
}

namespace {
std::optional<Json> normalize_configuration(std::string_view kind, const Json& configuration)
{
    if (!configuration.is_object() || !configuration.contains("data") ||
        !configuration.contains("traits") || !configuration.contains("defaultProperties"))
        return std::nullopt;
    Json record = Json::object();
    record["id"] = "archetype-validation";
    record["label"] = "Archetype validation";
    record["traits"] = configuration.at("traits");
    record["data"] = configuration.at("data");
    // TypeScript's parseConfiguration forcibly supplies the Character starter
    // world declaration before parsing, even for a broad /data override.
    // The generated Character record contract supplies that same schema default.
    if (kind == "character" && record.at("data").is_object() &&
        record.at("data").contains("initialWorldState"))
        record.at("data").erase("initialWorldState");
    if (kind == "interactable")
        record["defaultProperties"] = configuration.at("defaultProperties");
    const auto contract = kind == "room"        ? "RoomsRecord"
                          : kind == "character" ? "CharactersRecord"
                                                : "InteractablesRecord";
    const auto validated = validate_record(contract, record.to_string());
    if (!validated.accepted)
        return std::nullopt;
    auto result = Json::parse(validated.effective_json);
    Json normalized = Json::object();
    normalized["traits"] = result.at("traits");
    normalized["defaultProperties"] = configuration.at("defaultProperties");
    normalized["data"] = result.at("data");
    if (kind == "character" && normalized.at("data").is_object() &&
        normalized.at("data").contains("initialWorldState"))
        normalized.at("data").erase("initialWorldState");
    return normalized;
}

bool apply_overrides(Json& configuration, const Json* edits, std::string_view kind)
{
    if (!edits || !edits->is_object())
        return true;
    std::vector<std::string> keys;
    for (const auto& edit : edits->object_range())
        keys.emplace_back(edit.key());
    std::sort(keys.begin(), keys.end());
    for (const auto& key : keys)
        if (!override_allowed(kind, key) || !apply_override(configuration, key, edits->at(key)))
            return false;
    return true;
}

std::optional<Json> resolve_chain(std::string_view id, const AuthoringRecordResolver& resolve,
                                  std::set<std::string>& visiting)
{
    const auto key = std::string(id);
    if (!visiting.insert(key).second)
        return std::nullopt;
    const auto record = fetched(resolve, "archetypes", id);
    const auto* data = record ? member(&*record, "data") : nullptr;
    const auto kind = text(data, "instanceKind");
    if (kind != "character" && kind != "room" && kind != "interactable")
        return std::nullopt;
    auto templ = archetype_template_json(kind);
    if (!templ)
        return std::nullopt;
    Json configuration = Json::parse(*templ);
    const auto parent = ref_id(member(data, "base"));
    if (!parent.empty()) {
        const auto base = fetched(resolve, "archetypes", parent);
        if (!base || text(member(&*base, "data"), "instanceKind") != kind)
            return std::nullopt;
        const auto inherited = resolve_chain(parent, resolve, visiting);
        if (!inherited)
            return std::nullopt;
        configuration = *inherited;
    }
    if (!apply_overrides(configuration, member(data, "overrides"), kind))
        return std::nullopt;
    const auto normalized = normalize_configuration(kind, configuration);
    visiting.erase(key);
    return normalized;
}

void validate_chain_base(ValidationResult& result, const Json* data,
                         const AuthoringRecordResolver& resolve)
{
    const auto parent_id = ref_id(member(data, "base"));
    if (parent_id.empty())
        return;
    const auto parent = fetched(resolve, "archetypes", parent_id);
    if (!parent)
        add(result, "/data/base", "archetype.base.missing",
            "Archetype '" + parent_id + "' is not declared.");
    else if (text(member(&*parent, "data"), "instanceKind") != text(data, "instanceKind"))
        add(result, "/data/base", "archetype.base.kind",
            "Archetype bases must have the same gameplay-instance kind.");
}
} // namespace

ValidationResult validate_archetype_dependencies(std::string_view archetype_id,
                                                 std::string_view normalized_record,
                                                 const AuthoringRecordResolver& resolve)
{
    ValidationResult result;
    result.accepted = true;
    try {
        const auto record = Json::parse(normalized_record);
        const auto* data = member(&record, "data");
        validate_chain_base(result, data, resolve);
        std::set<std::string> visiting;
        const auto configuration = resolve_chain(archetype_id, resolve, visiting);
        if (!configuration)
            add(result, "/data", "archetype.chain.unresolved",
                "Archetype chain is cyclic or does not resolve to a valid same-kind "
                "configuration.");
        else if (text(data, "instanceKind") == "character") {
            Json synthetic = Json::object();
            synthetic["data"] = configuration->at("data");
            // Local references in inherited character layers are reported against
            // their effective configuration, not the source override keys.
            const auto semantic = validate_character_dependencies(synthetic.to_string(), resolve);
            result.accepted &= semantic.accepted;
            for (auto diagnostic : semantic.diagnostics) {
                diagnostic.path = "/data/effectiveConfiguration" + diagnostic.path;
                result.diagnostics.push_back(std::move(diagnostic));
            }
        }
        if (configuration)
            result.effective_json = configuration->to_string();
    } catch (const std::exception& error) {
        add(result, "", "archetype.dependencies.failure", error.what());
    }
    return result;
}

ValidationResult validate_archetype_owner(std::string_view family,
                                          std::string_view normalized_record,
                                          const AuthoringRecordResolver& resolve)
{
    ValidationResult result;
    result.accepted = true;
    try {
        const auto record = Json::parse(normalized_record);
        const auto kind = family == "rooms"           ? "room"
                          : family == "characters"    ? "character"
                          : family == "interactables" ? "interactable"
                                                      : "";
        if (!*kind)
            return result;
        const auto id = ref_id(member(&record, "archetype"));
        if (id.empty())
            return result;
        check_override_keys(result, member(&record, "archetypeOverrides"), kind,
                            "/archetypeOverrides", false);
        const auto base_record = fetched(resolve, "archetypes", id);
        if (!base_record) {
            add(result, "/archetype", "archetype.owner.missing",
                "Archetype '" + id + "' is not declared.");
            return result;
        }
        if (text(member(&*base_record, "data"), "instanceKind") != kind) {
            add(result, "/archetype", "archetype.owner.kind",
                "Archetype '" + id + "' is not a " + kind + " Archetype.");
            return result;
        }
        std::set<std::string> visiting;
        auto effective = resolve_chain(id, resolve, visiting);
        if (effective && apply_overrides(*effective, member(&record, "archetypeOverrides"), kind))
            effective = normalize_configuration(kind, *effective);
        else
            effective = std::nullopt;
        if (!effective) {
            add(result, "/archetype", "archetype.owner.unresolved",
                "Gameplay Instance Archetype configuration cannot be resolved.");
            return result;
        }
        Json combined = record;
        combined["data"] = effective->at("data");
        if (family == "characters")
            combined.at("data").insert_or_assign("initialWorldState",
                                                 record.at("data").at("initialWorldState"));
        Json traits = effective->at("traits");
        const auto* local_traits = member(&record, "traits");
        if (local_traits && local_traits->is_array())
            for (const auto& trait : local_traits->array_range()) {
                bool present = false;
                for (const auto& inherited : traits.array_range())
                    present |= inherited == trait;
                if (!present)
                    traits.push_back(trait);
            }
        combined.insert_or_assign("traits", traits);
        {
            Json merged = Json::array();
            std::map<std::string, std::size_t> property_positions;
            const auto append = [&](const Json* properties) {
                if (properties && properties->is_array())
                    for (const auto& property : properties->array_range()) {
                        const auto id = text(&property, "id");
                        if (property_positions.contains(id))
                            merged.at(property_positions.at(id)) = property;
                        else {
                            property_positions.emplace(id, merged.size());
                            merged.push_back(property);
                        }
                    }
            };
            append(member(&*effective, "defaultProperties"));
            append(member(&record, "defaultProperties"));
            combined.insert_or_assign("defaultProperties", merged);
        }
        result.effective_json = combined.to_string();
        if (family == "characters") {
            const auto local = validate_character_local(result.effective_json);
            if (!local.accepted)
                add(result, "/archetype", "archetype.owner.character-invalid",
                    "Gameplay Instance Archetype configuration cannot be resolved.");
        }
    } catch (const std::exception& error) {
        add(result, "", "archetype.owner.failure", error.what());
    }
    return result;
}

} // namespace noveltea::authoring
