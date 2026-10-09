#include "ui/rmlui/runtime_license_catalog.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/player_bootstrap.hpp"

#include <catch2/catch_test_macros.hpp>

#include <memory>
#include <span>
#include <string>
#include <string_view>

using namespace noveltea;

namespace {

void add(assets::MemoryAssetSource& source, std::string path, std::string_view text)
{
    source.add(std::move(path), assets::AssetBytes(text.begin(), text.end()));
}

std::string digest(std::string_view text)
{
    return core::sha256_hex(std::as_bytes(std::span(text.data(), text.size())));
}

} // namespace

TEST_CASE("license catalog reads engine and Project notices only through validated namespaces")
{
    auto system = std::make_shared<assets::MemoryAssetSource>();
    auto project = std::make_shared<assets::MemoryAssetSource>();
    constexpr std::string_view engine_text = "Apache 2.0\n<copyright>& all rights reserved\n";
    constexpr std::string_view project_text = "Attribution for game artwork\n";
    add(*system, "system:/licenses/library--license.txt", engine_text);
    add(*system, "system:/licenses/index.json",
        "{\"format\":\"noveltea.engine-licenses\",\"components\":[{\"component\":\"library\","
        "\"displayName\":\"Library\",\"version\":\"1.2\",\"files\":[{\"path\":\"licenses/"
        "library--license.txt\","
        "\"size\":" +
            std::to_string(engine_text.size()) + ",\"sha256\":\"" + digest(engine_text) +
            "\"}]}]}");
    add(*project, "project:/licenses/art.txt", project_text);
    add(*project, "project:/licenses/index.json",
        "{\"schema\":\"noveltea.project-notices\",\"notices\":[{\"path\":\"licenses/art.txt\","
        "\"source\":\"art.txt\",\"displayName\":\"Game art\",\"contentHash\":\"sha256:" +
            digest(project_text) + "\"}]}");
    assets::AssetManager manager;
    manager.mount("system", system);
    manager.mount("project", project);

    const auto catalog = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    REQUIRE_FALSE(catalog.invalid_inventory);
    REQUIRE_FALSE(catalog.engine_inventory_missing);
    REQUIRE(catalog.notices.size() == 2);
    CHECK(catalog.notices[0].group == "engine");
    CHECK(catalog.notices[0].label == "Library (1.2)");
    CHECK(catalog.notices[1].group == "project");
    CHECK(catalog.notices[1].label == "Game art");
    CHECK(catalog.read_notice(manager, 0) == engine_text);
    CHECK(catalog.read_notice(manager, 1) == project_text);
    CHECK_FALSE(catalog.read_notice(manager, 2));

    add(*system, "system:/licenses/library--license.txt", "Tampered");
    CHECK_FALSE(catalog.read_notice(manager, 0));
}

TEST_CASE("license catalog rejects path traversal and does not replace missing target inventories")
{
    auto system = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager manager;
    manager.mount("system", system);
    auto missing = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    CHECK(missing.engine_inventory_missing);
    CHECK(missing.notices.empty());

    add(*system, "system:/licenses/index.json",
        "{\"format\":\"noveltea.engine-licenses\",\"components\":[{\"component\":\"foo\","
        "\"displayName\":\"Foo\",\"version\":\"1\",\"files\":[{\"path\":\"licenses/../escape.txt\","
        "\"size\":2,\"sha256\":\"" +
            std::string(64, 'a') + "\"}]}]}");
    auto invalid = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    CHECK(invalid.invalid_inventory);
    CHECK(invalid.notices.empty());

    add(*system, "system:/licenses/index.json", "{\"format\":42,\"components\":[]}");
    invalid = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    CHECK(invalid.invalid_inventory);
    CHECK(invalid.notices.empty());
}

TEST_CASE("license catalog admits a one-MiB plain text notice but rejects larger payloads")
{
    auto project = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager manager;
    manager.mount("project", project);
    const std::string text(1024 * 1024, 'L');
    const auto hash = digest(text);
    add(*project, "project:/licenses/large.txt", text);
    add(*project, "project:/licenses/index.json",
        "{\"schema\":\"noveltea.project-notices\",\"notices\":[{\"path\":\"licenses/large.txt\","
        "\"source\":\"large.txt\",\"displayName\":\"Large license\",\"contentHash\":\"sha256:" +
            hash + "\"}]}");
    const auto catalog = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    REQUIRE_FALSE(catalog.invalid_inventory);
    REQUIRE(catalog.notices.size() == 1);
    const auto loaded = catalog.read_notice(manager, 0);
    REQUIRE(loaded);
    CHECK(*loaded == text);

    add(*project, "project:/licenses/large.txt", text + "L");
    CHECK_FALSE(catalog.read_notice(manager, 0));
}
