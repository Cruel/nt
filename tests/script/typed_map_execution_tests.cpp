#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/runtime/runtime_executor.hpp"
#include "runtime_test_services.hpp"

#include <fstream>
#include <iterator>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

using TypedExecutionKernel = runtime::RuntimeExecutor;

template<class T>
concept HasCategories = requires(const T& value) { value.categories; };

template<class T>
concept HasTags = requires(const T& value) { value.tags; };

template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    REQUIRE(result);
    return std::move(result).value();
}

core::CompiledProject load_project()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/interaction-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, "typed-map-test");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

void drive_to_room(TypedExecutionKernel& kernel, const core::RoomId& room)
{
    for (std::size_t iteration = 0; iteration < 64; ++iteration) {
        const auto outcome = kernel.run_until_blocked(1, "en");
        if (const auto* changed = std::get_if<core::FlowModeChangedOutcome>(&outcome)) {
            const auto* active = std::get_if<core::RoomMode>(&changed->mode);
            REQUIRE(active != nullptr);
            if (active->room == room)
                return;
        }
        REQUIRE_FALSE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    }
    FAIL("typed Room transition did not complete");
}

} // namespace

TEST_CASE("typed Map derives selection exclusively from Room exits and routes navigation lifecycle")
{
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::CharacterDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::RoomDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::InteractableDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::VerbDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::InteractionDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::SceneDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::DialogueDefinition>);
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::MapDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::CharacterDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::RoomDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::InteractableDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::VerbDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::InteractionDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::SceneDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::DialogueDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::MapDefinition>);

    auto memory = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", memory);
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&assets}));
    REQUIRE(runtime.execute("function initialize_fixture() end\n"
                            "function can_leave_start() return true end\n"
                            "function after_enter_start() end\n"
                            "function before_leave_start() end\n"
                            "function hall_description() return 'Hall' end\n"
                            "function tower_open() return true end\n"
                            "function can_unlock() return true end\n"
                            "function key_label() return 'Key' end",
                            "typed-map-setup"));
    auto project = load_project();
    auto created = test_support::create_execution_kernel(project, runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel, id<core::RoomId>("start"));

    REQUIRE(kernel->present_map(id<core::MapId>("house")));
    auto map = kernel->map_view("en");
    REQUIRE(map);
    CHECK(map.value().title == "House Map");
    CHECK(map.value().current_room == id<core::RoomId>("start"));
    REQUIRE(map.value().connections.size() == 2);
    CHECK(map.value().connections[0].selectable);
    CHECK_FALSE(map.value().connections[1].selectable);

    REQUIRE(kernel->select_map_location(id<core::MapLocationId>("hall-location"), "en"));
    REQUIRE(kernel->state().map_presentation());
    CHECK(kernel->state().map_presentation()->focused_location ==
          id<core::MapLocationId>("hall-location"));
    CHECK(kernel->state().flow_stack().empty());

    REQUIRE(kernel->activate_map_connection(id<core::MapConnectionId>("start-hall"), "en"));
    REQUIRE_FALSE(kernel->state().flow_stack().empty());
    const auto* transition =
        std::get_if<core::RoomTransitionFrame>(&kernel->state().flow_stack().back());
    REQUIRE(transition != nullptr);
    REQUIRE(transition->selected_exit);
    CHECK(transition->selected_exit->room == id<core::RoomId>("start"));
    CHECK(transition->selected_exit->exit_id == id<core::RoomExitId>("north-exit"));
    drive_to_room(*kernel, id<core::RoomId>("hall"));

    auto ui = kernel->runtime_ui_view("en");
    REQUIRE(ui);
    REQUIRE(ui.value().map);
    CHECK(ui.value().map->current_room == id<core::RoomId>("hall"));
    CHECK(ui.value().map->locations[1].focused);
}

} // namespace noveltea::script::test
