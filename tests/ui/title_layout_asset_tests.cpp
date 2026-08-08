#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

std::string read_source_file(const std::filesystem::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

} // namespace

TEST_CASE("built-in title layout uses the NovelTea data model")
{
    const auto root = std::filesystem::path(NOVELTEA_SOURCE_DIR);
    const auto rml = read_source_file(root / "engine/assets/system/ui/title/default-title.rml");

    REQUIRE_FALSE(rml.empty());
    CHECK(rml.find("system|/ui/title/default-title.rcss") != std::string::npos);
    CHECK(rml.find("<body data-model=\"noveltea\">") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-project\">{{ project.title }}") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-subtitle\">{{ project.subtitle }}") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-diagnostic\"") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-start\" data-event-click=\"shell_start()\"") !=
          std::string::npos);
    CHECK(rml.find("{{ project.start_label }}") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-load\" data-event-click=\"shell_open_load()\"") !=
          std::string::npos);
    CHECK(rml.find("id=\"nt-title-settings\" data-event-click=\"shell_open_settings()\"") !=
          std::string::npos);
    CHECK(rml.find("id=\"nt-shell-status\">{{ shell.status }}") != std::string::npos);
    CHECK(rml.find("onclick=\"Game.") == std::string::npos);
    CHECK(rml.find("nt-command") == std::string::npos);
}

TEST_CASE("built-in system menu assets use NovelTea data-model callbacks")
{
    const auto root = std::filesystem::path(NOVELTEA_SOURCE_DIR);
    const auto menu_root = root / "engine/assets/system/ui/menu";
    const std::vector<std::string> documents{"pause-menu.rml",    "save-menu.rml", "load-menu.rml",
                                             "settings-menu.rml", "text-log.rml",  "modal.rml"};

    for (const auto& document : documents) {
        const auto rml = read_source_file(menu_root / document);
        INFO(document);
        REQUIRE_FALSE(rml.empty());
        CHECK(rml.find("<body data-model=\"noveltea\">") != std::string::npos);
        CHECK(rml.find("Game.command") == std::string::npos);
        CHECK(rml.find("nt-command") == std::string::npos);
        CHECK(rml.find("onclick=\"Game.shell.") == std::string::npos);
        CHECK(rml.find("id=\"nt-shell-status\">{{ shell.status }}") != std::string::npos);
    }

    const auto save = read_source_file(menu_root / "save-menu.rml");
    CHECK(save.find("{{ shell.checkpoint.summary }}") != std::string::npos);
    CHECK(save.find("data-for=\"slot : shell.save_slots\"") != std::string::npos);
    CHECK(save.find("data-if=\"slot.kind != 'autosave'\"") != std::string::npos);
    CHECK(save.find("data-attr-src=\"slot.thumbnail_url\"") != std::string::npos);
    CHECK(save.find("data-event-click=\"shell_save_slot(slot.number)\"") != std::string::npos);
    const auto load = read_source_file(menu_root / "load-menu.rml");
    CHECK(load.find("{{ shell.checkpoint.summary }}") != std::string::npos);
    CHECK(load.find("data-for=\"slot : shell.save_slots\"") != std::string::npos);
    CHECK(load.find("data-if=\"slot.occupied\"") != std::string::npos);
    CHECK(load.find("data-attr-src=\"slot.thumbnail_url\"") != std::string::npos);
    CHECK(load.find("data-event-click=\"shell_load_slot(slot.kind, slot.number)\"") !=
          std::string::npos);
    const auto text_log = read_source_file(menu_root / "text-log.rml");
    CHECK(text_log.find("<nt-text-log") == std::string::npos);
    CHECK(text_log.find("data-for=\"entry : gameplay.text_log.entries\"") != std::string::npos);
    CHECK(text_log.find("data-if=\"gameplay.text_log.entries.size == 0\"") != std::string::npos);
    CHECK(text_log.find("data-rml=\"entry.body_rml\"") != std::string::npos);

    const auto settings = read_source_file(menu_root / "settings-menu.rml");
    CHECK(settings.find("id=\"nt-settings-ui-scale-control\"") != std::string::npos);
    CHECK(settings.find("id=\"nt-settings-text-scale-control\"") != std::string::npos);
    CHECK(settings.find("data-if=\"shell.settings.ui_scale.enabled\"") != std::string::npos);
    CHECK(settings.find("data-if=\"shell.settings.text_scale.enabled\"") != std::string::npos);
    CHECK(settings.find("shell_set_ui_scale(shell.settings.ui_scale.minimum)") !=
          std::string::npos);
    CHECK(settings.find("shell_set_ui_scale(shell.settings.ui_scale.default_value)") !=
          std::string::npos);
    CHECK(settings.find("shell_set_ui_scale(shell.settings.ui_scale.maximum)") !=
          std::string::npos);
    CHECK(settings.find("shell_set_text_scale(shell.settings.text_scale.minimum)") !=
          std::string::npos);
    CHECK(settings.find("shell_set_text_scale(shell.settings.text_scale.default_value)") !=
          std::string::npos);
    CHECK(settings.find("shell_set_text_scale(shell.settings.text_scale.maximum)") !=
          std::string::npos);
    CHECK(settings.find("set_text_scale(0.9)") == std::string::npos);

    const auto modal = read_source_file(menu_root / "modal.rml");
    CHECK(modal.find("{{ shell.confirmation.prompt }}") != std::string::npos);
    CHECK(modal.find("data-event-click=\"shell_confirm()\"") != std::string::npos);
    CHECK(modal.find("data-event-click=\"shell_cancel()\"") != std::string::npos);
}

