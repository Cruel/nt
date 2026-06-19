#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/editor_api.hpp>
#include <noveltea/core/legacy/project_package_reader.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/runtime_controller.hpp>
#include <noveltea/core/save_document.hpp>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

#include <span>

using namespace noveltea::core;
using namespace noveltea::core::editor;

namespace {

nlohmann::json props() { return nlohmann::json::object(); }

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

nlohmann::json path_entry(bool enabled, EntityType type, const std::string& id)
{
    return nlohmann::json::array({enabled, ref(type, id)});
}

nlohmann::json object_entry(const std::string& id, const std::string& name)
{
    return nlohmann::json::array({id, "", props(), name, false});
}

nlohmann::json verb_entry(const std::string& id, const std::string& name, int object_count,
                          std::string default_script)
{
    return nlohmann::json::array({id, "", props(), name, object_count, std::move(default_script),
                                  "", nlohmann::json::array()});
}

nlohmann::json action_entry(const std::string& id, const std::string& verb_id, std::string script,
                            std::vector<std::string> object_ids)
{
    nlohmann::json objects = nlohmann::json::array();
    for (const auto& object_id : object_ids) {
        objects.push_back(object_id);
    }
    return nlohmann::json::array({id, "", props(), verb_id, std::move(script), objects, false});
}

nlohmann::json dialogue_segment(int id, int link, bool is_option, bool show_once, bool logged,
                                bool autosave, std::string text, std::vector<int> children)
{
    nlohmann::json child_json = nlohmann::json::array();
    for (const int child : children) {
        child_json.push_back(child);
    }
    return nlohmann::json::array({id, link, false, false, is_option, autosave, show_once, logged,
                                  "", "", std::move(text), child_json});
}

ProjectDocument make_reduced_legacy_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::project_name] = "Reduced Compatibility Fixture";
    root[project_ids::project_fonts] = nlohmann::json::object({{"caption", "fonts/caption.ttf"}});
    root[project_ids::textures] = nlohmann::json::object({{"foyer", "textures/foyer.png"}});
    root["legacyUnknownExtension"] = nlohmann::json::object({{"kept", true}});

    root[project_ids::object] = nlohmann::json::object({
        {"lamp", object_entry("lamp", "Lamp")},
        {"coin", object_entry("coin", "Coin")},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"look", verb_entry("look", "Look", 1, "default_look();")},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"look_lamp", action_entry("look_lamp", "look", "look_lamp();", {"lamp"})},
    });
    root[project_ids::room] = nlohmann::json::object({
        {"foyer",
         nlohmann::json::array(
             {"foyer", "", props(), "The foyer.", "", "", "", "",
              nlohmann::json::array({nlohmann::json::array({"lamp", true})}),
              nlohmann::json::array({path_entry(true, EntityType::Room, "kitchen")}), "Foyer"})},
        {"kitchen",
         nlohmann::json::array({"kitchen", "", props(), "The kitchen.", "", "", "", "",
                                nlohmann::json::array(), nlohmann::json::array(), "Kitchen"})},
    });
    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object({
        {"boot", nlohmann::json::array({"boot", "", props(), false, "toast('boot');"})},
    });
    root[project_ids::dialogue] = nlohmann::json::object({
        {"guide",
         nlohmann::json::array(
             {"guide", "", props(), "Guide", ref(EntityType::Room, "kitchen"), 0, false, true, 1,
              nlohmann::json::array({
                  dialogue_segment(0, -1, false, false, false, false, "", {1}),
                  dialogue_segment(1, -1, false, false, true, true, "[Guide]Hello.", {2}),
                  dialogue_segment(2, -1, true, true, false, false, "Continue", {}),
              })})},
    });

    auto page = nlohmann::json::array();
    page.push_back(2);
    page.push_back(true);
    page.push_back("Intro.\n\nDone.");
    page.push_back("\n");
    page.push_back("\n\n");
    page.push_back(0);
    page.push_back(1);
    page.push_back(1000);
    page.push_back(2000);
    page.push_back(2000);
    page.push_back(3000);
    page.push_back(true);
    page.push_back(true);
    page.push_back(0);
    page.push_back(0);
    page.push_back("");
    page.push_back(true);

    root[project_ids::cutscene] = nlohmann::json::object({
        {"intro",
         nlohmann::json::array({"intro", "", props(), true, true, 1.0,
                                ref(EntityType::Room, "foyer"), nlohmann::json::array({page})})},
    });
    root[project_ids::starting_inventory] = nlohmann::json::array({"coin"});
    root[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "intro");
    return project;
}

