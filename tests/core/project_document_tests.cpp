#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/legacy/project_package_reader.hpp>
#include <noveltea/core/legacy/project_importer.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/project_ids.hpp>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

using namespace noveltea::core;
using noveltea::core::legacy::ImportError;
using noveltea::core::legacy::PackageError;
using noveltea::core::legacy::ProjectImporter;
using noveltea::core::legacy::ProjectPackageReader;

namespace {

nlohmann::json make_legacy_game_json()
{
    auto legacy = nlohmann::json::object({
        {project_ids::engine_version, 1.0},
        {project_ids::project_name, "Legacy Game"},
        {project_ids::project_version, "0.9"},
        {project_ids::project_author, "Author"},
        {project_ids::project_website, "https://example.invalid"},
        {project_ids::project_font_default, "sys"},
        {project_ids::project_fonts, nlohmann::json::array()},
        {project_ids::starting_inventory, nlohmann::json::array()},
        {project_ids::script_before_save, ""},
        {project_ids::script_after_load, ""},
        {project_ids::script_after_action, ""},
        {project_ids::script_before_action, "return true;"},
        {project_ids::script_undefined_action, "return false;"},
        {project_ids::script_after_leave, ""},
        {project_ids::script_before_leave, "return true;"},
        {project_ids::script_after_enter, ""},
        {project_ids::script_before_enter, "return true;"},
        {project_ids::open_tabs, nlohmann::json::array()},
        {project_ids::open_tab_index, -1},
        {project_ids::textures, nlohmann::json::array()},
        {project_ids::shaders, nlohmann::json::object({
                                   {"defaultFrag", "legacy fragment source"},
                                   {"defaultVert", "legacy vertex source"},
                               })},
        {project_ids::system_shaders, nlohmann::json::array({"defaultFrag", "defaultFrag"})},
        {project_ids::engine_fonts, nlohmann::json::object({
                                        {"sys", "LiberationSans.ttf"},
                                        {"sysIcon", "fontawesome.ttf"},
                                    })},
    });
    for (auto key : project_ids::entity_collection_keys) {
        legacy[key] = nlohmann::json::object();
    }
    return legacy;
}

void add_zip_entry(mz_zip_archive& archive, const char* name, std::string_view payload)
{
    REQUIRE(mz_zip_writer_add_mem(&archive, name, payload.data(), payload.size(),
                                  MZ_DEFAULT_COMPRESSION));
}

std::vector<std::byte>
make_zip_fixture(const std::vector<std::pair<std::string, std::string>>& entries)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_writer_init_heap(&archive, 0, 0));
    for (const auto& [name, payload] : entries) {
        add_zip_entry(archive, name.c_str(), payload);
    }

    void* data = nullptr;
    size_t size = 0;
    REQUIRE(mz_zip_writer_finalize_heap_archive(&archive, &data, &size));
    std::vector<std::byte> bytes(size);
    auto* first = static_cast<const std::byte*>(data);
    bytes.assign(first, first + size);
    mz_free(data);
    REQUIRE(mz_zip_writer_end(&archive));
    return bytes;
}

} // namespace

TEST_CASE("ProjectDocument new_project creates old-compatible default project keys")
{
    auto project = ProjectDocument::new_project();
    const auto& root = project.root();

    CHECK(project.has_required_project_keys());
    CHECK(root.contains(project_ids::engine_version));
    CHECK(root.contains(project_ids::project_name));
    CHECK(root.contains(project_ids::project_version));
    CHECK(root.contains(project_ids::project_author));
    CHECK(root.contains(project_ids::project_font_default));
    CHECK(root.contains(project_ids::project_fonts));
    CHECK(root.contains(project_ids::starting_inventory));
    CHECK(root.contains(project_ids::script_before_save));
    CHECK(root.contains(project_ids::script_after_load));
    CHECK(root.contains(project_ids::script_before_action));
    CHECK(root.contains(project_ids::script_undefined_action));
    CHECK(root.contains(project_ids::textures));
    CHECK(root.contains(project_ids::shaders));
    CHECK(root.contains(project_ids::system_shaders));
    CHECK(root.contains(project_ids::engine_fonts));

    for (auto key : project.entity_collection_keys()) {
        INFO("collection key: " << key);
        CHECK(root.contains(key));
        REQUIRE(root[key].is_object());
    }

    CHECK(root[project_ids::project_name] == "Project Name");
    CHECK(root[project_ids::project_version] == "1.0");
    CHECK(root[project_ids::project_author] == "Author Name");
    CHECK(root[project_ids::project_font_default] == "sys");
    REQUIRE(root[project_ids::engine_fonts].is_object());
    REQUIRE(root[project_ids::project_fonts].is_object());
    REQUIRE(root[project_ids::starting_inventory].is_array());
    REQUIRE(root[project_ids::textures].is_object());
    REQUIRE(root[project_ids::shaders].is_object());
    REQUIRE(root[project_ids::system_shaders].is_array());
    CHECK(root[project_ids::script_before_action] == "return true;");
    CHECK(root[project_ids::script_undefined_action] == "return false;");
    CHECK(root[project_ids::script_before_leave] == "return true;");
    CHECK(root[project_ids::script_before_enter] == "return true;");
}

