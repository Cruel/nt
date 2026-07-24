#include <catch2/catch_test_macros.hpp>

#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/runtime/runtime_executor.hpp"
#include "fake_script_source.hpp"
#include "runtime_test_services.hpp"

#include <fstream>
#include <chrono>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

using TypedExecutionKernel = runtime::RuntimeExecutor;

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
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;

    RuntimeFixture() { REQUIRE(runtime.initialize({&sources})); }
};

template<class Frame> bool has_root_frame(const TypedExecutionKernel& kernel)
{
    return kernel.state().flow_stack().size() == 1 &&
           std::holds_alternative<Frame>(kernel.state().flow_stack().front());
}

const core::SceneFrame& active_scene(const TypedExecutionKernel& kernel)
{
    REQUIRE_FALSE(kernel.state().flow_stack().empty());
    const auto* frame = std::get_if<core::SceneFrame>(&kernel.state().flow_stack().back());
    REQUIRE(frame != nullptr);
    return *frame;
}

core::FlowBlocker active_blocker(const TypedExecutionKernel& kernel)
{
    REQUIRE(kernel.state().blocker());
    return *kernel.state().blocker();
}

} // namespace

TEST_CASE("typed execution kernel composes Scene primitives Lua waits and host state")
{
    RuntimeFixture fixture;
    auto project = load_fixture("scene-program.json");
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
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
    auto events = kernel->gateway().take_events();
    REQUIRE(events.size() == 1);
    CHECK(std::holds_alternative<runtime::NotificationEvent>(events.front()));
}

TEST_CASE("typed execution kernel initializes each frame category from compiled fixtures")
{
    RuntimeFixture fixture;

    auto dialogue_project = load_fixture("dialogue-program.json");
    auto dialogue = test_support::create_execution_kernel(dialogue_project, fixture.runtime);
    REQUIRE(dialogue);
    CHECK(has_root_frame<core::DialogueFrame>(*dialogue.value()));
    dialogue.value().reset();

    auto room_project = load_fixture("comprehensive.json");
    auto room = test_support::create_execution_kernel(room_project, fixture.runtime);
    REQUIRE(room);
    CHECK(has_root_frame<core::RoomTransitionFrame>(*room.value()));
    room.value().reset();

    auto interaction_project = load_fixture("interaction-program.json");
    auto interaction = test_support::create_execution_kernel(interaction_project, fixture.runtime);
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
                                           {core::compiled::InteractableInteractionSubject{
                                               core::InteractableId::create("key").value()}}},
        core::InteractionRuleProgramRef{interaction_id, rule_id}));
    CHECK(has_root_frame<core::InteractionFrame>(kernel));
}

TEST_CASE("save projection ignores internal runtime actions")
{
    RuntimeFixture fixture;
    auto project = load_fixture("scene-program.json");
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    REQUIRE(core::make_save_state(project, kernel->state()));
    REQUIRE(kernel->gateway().request_notification("pending"));
    auto pending = core::make_save_state(project, kernel->state());
    REQUIRE(pending);
    CHECK(kernel->gateway().take_events().size() == 1);
    REQUIRE(core::make_save_state(project, kernel->state()));
}

