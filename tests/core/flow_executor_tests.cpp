#include <noveltea/core/flow_executor.hpp>
#include <noveltea/presentation/presentation_operation_requests.hpp>
#include <noveltea/presentation/presentation_coordinator.hpp>

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <type_traits>
#include <utility>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace noveltea::core {
struct FlowExecutorTestAccess {
    static void set_running(FlowExecutor& executor, bool value) { executor.running_flag() = value; }
};
} // namespace noveltea::core

namespace {
template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

TextContent text(std::string value)
{
    return TextContent{InlineText{std::move(value)}, TextMarkup::Plain};
}

compiled::RoomDefinition make_room(RoomId room_id, std::vector<compiled::RoomExit> exits = {})
{
    return compiled::RoomDefinition{
        .identity = {std::move(room_id), std::nullopt, {}},
        .display_name = "Room",
        .description = text("Room"),
        .background = {std::nullopt, std::nullopt, compiled::BackgroundFit::Cover, std::nullopt},
        .lifecycle = {Always{}, Always{}, {}},
        .overlays = {},
        .placements = {},
        .exits = std::move(exits),
    };
}

compiled::RoomDefinition make_room_with_hooks(RoomId room_id,
                                              std::vector<compiled::RoomExit> exits = {})
{
    auto room = make_room(std::move(room_id), std::move(exits));
    room.lifecycle.hooks = {
        compiled::RoomHookProgram{compiled::RoomHookKind::BeforeEnter,
                                  {SetVariable{id<VariableId>("flag"), RuntimeValue{true}},
                                   SetVariable{id<VariableId>("flag"), RuntimeValue{false}}}},
        compiled::RoomHookProgram{compiled::RoomHookKind::AfterEnter,
                                  {SetVariable{id<VariableId>("flag"), RuntimeValue{true}}}},
    };
    return room;
}

compiled::SceneDefinition make_scene(SceneId scene_id, std::string first, std::string second)
{
    std::vector<compiled::SceneInstruction> instructions;
    instructions.emplace_back(
        compiled::SetVariableSceneInstruction{id<SceneStepId>(std::move(first)), std::nullopt,
                                              id<VariableId>("flag"), RuntimeValue{false}});
    instructions.emplace_back(
        compiled::SetVariableSceneInstruction{id<SceneStepId>(std::move(second)), std::nullopt,
                                              id<VariableId>("flag"), RuntimeValue{true}});
    return compiled::SceneDefinition{
        .identity = {std::move(scene_id), std::nullopt, {}},
        .display_name = "Scene",
        .default_background = {std::nullopt, std::nullopt, compiled::BackgroundFit::Cover,
                               std::nullopt},
        .default_layout = std::nullopt,
        .program = {std::move(instructions)},
        .continuation = EndFlow{},
    };
}

compiled::DialogueDefinition make_dialogue(DialogueId dialogue_id)
{
    std::vector<compiled::DialogueBlock> blocks;
    blocks.emplace_back(
        compiled::DialogueSequenceBlock{id<DialogueBlockId>("entry"), std::nullopt, {}});
    return compiled::DialogueDefinition{
        .identity = {std::move(dialogue_id), std::nullopt, {}},
        .display_name = "Dialogue",
        .default_speaker = std::nullopt,
        .program = {std::move(blocks), {}, id<DialogueBlockId>("entry")},
        .settings = {compiled::DialogueLogMode::Everything, false},
        .completion = EndFlow{},
    };
}

CompiledProject make_project(compiled::Entrypoint entrypoint)
{
    const auto hall = id<RoomId>("hall");
    const auto garden = id<RoomId>("garden");
    std::vector<compiled::RoomExit> exits;
    exits.push_back(compiled::RoomExit{id<RoomExitId>("to-garden"), Always{},
                                       compiled::RoomExitDirection::East, text("Garden"), garden});

    compiled::InteractionProgram default_program{
        {}, EndFlow{}, compiled::InteractionOutcome::Handled};
    compiled::InteractionProgram rule_program{
        {compiled::NotifyInstruction{id<InteractionInstructionId>("notify"), text("Done")}},
        EndFlow{},
        compiled::InteractionOutcome::Handled};
    compiled::VerbDefinition verb{{id<VerbId>("look"), std::nullopt, {}},
                                  text("Look"),
                                  0,
                                  Always{},
                                  std::move(default_program),
                                  {},
                                  true};
    compiled::InteractionRule rule{id<InteractionRuleId>("look-rule"),
                                   id<VerbId>("look"),
                                   compiled::AnyInteractionContext{},
                                   {},
                                   std::move(rule_program)};
    compiled::InteractionDefinition interaction{
        {id<InteractionId>("room-actions"), std::nullopt, {}}, {std::move(rule)}};

    compiled::CompiledProjectInput input{
        .identity = {id<ProjectId>("flow-test"), "Flow", "1.0", "", ""},
        .settings = {{compiled::ReferenceResolution{1920, 1080}, "#000000",
                      compiled::WorldRasterPolicy::Capped},
                     {{true, 1.0, 2.0}, {true, 1.0, 2.0}},
                     {},
                     {std::nullopt},
                     {false, true, "Start", "", std::nullopt}},
        .entrypoint = std::move(entrypoint),
        .startup_hook = std::nullopt,
        .localization = {"en", std::nullopt, {compiled::LocalizationCatalog{"en", {}}}},
        .variables = {{id<VariableId>("flag"), BooleanPropertyType{}, RuntimeValue{false}}},
        .properties = {},
        .assets = {},
        .layouts = {},
        .scripts = {},
        .characters = {},
        .rooms = {make_room(hall, std::move(exits)), make_room(garden)},
        .interactables = {},
        .verbs = {std::move(verb)},
        .interactions = {std::move(interaction)},
        .scenes = {make_scene(id<SceneId>("opening"), "opening-a", "opening-b"),
                   make_scene(id<SceneId>("nested"), "nested-a", "nested-b")},
        .dialogues = {make_dialogue(id<DialogueId>("greeting"))},
        .maps = {},
    };
    auto result = CompiledProject::create(std::move(input));
    REQUIRE(result);
    return std::move(result).value();
}

SessionState make_state(const CompiledProject& project)
{
    auto result = SessionState::create(project);
    REQUIRE(result);
    return std::move(result).value();
}

void finish_initial_room_transition(FlowExecutor& executor)
{
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::BeforeEnter));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::AfterEnter));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::Complete));
    REQUIRE(executor.complete_room_transition());
}

