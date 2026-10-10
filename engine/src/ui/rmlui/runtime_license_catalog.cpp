#include "ui/rmlui/runtime_license_catalog.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/package_export.hpp"
#include "noveltea/core/player_bootstrap.hpp"
#include "noveltea/core/json_access.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <map>
#include <set>
#include <span>
#include <string_view>
#include <utility>

#include <nlohmann/json.hpp>

namespace noveltea::ui::rmlui {
namespace {

constexpr std::size_t kMaxNoticeBytes = 1024 * 1024;
constexpr std::size_t kMaxNotices = 512;

bool valid_sha256(std::string_view value)
{
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char ch) {
               return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
           });
}

bool safe_notice_path(std::string_view path)
{
    if (!path.starts_with("licenses/") || path.size() <= 9 || path.find('\\') != path.npos ||
        path.find(':') != path.npos)
        return false;
    auto rest = path.substr(9);
    while (!rest.empty()) {
        const auto separator = rest.find('/');
        const auto part = rest.substr(0, separator);
        if (part.empty() || part == "." || part == ".." ||
            std::any_of(part.begin(), part.end(), [](unsigned char ch) { return ch < 32; }))
            return false;
        if (separator == rest.npos)
            break;
        rest.remove_prefix(separator + 1);
        if (rest.empty())
            return false;
    }
    return true;
}

bool valid_text(std::string_view text)
{
    return !text.empty() && text.size() <= kMaxNoticeBytes &&
           core::ProjectPackageWriter::is_valid_distribution_notice_text(
               std::as_bytes(std::span(text.data(), text.size())));
}

bool valid_engine_text(std::string_view text)
{
    // Original upstream notices can use form feeds as page separators. Preserve
    // their bytes; allow that one control only for engine-owned notices.
    if (text.empty() || text.size() > kMaxNoticeBytes)
        return false;
    std::string normalized(text);
    std::replace(normalized.begin(), normalized.end(), static_cast<char>(12), '\n');
    return valid_text(normalized);
}

std::optional<std::string> read_bounded_text(const assets::AssetManager& assets,
                                             std::string_view path)
{
    auto opened = assets.open(path);
    if (!opened)
        return std::nullopt;
    auto& reader = **opened.value;
    auto size = reader.size();
    if (!size || *size.value > kMaxNoticeBytes)
        return std::nullopt;
    std::string text(static_cast<std::size_t>(*size.value), '\0');
    std::size_t offset = 0;
    while (offset < text.size()) {
        auto read = reader.read(text.data() + offset, text.size() - offset);
        if (!read || *read.value == 0 || *read.value > text.size() - offset)
            return std::nullopt;
        offset += *read.value;
    }
    return text;
}

std::optional<nlohmann::json> read_index(const assets::AssetManager& assets, std::string_view path)
{
    auto text = read_bounded_text(assets, path);
    if (!text)
        return std::nullopt;
    auto parsed = nlohmann::json::parse(*text, nullptr, false);
    if (!parsed.is_object())
        return std::nullopt;
    return parsed;
}

bool append_engine(const nlohmann::json& index, std::vector<RuntimeLicenseNotice>& out)
{
    if (index.size() != 2 || !index.contains("format") || !index["format"].is_string() ||
        index["format"] != "noveltea.engine-licenses" || !index.contains("components") ||
        !index["components"].is_array())
        return false;
    std::string previous;
    std::set<std::string> paths;
    for (const auto& component : index["components"]) {
        if (!component.is_object() || component.size() != 4 || !component.contains("component") ||
            !component["component"].is_string() || !component.contains("displayName") ||
            !component["displayName"].is_string() || !component.contains("version") ||
            !component["version"].is_string() || !component.contains("files") ||
            !component["files"].is_array())
            return false;
        const auto name = core::json_access::value_or<std::string>(component, "component", "");
        const auto label = core::json_access::value_or<std::string>(component, "displayName", "");
        const auto version = core::json_access::value_or<std::string>(component, "version", "");
        if (name.empty() || label.empty() || version.empty() ||
            (!previous.empty() && name <= previous) || component["files"].empty())
            return false;
        previous = name;
        for (const auto& file : component["files"]) {
            if (!file.is_object() || file.size() != 3 || !file.contains("path") ||
                !file["path"].is_string() || !file.contains("size") ||
                !file["size"].is_number_unsigned() || !file.contains("sha256") ||
                !file["sha256"].is_string())
                return false;
            const auto path = core::json_access::value_or<std::string>(file, "path", "");
            const auto hash = core::json_access::value_or<std::string>(file, "sha256", "");
            const auto size = core::json_access::value_or<std::size_t>(file, "size", 0);
            if (!safe_notice_path(path) || !path.ends_with(".txt") || !valid_sha256(hash) ||
                size == 0 || size > kMaxNoticeBytes || !paths.insert(path).second ||
                out.size() >= kMaxNotices)
                return false;
            out.push_back({"engine", label + " (" + version + ")", "system:/" + path, hash, size});
        }
    }
    return !out.empty();
}