TEST_CASE("built-in game HUD is a transparent functional overlay")
{
    const auto root = std::filesystem::path(NOVELTEA_SOURCE_DIR);
    const auto hud_root = root / "engine/assets/system/ui/runtime";
    const auto rml = read_source_file(hud_root / "runtime_game.rml");
    const auto rcss = read_source_file(hud_root / "runtime_game.rcss");

    REQUIRE_FALSE(rml.empty());
    REQUIRE_FALSE(rcss.empty());
    CHECK(rml.find("system|/ui/runtime/runtime_game.rcss") != std::string::npos);
    CHECK(rml.find("<body data-model=\"noveltea\">") != std::string::npos);
    CHECK(rml.find("<nt-active-text id=\"rt_body\"") != std::string::npos);
    CHECK(rml.find("{{ gameplay.title }}") != std::string::npos);
    CHECK(rml.find("{{ gameplay.notification }}") != std::string::npos);
    CHECK(rml.find("data-for=\"choice : gameplay.choices\"") != std::string::npos);
    CHECK(rml.find("data-event-click=\"ui_choose(choice.kind, choice.id)\"") != std::string::npos);
    CHECK(rml.find("data-for=\"object : gameplay.room.objects\"") != std::string::npos);
    CHECK(rml.find("data-for=\"item : gameplay.inventory.items\"") != std::string::npos);
    CHECK(rml.find("data-for=\"action : gameplay.interaction.actions\"") != std::string::npos);
    CHECK(rml.find("data-event-click=\"ui_clear_selection()\"") != std::string::npos);
    CHECK(rml.find("data-for=\"exit : gameplay.room.exits\"") != std::string::npos);
    CHECK(rml.find("data-event-click=\"ui_navigate_room(exit.id)\"") != std::string::npos);
    CHECK(rml.find("id=\"rt_menu\" data-event-click=\"shell_pause()\"") != std::string::npos);
    CHECK(rml.find("data-exit-id") == std::string::npos);
    CHECK(rml.find("onclick=\"Game.") == std::string::npos);
    CHECK(rml.find("id=\"rt_mode\"") == std::string::npos);
    CHECK(rml.find("id=\"rt_prompt\"") == std::string::npos);
    CHECK(rml.find("id=\"rt_actors\"") == std::string::npos);
    CHECK(rml.find("<nt-text-log") == std::string::npos);
    CHECK(rml.find("<nt-map-view") == std::string::npos);
    CHECK(rml.find("rt_background_image") == std::string::npos);
    CHECK(rml.find("rt_room_image") == std::string::npos);
    CHECK(rcss.find("pointer-events: none") != std::string::npos);
    CHECK(rcss.find(".nav-slot-northwest") != std::string::npos);
    CHECK(rcss.find(".nav-slot-southeast") != std::string::npos);
    CHECK(rcss.find(".nav-slot-south { left: 80px; bottom: 0; }") != std::string::npos);
    const std::vector<std::string> compass_directions{"northwest", "north",  "northeast",
                                                      "west",      "custom", "east",
                                                      "southwest", "south",  "southeast"};
    for (const auto& direction : compass_directions) {
        INFO(direction);
        CHECK(rml.find("data-class-nav-slot-" + direction + "=\"exit.direction == '" + direction +
                       "'\"") != std::string::npos);
    }
}