SceneFramePosition scene_position(std::string step)
{
    return SceneFramePosition{id<SceneStepId>(std::move(step)), SceneStepReady{}};
}
} // namespace

TEST_CASE("flow state initializes entrypoint frames and only executor changes mode and stack")
{
    STATIC_REQUIRE(std::variant_size_v<FlowFrame> == 4);
    STATIC_REQUIRE(std::variant_size_v<ReturnDestination> == 3);
    STATIC_REQUIRE(std::variant_size_v<FlowBlocker> == 5);
    STATIC_REQUIRE(std::variant_size_v<AnyFlowBlockerHandle> == 5);

    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    REQUIRE(state.flow_stack().size() == 1);
    const auto initial_id = flow_frame_id(state.flow_stack().front()).number();
    finish_initial_room_transition(executor);
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
    CHECK(state.flow_stack().empty());

    REQUIRE(executor.start_transient(id<SceneId>("opening")));
    REQUIRE(state.flow_stack().size() == 1);
    CHECK(flow_frame_id(state.flow_stack().front()).number() > initial_id);
    CHECK(std::holds_alternative<ResumeRoomDestination>(
        flow_return_destination(state.flow_stack().front())));
}

TEST_CASE("child calls advance callers atomically and nested returns preserve explicit stack order")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);
    REQUIRE(executor.start_transient(id<SceneId>("opening")));
    const auto root_id = flow_frame_id(state.flow_stack().back()).number();

    REQUIRE(
        executor.call_child(id<DialogueId>("greeting"), std::nullopt, scene_position("opening-b")));
    REQUIRE(state.flow_stack().size() == 2);
    CHECK(std::get<SceneFrame>(state.flow_stack().front()).position.next_step ==
          id<SceneStepId>("opening-b"));
    const auto dialogue_id = flow_frame_id(state.flow_stack().back()).number();
    CHECK(dialogue_id > root_id);

    const DialogueFramePosition dialogue_next{id<DialogueBlockId>("entry"), std::nullopt,
                                              std::nullopt, DialogueFramePosition::Stage::Complete,
                                              0};
    REQUIRE(executor.call_child(id<SceneId>("nested"), dialogue_next));
    REQUIRE(state.flow_stack().size() == 3);
    CHECK(flow_frame_id(state.flow_stack().back()).number() > dialogue_id);
    REQUIRE(executor.return_from_flow());
    REQUIRE(state.flow_stack().size() == 2);
    CHECK(std::get<DialogueFrame>(state.flow_stack().back()).position.stage ==
          DialogueFramePosition::Stage::Complete);
    REQUIRE(executor.return_from_flow());
    REQUIRE(state.flow_stack().size() == 1);
    REQUIRE(executor.return_from_flow());
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
    CHECK(state.flow_stack().empty());
}

