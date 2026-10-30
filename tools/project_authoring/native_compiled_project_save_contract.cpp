#include "native_compiled_project_save_contract.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string_view>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

// JSON object keys have code-point ordering in the original compiler.
// nlohmann's default ordered map compares UTF-8 byte values; valid UTF-8
// preserves Unicode scalar ordering.
Json canonical(Json value)
{
    if (value.is_number_float()) {
        const auto number = value.get<double>();
        if (number == 0)
            return 0;
        if (std::isfinite(number) && std::trunc(number) == number &&
            std::abs(number) <= 9007199254740991.0)
            return static_cast<std::int64_t>(number);
    }
    if (value.is_array() || value.is_object())
        for (auto& item : value)
            item = canonical(std::move(item));
    return value;
}

void fold_utf16(std::string_view text, std::array<std::uint32_t, 4>& state)
{
    const auto add_unit = [&](std::uint16_t unit) {
        for (auto& hash : state) {
            hash ^= unit;
            hash *= 16777619u;
        }
    };
    for (std::size_t position = 0; position < text.size();) {
        const auto lead = static_cast<unsigned char>(text[position++]);
        std::uint32_t codepoint = lead;
        unsigned continuation = 0;
        if ((lead & 0xe0) == 0xc0) {
            continuation = 1;
            codepoint &= 0x1f;
        } else if ((lead & 0xf0) == 0xe0) {
            continuation = 2;
            codepoint &= 0x0f;
        } else if ((lead & 0xf8) == 0xf0) {
            continuation = 3;
            codepoint &= 0x07;
        }
        for (unsigned index = 0; index < continuation && position < text.size(); ++index) {
            codepoint = (codepoint << 6) | (static_cast<unsigned char>(text[position++]) & 0x3f);
        }
        if (codepoint > 0xffff) {
            const auto shifted = codepoint - 0x10000;
            add_unit(static_cast<std::uint16_t>(0xd800 + (shifted >> 10)));
            add_unit(static_cast<std::uint16_t>(0xdc00 + (shifted & 0x3ff)));
        } else {
            add_unit(static_cast<std::uint16_t>(codepoint));
        }
    }
}

Json resource_contract(const Json& compiled)
{
    const auto& resources = compiled.at("resources");
    Json result = Json::object();
    if (!resources.at("animations").empty()) {
        Json animations = Json::array();
        for (const auto& animation : resources.at("animations")) {
            Json motions = Json::array();
            for (const auto& motion : animation.at("motions")) {
                Json markers = Json::array();
                for (const auto& marker : motion.at("markers"))
                    markers.push_back(marker.at("id"));
                motions.push_back({{"id", motion.at("id")}, {"markers", std::move(markers)}});
            }
            animations.push_back({{"id", animation.at("id")},
                                  {"defaultMotionId", animation.at("defaultMotionId")},
                                  {"motions", std::move(motions)}});
        }
        result["animations"] = std::move(animations);
    }
    result["assets"] = Json::array();
    for (const auto& item : resources.at("assets"))
        result["assets"].push_back(item.at("id"));
    result["layouts"] = Json::array();
    for (const auto& item : resources.at("layouts")) {
        if (item.contains("contract") && item["contract"].is_object() &&
            item["contract"].contains("state") && !item["contract"]["state"].is_null())
            result["layouts"].push_back(
                {{"id", item.at("id")}, {"state", item.at("contract").at("state")}});
        else
            result["layouts"].push_back(item.at("id"));
    }
    result["materialInterfaces"] = resources.at("materialInterfaces");
    result["scripts"] = resources.at("scripts");
    return result;
}
} // namespace

std::string compiled_project_save_contract(const nlohmann::json& compiled_project)
{
    Json projection{{"bootstrapModule", compiled_project.at("bootstrapModule")},
                    {"archetypes", compiled_project.at("archetypes")},
                    {"definitions", compiled_project.at("definitions")},
                    {"inventories", compiled_project.at("inventories")},
                    {"interactableInstances", compiled_project.at("interactableInstances")},
                    {"properties", compiled_project.at("properties")},
                    {"resources", resource_contract(compiled_project)},
                    {"traits", compiled_project.at("traits")}};
    const auto serialized =
        canonical(std::move(projection)).dump(-1, ' ', false, Json::error_handler_t::strict);
    std::array<std::uint32_t, 4> hash{2166136261u, 2246822507u, 3266489909u, 668265263u};
    fold_utf16(serialized, hash);
    std::ostringstream output;
    output << "sc1:" << std::hex << std::setfill('0');
    for (const auto value : hash)
        output << std::setw(8) << value;
    return output.str();
}

} // namespace noveltea::cli
