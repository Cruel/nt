#include "asset_animation_semantics.hpp"
#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

void add(ValidationResult& result, std::string path, std::string code, std::string message,
         std::string severity = "error")
{
    result.diagnostics.push_back(
        {std::move(path), std::move(code), std::move(message), std::move(severity)});
    if (result.diagnostics.back().severity == "error")
        result.accepted = false;
}

std::string escape(std::string_view token)
{
    std::string result;
    for (const char c : token) {
        if (c == '~')
            result += "~0";
        else if (c == '/')
            result += "~1";
        else
            result += c;
    }
    return result;
}

bool safe_asset_path(std::string_view path)
{
    if (path.empty() || path.front() == '/' || path.front() == '\\' || path.back() == '/' ||
        path.find_first_of(":\\") != std::string_view::npos)
        return false;
    std::size_t start = 0;
    while (start < path.size()) {
        const auto end = path.find('/', start);
        const auto segment = path.substr(start, end == path.npos ? end : end - start);
        if (segment.empty() || segment == "." || segment == "..")
            return false;
        if (end == path.npos)
            break;
        start = end + 1;
    }
    return true;
}

bool physical_source(const std::filesystem::path& root, std::string_view source)
{
    const auto canonical_root = std::filesystem::canonical(root);
    const auto target = std::filesystem::weakly_canonical(root / std::string(source));
    const auto relative = target.lexically_relative(canonical_root);
    if (relative.empty() || relative == "." || *relative.begin() == "..")
        return false;
    return std::filesystem::is_regular_file(target);
}

std::string ref_id(const Json& ref) { return ref.at("$ref").at("id").as<std::string>(); }

std::string asset_kind(const AuthoringRecordResolver& resolve, std::string_view id)
{
    const auto record = resolve("assets", id);
    if (!record)
        return {};
    const auto asset = Json::parse(*record);
    return asset.at("data").at("kind").as<std::string>();
}

double duration_ms(const Json& motion)
{
    if (motion.at("kind") == "video") {
        if (!motion.contains("sourceRange"))
            return -1;
        const auto& range = motion.at("sourceRange");
        return range.at("endMs").as<double>() - range.at("startMs").as<double>();
    }
    double duration = 0;
    for (const auto& frame : motion.at("frames").array_range())
        duration += frame.at("durationMs").as<double>();
    return duration;
}
} // namespace

ValidationResult validate_asset_local(std::string_view normalized_record,
                                      const std::filesystem::path& project_root)
{
    ValidationResult result{true, {}, {}};
    const auto record = Json::parse(normalized_record);
    const auto& data = record.at("data");
    const auto source = data.at("source").at("path").as<std::string>();
    if (!safe_asset_path(source))
        add(result, "/data/source/path", "asset.source.path",
            "Asset source path must be a safe project-relative path.");
    else if (!physical_source(project_root, source))
        add(result, "/data/source/path", "asset.source.missing",
            "Asset source file is missing or escapes the Project root.");
    if (data.contains("attachments")) {
        for (std::size_t i = 0; i < data.at("attachments").size(); ++i) {
            const auto& attachment = data.at("attachments").at(i);
            const auto path = attachment.at("path").as<std::string>();
            if (!physical_source(project_root, path))
                add(result, "/data/attachments/" + std::to_string(i) + "/path",
                    "asset.attachment.missing",
                    "Attachment file is missing or outside the Project.");
        }
    }
    std::set<std::string> seen;
    if (data.contains("aliases")) {
        std::size_t i = 0;
        for (const auto& alias : data.at("aliases").array_range()) {
            const auto text = alias.as<std::string>();
            const auto path = "/data/aliases/" + std::to_string(i++);
            bool valid = !text.empty() && text.front() >= 'a' && text.front() <= 'z';
            bool separator = false;
            for (std::size_t j = 1; j < text.size(); ++j) {
                const char c = text[j];
                const bool letter = c >= 'a' && c <= 'z';
                const bool digit = c >= '0' && c <= '9';
                if (!letter && !digit && c != '.' && c != '_' && c != '-')
                    valid = false;
                if (c == '.' || c == '_' || c == '-') {
                    if (separator || j + 1 == text.size())
                        valid = false;
                    separator = true;
                } else
                    separator = false;
            }
            if (!valid)
                add(result, path, "asset.alias.invalid", "Invalid Asset alias.");
            if (!seen.insert(text).second)
                add(result, path, "asset.alias.duplicate", "Duplicate Asset alias.");
        }
    }
    return result;
}

