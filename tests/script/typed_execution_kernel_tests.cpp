#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/typed_execution_kernel.hpp"

#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

core::CompiledProject load_fixture(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

struct RuntimeFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    ScriptRuntime runtime;

    RuntimeFixture()
    {
        assets.mount("project", memory);
        REQUIRE(runtime.initialize({&assets}));
    }
};

template<class Frame> bool has_root_frame(const TypedExecutionKernel& kernel)
{
    return kernel.state().flow_stack().size() == 1 &&
           std::holds_alternative<Frame>(kernel.state().flow_stack().front());
}

} // namespace

TEST_CASE("typed execution kernel composes Scene primitives Lua waits and host state")
{
    RuntimeFixture fixture;
    auto project = load_fixture("scene-program.json");
    auto created = TypedExecutionKernel::create(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    REQUIRE(has_root_frame<core::SceneFrame>(*kernel));

    auto condition = kernel->evaluate(core::Always{});
    REQUIRE(condition);
    CHECK(condition.value());

    const auto count = core::VariableId::create("count").value();
    auto assigned = kernel->apply(core::SetVariable{count, std::int64_t{9}});
    REQUIRE(assigned);
    CHECK(std::holds_alternative<core::WaitCompleted>(assigned.value()));
    CHECK(kernel->state().variable(project, count).value() == core::RuntimeValue{std::int64_t{9}});

    auto lua_condition =
        kernel->evaluate(core::LuaPredicate{"noveltea.variables.get('count') == 9"});
    REQUIRE(lua_condition);
    CHECK(lua_condition.value());

    auto text = kernel->resolve(
        core::LuaTextExpression{"'count=' .. noveltea.variables.get('count')"}, "en");
    REQUIRE(text);
    CHECK(text.value() == "count=9");

    auto suspended =
        kernel->apply(core::RunLuaEffect{"noveltea.variables.set('count', 10); coroutine.yield(); "
                                         "noveltea.notify('resumed')"},
                      "kernel-suspension");
    REQUIRE(suspended);
    const auto* wait = std::get_if<ScriptInvocationSuspended>(&suspended.value());
    REQUIRE(wait != nullptr);
    CHECK(kernel->state().blocker().has_value());
    CHECK(kernel->state().variable(project, count).value() == core::RuntimeValue{std::int64_t{10}});

    auto resumed = kernel->resume_script(wait->owner, wait->invocation);
    REQUIRE(resumed);
    CHECK(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
    REQUIRE(kernel->host().requests().size() == 1);
    CHECK(std::holds_alternative<core::NotificationRequest>(kernel->host().requests().front()));
}

TEST_CASE("typed execution kernel initializes each Phase 6 frame category from compiled fixtures")
{
    RuntimeFixture fixture;

    auto dialogue_project = load_fixture("dialogue-program.json");
    auto dialogue = TypedExecutionKernel::create(dialogue_project, fixture.runtime);
    REQUIRE(dialogue);
    CHECK(has_root_frame<core::DialogueFrame>(*dialogue.value()));
    dialogue.value().reset();

    auto room_project = load_fixture("comprehensive.json");
    auto room = TypedExecutionKernel::create(room_project, fixture.runtime);
    REQUIRE(room);
    CHECK(has_root_frame<core::RoomTransitionFrame>(*room.value()));
    room.value().reset();

    auto interaction_project = load_fixture("interaction-program.json");
    auto interaction = TypedExecutionKernel::create(interaction_project, fixture.runtime);
    REQUIRE(interaction);
    auto& kernel = *interaction.value();
    REQUIRE(kernel.flow().advance_room_transition(core::RoomTransitionStage::BeforeEnter));
    REQUIRE(kernel.flow().advance_room_transition(core::RoomTransitionStage::BeforeEnter, 1));
    REQUIRE(kernel.flow().advance_room_transition(core::RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(kernel.flow().advance_room_transition(core::RoomTransitionStage::AfterEnter));
    REQUIRE(kernel.flow().advance_room_transition(core::RoomTransitionStage::AfterEnter, 1));
    REQUIRE(kernel.flow().advance_room_transition(core::RoomTransitionStage::Complete));
    REQUIRE(kernel.flow().complete_room_transition());

    const auto interaction_id = core::InteractionId::create("actions").value();
    const auto rule_id = core::InteractionRuleId::create("any-context").value();
    const auto verb_id = core::VerbId::create("use").value();
    REQUIRE(kernel.flow().start_interaction(
        core::InteractionInvocationContext{verb_id,
                                           core::RoomId::create("start").value(),
                                           {core::InteractableId::create("key").value()}},
        core::InteractionRuleProgramRef{interaction_id, rule_id}));
    CHECK(has_root_frame<core::InteractionFrame>(kernel));
}

TEST_CASE("typed execution kernel preserves exact blocker ownership and fail-stops errors")
{
    RuntimeFixture fixture;
    auto project = load_fixture("scene-program.json");
    auto created = TypedExecutionKernel::create(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    auto duration = core::DurationWait::create(std::chrono::milliseconds{50});
    REQUIRE(duration);
    auto blocked = kernel->begin(duration.value());
    REQUIRE(blocked);
    const auto* wait = std::get_if<core::WaitBlocked>(&blocked.value());
    REQUIRE(wait != nullptr);
    const auto* duration_blocker = std::get_if<core::DurationFlowBlocker>(&wait->blocker);
    REQUIRE(duration_blocker != nullptr);
    const auto owner = duration_blocker->owner;
    const auto handle = duration_blocker->handle;

    REQUIRE(kernel->advance(owner, handle, std::chrono::milliseconds{50}));
    CHECK_FALSE(kernel->state().blocker().has_value());

    auto second_duration = core::DurationWait::create(std::chrono::milliseconds{20});
    REQUIRE(second_duration);
    auto second_blocked = kernel->begin(second_duration.value());
    REQUIRE(second_blocked);
    CHECK_FALSE(kernel->advance(owner, handle, std::chrono::milliseconds{10}));
    CHECK(kernel->state().blocker().has_value());
    const auto* second_wait = std::get_if<core::WaitBlocked>(&second_blocked.value());
    REQUIRE(second_wait != nullptr);
    const auto* second_blocker = std::get_if<core::DurationFlowBlocker>(&second_wait->blocker);
    REQUIRE(second_blocker != nullptr);
    REQUIRE(kernel->advance(second_blocker->owner, second_blocker->handle,
                            std::chrono::milliseconds{20}));

    auto bad_effect = kernel->apply(
        core::SetVariable{core::VariableId::create("missing").value(), std::int64_t{1}});
    REQUIRE_FALSE(bad_effect);
    CHECK(std::holds_alternative<core::Diagnostics>(bad_effect.error()));

    auto bad_lua = kernel->evaluate(core::LuaPredicate{"coroutine.yield()"});
    REQUIRE_FALSE(bad_lua);
    const auto* script_error = std::get_if<ScriptError>(&bad_lua.error());
    REQUIRE(script_error != nullptr);
    CHECK(script_error->code == ScriptErrorCode::YieldForbidden);
}

} // namespace noveltea::script::test
