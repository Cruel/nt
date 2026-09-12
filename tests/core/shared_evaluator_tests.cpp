#include <noveltea/core/message_realization.hpp>
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
                         "en",
                         {{"en", std::nullopt, true},
                          {"fr", std::nullopt, true},
                          {"de", std::string{"fr"}, true}},
                         {compiled::LocalizationCatalog{
                              "en", {{0, "Hello"}, {1, "Default"}, {2, "Fallback"}}},
                          compiled::LocalizationCatalog{"fr", {{0, "Bonjour"}, {2, "Secours"}}},
                          compiled::LocalizationCatalog{"de", {{0, "Hallo"}}}}},
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
    CHECK(evaluator.resolve(MessageRef{0}, "de").value() == "Hallo");
    CHECK(evaluator.resolve(MessageRef{1}, "de").value() == "Default");
    CHECK(evaluator.resolve(MessageRef{2}, "de").value() == "Fallback");
    auto missing = evaluator.resolve(MessageRef{99}, "de");
    REQUIRE_FALSE(missing);
    CHECK(missing.error().front().code == "execution.missing_message");
    auto script = evaluator.resolve(LuaTextExpression{"return name"}, "en");
    REQUIRE_FALSE(script);
    CHECK(script.error().front().code == "execution.lua_text_requires_script_runtime");
}

TEST_CASE("Message realization negotiates supported locale tags independently of authoring parents")
{
    compiled::Localization localization;
    localization.source_locale = "en";
    localization.default_locale = "fr";
    localization.locales = {
        {"en", std::nullopt, true},         {"de", std::nullopt, true},
        {"fr", std::nullopt, true},         {"fr-CA", std::string{"de"}, false},
        {"fr-FR", std::string{"de"}, true},
    };
    localization.catalogs = {
        {"en", {{0, "Source"}, {1, "Source only"}}},
        {"de", {{0, "Deutsch"}}},
        {"fr", {{0, "Français"}}},
        {"fr-FR", {{0, "Français (France)"}}},
    };

    const MessageRealizer realizer(localization);

    const auto exact = realizer.realize({0, "fr-FR"});
    REQUIRE(exact);
    CHECK(exact->text == "Français (France)");
    CHECK(exact->locale == "fr-FR");

    const auto less_specific = realizer.realize({0, "fr-CA"});
    REQUIRE(less_specific);
    CHECK(less_specific->text == "Français");
    CHECK(less_specific->locale == "fr");

    const auto source = realizer.realize({1, "fr-CA"});
    REQUIRE(source);
    CHECK(source->text == "Source only");
    CHECK(source->locale == "en");
}

TEST_CASE("Message realization supplies engine system defaults and accepts Project overrides")
{
    compiled::Localization localization;
    localization.source_locale = "en";
    localization.default_locale = "pt-BR";
    localization.locales = {{"en", std::nullopt, true}, {"pt-BR", std::nullopt, true}};
    localization.catalogs = {{"en", {}}, {"pt-BR", {}}};

    const auto settings_id = system_message_id("noveltea.shell.settings");
    REQUIRE(settings_id);
    MessageRealizer defaults(localization);
    const auto translated = defaults.realize({*settings_id, "pt-BR"});
    REQUIRE(translated);
    CHECK(translated->text == "Configurações");
    CHECK(translated->locale == "pt-BR");

    localization.catalogs[0].entries.push_back({*settings_id, "Options"});
    localization.catalogs[1].entries.push_back({*settings_id, "Opções"});
    MessageRealizer overridden(localization);
    const auto project_target = overridden.realize({*settings_id, "pt-BR"});
    REQUIRE(project_target);
    CHECK(project_target->text == "Opções");
    const auto project_source = overridden.realize({*settings_id, "es"});
    REQUIRE(project_source);
    CHECK(project_source->text == "Options");
    CHECK(project_source->locale == "en");
}

TEST_CASE("Message realization validates typed arguments and formats values for the active locale")
{
    compiled::Localization localization;
    localization.source_locale = "en";
    localization.default_locale = "en";
    localization.locales = {{"en", std::nullopt, true}, {"de", std::nullopt, true}};
    localization.locales[1].number_format.decimal_separator = ",";
    localization.locales[1].number_format.group_separator = ".";
    const std::vector<compiled::MessageArgumentDefinition> arguments = {
        {"name", compiled::MessageArgumentType::String},
        {"count", compiled::MessageArgumentType::Integer},
        {"score", compiled::MessageArgumentType::Number},
    };
    localization.catalogs = {
        {"en", {{7, "{name}: {count} / {score}", arguments}}},
        {"de", {{7, "{score} Punkte für {name}; Anzahl {count}", arguments}}},
    };

    const MessageRealizer realizer(localization);
    const auto realized = realizer.realize(
        {7,
         "de",
         {{"name", std::string{"Ada"}}, {"count", std::int64_t{12345}}, {"score", 1234.5}}});
    REQUIRE(realized);
    CHECK(realized->text == "1.234,5 Punkte für Ada; Anzahl 12.345");
    CHECK(realized->locale == "de");

    CHECK_FALSE(
        realizer.realize({7, "de", {{"name", std::string{"Ada"}}, {"count", std::int64_t{1}}}}));
    CHECK_FALSE(realizer.realize(
        {7, "de", {{"name", std::string{"Ada"}}, {"count", 1.0}, {"score", 2.0}}}));
}

