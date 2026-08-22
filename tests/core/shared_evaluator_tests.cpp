#include <noveltea/core/property_resolver.hpp>
#include <noveltea/core/shared_evaluator.hpp>

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <string>
#include <utility>

using namespace std::chrono_literals;
using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

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

PropertyDefinition global_property(std::string name, PropertyValueType type,
                                   RuntimeValue default_value)
{
    auto definition = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>(std::move(name)),
        .value_type = std::move(type),
        .nullable = false,
        .default_value = std::move(default_value),
        .scope = PropertyScope::Global,
        .allowed_owners = {},
    });
    REQUIRE(definition);
    return std::move(definition).value();
}

CompiledProject make_project()
{
    compiled::RoomDefinition room{
        .identity = {id<RoomId>("hall"), {}, {}},
        .display_name = "Hall",
        .description = text("Hall"),
        .background = {std::nullopt, std::nullopt, compiled::BackgroundFit::Cover, std::nullopt},
        .lifecycle = {Always{}, Always{}},
        .overlays = {},
        .placements = {},
        .exits = {},
    };
    compiled::CompiledProjectInput input{
        .identity = {id<ProjectId>("evaluation-test"), "Evaluation", "1.0", "", ""},
        .settings = {{compiled::ReferenceResolution{1920, 1080}, "#000000",
                      compiled::WorldRasterPolicy::Capped},
                     {{true, 1.0, 2.0}, {true, 1.0, 2.0}},
                     {},
                     {std::nullopt},
                     {false, true, "Start", "", std::nullopt}},
        .entrypoint = id<RoomId>("hall"),
        .bootstrap_module = id<ScriptId>("bootstrap"),
        .save_contract = "sc1:00000000000000000000000000000000",
        .localization = {"en",
                         std::string{"fr"},
                         {compiled::LocalizationCatalog{
                              "en", {{"greeting", "Hello"}, {"default-only", "Default"}}},
                          compiled::LocalizationCatalog{
                              "fr", {{"greeting", "Bonjour"}, {"fallback-only", "Secours"}}},
                          compiled::LocalizationCatalog{"de", {{"greeting", "Hallo"}}}}},
        .properties = {global_property("flag", BooleanPropertyType{}, RuntimeValue{false}),
                       global_property("count", IntegerPropertyType{},
                                       RuntimeValue{std::int64_t{3}}),
                       global_property("ratio", NumberPropertyType{}, RuntimeValue{1.5}),
                       global_property("name", StringPropertyType{},
                                       RuntimeValue{std::string{"beta"}}),
                       global_property("mood", EnumPropertyType{{"calm", "tense"}},
                                       RuntimeValue{std::string{"calm"}})},
        .traits = {},
        .assets = {},
        .layouts = {},
        .scripts = {{id<ScriptId>("bootstrap"), compiled::InlineLuaSource{"return {}"}}},
        .characters = {},
        .rooms = {std::move(room)},
        .interactables = {},
        .verbs = {},
        .interactions = {},
        .scenes = {},
        .dialogues = {},
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

bool condition_value(SharedPrimitiveEvaluator& evaluator, Condition condition)
{
    auto result = evaluator.evaluate(condition);
    REQUIRE(result);
    return result.value();
}

const WaitBlocked& blocked_wait(const Result<WaitEvaluation, Diagnostics>& result)
{
    REQUIRE(result);
    const auto* blocked = std::get_if<WaitBlocked>(&result.value());
    REQUIRE(blocked != nullptr);
    return *blocked;
}
} // namespace

TEST_CASE("shared condition evaluation covers every non-script Global Property comparison form")
{
    const auto project = make_project();
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    SharedPrimitiveEvaluator evaluator(project, state, executor);

    CHECK(condition_value(evaluator, Always{}));
    CHECK_FALSE(condition_value(
        evaluator, GlobalPropertyTruthiness{id<PropertyId>("flag"), TruthinessOperator::Truthy}));
    CHECK(condition_value(
        evaluator, GlobalPropertyTruthiness{id<PropertyId>("flag"), TruthinessOperator::Falsy}));
    CHECK(condition_value(evaluator, GlobalPropertyValueComparison{id<PropertyId>("count"),
                                                                   ValueComparisonOperator::Equal,
                                                                   RuntimeValue{std::int64_t{3}}}));
    CHECK(condition_value(evaluator, GlobalPropertyValueComparison{
                                         id<PropertyId>("count"), ValueComparisonOperator::NotEqual,
                                         RuntimeValue{std::int64_t{4}}}));
    CHECK(condition_value(evaluator, GlobalPropertyValueComparison{id<PropertyId>("count"),
                                                                   ValueComparisonOperator::Less,
                                                                   RuntimeValue{std::int64_t{4}}}));
    CHECK(
        condition_value(evaluator, GlobalPropertyValueComparison{id<PropertyId>("count"),
                                                                 ValueComparisonOperator::LessEqual,
                                                                 RuntimeValue{std::int64_t{3}}}));
    CHECK(condition_value(evaluator, GlobalPropertyValueComparison{id<PropertyId>("ratio"),
                                                                   ValueComparisonOperator::Greater,
                                                                   RuntimeValue{std::int64_t{1}}}));
    CHECK(condition_value(evaluator,
                          GlobalPropertyValueComparison{id<PropertyId>("name"),
                                                        ValueComparisonOperator::GreaterEqual,
                                                        RuntimeValue{std::string{"alpha"}}}));

    auto missing = evaluator.evaluate(
        GlobalPropertyTruthiness{id<PropertyId>("missing"), TruthinessOperator::Truthy});
    REQUIRE_FALSE(missing);
    CHECK(missing.error().front().code == "execution.unknown_global_property");
    auto invalid_truthiness = evaluator.evaluate(
        GlobalPropertyTruthiness{id<PropertyId>("count"), TruthinessOperator::Truthy});
    REQUIRE_FALSE(invalid_truthiness);
    CHECK(invalid_truthiness.error().front().code == "execution.invalid_truthiness_value");
    auto invalid_order = evaluator.evaluate(GlobalPropertyValueComparison{
        id<PropertyId>("mood"), ValueComparisonOperator::Less, RuntimeValue{std::string{"tense"}}});
    REQUIRE_FALSE(invalid_order);
    CHECK(invalid_order.error().front().code == "execution.invalid_comparison_operator");
    auto script = evaluator.evaluate(LuaPredicate{"return true"});
    REQUIRE_FALSE(script);
    CHECK(script.error().front().code == "execution.lua_condition_requires_script_runtime");
}

TEST_CASE("shared effects mutate only declared type-compatible Global Properties")
{
    const auto project = make_project();
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    SharedPrimitiveEvaluator evaluator(project, state, executor);
    PropertyResolver resolver(project, state);

    REQUIRE(evaluator.apply(SetGlobalProperty{id<PropertyId>("flag"), RuntimeValue{true}}));
    CHECK(std::get<RuntimeValue>(resolver.get_global(id<PropertyId>("flag")).value()) ==
          RuntimeValue{true});
    CHECK_FALSE(evaluator.apply(
        SetGlobalProperty{id<PropertyId>("flag"), RuntimeValue{std::string{"true"}}}));
    CHECK_FALSE(evaluator.apply(SetGlobalProperty{id<PropertyId>("missing"), RuntimeValue{true}}));
    auto script = evaluator.apply(RunLuaEffect{"flag = true"});
    REQUIRE_FALSE(script);
    CHECK(script.error().front().code == "execution.lua_effect_requires_script_runtime");
    CHECK(std::get<RuntimeValue>(resolver.get_global(id<PropertyId>("flag")).value()) ==
          RuntimeValue{true});
}

TEST_CASE("shared text resolution handles inline locale fallback and script boundaries")
{
    const auto project = make_project();
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    SharedPrimitiveEvaluator evaluator(project, state, executor);

    CHECK(evaluator.resolve(InlineText{"Direct"}, "de").value() == "Direct");
    CHECK(evaluator.resolve(LocalizedTextKey{"greeting"}, "de").value() == "Hallo");
    CHECK(evaluator.resolve(LocalizedTextKey{"default-only"}, "de").value() == "Default");
    CHECK(evaluator.resolve(LocalizedTextKey{"fallback-only"}, "de").value() == "Secours");
    auto missing = evaluator.resolve(LocalizedTextKey{"missing"}, "de");
    REQUIRE_FALSE(missing);
    CHECK(missing.error().front().code == "execution.missing_localized_text");
    auto script = evaluator.resolve(LuaTextExpression{"return name"}, "en");
    REQUIRE_FALSE(script);
    CHECK(script.error().front().code == "execution.lua_text_requires_script_runtime");
}

TEST_CASE("engine waits create typed owner-bound logical state and complete or cancel exactly")
{
    const auto project = make_project();
    auto state = make_state(project);
    FlowExecutor executor(project, state);
    SharedPrimitiveEvaluator evaluator(project, state, executor);

    auto immediate = evaluator.begin(ImmediateWait{});
    REQUIRE(immediate);
    CHECK(std::holds_alternative<WaitCompleted>(immediate.value()));
    CHECK_FALSE(state.blocker());

    auto input = evaluator.begin(InputWait{});
    const auto& input_blocked = blocked_wait(input);
    CHECK(flow_blocker_kind(input_blocked.blocker) == FlowBlockerKind::Input);
    const auto input_owner = flow_blocker_owner(input_blocked.blocker);
    const auto input_handle = flow_blocker_handle(input_blocked.blocker);
    REQUIRE(evaluator.complete(input_owner, input_handle));
    CHECK_FALSE(state.blocker());
    CHECK_FALSE(evaluator.complete(input_owner, input_handle));

    auto presentation = evaluator.begin(PresentationCompletionWait{});
    const auto& presentation_blocked = blocked_wait(presentation);
    CHECK(flow_blocker_kind(presentation_blocked.blocker) == FlowBlockerKind::Presentation);
    CHECK_FALSE(evaluator.complete(flow_blocker_owner(presentation_blocked.blocker), input_handle));
    REQUIRE(state.blocker());
    REQUIRE(evaluator.cancel(flow_blocker_owner(presentation_blocked.blocker),
                             flow_blocker_handle(presentation_blocked.blocker)));

    auto audio = evaluator.begin(AudioCompletionWait{});
    const auto& audio_blocked = blocked_wait(audio);
    CHECK(flow_blocker_kind(audio_blocked.blocker) == FlowBlockerKind::Audio);
    REQUIRE(evaluator.complete(flow_blocker_owner(audio_blocked.blocker),
                               flow_blocker_handle(audio_blocked.blocker)));

    auto duration_result = DurationWait::create(25ms);
    REQUIRE(duration_result);
    auto duration = evaluator.begin(duration_result.value());
    const auto& duration_blocked = blocked_wait(duration);
    const auto* duration_state = std::get_if<DurationFlowBlocker>(&duration_blocked.blocker);
    REQUIRE(duration_state != nullptr);
    CHECK(duration_state->remaining == 25ms);
    auto pending = evaluator.advance(duration_state->owner, duration_state->handle, 10ms);
    REQUIRE(pending);
    CHECK_FALSE(pending.value());
    REQUIRE(state.blocker());
    CHECK(std::get<DurationFlowBlocker>(*state.blocker()).remaining == 15ms);
    auto complete = evaluator.advance(duration_state->owner, duration_state->handle, 15ms);
    REQUIRE(complete);
    CHECK(complete.value());
    CHECK_FALSE(state.blocker());
    CHECK_FALSE(evaluator.advance(duration_state->owner, duration_state->handle, 1ms));

    auto zero_result = DurationWait::create(0ms);
    REQUIRE(zero_result);
    auto zero = evaluator.begin(zero_result.value());
    REQUIRE(zero);
    CHECK(std::holds_alternative<WaitCompleted>(zero.value()));

    auto child = evaluator.begin(ChildFlowCompletionWait{});
    REQUIRE_FALSE(child);
    CHECK(child.error().front().code == "execution.child_flow_wait_requires_call");
    auto script = evaluator.begin(ScriptCompletionWait{});
    REQUIRE_FALSE(script);
    CHECK(script.error().front().code == "execution.script_wait_requires_script_runtime");
    CHECK_FALSE(state.blocker());
}
