#include "ui/rmlui/runtime_license_catalog.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/package_export.hpp"
#include "noveltea/core/player_bootstrap.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
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

std::optional<nlohmann::json> read_index(const assets::AssetManager& assets, std::string_view path)
{
    auto text = assets.read_text(path);
    if (!text || text.value->size() > kMaxNoticeBytes)
        return std::nullopt;
    auto parsed = nlohmann::json::parse(*text.value, nullptr, false);
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
        const auto name = component["component"].get<std::string>();
        const auto label = component["displayName"].get<std::string>();
        const auto version = component["version"].get<std::string>();
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
            const auto path = file["path"].get<std::string>();
            const auto hash = file["sha256"].get<std::string>();
            const auto size = file["size"].get<std::size_t>();
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
    std::string previous;
    for (const auto& notice : index["notices"]) {
        if (!notice.is_object() || notice.size() != 4 || !notice.contains("path") ||
            !notice["path"].is_string() || !notice.contains("source") ||
            !notice["source"].is_string() || !notice.contains("displayName") ||
            !notice["displayName"].is_string() || !notice.contains("contentHash") ||
            !notice["contentHash"].is_string())
            return false;
        const auto path = notice["path"].get<std::string>();
        const auto source = notice["source"].get<std::string>();
        const auto label = notice["displayName"].get<std::string>();
        const auto hash = notice["contentHash"].get<std::string>();
        if (!safe_notice_path(path) || path != "licenses/" + source ||
            !(path.ends_with(".txt") || path.ends_with(".md")) ||
            (!previous.empty() && source <= previous) || label.empty() ||
            !hash.starts_with("sha256:") || !valid_sha256(std::string_view(hash).substr(7)) ||
            out.size() >= kMaxNotices)
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
    auto text = assets.read_text(notice.path);
    if (!text || !valid_text(*text.value) ||
        (notice.byte_size != 0 && notice.byte_size != text.value->size()) ||
        core::sha256_hex(std::as_bytes(std::span(text.value->data(), text.value->size()))) !=
            notice.sha256)
        return std::nullopt;
    return std::move(*text.value);
}

} // namespace noveltea::ui::rmlui