std::vector<std::byte>
make_zip_fixture(const std::vector<std::pair<std::string, std::string>>& entries)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_writer_init_heap(&archive, 0, 0));
    for (const auto& [name, payload] : entries) {
        REQUIRE(mz_zip_writer_add_mem(&archive, name.c_str(), payload.data(), payload.size(),
                                      MZ_DEFAULT_COMPRESSION));
    }

    void* data = nullptr;
    size_t size = 0;
    REQUIRE(mz_zip_writer_finalize_heap_archive(&archive, &data, &size));
    std::vector<std::byte> bytes(size);
    const auto* first = static_cast<const std::byte*>(data);
    bytes.assign(first, first + size);
    mz_free(data);
    REQUIRE(mz_zip_writer_end(&archive));
    return bytes;
}

std::string command_name(ControllerCommandType type)
{
    switch (type) {
    case ControllerCommandType::ModeChanged:
        return "mode";
    case ControllerCommandType::RoomEntry:
        return "room-entry";
    case ControllerCommandType::RoomDescription:
        return "room-description";
    case ControllerCommandType::NavigationUpdate:
        return "navigation";
    case ControllerCommandType::ScriptDeferred:
        return "script-deferred";
    case ControllerCommandType::Notification:
        return "notification";
    case ControllerCommandType::TextLogged:
        return "text-log";
    case ControllerCommandType::DialogueText:
        return "dialogue-text";
    case ControllerCommandType::DialogueOptions:
        return "dialogue-options";
    case ControllerCommandType::DialogueComplete:
        return "dialogue-complete";
    case ControllerCommandType::CutsceneText:
        return "cutscene-text";
    case ControllerCommandType::CutscenePageBreak:
        return "cutscene-page-break";
    case ControllerCommandType::CutsceneComplete:
        return "cutscene-complete";
    case ControllerCommandType::ActionResolved:
        return "action-resolved";
    case ControllerCommandType::ActionRejected:
        return "action-rejected";
    }
    return "unknown";
}

std::vector<std::string> command_golden(const std::vector<ControllerCommand>& commands)
{
    std::vector<std::string> result;
    for (const auto& command : commands) {
        std::string line = command_name(command.type);
        if (command.entity.has_value()) {
            line +=
                ":" + std::to_string(to_integer(command.entity->type)) + ":" + command.entity->id;
        }
        if (!command.text.empty()) {
            line += ":" + command.text;
        }
        result.push_back(std::move(line));
    }
    return result;
}

} // namespace

TEST_CASE("Compatibility fixture preserves legacy project JSON through import and editor save")
{
    const auto project = make_reduced_legacy_project();
    auto imported = ProjectTooling::import_legacy_game_json(project.dump());

    REQUIRE(imported.project.has_value());
    CHECK(imported.success());
    CHECK(imported.imported_legacy);
    CHECK(imported.project->root() == project.root());

    auto reloaded =
        ProjectTooling::load_project_json(ProjectTooling::save_project_json(*imported.project));
    REQUIRE(reloaded.project.has_value());
    CHECK(reloaded.success());
    CHECK(reloaded.project->root() == project.root());
    CHECK(reloaded.project->root()["legacyUnknownExtension"]["kept"] == true);
}

TEST_CASE("Compatibility fixture preserves save JSON where lossless save import is promised")
{
    auto save = SaveDocument::new_save();
    auto& root = save.root();
    root[project_ids::play_time] = 12.25;
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "kitchen");
    root[project_ids::entrypoint_metadata] = nlohmann::json::array({"restored"});
    root[project_ids::save_map] = "main";
    root[project_ids::object_locations] = nlohmann::json::object({
        {"inventory", nlohmann::json::array({"coin"})},
        {"room", nlohmann::json::object({{"foyer", nlohmann::json::array({"lamp"})}})},
    });
    root[project_ids::log] = nlohmann::json::array({"first", "second"});
    root[project_ids::properties] =
        nlohmann::json::object({{"global", nlohmann::json::object({{"flag", true}})}});
    root[project_ids::room_descriptions] = nlohmann::json::object({{"foyer", "changed"}});
    root[project_ids::visited_rooms] = nlohmann::json::object({{"foyer", 2}});
    root["legacyExtraSaveKey"] = nlohmann::json::array({1, 2, 3});

    std::vector<DocumentError> errors;
    auto parsed = SaveDocument::parse_json_text(save.dump(), errors);

    REQUIRE(parsed.has_value());
    CHECK(errors.empty());
    CHECK(parsed->root() == save.root());
    CHECK(parsed->dump() == save.dump());
}

TEST_CASE("Compatibility fixture imports legacy packages and preserves supported package entries")
{
    const auto project = make_reduced_legacy_project();
    const auto package_bytes = make_zip_fixture({
        {"game", project.dump()},
        {"image", "cover"},
        {"fonts/caption.ttf", "font"},
        {"textures/foyer.png", "texture"},
        {"scripts/bootstrap.lua", "script"},
        {"text/intro.txt", "intro"},
        {"notes/private.txt", "ignored"},
    });

    std::vector<legacy::PackageError> errors;
    const auto package = legacy::ProjectPackageReader::read(
        std::span<const std::byte>(package_bytes.data(), package_bytes.size()), errors);

    REQUIRE(package.has_value());
    CHECK(errors.empty());
    CHECK(package->imported_project.document.root() == project.root());
    CHECK(package->game_json == project.dump());
    CHECK(package->image.size() == 5);
    CHECK(package->fonts.contains("caption.ttf"));
    CHECK(package->textures.contains("foyer.png"));
    CHECK(package->assets.contains("scripts/bootstrap.lua"));
    CHECK(package->assets.contains("text/intro.txt"));
    CHECK_FALSE(package->assets.contains("notes/private.txt"));
}