TEST_CASE("ProjectDocument new_project is normalized rather than exact legacy wire format")
{
    const auto root = ProjectDocument::new_project().root();

    CHECK(root[project_ids::project_fonts].is_object());
    CHECK(root[project_ids::textures].is_object());
}

TEST_CASE("ProjectDocument validates old entrypoint requirement")
{
    auto project = ProjectDocument::new_project();
    std::string error;

    CHECK_FALSE(project.validate_entrypoint(&error));
    CHECK(error == "No valid entry point defined in project settings.");

    project.root()[project_ids::entrypoint_entity] = EntityRef{EntityType::Cutscene, ""}.to_json();
    CHECK_FALSE(project.validate_entrypoint(&error));

    project.root()[project_ids::entrypoint_entity] =
        EntityRef{EntityType::Cutscene, "intro"}.to_json();
    CHECK(project.validate_entrypoint(&error));
    CHECK(error.empty());
}

TEST_CASE("ProjectDocument round-trips through its JSON representation")
{
    auto project = ProjectDocument::new_project();
    project.root()[project_ids::entrypoint_entity] =
        EntityRef{EntityType::Room, "start_room"}.to_json();

    ProjectDocument copy(project.root());

    CHECK(copy.root() == project.root());
    CHECK(copy.dump() == project.dump());
    CHECK(copy.has_required_project_keys());
    CHECK(copy.has_valid_entrypoint());
}

TEST_CASE("legacy ProjectImporter imports representative old game JSON")
{
    auto legacy = make_legacy_game_json();
    legacy[project_ids::entrypoint_entity] = EntityRef{EntityType::Cutscene, "intro"}.to_json();

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json_text(legacy.dump(), errors);

    REQUIRE(result.has_value());
    CHECK(errors.empty());
    CHECK(result->document.root() == legacy);
    CHECK(result->document.has_valid_entrypoint());
}

TEST_CASE("legacy ProjectImporter accepts empty-array font and texture placeholders")
{
    auto legacy = make_legacy_game_json();

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json(legacy, errors);

    REQUIRE(result.has_value());
    CHECK(errors.empty());
    CHECK(result->document.root()[project_ids::project_fonts].is_array());
    CHECK(result->document.root()[project_ids::textures].is_array());
}

TEST_CASE("legacy ProjectImporter accepts object-map font and texture assets")
{
    auto legacy = make_legacy_game_json();
    legacy[project_ids::project_fonts] = nlohmann::json::object({{"caption", "example.ttf"}});
    legacy[project_ids::textures] = nlohmann::json::object({{"example.png", "example.png"}});

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json(legacy, errors);

    REQUIRE(result.has_value());
    CHECK(errors.empty());
    CHECK(result->document.root()[project_ids::project_fonts] ==
          legacy[project_ids::project_fonts]);
    CHECK(result->document.root()[project_ids::textures] == legacy[project_ids::textures]);
}

TEST_CASE("legacy ProjectImporter rejects scalar font and texture fields with key diagnostics")
{
    auto legacy = make_legacy_game_json();
    legacy[project_ids::project_fonts] = "bad";
    legacy[project_ids::textures] = 42;

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json(legacy, errors);

    CHECK_FALSE(result.has_value());
    REQUIRE(errors.size() >= 2);
    CHECK(errors[0].message.find("key 'fonts'") != std::string::npos);
    CHECK(errors[0].message.find("expected object map or empty array placeholder") !=
          std::string::npos);
    CHECK(errors[0].message.find("found string") != std::string::npos);
    CHECK(errors[1].message.find("key 'textures'") != std::string::npos);
    CHECK(errors[1].message.find("found number") != std::string::npos);
}

TEST_CASE("legacy ProjectImporter reports malformed JSON diagnostics")
{
    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json_text("{\"name\":", errors);

    CHECK_FALSE(result.has_value());
    REQUIRE_FALSE(errors.empty());
    CHECK(errors.front().message.find("Malformed legacy project JSON") != std::string::npos);
}