bool append_project(const nlohmann::json& index, std::vector<RuntimeLicenseNotice>& out)
{
    if (index.size() != 2 || !index.contains("schema") || !index["schema"].is_string() ||
        index["schema"] != "noveltea.project-notices" || !index.contains("notices") ||
        !index["notices"].is_array())
        return false;
    // Player and Runtime Package inventories are certified separately. Neither may consume
    // the other's quota, or an otherwise valid Project notice catalog disappears from the UI.
    const auto project_start = out.size();
    std::string previous;
    for (const auto& notice : index["notices"]) {
        if (!notice.is_object() || notice.size() != 4 || !notice.contains("path") ||
            !notice["path"].is_string() || !notice.contains("source") ||
            !notice["source"].is_string() || !notice.contains("displayName") ||
            !notice["displayName"].is_string() || !notice.contains("contentHash") ||
            !notice["contentHash"].is_string())
            return false;
        const auto path = core::json_access::value_or<std::string>(notice, "path", "");
        const auto source = core::json_access::value_or<std::string>(notice, "source", "");
        const auto label = core::json_access::value_or<std::string>(notice, "displayName", "");
        const auto hash = core::json_access::value_or<std::string>(notice, "contentHash", "");
        const auto dot = path.find_last_of('.');
        if (dot == std::string::npos)
            return false;
        auto extension = path.substr(dot);
        std::transform(extension.begin(), extension.end(), extension.begin(),
                       [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        if (!safe_notice_path(path) || path != "licenses/" + source ||
            (extension != ".txt" && extension != ".md") ||
            (!previous.empty() && source <= previous) || label.empty() ||
            !hash.starts_with("sha256:") || !valid_sha256(std::string_view(hash).substr(7)) ||
            out.size() - project_start >= kMaxNotices)
            return false;
        previous = source;
        out.push_back({"project", label, "project:/" + path, hash.substr(7), 0});
    }
    return true;
}

} // namespace

RuntimeLicenseCatalog RuntimeLicenseCatalog::load(const assets::AssetManager& assets)
{
    RuntimeLicenseCatalog catalog;
    if (auto engine = read_index(assets, "system:/licenses/index.json")) {
        if (!append_engine(*engine, catalog.notices)) {
            catalog.invalid_inventory = true;
            catalog.notices.clear();
        }
    } else {
        catalog.engine_inventory_missing = !assets.exists("system:/licenses/index.json");
        catalog.invalid_inventory = !catalog.engine_inventory_missing;
    }
    if (auto project = read_index(assets, "project:/licenses/index.json")) {
        auto project_entries = catalog.notices;
        if (append_project(*project, project_entries))
            catalog.notices = std::move(project_entries);
        else
            catalog.invalid_inventory = true;
    } else if (assets.exists("project:/licenses/index.json")) {
        catalog.invalid_inventory = true;
    }
    // A display name is advisory. Distinct Project files with the same label must remain
    // identifiable without authors having to rename their original notice files.
    std::map<std::string, std::size_t> project_label_counts;
    for (const auto& notice : catalog.notices)
        if (notice.group == "project")
            ++project_label_counts[notice.label];
    for (auto& notice : catalog.notices)
        if (notice.group == "project" && project_label_counts[notice.label] > 1)
            notice.label +=
                " (" + notice.path.substr(std::string("project:/licenses/").size()) + ")";
    std::stable_sort(catalog.notices.begin(), catalog.notices.end(),
                     [](const auto& a, const auto& b) {
                         if (a.group != b.group)
                             return a.group == "engine";
                         if (a.label != b.label)
                             return a.label < b.label;
                         return a.path < b.path;
                     });
    return catalog;
}

std::optional<std::string> RuntimeLicenseCatalog::read_notice(const assets::AssetManager& assets,
                                                              std::size_t index) const
{
    if (index >= notices.size())
        return std::nullopt;
    const auto& notice = notices[index];
    auto text = read_bounded_text(assets, notice.path);
    if (!text)
        return std::nullopt;
    const bool content_valid =
        notice.group == "engine" ? valid_engine_text(*text) : valid_text(*text);
    if (!content_valid || (notice.byte_size != 0 && notice.byte_size != text->size()) ||
        core::sha256_hex(std::as_bytes(std::span(text->data(), text->size()))) != notice.sha256)
        return std::nullopt;
    return text;
}

} // namespace noveltea::ui::rmlui