ValidationResult validate_animation_local(std::string_view normalized_record)
{
    ValidationResult result{true, {}, {}};
    const auto record = Json::parse(normalized_record);
    const auto& data = record.at("data");
    const auto& motions = data.at("motions");
    bool empty_draft = true;
    for (const auto& motion : motions.array_range())
        empty_draft &= motion.at("kind") == "sprite-sequence" && motion.at("frames").empty();
    if (empty_draft)
        add(result, "/data/motions", "animation.empty",
            "Add image frames before using this Animation.", "warning");
    std::set<std::string> ids;
    for (std::size_t i = 0; i < motions.size(); ++i) {
        const auto& motion = motions.at(i);
        const auto path = "/data/motions/" + std::to_string(i);
        if (!ids.insert(motion.at("id").as<std::string>()).second)
            add(result, path + "/id", "animation.motion.duplicate-id",
                "Duplicate Animation motion ID.");
        if (!empty_draft && motion.at("kind") == "sprite-sequence" && motion.at("frames").empty())
            add(result, path + "/frames", "animation.motion.empty",
                "Animation motions require at least one frame.");
        std::set<std::string> markers{"start", "end"};
        const double duration = duration_ms(motion);
        for (std::size_t j = 0; j < motion.at("markers").size(); ++j) {
            const auto& marker = motion.at("markers").at(j);
            if (!markers.insert(marker.at("id").as<std::string>()).second ||
                (duration >= 0 && marker.at("timeMs").as<double>() > duration))
                add(result, path + "/markers/" + std::to_string(j), "animation.marker.invalid",
                    "Animation marker must be unique, non-reserved, and within the motion.");
        }
    }
    if (!ids.contains(data.at("defaultMotionId").as<std::string>()))
        add(result, "/data/defaultMotionId", "animation.default-motion.missing",
            "Default Animation motion does not exist.");
    return result;
}

ValidationResult validate_animation_dependencies(std::string_view normalized_record,
                                                 const AuthoringRecordResolver& resolve)
{
    ValidationResult result{true, {}, {}};
    const auto record = Json::parse(normalized_record);
    const auto& motions = record.at("data").at("motions");
    for (std::size_t i = 0; i < motions.size(); ++i) {
        const auto& motion = motions.at(i);
        const auto path = "/data/motions/" + std::to_string(i);
        const auto check = [&](const Json& reference, std::string expected, std::string path,
                               std::string category) {
            const auto id = ref_id(reference);
            const auto kind = asset_kind(resolve, id);
            if (kind.empty())
                add(result, path + "/$ref", "animation." + category + ".asset-missing",
                    "Missing Animation Asset '" + id + "'.");
            else if (kind != expected)
                add(result, path + "/$ref", "animation." + category + ".asset-kind",
                    "Animation Asset '" + id + "' must be " + expected + ".");
        };
        if (motion.at("kind") == "sprite-sequence") {
            for (std::size_t j = 0; j < motion.at("frames").size(); ++j)
                check(motion.at("frames").at(j).at("image"), "image",
                      path + "/frames/" + std::to_string(j) + "/image", "frame");
        } else
            check(motion.at("video"), "video", path + "/video", "video");
    }
    return result;
}