TEST_CASE("legacy ProjectImporter reports legacy shape diagnostics")
{
    auto legacy = ProjectDocument::new_project().root();
    legacy[project_ids::project_fonts] = nlohmann::json::array();
    legacy[project_ids::textures] = nlohmann::json::array();
    legacy.erase(project_ids::project_name);
    legacy[project_ids::object] = nlohmann::json::array();
    legacy[project_ids::entrypoint_entity] = nlohmann::json::object();

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json(legacy, errors);

    CHECK_FALSE(result.has_value());
    REQUIRE(errors.size() >= 3);
    CHECK(errors[0].message.find("missing required key 'name'") != std::string::npos);
    CHECK(errors[1].message.find("entity collection 'object' expected object") !=
          std::string::npos);
    CHECK(errors[1].message.find("found array") != std::string::npos);
    CHECK(errors[2].message.find("entrypoint must use selected-entity array shape") !=
          std::string::npos);
}

TEST_CASE("legacy ProjectPackageReader reads old package entries and imports game")
{
    auto game = make_legacy_game_json();
    game[project_ids::project_fonts] = nlohmann::json::object({{"caption", "example.ttf"}});
    game[project_ids::textures] = nlohmann::json::object({{"example.png", "example.png"}});
    game[project_ids::entrypoint_entity] = EntityRef{EntityType::Room, "start"}.to_json();

    const auto zip = make_zip_fixture({
        {"game", game.dump()},
        {"image", "image-bytes"},
        {"fonts/example.ttf", "font-bytes"},
        {"textures/example.png", "texture-bytes"},
        {"scripts/bootstrap.lua", "script-bytes"},
        {"text/intro.txt", "intro-bytes"},
        {"shaders/bgfx/glsl-120/custom.fs.bin", "shader-bytes"},
        {"notes/ignored.txt", "ignored"},
        {"scripts/../escape.lua", "unsafe"},
    });

    std::vector<PackageError> errors;
    const auto package =
        ProjectPackageReader::read(std::span<const std::byte>(zip.data(), zip.size()), errors);

    REQUIRE(package.has_value());
    CHECK(errors.empty());
    CHECK(package->game_json == game.dump());
    CHECK(package->imported_project.document.root() == game);
    REQUIRE(package->image.size() == 11);
    CHECK(std::string(reinterpret_cast<const char*>(package->image.data()),
                      package->image.size()) == "image-bytes");
    REQUIRE(package->fonts.contains("example.ttf"));
    CHECK(std::string(reinterpret_cast<const char*>(package->fonts.at("example.ttf").data()),
                      package->fonts.at("example.ttf").size()) == "font-bytes");
    REQUIRE(package->textures.contains("example.png"));
    CHECK(std::string(reinterpret_cast<const char*>(package->textures.at("example.png").data()),
                      package->textures.at("example.png").size()) == "texture-bytes");
    REQUIRE(package->assets.contains("scripts/bootstrap.lua"));
    CHECK(std::string(
              reinterpret_cast<const char*>(package->assets.at("scripts/bootstrap.lua").data()),
              package->assets.at("scripts/bootstrap.lua").size()) == "script-bytes");
    REQUIRE(package->assets.contains("text/intro.txt"));
    CHECK(std::string(reinterpret_cast<const char*>(package->assets.at("text/intro.txt").data()),
                      package->assets.at("text/intro.txt").size()) == "intro-bytes");
    REQUIRE(package->assets.contains("shaders/bgfx/glsl-120/custom.fs.bin"));
    CHECK(std::string(reinterpret_cast<const char*>(
                          package->assets.at("shaders/bgfx/glsl-120/custom.fs.bin").data()),
                      package->assets.at("shaders/bgfx/glsl-120/custom.fs.bin").size()) ==
          "shader-bytes");
    CHECK(package->fonts.size() == 1);
    CHECK(package->textures.size() == 1);
    CHECK(package->assets.size() == 3);
    CHECK_FALSE(package->assets.contains("notes/ignored.txt"));
    CHECK_FALSE(package->assets.contains("scripts/../escape.lua"));
}

TEST_CASE("legacy ProjectPackageReader reports missing game entry")
{
    const auto zip = make_zip_fixture({
        {"image", "image-bytes"},
        {"fonts/example.ttf", "font-bytes"},
    });

    std::vector<PackageError> errors;
    const auto package =
        ProjectPackageReader::read(std::span<const std::byte>(zip.data(), zip.size()), errors);

    CHECK_FALSE(package.has_value());
    REQUIRE_FALSE(errors.empty());
    CHECK(errors.front().message.find("missing required 'game' entry") != std::string::npos);
}

TEST_CASE("legacy ProjectPackageReader reports malformed game JSON")
{
    const auto zip = make_zip_fixture({
        {"game", "{\"name\":"},
        {"image", "image-bytes"},
    });

    std::vector<PackageError> errors;
    const auto package =
        ProjectPackageReader::read(std::span<const std::byte>(zip.data(), zip.size()), errors);

    CHECK_FALSE(package.has_value());
    REQUIRE_FALSE(errors.empty());
    CHECK(errors.front().message.find("game import failed") != std::string::npos);
    CHECK(errors.front().message.find("Malformed legacy project JSON") != std::string::npos);
}