TEST_CASE("invalid child targets and positions fault without partially advancing the caller")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);
    REQUIRE(executor.start_transient(id<SceneId>("opening")));
    const auto before = std::get<SceneFrame>(state.flow_stack().back()).position.next_step;
    const auto frame_id = flow_frame_id(state.flow_stack().back());

    CHECK_FALSE(executor.call_child(id<SceneId>("missing"), scene_position("opening-b")));
    REQUIRE(state.execution_fault());
    CHECK(state.flow_stack().size() == 1);
    CHECK(flow_frame_id(state.flow_stack().back()) == frame_id);
    CHECK(std::get<SceneFrame>(state.flow_stack().back()).position.next_step == before);
    REQUIRE(executor.discard_fault());
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
}

TEST_CASE("Interaction roots retain typed invocation program and instruction positions")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);
    InteractionInvocationContext invocation{id<VerbId>("look"), id<RoomId>("hall"), {}};
    InteractionProgramRef program = InteractionRuleProgramRef{id<InteractionId>("room-actions"),
                                                              id<InteractionRuleId>("look-rule")};
    REQUIRE(executor.start_interaction(invocation, program));
    const auto& frame = std::get<InteractionFrame>(state.flow_stack().back());
    CHECK(frame.invocation.verb == id<VerbId>("look"));
    CHECK(frame.position.next_instruction == id<InteractionInstructionId>("notify"));
    CHECK(frame.position.fallback_stage == InteractionFallbackStage::SelectedProgram);
    CHECK(std::holds_alternative<ResumeRoomDestination>(frame.destination));
}

TEST_CASE("root NoReturn rejects Return and explicit discard ends the session")
{
    const auto project = make_project(id<SceneId>("opening"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    CHECK_FALSE(executor.return_from_flow());
    REQUIRE(state.execution_fault());
    CHECK(state.flow_stack().size() == 1);
    REQUIRE(executor.discard_fault());
    CHECK(std::holds_alternative<EndedMode>(state.mode()));
    CHECK(state.flow_stack().empty());
}

TEST_CASE("terminal replacement preserves depth and destination while invalidating old blockers")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);
    REQUIRE(executor.start_transient(id<SceneId>("opening")));
    const auto old_id = flow_frame_id(state.flow_stack().back());
    auto blocker = executor.block_top(FlowBlockerKind::Input);
    REQUIRE(blocker);

    REQUIRE(executor.apply_target(FlowTarget{id<DialogueId>("greeting")}));
    REQUIRE(state.flow_stack().size() == 1);
    CHECK_FALSE(state.blocker());
    CHECK(flow_frame_id(state.flow_stack().back()) != old_id);
    CHECK(std::holds_alternative<ResumeRoomDestination>(
        flow_return_destination(state.flow_stack().back())));

    REQUIRE(executor.apply_target(FlowTarget{id<RoomId>("garden")}));
    REQUIRE(state.flow_stack().size() == 1);
    const auto& transition = std::get<RoomTransitionFrame>(state.flow_stack().back());
    REQUIRE(transition.source_room);
    CHECK(*transition.source_room == id<RoomId>("hall"));
    CHECK(transition.target_room == id<RoomId>("garden"));
    REQUIRE(executor.apply_target(FlowTarget{EndFlow{}}));
    CHECK(std::holds_alternative<EndedMode>(state.mode()));
    CHECK(state.flow_stack().empty());
}

