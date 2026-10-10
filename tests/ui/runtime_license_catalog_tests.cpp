#include "ui/rmlui/runtime_license_catalog.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/player_bootstrap.hpp"

#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

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

TEST_CASE("license catalog displays mixed-case Project notice file extensions")
{
    auto project = std::make_shared<assets::MemoryAssetSource>();
    constexpr std::string_view text = "Attribution kept as plain text\n";
    add(*project, "project:/licenses/support/NOTICE.MD", text);
    add(*project, "project:/licenses/index.json",
        "{\"schema\":\"noveltea.project-notices\",\"notices\":[{\"path\":\"licenses/support/"
        "NOTICE.MD\","
        "\"source\":\"support/"
        "NOTICE.MD\",\"displayName\":\"Attribution\",\"contentHash\":\"sha256:" +
            digest(text) + "\"}]}");
    assets::AssetManager manager;
    manager.mount("project", project);
    const auto catalog = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    REQUIRE_FALSE(catalog.invalid_inventory);
    REQUIRE(catalog.notices.size() == 1);
    CHECK(catalog.read_notice(manager, 0) == text);
}

TEST_CASE("extensionless Project notice paths are rejected without throwing")
{
    auto project = std::make_shared<assets::MemoryAssetSource>();
    add(*project, "project:/licenses/NOTICE", "Copyright\n");
    add(*project, "project:/licenses/index.json",
        "{\"schema\":\"noveltea.project-notices\",\"notices\":[{\"path\":\"licenses/NOTICE\","
        "\"source\":\"NOTICE\",\"displayName\":\"Notice\",\"contentHash\":\"sha256:" +
            digest("Copyright\n") + "\"}]}");
    assets::AssetManager manager;
    manager.mount("project", project);
    const auto catalog = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    CHECK(catalog.invalid_inventory);
    CHECK(catalog.notices.empty());
}

TEST_CASE("duplicate Project notice labels are disambiguated by their source paths")
{
    auto project = std::make_shared<assets::MemoryAssetSource>();
    const auto entries = nlohmann::json::array({
        {{"path", "licenses/art/LICENSE.txt"},
         {"source", "art/LICENSE.txt"},
         {"displayName", "LICENSE.txt"},
         {"contentHash", "sha256:" + digest("Art\n")}},
        {{"path", "licenses/fonts/LICENSE.txt"},
         {"source", "fonts/LICENSE.txt"},
         {"displayName", "LICENSE.txt"},
         {"contentHash", "sha256:" + digest("Fonts\n")}},
    });
    const nlohmann::json index = {{"schema", "noveltea.project-notices"}, {"notices", entries}};
    add(*project, "project:/licenses/index.json", index.dump());
    add(*project, "project:/licenses/art/LICENSE.txt", "Art\n");
    add(*project, "project:/licenses/fonts/LICENSE.txt", "Fonts\n");
    assets::AssetManager manager;
    manager.mount("project", project);
    const auto catalog = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    REQUIRE_FALSE(catalog.invalid_inventory);
    REQUIRE(catalog.notices.size() == 2);
    CHECK(catalog.notices[0].label == "LICENSE.txt (art/LICENSE.txt)");
    CHECK(catalog.notices[1].label == "LICENSE.txt (fonts/LICENSE.txt)");
}

TEST_CASE("engine and Project notice inventories have independent entry limits")
{
    auto system = std::make_shared<assets::MemoryAssetSource>();
    auto project = std::make_shared<assets::MemoryAssetSource>();
    auto files = nlohmann::json::array();
    for (int i = 0; i < 512; ++i) {
        const auto path = "licenses/library--notice-" + std::to_string(i) + ".txt";
        files.push_back({{"path", path}, {"size", 1}, {"sha256", digest("x")}});
    }
    const nlohmann::json engine_index = {
        {"format", "noveltea.engine-licenses"},
        {"components", nlohmann::json::array({{{"component", "library"},
                                               {"displayName", "Library"},
                                               {"version", "1.0"},
                                               {"files", files}}})},
    };
    add(*system, "system:/licenses/index.json", engine_index.dump());
    constexpr std::string_view project_text = "Game art notice\n";
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
    REQUIRE(catalog.notices.size() == 513);
    CHECK(catalog.notices.back().group == "project");
    CHECK(catalog.read_notice(manager, 512) == project_text);
}

TEST_CASE("engine notice pagination form feeds remain readable without relaxing Project notices")
{
    auto system = std::make_shared<assets::MemoryAssetSource>();
    auto project = std::make_shared<assets::MemoryAssetSource>();
    const std::string engine_text = "Upstream license page 1\fPage 2\n";
    add(*system, "system:/licenses/upstream--license.txt", engine_text);
    add(*system, "system:/licenses/index.json",
        "{\"format\":\"noveltea.engine-licenses\",\"components\":[{\"component\":\"upstream\","
        "\"displayName\":\"Upstream\",\"version\":\"1.0\",\"files\":[{\"path\":\"licenses/"
        "upstream--license.txt\",\"size\":" +
            std::to_string(engine_text.size()) + ",\"sha256\":\"" + digest(engine_text) +
            "\"}]}]}");
    add(*project, "project:/licenses/local.txt", engine_text);
    add(*project, "project:/licenses/index.json",
        "{\"schema\":\"noveltea.project-notices\",\"notices\":[{\"path\":\"licenses/local.txt\","
        "\"source\":\"local.txt\",\"displayName\":\"Local\",\"contentHash\":\"sha256:" +
            digest(engine_text) + "\"}]}");
    assets::AssetManager manager;
    manager.mount("system", system);
    manager.mount("project", project);
    const auto catalog = ui::rmlui::RuntimeLicenseCatalog::load(manager);
    REQUIRE_FALSE(catalog.invalid_inventory);
    REQUIRE(catalog.notices.size() == 2);
    CHECK(catalog.read_notice(manager, 0) == engine_text);
    CHECK_FALSE(catalog.read_notice(manager, 1));
}