TEST_CASE("Message realization applies locale plural rules and exact selectors through one pattern")
{
    compiled::Localization localization;
    localization.source_locale = "en";
    localization.default_locale = "ru";
    localization.locales = {{"en", std::nullopt, true}, {"ru", std::nullopt, true}};
    auto& russian = localization.locales[1];
    russian.plural_categories = {"one", "few", "many", "other"};
    russian.plural_rules = {
        {"one",
         {{{compiled::PluralOperand::V, std::nullopt, false, {{0, 0}}},
           {compiled::PluralOperand::I, 10, false, {{1, 1}}},
           {compiled::PluralOperand::I, 100, true, {{11, 11}}}}}},
        {"few",
         {{{compiled::PluralOperand::V, std::nullopt, false, {{0, 0}}},
           {compiled::PluralOperand::I, 10, false, {{2, 4}}},
           {compiled::PluralOperand::I, 100, true, {{12, 14}}}}}},
        {"many",
         {{{compiled::PluralOperand::V, std::nullopt, false, {{0, 0}}},
           {compiled::PluralOperand::I, 10, false, {{0, 0}}}},
          {{compiled::PluralOperand::V, std::nullopt, false, {{0, 0}}},
           {compiled::PluralOperand::I, 10, false, {{5, 9}}}},
          {{compiled::PluralOperand::V, std::nullopt, false, {{0, 0}}},
           {compiled::PluralOperand::I, 100, false, {{11, 14}}}}}},
    };

    compiled::MessagePattern pattern;
    pattern.root = 0;
    pattern.nodes = {
        {compiled::MessagePatternNodeKind::Plural,
         {},
         "count",
         {{"one", 1}, {"few", 2}, {"many", 3}, {"other", 4}}},
        {compiled::MessagePatternNodeKind::Select, {}, "gender", {{"feminine", 5}, {"other", 6}}},
        {compiled::MessagePatternNodeKind::Text, "{count} предмета", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "{count} предметов", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "{count} предмета", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "{count} предмет для неё", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "{count} предмет", {}, {}},
    };
    const std::vector<compiled::MessageArgumentDefinition> arguments = {
        {"count", compiled::MessageArgumentType::PluralNumber},
        {"gender", compiled::MessageArgumentType::String},
    };
    localization.catalogs = {
        {"en", {{9, "{count} items", arguments, pattern}}},
        {"ru", {{9, "{count} предметов", arguments, pattern}}},
    };

    const MessageRealizer realizer(localization);
    const auto one = realizer.realize(
        {9, "ru", {{"count", std::int64_t{21}}, {"gender", std::string{"feminine"}}}});
    REQUIRE(one);
    CHECK(one->text == "21 предмет для неё");

    const auto few = realizer.realize(
        {9, "ru", {{"count", std::int64_t{22}}, {"gender", std::string{"other"}}}});
    REQUIRE(few);
    CHECK(few->text == "22 предмета");

    const auto many = realizer.realize(
        {9, "ru", {{"count", std::int64_t{25}}, {"gender", std::string{"other"}}}});
    REQUIRE(many);
    CHECK(many->text == "25 предметов");
}

TEST_CASE("Message realization evaluates compiled CLDR rules for arbitrary locales")
{
    compiled::Localization localization;
    localization.source_locale = "cy";
    localization.default_locale = "cy";
    compiled::LocaleDefinition welsh{"cy", std::nullopt, true};
    welsh.plural_categories = {"zero", "one", "two", "few", "many", "other"};
    const auto exact_n = [](std::string category, double value) {
        return compiled::PluralRule{
            std::move(category),
            {{{compiled::PluralOperand::N, std::nullopt, false, {{value, value}}}}}};
    };
    welsh.plural_rules = {exact_n("zero", 0), exact_n("one", 1), exact_n("two", 2),
                          exact_n("few", 3), exact_n("many", 6)};
    localization.locales = {std::move(welsh)};

    compiled::MessagePattern pattern;
    pattern.root = 0;
    pattern.nodes = {
        {compiled::MessagePatternNodeKind::Plural,
         {},
         "count",
         {{"zero", 1}, {"one", 2}, {"two", 3}, {"few", 4}, {"many", 5}, {"other", 6}}},
        {compiled::MessagePatternNodeKind::Text, "zero", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "one", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "two", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "few", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "many", {}, {}},
        {compiled::MessagePatternNodeKind::Text, "other", {}, {}},
    };
    const std::vector<compiled::MessageArgumentDefinition> arguments = {
        {"count", compiled::MessageArgumentType::PluralNumber},
    };
    localization.catalogs = {{"cy", {{10, "", arguments, pattern}}}};

    const MessageRealizer realizer(localization);
    REQUIRE(realizer.realize({10, "cy", {{"count", std::int64_t{0}}}}));
    CHECK(realizer.realize({10, "cy", {{"count", std::int64_t{0}}}})->text == "zero");
    CHECK(realizer.realize({10, "cy", {{"count", std::int64_t{3}}}})->text == "few");
    CHECK(realizer.realize({10, "cy", {{"count", std::int64_t{6}}}})->text == "many");
    CHECK(realizer.realize({10, "cy", {{"count", std::int64_t{4}}}})->text == "other");
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