ValidationResult validate_project_asset_aliases(const std::filesystem::path& project_root,
                                                const AuthoringRecordResolver& resolve)
{
    ValidationResult result{true, {}, {}};
    std::map<std::string, std::string> owners;
    const auto directory = project_root / "records/assets";
    if (!std::filesystem::is_directory(directory))
        return result;
    // Only read tracked Asset YAML owners; aliases never depend on media bytes.
    std::set<std::string> ids;
    for (const auto& file : std::filesystem::directory_iterator(directory))
        if (file.is_regular_file() && file.path().extension() == ".yaml")
            ids.insert(file.path().stem().string());
    for (const auto& id : ids) {
        const auto source = resolve("assets", id);
        if (!source)
            continue;
        const auto record = Json::parse(*source);
        const auto& data = record.at("data");
        if (!data.contains("aliases"))
            continue;
        for (std::size_t index = 0; index < data.at("aliases").size(); ++index) {
            const auto alias = data.at("aliases").at(index).as<std::string>();
            const auto [found, inserted] = owners.emplace(alias, id);
            if (!inserted && found->second != id)
                add(result, "/assets/" + escape(id) + "/data/aliases/" + std::to_string(index),
                    "asset.alias.conflict",
                    "Asset alias '" + alias + "' is already assigned to '" + found->second + "'.");
        }
    }
    return result;
}

ValidationResult validate_asset_localizations(const std::filesystem::path& project_root,
                                              const AuthoringRecordResolver& resolve,
                                              std::string_view working_localization_json)
{
    ValidationResult result{true, {}, {}};
    std::map<std::string, Json> effective;
    if (!working_localization_json.empty()) {
        const auto localization = Json::parse(working_localization_json);
        for (const auto& entry : localization.at("assets").object_range())
            effective.emplace(std::string(entry.key()), entry.value());
    } else {
        const auto directory = project_root / "i18n/assets";
        if (!std::filesystem::is_directory(directory))
            return result;
        std::vector<std::filesystem::path> locales;
        for (const auto& file : std::filesystem::directory_iterator(directory))
            if (file.path().extension() == ".yaml" && file.is_regular_file())
                locales.push_back(file.path());
        std::sort(locales.begin(), locales.end());
        for (const auto& file : locales) {
            std::ifstream stream(file, std::ios::binary);
            const std::string bytes{std::istreambuf_iterator<char>(stream),
                                    std::istreambuf_iterator<char>()};
            const auto opened = open_yaml_source(bytes);
            const auto locale = file.stem().string();
            const auto prefix = "/localization/assets/" + escape(locale);
            if (!opened.accepted) {
                add(result, prefix, "localization.assets.source", opened.error);
                continue;
            }
            const auto normalized =
                validate_record("WorkspaceLocalizationAssets", opened.source_json);
            if (!normalized.accepted) {
                for (auto diagnostic : normalized.diagnostics) {
                    diagnostic.path = prefix + diagnostic.path;
                    result.diagnostics.push_back(std::move(diagnostic));
                }
                result.accepted = false;
                continue;
            }
            effective.emplace(locale, Json::parse(normalized.effective_json));
        }
    }
    for (const auto& [locale, mappings] : effective) {
        const auto prefix = "/localization/assets/" + escape(locale);
        for (const auto& entry : mappings.object_range()) {
            const auto path = prefix + "/" + escape(entry.key());
            const auto kind = asset_kind(resolve, entry.key());
            if (kind.empty()) {
                add(result, path, "localization.asset.base-missing",
                    "Localized Asset base does not exist.");
                continue;
            }
            if (kind != "image" && kind != "audio" && kind != "video") {
                add(result, path, "localization.asset.kind",
                    "Asset kind cannot have localized variants.");
                continue;
            }
            if (entry.value().contains("useSource"))
                continue;
            const auto id = ref_id(entry.value().at("asset"));
            if (id == entry.key()) {
                add(result, path + "/asset", "localization.asset.same",
                    "Localized variant must differ from its base Asset.");
                continue;
            }
            const auto variant = asset_kind(resolve, id);
            if (variant.empty())
                add(result, path + "/asset", "localization.asset.variant-missing",
                    "Localized Asset variant does not exist.");
            else if (variant != kind)
                add(result, path + "/asset", "localization.asset.variant-kind",
                    "Localized Asset variant kind does not match its base Asset.");
        }
    }
    return result;
}

} // namespace noveltea::authoring