TEST_CASE("invalid terminal targets preserve the active frame and fail stop execution")
{
    const auto project = make_project(id<SceneId>("opening"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    const auto frame_id = flow_frame_id(state.flow_stack().back());
    const auto position = flow_frame_position(state.flow_stack().back());
    CHECK_FALSE(executor.apply_target(FlowTarget{id<DialogueId>("missing")}));
    REQUIRE(state.execution_fault());
    REQUIRE(state.flow_stack().size() == 1);
    CHECK(flow_frame_id(state.flow_stack().back()) == frame_id);
    CHECK(std::get<SceneFramePosition>(flow_frame_position(state.flow_stack().back())).next_step ==
          std::get<SceneFramePosition>(position).next_step);
}

TEST_CASE("blocker resume and cancellation require exact owner handle and kind")
{
    const auto project = make_project(id<SceneId>("opening"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    const auto wrong_owner = flow_frame_id(state.flow_stack().front());
    REQUIRE(executor.call_child(id<SceneId>("nested"), scene_position("opening-b")));
    auto blocker = executor.block_top(FlowBlockerKind::Presentation);
    REQUIRE(blocker);
    const auto owner = flow_blocker_owner(blocker.value());
    const auto handle = flow_blocker_handle(blocker.value());
    CHECK(flow_blocker_kind(blocker.value()) == FlowBlockerKind::Presentation);
    CHECK(owner != wrong_owner);
    CHECK_FALSE(executor.resume_blocker(wrong_owner, handle));
    REQUIRE(state.blocker());
    REQUIRE(executor.resume_blocker(owner, handle));
    CHECK_FALSE(state.blocker());
    CHECK_FALSE(executor.resume_blocker(owner, handle));

    auto second = executor.block_top(FlowBlockerKind::Script);
    REQUIRE(second);
    const auto script_handle = flow_blocker_handle(second.value());
    REQUIRE(executor.cancel_blocker(flow_blocker_owner(second.value()), script_handle));
    CHECK_FALSE(state.blocker());

    auto third = executor.block_top(FlowBlockerKind::Presentation);
    REQUIRE(third);
    CHECK_FALSE(executor.resume_blocker(flow_blocker_owner(third.value()), script_handle));
    REQUIRE(state.blocker());
    REQUIRE(executor.resume_blocker(flow_blocker_owner(third.value()),
                                    flow_blocker_handle(third.value())));
    CHECK_FALSE(state.blocker());
}

TEST_CASE("direct Room navigation validates exits and rejected transitions resume their source")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);
    const compiled::RoomExitRef exit{id<RoomId>("hall"), id<RoomExitId>("to-garden")};
    REQUIRE(executor.start_navigation(id<RoomId>("garden"), exit));
    const auto& transition = std::get<RoomTransitionFrame>(state.flow_stack().back());
    REQUIRE(transition.selected_exit);
    CHECK(transition.position.stage == RoomTransitionStage::SourceCanLeave);
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::ExitCondition));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::TargetCanEnter));
    REQUIRE(executor.reject_room_transition());
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
}