TEST_CASE(
    "Compatibility golden covers room action dialogue cutscene timers text log save and inventory")
{
    RuntimePreviewSession preview;
    REQUIRE(preview.load(make_reduced_legacy_project()).success);
    preview.start();

    CHECK(command_golden(preview.take_captured_commands()) == std::vector<std::string>({
                                                                  "mode:1:intro:cutscene",
                                                                  "cutscene-text:1:intro:Intro.",
                                                              }));

    CHECK(preview.inject_continue());
    CHECK(command_golden(preview.take_captured_commands()) ==
          std::vector<std::string>({
              "cutscene-page-break:1:intro:intro",
              "cutscene-text:1:intro:Done.",
          }));

    CHECK(preview.inject_continue());
    CHECK(command_golden(preview.take_captured_commands()) ==
          std::vector<std::string>({
              "cutscene-complete:1:intro:intro",
              "mode:1:intro:cutscene",
              "mode:3:foyer:room",
              "script-deferred:3:foyer:return true;",
              "room-entry:3:foyer:foyer",
              "room-description:3:foyer:The foyer.",
              "navigation:3:foyer:foyer",
          }));
    REQUIRE(preview.inspect_state().view.objects.size() == 2);
    CHECK(preview.inspect_state().view.objects[0].id == "lamp");
    CHECK(preview.inspect_state().view.objects[0].in_room);
    CHECK(preview.inspect_state().view.objects[1].id == "coin");
    CHECK(preview.inspect_state().view.objects[1].in_inventory);

    CHECK(preview.inject_action("look", {"lamp"}));
    CHECK(command_golden(preview.take_captured_commands()) ==
          std::vector<std::string>({
              "script-deferred:return true;",
              "script-deferred:2:look_lamp:look_lamp();",
              "action-resolved:2:look_lamp:look_lamp",
          }));

    CHECK(preview.inject_navigation_choice(0));
    preview.step(0.0);
    CHECK(command_golden(preview.take_captured_commands()) ==
          std::vector<std::string>({
              "script-deferred:3:foyer:return true;",
              "mode:3:foyer:room",
              "mode:3:kitchen:room",
              "script-deferred:3:kitchen:return true;",
              "room-entry:3:kitchen:kitchen",
              "room-description:3:kitchen:The kitchen.",
              "navigation:3:kitchen:kitchen",
          }));

    REQUIRE(preview.set_entrypoint(EntityRef{EntityType::Dialogue, "guide"}).success);
    CHECK(command_golden(preview.take_captured_commands()) == std::vector<std::string>({
                                                                  "mode:5:guide:dialogue",
                                                                  "dialogue-text:5:guide:Hello.",
                                                                  "text-log:5:guide:Hello.",
                                                                  "dialogue-options:5:guide:guide",
                                                              }));
    CHECK(preview.inject_dialogue_option(0));
    CHECK(command_golden(preview.take_captured_commands()) ==
          std::vector<std::string>({
              "dialogue-complete:5:guide:guide",
              "mode:5:guide:dialogue",
              "mode:3:kitchen:room",
              "script-deferred:3:kitchen:return true;",
              "room-entry:3:kitchen:kitchen",
              "room-description:3:kitchen:The kitchen.",
              "navigation:3:kitchen:kitchen",
          }));

    GameSession session;
    auto save = SaveDocument::new_save();
    save.root()[project_ids::entrypoint_entity] = ref(EntityType::Room, "foyer");
    save.root()[project_ids::play_time] = 4.0;
    save.root()[project_ids::log] = nlohmann::json::array({"loaded"});
    REQUIRE(session.load(make_reduced_legacy_project(), save).success);
    RuntimeController controller(session);
    session.events().push(RuntimeEvent{RuntimeEventType::TextLogged, 0, 0.0, "runtime log"});
    const auto timer = session.timers().start(0.5);
    CHECK(timer.id != 0);
    controller.tick(0.5);

    CHECK(session.play_time() == 4.5);
    CHECK(session.timers().active_count() == 0);
    CHECK(command_golden(controller.take_commands()) == std::vector<std::string>({
                                                            "text-log:runtime log",
                                                            "mode:3:foyer:room",
                                                            "script-deferred:3:foyer:return true;",
                                                            "room-entry:3:foyer:foyer",
                                                            "room-description:3:foyer:The foyer.",
                                                            "navigation:3:foyer:foyer",
                                                        }));
}
