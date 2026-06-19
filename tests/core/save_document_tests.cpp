#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/save_document.hpp>

using namespace noveltea::core;

namespace {

nlohmann::json entity_ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

} // namespace

TEST_CASE("SaveDocument creates old reset-compatible baseline save keys")
{
    const auto save = SaveDocument::new_save();
    std::vector<DocumentError> errors;

    CHECK(save.validate(errors));
    CHECK(errors.empty());
    CHECK(save.play_time() == 0.0);
    CHECK(save.navigation_enabled());
    CHECK(save.map_enabled());
    CHECK_FALSE(save.entrypoint().has_value());
    CHECK(save.current_map_id().empty());

    const auto& root = save.root();
    CHECK(root[project_ids::log].is_array());
    CHECK(root[project_ids::properties].is_object());
    CHECK(root[project_ids::room_descriptions].is_object());
    CHECK(root[project_ids::visited_rooms].is_object());
}

TEST_CASE("SaveDocument parses representative runtime save shape")
{
    auto root = SaveDocument::new_save().root();
    root[project_ids::play_time] = 42.5;
    root[project_ids::entrypoint_entity] = entity_ref(EntityType::Dialogue, "intro");
    root[project_ids::entrypoint_metadata] =
        nlohmann::json::array({"foyer", nlohmann::json::object({{"index", 2}})});
    root[project_ids::save_map] = "main";
    root[project_ids::object_locations] = nlohmann::json::object({
        {"room", nlohmann::json::object({
                     {"foyer", nlohmann::json::array({nlohmann::json::array({"lamp", 1})})},
                 })},
    });
    root[project_ids::properties] = nlohmann::json::object({
        {"dialogue", nlohmann::json::object({{"intro", nlohmann::json::object({{"_d0", 0}})}})},
    });
    root[project_ids::room_descriptions] = nlohmann::json::object({{"foyer", "A changed room."}});
    root[project_ids::visited_rooms] = nlohmann::json::object({{"foyer", 3}});
    root[project_ids::log] = nlohmann::json::array({"hello"});

    std::vector<DocumentError> errors;
    const auto parsed = SaveDocument::parse_json_text(root.dump(), errors);

    REQUIRE(parsed.has_value());
    CHECK(errors.empty());
    CHECK(parsed->play_time() == 42.5);
    REQUIRE(parsed->entrypoint().has_value());
    CHECK(parsed->entrypoint()->type == EntityType::Dialogue);
    CHECK(parsed->entrypoint()->id == "intro");
    CHECK(parsed->current_map_id() == "main");
    CHECK(parsed->root() == root);
}

TEST_CASE("SaveDocument reports malformed required and optional fields")
{
    auto root = SaveDocument::new_save().root();
    root.erase(project_ids::log);
    root[project_ids::play_time] = "later";
    root[project_ids::entrypoint_entity] = nlohmann::json::array({999, "bad"});
    root[project_ids::object_locations] = nlohmann::json::array();

    std::vector<DocumentError> errors;
    const auto parsed = SaveDocument::parse_json_text(root.dump(), errors);

    CHECK_FALSE(parsed.has_value());
    REQUIRE(errors.size() >= 1);
    CHECK(errors[0].path == "/log");
    CHECK(errors[0].message == "missing required key");
}

TEST_CASE("SaveDocument reports malformed JSON")
{
    std::vector<DocumentError> errors;
    const auto parsed = SaveDocument::parse_json_text("{\"playTime\":", errors);

    CHECK_FALSE(parsed.has_value());
    REQUIRE(errors.size() == 1);
    CHECK(errors[0].message.find("malformed .ntsav JSON") != std::string::npos);
}

TEST_CASE("SettingsDocument parses old settings.conf profile shape")
{
    const auto root = nlohmann::json::object({
        {"sizeFactor", 1.25},
        {"profiles", nlohmann::json::array({
                         nlohmann::json::array({"Default"}),
                         nlohmann::json::array({"Second"}),
                     })},
        {"activeProfile", 1},
    });

    std::vector<DocumentError> errors;
    const auto parsed = SettingsDocument::parse_json_text(root.dump(), errors);

    REQUIRE(parsed.has_value());
    CHECK(errors.empty());
    CHECK(parsed->font_size_multiplier() == 1.25);
    CHECK(parsed->active_profile_index() == 1);
    const auto profiles = parsed->profiles();
    REQUIRE(profiles.size() == 2);
    CHECK(profiles[0].name == "Default");
    CHECK(profiles[1].name == "Second");
}

TEST_CASE("SettingsDocument defaults match old in-memory settings state")
{
    const auto settings = SettingsDocument::defaults();
    std::vector<DocumentError> errors;

    CHECK(settings.validate(errors));
    CHECK(errors.empty());
    CHECK(settings.font_size_multiplier() == 1.0);
    CHECK(settings.active_profile_index() == -1);
    CHECK(settings.profiles().empty());
}

TEST_CASE("SettingsDocument reports malformed profiles and active index")
{
    const auto root = nlohmann::json::object({
        {"sizeFactor", true},
        {"profiles", nlohmann::json::array({
                         nlohmann::json::array({"Default", "extra"}),
                         nlohmann::json::array({7}),
                     })},
        {"activeProfile", 4},
    });

    std::vector<DocumentError> errors;
    const auto parsed = SettingsDocument::parse_json_text(root.dump(), errors);

    CHECK_FALSE(parsed.has_value());
    REQUIRE(errors.size() >= 4);
    CHECK(errors[0].path == "/sizeFactor");
    CHECK(errors[0].message == "expected number");
    CHECK(errors[1].path == "/profiles/0");
    CHECK(errors[1].message == "expected profile array [name]");
}

TEST_CASE("legacy profile path helpers preserve old slot naming")
{
    CHECK(profile_paths::settings_filename == "settings.conf");
    CHECK(profile_paths::last_save_filename == "lastSave");
    CHECK(profile_paths::profile_directory_name(3) == "3");
    CHECK(profile_paths::slot_filename(2) == "2.ntsav");
    CHECK(profile_paths::slot_path(3, 2) == "3/2.ntsav");
}