TEST_CASE(
    "fault discard selects precommit source postcommit target and no-source Ended destinations")
{
    const auto project = make_project(id<RoomId>("hall"));

    SECTION("precommit resumes source")
    {
        auto state = make_state(project);
        FlowExecutor executor(project, state);
        finish_initial_room_transition(executor);
        REQUIRE(executor.start_transient(id<SceneId>("opening")));
        REQUIRE(executor.apply_target(FlowTarget{id<RoomId>("garden")}));
        CHECK(std::holds_alternative<FlowFaultOutcome>(executor.run_until_blocked(1)));
        REQUIRE(executor.discard_fault());
        CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
    }

    SECTION("postcommit resumes target")
    {
        auto state = make_state(project);
        FlowExecutor executor(project, state);
        finish_initial_room_transition(executor);
        REQUIRE(executor.start_transient(id<SceneId>("opening")));
        REQUIRE(executor.apply_target(FlowTarget{id<RoomId>("garden")}));
        REQUIRE(executor.advance_room_transition(RoomTransitionStage::TargetCanEnter));
        REQUIRE(executor.advance_room_transition(RoomTransitionStage::BeforeLeave));
        REQUIRE(executor.advance_room_transition(RoomTransitionStage::BeforeEnter));
        REQUIRE(executor.advance_room_transition(RoomTransitionStage::CommitRoomSwitch));
        REQUIRE(executor.advance_room_transition(RoomTransitionStage::AfterLeave));
        CHECK(std::holds_alternative<FlowFaultOutcome>(executor.run_until_blocked(1)));
        REQUIRE(executor.discard_fault());
        CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("garden"));
    }

    SECTION("initial transition has no discardable Room")
    {
        auto state = make_state(project);
        FlowExecutor executor(project, state);
        CHECK(std::holds_alternative<FlowFaultOutcome>(executor.run_until_blocked(1)));
        REQUIRE(executor.discard_fault());
        CHECK(std::holds_alternative<EndedMode>(state.mode()));
    }
}