TEST_CASE("typed execution kernel preserves exact blocker ownership and fail-stops errors")
{
    RuntimeFixture fixture;
    auto project = load_fixture("scene-program.json");
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
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

TEST_CASE(
    "typed Scene execution covers live V1 instructions and stages one atomic transition group")
{
    RuntimeFixture fixture;
    REQUIRE(
        fixture.runtime.execute("function show_hero() return true end\n"
                                "function dynamic_line() return 'Dynamic line.' end\n"
                                "function run_scene_effect() coroutine.yield() end\n"
                                "function take_layout_branch() return false end\n"
                                "function can_transition() return true end\n"
                                "function prepare_transition() noveltea.notify('prepared') end\n"
                                "function transition_label() return 'Transition' end",
                                "scene-test-setup"));
    auto project = load_fixture("scene-program.json");
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    auto first = kernel->run_until_blocked(2, "en");
    const auto* first_budget = std::get_if<core::FlowBudgetYieldOutcome>(&first);
    REQUIRE(first_budget != nullptr);
    CHECK(first_budget->executed_units == 2);
    auto view = kernel->scene_view();
    REQUIRE(view);
    REQUIRE(view.value().background);
    REQUIRE(view.value().actors.size() == 1);
    CHECK(view.value().actors.front().character == core::CharacterId::create("hero").value());
    CHECK_FALSE(view.value().actors.front().visible);
    CHECK(view.value().actors.front().presentation_complete);
    auto runtime_ui = kernel->runtime_ui_view("en");
    REQUIRE(runtime_ui);
    CHECK(runtime_ui.value().mode == "scene");
    REQUIRE(runtime_ui.value().scene);
    CHECK(runtime_ui.value().scene->scene == view.value().scene);
    REQUIRE(runtime_ui.value().scene->actors.size() == 1);
    CHECK(runtime_ui.value().scene->actors.front().character ==
          view.value().actors.front().character);
    CHECK_FALSE(runtime_ui.value().dialogue);
    CHECK_FALSE(runtime_ui.value().room);
    CHECK_FALSE(runtime_ui.value().interaction);

    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    REQUIRE(std::holds_alternative<core::DialogueFrame>(kernel->state().flow_stack().back()));
    REQUIRE(kernel->flow().return_from_flow());
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    REQUIRE(kernel->gateway().command_queue().size() == 1);
    auto autosave = kernel->gateway().command_queue().pop_front();
    REQUIRE(autosave.has_value());
    REQUIRE(std::holds_alternative<runtime::RequestAutosaveCommand>(autosave->payload));

    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(kernel->state().presented_text()->text == "Inline text.");
    CHECK(kernel->state().text_log().size() == 1);

    auto localized = kernel->run_until_blocked(1, "en");
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(localized));
    auto localized_blocker = active_blocker(*kernel);
    CHECK(kernel->state().presented_text()->text == "Welcome.");
    const auto localized_owner = core::flow_blocker_owner(localized_blocker);
    const auto localized_handle = core::flow_blocker_handle(localized_blocker);
    REQUIRE(kernel->complete(localized_owner, localized_handle));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_scene(*kernel).position.next_step ==
          core::SceneStepId::create("lua-text").value());

    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(1, "en")));
    auto lua_text_blocker = active_blocker(*kernel);
    REQUIRE(kernel->complete(core::flow_blocker_owner(lua_text_blocker),
                             core::flow_blocker_handle(lua_text_blocker)));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(kernel->state().presented_text()->text == "Dynamic line.");

    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(1, "en")));
    auto audio_blocker = active_blocker(*kernel);
    CHECK(core::flow_blocker_kind(audio_blocker) == core::FlowBlockerKind::Audio);
    auto pending_audio = kernel->take_pending_audio_operations();
    REQUIRE(pending_audio.size() == 1);
    CHECK(pending_audio.front().asset == core::AssetId::create("audio-voice").value());
    CHECK(pending_audio.front().completion.has_value());
    CHECK(kernel->state().desired_audio().empty());
    REQUIRE(kernel->complete(core::flow_blocker_owner(audio_blocker),
                             core::flow_blocker_handle(audio_blocker)));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(kernel->state().desired_audio().empty());

    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(kernel->state().variable(project, core::VariableId::create("flag").value()).value() ==
          core::RuntimeValue{true});

    auto script = kernel->run_until_blocked(1, "en");
    const auto* script_blocked = std::get_if<core::FlowBlockedOutcome>(&script);
    REQUIRE(script_blocked != nullptr);
    const auto* script_wait = std::get_if<core::ScriptFlowBlocker>(&script_blocked->blocker);
    REQUIRE(script_wait != nullptr);
    auto resumed = kernel->resume_script(script_wait->owner, script_wait->handle);
    REQUIRE(resumed);
    CHECK(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));

    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(1, "en")));
    auto duration_blocker = active_blocker(*kernel);
    const auto* duration = std::get_if<core::DurationFlowBlocker>(&duration_blocker);
    REQUIRE(duration != nullptr);
    REQUIRE(kernel->advance(duration->owner, duration->handle, std::chrono::milliseconds{1500}));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));

    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(1, "en")));
    auto input_blocker = active_blocker(*kernel);
    REQUIRE(kernel->cancel(core::flow_blocker_owner(input_blocker),
                           core::flow_blocker_handle(input_blocker)));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));

    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(1, "en")));
    auto choice_blocker = active_blocker(*kernel);
    const auto* choice_input = std::get_if<core::InputFlowBlocker>(&choice_blocker);
    REQUIRE(choice_input != nullptr);
    auto choice_view = kernel->scene_view();
    REQUIRE(choice_view);
    REQUIRE(choice_view.value().choice);
    CHECK(choice_view.value().choice->options.size() == 2);
    CHECK_FALSE(kernel->choose_scene_option(choice_input->owner, choice_input->handle,
                                            core::SceneChoiceOptionId::create("missing").value()));
    REQUIRE(kernel->state().blocker());
    REQUIRE(
        kernel->choose_scene_option(choice_input->owner, choice_input->handle,
                                    core::SceneChoiceOptionId::create("layout-option").value()));
    CHECK_FALSE(kernel->state().blocker());
    CHECK_FALSE(
        kernel->choose_scene_option(choice_input->owner, choice_input->handle,
                                    core::SceneChoiceOptionId::create("layout-option").value()));

    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(kernel->state().variable(project, core::VariableId::create("ratio").value()).value() ==
          core::RuntimeValue{0.75});
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    REQUIRE(kernel->state().mounted_layouts().size() == 1);
    CHECK(kernel->state().mounted_layouts().front().layout ==
          core::LayoutId::create("hud-assets").value());

    auto transition = kernel->run_until_blocked(1, "en");
    const auto* transition_blocked = std::get_if<core::FlowBlockedOutcome>(&transition);
    REQUIRE(transition_blocked != nullptr);
    const auto* presentation =
        std::get_if<core::PresentationFlowBlocker>(&transition_blocked->blocker);
    REQUIRE(presentation != nullptr);
    REQUIRE(kernel->pending_presentation_operation());
    CHECK(std::holds_alternative<runtime::PendingSceneTransitionGroupOperation>(
        *kernel->pending_presentation_operation()));
    CHECK(active_scene(*kernel).position.next_step ==
          core::SceneStepId::create("transition").value());
    REQUIRE_FALSE(kernel->state().background_overrides().empty());
    CHECK(kernel->state().background_overrides().back().background.color == "#0f172a");

    kernel->commit_pending_presentation();
    REQUIRE(kernel->complete(presentation->owner, presentation->handle));
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
}

TEST_CASE("typed Scene failures preserve the stable cursor and stale resumes do not mutate state")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.execute("function show_hero() error('actor condition failed') end",
                                    "scene-failure-setup"));
    auto project = load_fixture("scene-program.json");
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    const auto before = active_scene(*kernel).position.next_step;
    auto failed = kernel->run_until_blocked(1, "en");
    REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(failed));
    CHECK(active_scene(*kernel).position.next_step == before);
    CHECK(kernel->state().execution_fault());
}

} // namespace noveltea::script::test
