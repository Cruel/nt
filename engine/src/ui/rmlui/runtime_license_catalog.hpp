#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::ui::rmlui {

struct RuntimeLicenseNotice {
    std::string group;
    std::string label;
    std::string path;
    std::string sha256;
    std::size_t byte_size = 0;
};

struct RuntimeLicenseCatalog {
    std::vector<RuntimeLicenseNotice> notices;
    bool engine_inventory_missing = false;
    bool invalid_inventory = false;

    // Indexes are validated as a whole; individual texts are fetched only when selected.
    [[nodiscard]] static RuntimeLicenseCatalog load(const assets::AssetManager& assets);
    [[nodiscard]] std::optional<std::string> read_notice(const assets::AssetManager& assets,
                                                         std::size_t index) const;
};

} // namespace noveltea::ui::rmlui