TEST_CASE("bounded execution reports blockers and completed gameplay modes as closed outcomes")
{
    const auto project = make_project(id<SceneId>("opening"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    auto blocker = executor.block_top(FlowBlockerKind::Input);
    REQUIRE(blocker);
    const auto blocked = executor.run_until_blocked(8);
    REQUIRE(std::holds_alternative<FlowBlockedOutcome>(blocked));
    CHECK(flow_blocker_handle(std::get<FlowBlockedOutcome>(blocked).blocker) ==
          flow_blocker_handle(blocker.value()));
    REQUIRE(executor.apply_target(FlowTarget{EndFlow{}}));
    const auto mode_changed = executor.run_until_blocked(8);
    REQUIRE(std::holds_alternative<FlowModeChangedOutcome>(mode_changed));
    CHECK(std::holds_alternative<EndedMode>(std::get<FlowModeChangedOutcome>(mode_changed).mode));
}

TEST_CASE("bounded execution yields deterministically and rejects reentrant entry")
{
    const auto project = make_project(id<SceneId>("opening"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    const auto yielded = executor.run_until_blocked(0);
    REQUIRE(std::holds_alternative<FlowBudgetYieldOutcome>(yielded));
    CHECK(std::get<FlowBudgetYieldOutcome>(yielded).executed_units == 0);
    CHECK_FALSE(state.execution_fault());

    FlowExecutor second_executor(project, state);
    FlowExecutorTestAccess::set_running(executor, true);
    const auto reentrant = second_executor.run_until_blocked(1);
    REQUIRE(std::holds_alternative<FlowFaultOutcome>(reentrant));
    CHECK(std::get<FlowFaultOutcome>(reentrant).diagnostics.front().code ==
          "execution.non_reentrant");
    FlowExecutorTestAccess::set_running(executor, false);
    REQUIRE(state.execution_fault());
    REQUIRE(executor.discard_fault());
    CHECK(std::holds_alternative<EndedMode>(state.mode()));
}

TEST_CASE("discarding an empty-stack kernel fault preserves a valid Room mode")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);
    FlowExecutor second_executor(project, state);

    FlowExecutorTestAccess::set_running(executor, true);
    CHECK(std::holds_alternative<FlowFaultOutcome>(second_executor.run_until_blocked(1)));
    FlowExecutorTestAccess::set_running(executor, false);
    REQUIRE(state.execution_fault());
    REQUIRE(executor.discard_fault());
    CHECK_FALSE(state.execution_fault());
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
    CHECK(state.flow_stack().empty());
}

TEST_CASE("FlowExecutor is a unique noncopyable mutation service")
{
    STATIC_REQUIRE_FALSE(std::is_copy_constructible_v<FlowExecutor>);
    STATIC_REQUIRE_FALSE(std::is_copy_assignable_v<FlowExecutor>);
    STATIC_REQUIRE_FALSE(std::is_move_constructible_v<FlowExecutor>);
    STATIC_REQUIRE_FALSE(std::is_move_assignable_v<FlowExecutor>);
}

TEST_CASE("invalid Room-mode starts fail without faulting or ending the active Room")
{
    const auto project = make_project(id<RoomId>("hall"));
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    finish_initial_room_transition(executor);

    CHECK_FALSE(executor.start_transient(id<SceneId>("missing")));
    CHECK_FALSE(state.execution_fault());
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
    CHECK(state.flow_stack().empty());

    const compiled::RoomExitRef missing_exit{id<RoomId>("hall"), id<RoomExitId>("missing")};
    CHECK_FALSE(executor.start_navigation(id<RoomId>("garden"), missing_exit));
    CHECK_FALSE(state.execution_fault());
    CHECK(std::get<RoomMode>(state.mode()).room == id<RoomId>("hall"));
}

TEST_CASE("child-call cursor validation rejects incoherent Dialogue and Room positions atomically")
{
    const auto project = make_project(id<RoomId>("hall"));

    SECTION("Dialogue FollowEdge requires an edge owned by the current block")
    {
        auto state = make_state(project);
        FlowExecutor executor(project, state);
        finish_initial_room_transition(executor);
        REQUIRE(executor.start_transient(id<DialogueId>("greeting")));
        const DialogueFramePosition invalid{id<DialogueBlockId>("entry"), std::nullopt,
                                            std::nullopt, DialogueFramePosition::Stage::FollowEdge,
                                            0};
        CHECK_FALSE(executor.call_child(id<SceneId>("nested"), invalid));
        REQUIRE(state.execution_fault());
        CHECK(state.flow_stack().size() == 1);
        const auto& position = std::get<DialogueFrame>(state.flow_stack().back()).position;
        CHECK(position.block == id<DialogueBlockId>("entry"));
        CHECK(position.stage == DialogueFramePosition::Stage::EnterBlock);
        CHECK_FALSE(position.segment);
        CHECK_FALSE(position.edge);
    }

    SECTION("Room transition effect cursors must fit their active hook")
    {
        auto state = make_state(project);
        FlowExecutor executor(project, state);
        const RoomTransitionPosition invalid{RoomTransitionStage::BeforeEnter, 999};
        CHECK_FALSE(executor.call_child(id<SceneId>("nested"), invalid));
        REQUIRE(state.execution_fault());
        CHECK(state.flow_stack().size() == 1);
        const auto& position = std::get<RoomTransitionFrame>(state.flow_stack().back()).position;
        CHECK(position.stage == RoomTransitionStage::TargetCanEnter);
        CHECK(position.next_effect == 0);
    }
}

TEST_CASE("Room transition hooks advance one indexed effect at a time and cannot be skipped")
{
    const auto hall = id<RoomId>("hall");
    compiled::CompiledProjectInput input{
        .identity = {id<ProjectId>("hook-test"), "Hooks", "1.0", "", ""},
        .settings = {{compiled::ReferenceResolution{1920, 1080}, "#000000",
                      compiled::WorldRasterPolicy::Capped},
                     {{true, 1.0, 2.0}, {true, 1.0, 2.0}},
                     {},
                     {std::nullopt},
                     {false, true, "Start", "", std::nullopt}},
        .entrypoint = hall,
        .startup_hook = std::nullopt,
        .localization = {"en", std::nullopt, {compiled::LocalizationCatalog{"en", {}}}},
        .variables = {{id<VariableId>("flag"), BooleanPropertyType{}, RuntimeValue{false}}},
        .properties = {},
        .assets = {},
        .layouts = {},
        .scripts = {},
        .characters = {},
        .rooms = {make_room_with_hooks(hall)},
        .interactables = {},
        .verbs = {},
        .interactions = {},
        .scenes = {},
        .dialogues = {},
        .maps = {},
    };
    auto project_result = CompiledProject::create(std::move(input));
    REQUIRE(project_result);
    auto project = std::move(project_result).value();
    auto state = make_state(project);
    FlowExecutor executor(project, state);

    REQUIRE(executor.advance_room_transition(RoomTransitionStage::BeforeEnter));
    CHECK_FALSE(executor.advance_room_transition(RoomTransitionStage::BeforeEnter, 2));
    REQUIRE(state.execution_fault());
    const auto& failed = std::get<RoomTransitionFrame>(state.flow_stack().back());
    CHECK(failed.position.next_effect == 0);
    REQUIRE(executor.discard_fault());
    CHECK(std::holds_alternative<EndedMode>(state.mode()));

    auto fresh_state = make_state(project);
    FlowExecutor fresh_executor(project, fresh_state);
    REQUIRE(fresh_executor.advance_room_transition(RoomTransitionStage::BeforeEnter));
    CHECK_FALSE(fresh_executor.advance_room_transition(RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(fresh_state.execution_fault());
}

TEST_CASE("awaited Scene and Room finite operations register exact causal ownership")
{
    const auto opening = id<SceneId>("opening");
    const auto project = make_project(opening);
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    auto blocked = executor.block_top(FlowBlockerKind::Presentation);
    REQUIRE(blocked);
    const auto& presentation = std::get<PresentationFlowBlocker>(blocked.value());
    const PresentationFlowCompletion completion{presentation.owner, presentation.handle};

    PresentationCoordinator coordinator;
    SceneTransitionGroupOperation scene_operation{
        .common = {.id = PresentationOperationId::from_number(1),
                   .duration = std::chrono::milliseconds{250},
                   .skippable = true,
                   .clock = LayoutClockDomain::Gameplay,
                   .revisions = {PresentationSnapshotRevision::from_number(1),
                                 PresentationSnapshotRevision::from_number(2)}},
        .kind = compiled::TransitionKind::Fade,
        .color = std::string{"#000000"},
        .completion = completion,
    };
    auto accepted_scene = coordinator.accept(PresentationOperation{scene_operation});
    REQUIRE(accepted_scene);
    CHECK(accepted_scene.value().metadata.checkpoint_class == CheckpointClass::CausalBarrier);
    CHECK(std::get<PresentationFlowCompletion>(accepted_scene.value().metadata.completion) ==
          completion);

    RoomNavigationTransitionOperation room_operation{
        .common = {.id = PresentationOperationId::from_number(2),
                   .duration = std::chrono::milliseconds{300},
                   .skippable = false,
                   .clock = LayoutClockDomain::Gameplay,
                   .revisions = {PresentationSnapshotRevision::from_number(2),
                                 PresentationSnapshotRevision::from_number(3)}},
        .target = {.source_room = id<RoomId>("hall"), .target_room = id<RoomId>("garden")},
        .kind = compiled::TransitionKind::Dissolve,
        .color = std::nullopt,
        .completion = completion,
    };
    auto accepted_room = coordinator.accept(PresentationOperation{room_operation});
    REQUIRE(accepted_room);
    CHECK(accepted_room.value().metadata.checkpoint_class == CheckpointClass::CausalBarrier);
    CHECK(std::get<PresentationFlowCompletion>(accepted_room.value().metadata.completion) ==
          completion);
    CHECK(std::holds_alternative<RoomNavigationOperationTarget>(
        operation_target(FinitePresentationOperation{room_operation})));
}
