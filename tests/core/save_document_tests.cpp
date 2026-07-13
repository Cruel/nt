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
