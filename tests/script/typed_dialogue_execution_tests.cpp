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
#include <string_view>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

using TypedExecutionKernel = runtime::RuntimeExecutor;

nlohmann::json load_document(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    return document;
}

core::CompiledProject decode_document(nlohmann::json document, std::string_view source_name)
{
    auto decoded = core::decode_compiled_project(document, std::string(source_name));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

nlohmann::json& definition_by_id(nlohmann::json& definitions, std::string_view collection,
                                 std::string_view id)
{
    for (auto& definition : definitions[std::string(collection)]) {
        if (definition["id"].get<std::string>() == id)
            return definition;
    }
    FAIL("Compiled fixture definition is missing");
    return definitions;
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

void install_dialogue_functions(ScriptRuntime& runtime, bool can_finish = true)
{
    const std::string finish = can_finish ? "true" : "false";
    REQUIRE(runtime.execute("function after_localized_line() noveltea.notify('localized') end\n"
                            "function show_lua_line() return true end\n"
                            "function dialogue_line() return 'Lua line.' end\n"
                            "function yielding_dialogue_effect() noveltea.notify('segment-start'); "
                            "coroutine.yield(); noveltea.notify('segment-end') end\n"
                            "function can_finish_dialogue() return " +
                                finish +
                                " end\n"
                                "function final_choice_label() return 'Finish' end\n"
                                "function finish_dialogue() noveltea.notify('finished') end",
                            "dialogue-test-setup"));
}

const core::DialogueFrame& active_dialogue(const TypedExecutionKernel& kernel)
{
    REQUIRE_FALSE(kernel.state().flow_stack().empty());
    const auto* frame = std::get_if<core::DialogueFrame>(&kernel.state().flow_stack().back());
    REQUIRE(frame != nullptr);
    return *frame;
}

core::FlowBlocker active_blocker(const TypedExecutionKernel& kernel)
{
    REQUIRE(kernel.state().blocker());
    return *kernel.state().blocker();
}

void complete_input(TypedExecutionKernel& kernel)
{
    const auto blocker = active_blocker(kernel);
    REQUIRE(core::flow_blocker_kind(blocker) == core::FlowBlockerKind::Input);
    REQUIRE(kernel.complete(core::flow_blocker_owner(blocker), core::flow_blocker_handle(blocker)));
}

void resume_active_script(TypedExecutionKernel& kernel)
{
    const auto blocker = active_blocker(kernel);
    const auto* script = std::get_if<core::ScriptFlowBlocker>(&blocker);
    REQUIRE(script != nullptr);
    auto resumed = kernel.resume_script(script->owner, script->handle);
    REQUIRE(resumed);
    REQUIRE(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
}

const core::InputFlowBlocker& require_input_blocker(const core::FlowRunOutcome& outcome)
{
    const auto* blocked = std::get_if<core::FlowBlockedOutcome>(&outcome);
    REQUIRE(blocked != nullptr);
    const auto* input = std::get_if<core::InputFlowBlocker>(&blocked->blocker);
    REQUIRE(input != nullptr);
    return *input;
}

void progress_intro_to_choice(TypedExecutionKernel& kernel)
{
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel.run_until_blocked(100, "en")));
    complete_input(kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel.run_until_blocked(100, "en")));
    complete_input(kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel.run_until_blocked(100, "en")));
    complete_input(kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel.run_until_blocked(100, "en")));
    REQUIRE(core::flow_blocker_kind(active_blocker(kernel)) == core::FlowBlockerKind::Script);
    resume_active_script(kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel.run_until_blocked(100, "en")));
    REQUIRE(core::flow_blocker_kind(active_blocker(kernel)) == core::FlowBlockerKind::Input);
}

nlohmann::json minimal_dialogue_program(std::string_view log_mode, bool line_logged,
                                        bool choice_logged,
                                        std::string_view line_effect_source = {})
{
    auto program = nlohmann::json::parse(
        R"json({
          "blocks": [
            {
              "defaultSpeaker": null,
              "id": "start",
              "kind": "sequence",
              "segments": [
                {
                  "autosaveSafePoint": false,
                  "effects": [],
                  "id": "line",
                  "kind": "line",
                  "logged": true,
                  "showOnce": false,
                  "speaker": null,
                  "text": {"markup": "plain", "source": {"kind": "inline", "text": "Line"}}
                }
              ]
            },
            {"id": "decision", "kind": "choice"},
            {
              "defaultSpeaker": null,
              "id": "final",
              "kind": "sequence",
              "segments": [
                {
                  "autosaveSafePoint": false,
                  "effects": [],
                  "id": "done",
                  "kind": "line",
                  "logged": false,
                  "showOnce": false,
                  "speaker": null,
                  "text": {"markup": "plain", "source": {"kind": "inline", "text": "Done"}}
                }
              ]
            }
          ],
          "edges": [
            {"fromBlockId": "start", "id": "next", "kind": "next", "toBlockId": "decision"},
            {
              "autosaveSafePoint": false,
              "effects": [],
              "fromBlockId": "decision",
              "id": "choose",
              "kind": "choice",
              "label": {"markup": "active-text", "source": {"kind": "inline", "text": "Choice"}},
              "logged": true,
              "toBlockId": "final"
            }
          ],
          "entryBlockId": "start"
        })json",
        nullptr, false);
    REQUIRE_FALSE(program.is_discarded());
    program["blocks"][0]["segments"][0]["logged"] = line_logged;
    program["edges"][1]["logged"] = choice_logged;
    if (!line_effect_source.empty()) {
        program["blocks"][0]["segments"][0]["effects"] = nlohmann::json::array(
            {{{"kind", "run-lua-effect"}, {"source", std::string(line_effect_source)}}});
    }
    program["settings"] = {{"logMode", std::string(log_mode)}, {"showDisabledChoices", true}};
    return program;
}

core::CompiledProject make_minimal_dialogue_project(std::string_view log_mode, bool line_logged,
                                                    bool choice_logged,
                                                    std::string_view line_effect_source = {})
{
    auto document = load_document("dialogue-program.json");
    auto& intro = definition_by_id(document["definitions"], "dialogues", "intro");
    auto program =
        minimal_dialogue_program(log_mode, line_logged, choice_logged, line_effect_source);
    intro["program"] = std::move(program);
    intro["settings"] = intro["program"]["settings"];
    intro["program"].erase("settings");
    intro["completion"] = {{"kind", "end"}};
    document["entrypoint"] = {{"kind", "dialogue"},
                              {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}};
    return decode_document(std::move(document), "minimal-dialogue-runtime.json");
}

} // namespace

TEST_CASE("typed Dialogue execution covers blocks segments edges waits history and typed view")
{
    RuntimeFixture fixture;
    install_dialogue_functions(fixture.runtime);
    auto project = decode_document(load_document("dialogue-program.json"), "dialogue-program.json");
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    auto first = kernel->run_until_blocked(100, "en");
    require_input_blocker(first);
    auto view = kernel->dialogue_view();
    REQUIRE(view);
    REQUIRE(view.value().line);
    CHECK(view.value().line->text == "Inline dialogue.");
    CHECK(view.value().line->speaker == core::CharacterId::create("hero").value());
    auto runtime_ui = kernel->runtime_ui_view("en");
    REQUIRE(runtime_ui);
    CHECK(runtime_ui.value().mode == "dialogue");
    REQUIRE(runtime_ui.value().dialogue);
    REQUIRE(runtime_ui.value().dialogue->line);
    CHECK(runtime_ui.value().dialogue->line->text == view.value().line->text);
    CHECK_FALSE(runtime_ui.value().scene);
    CHECK_FALSE(runtime_ui.value().room);
    CHECK_FALSE(runtime_ui.value().interaction);
    CHECK(kernel->state().dialogue_line_visits(
              {core::DialogueId::create("intro").value(),
               core::DialogueSegmentId::create("inline-line").value()}) == 1);
    CHECK(kernel->state().text_log().size() == 1);

    complete_input(*kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
    CHECK(kernel->state().variable(project, core::VariableId::create("flag").value()).value() ==
          core::RuntimeValue{true});
    CHECK(kernel->state().presented_text()->text == "Welcome.");
    REQUIRE(kernel->gateway().command_queue().size() == 1);
    auto first_autosave = kernel->gateway().command_queue().pop_front();
    REQUIRE(first_autosave.has_value());
    CHECK(std::holds_alternative<runtime::RequestAutosaveCommand>(first_autosave->payload));

    complete_input(*kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
    CHECK(kernel->state().presented_text()->text == "Lua line.");
    complete_input(*kernel);

    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
    REQUIRE(core::flow_blocker_kind(active_blocker(*kernel)) == core::FlowBlockerKind::Script);
    const auto suspended_position = active_dialogue(*kernel).position;
    resume_active_script(*kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
    CHECK(suspended_position.awaiting_completion);

    view = kernel->dialogue_view();
    REQUIRE(view);
    REQUIRE(view.value().choice);
    REQUIRE(view.value().choice->options.size() == 2);
    const auto blocker = active_blocker(*kernel);
    const auto* input = std::get_if<core::InputFlowBlocker>(&blocker);
    REQUIRE(input != nullptr);
    REQUIRE(kernel->choose_dialogue_option(
        input->owner, input->handle, core::DialogueEdgeId::create("choice-redirect").value()));
    CHECK(kernel->state().dialogue_choice_visits(
              {core::DialogueId::create("intro").value(),
               core::DialogueEdgeId::create("choice-redirect").value()}) == 1);
    CHECK(kernel->state().text_log().size() == 2);

    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
    CHECK(kernel->state().variable(project, core::VariableId::create("count").value()).value() ==
          core::RuntimeValue{std::int64_t{4}});
    CHECK(kernel->state().presented_text()->text == "Final line.");
    REQUIRE(kernel->gateway().command_queue().size() == 1);
    auto second_autosave = kernel->gateway().command_queue().pop_front();
    REQUIRE(second_autosave.has_value());
    CHECK(std::holds_alternative<runtime::RequestAutosaveCommand>(second_autosave->payload));

    complete_input(*kernel);
    REQUIRE(std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
    CHECK(active_dialogue(*kernel).dialogue == core::DialogueId::create("epilogue").value());
    CHECK(kernel->state().presented_text()->text == "Epilogue.");
}

TEST_CASE("typed Dialogue show-once and disabled-choice policy are deterministic")
{
    SECTION("show-once line is skipped after its first recorded presentation")
    {
        RuntimeFixture fixture;
        install_dialogue_functions(fixture.runtime);
        auto project =
            decode_document(load_document("dialogue-program.json"), "dialogue-show-once.json");
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        REQUIRE(
            std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
        complete_input(*kernel);
        REQUIRE(kernel->flow().apply_target(core::DialogueId::create("intro").value()));
        REQUIRE(
            std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
        CHECK(kernel->state().presented_text()->text == "Welcome.");
        CHECK(kernel->state().dialogue_line_visits(
                  {core::DialogueId::create("intro").value(),
                   core::DialogueSegmentId::create("inline-line").value()}) == 1);
    }

    SECTION("hidden disabled choices are omitted")
    {
        RuntimeFixture fixture;
        install_dialogue_functions(fixture.runtime, false);
        auto project =
            decode_document(load_document("dialogue-program.json"), "dialogue-hidden-choice.json");
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        progress_intro_to_choice(*kernel);
        auto view = kernel->dialogue_view();
        REQUIRE(view);
        REQUIRE(view.value().choice);
        REQUIRE(view.value().choice->options.size() == 1);
        CHECK(view.value().choice->options.front().enabled);
    }

    SECTION("shown disabled choices remain unselectable without consuming the blocker")
    {
        RuntimeFixture fixture;
        install_dialogue_functions(fixture.runtime, false);
        auto document = load_document("dialogue-program.json");
        auto& intro = definition_by_id(document["definitions"], "dialogues", "intro");
        intro["settings"]["showDisabledChoices"] = true;
        auto project = decode_document(std::move(document), "dialogue-disabled-choice.json");
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        progress_intro_to_choice(*kernel);
        auto view = kernel->dialogue_view();
        REQUIRE(view);
        REQUIRE(view.value().choice);
        REQUIRE(view.value().choice->options.size() == 2);
        CHECK_FALSE(view.value().choice->options[1].enabled);
        const auto blocker = active_blocker(*kernel);
        const auto* input = std::get_if<core::InputFlowBlocker>(&blocker);
        REQUIRE(input != nullptr);
        CHECK_FALSE(kernel->choose_dialogue_option(
            input->owner, input->handle, core::DialogueEdgeId::create("choice-final").value()));
        REQUIRE(kernel->state().blocker());
        REQUIRE(kernel->choose_dialogue_option(
            input->owner, input->handle, core::DialogueEdgeId::create("choice-redirect").value()));
    }
}

TEST_CASE("typed Dialogue logging modes and per-item suppression are closed policies")
{
    struct Case {
        const char* mode;
        bool line_logged;
        bool choice_logged;
        std::size_t expected_after_line;
        std::size_t expected_after_choice;
    };
    const Case cases[] = {
        {"everything", true, true, 1, 2},   {"nothing", true, true, 0, 0},
        {"only-lines", true, true, 1, 1},   {"only-choices", true, true, 0, 1},
        {"everything", false, false, 0, 0},
    };

    for (const auto& item : cases) {
        RuntimeFixture fixture;
        auto project =
            make_minimal_dialogue_project(item.mode, item.line_logged, item.choice_logged);
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        REQUIRE(
            std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
        CHECK(kernel->state().text_log().size() == item.expected_after_line);
        complete_input(*kernel);
        auto choice = kernel->run_until_blocked(100, "en");
        const auto& input = require_input_blocker(choice);
        REQUIRE(kernel->choose_dialogue_option(input.owner, input.handle,
                                               core::DialogueEdgeId::create("choose").value()));
        CHECK(kernel->state().text_log().size() == item.expected_after_choice);
        if (!kernel->state().text_log().empty())
            CHECK(kernel->state().text_log().back().markup <= core::TextMarkup::ActiveText);
    }
}

TEST_CASE("typed Dialogue nested Return resumes its caller and failed effects do not advance")
{
    SECTION("Dialogue completion Return resumes a Scene caller")
    {
        RuntimeFixture fixture;
        auto document = load_document("dialogue-program.json");
        auto& intro = definition_by_id(document["definitions"], "dialogues", "intro");
        intro["program"] = minimal_dialogue_program("nothing", false, false);
        intro["program"].erase("settings");
        intro["settings"] = {{"logMode", "nothing"}, {"showDisabledChoices", true}};
        intro["completion"] = {{"kind", "return"}};
        auto& opening = definition_by_id(document["definitions"], "scenes", "opening");
        opening["program"]["instructions"] = nlohmann::json::array({
            {{"autosaveSafePoint", false},
             {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}},
             {"id", "call"},
             {"kind", "call-dialogue"},
             {"startBlockId", "final"}},
        });
        opening["continuation"] = {{"kind", "end"}};
        document["entrypoint"] = {{"kind", "scene"},
                                  {"scene", {{"kind", "scene"}, {"id", "opening"}}}};
        auto project = decode_document(std::move(document), "dialogue-nested-return.json");
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        REQUIRE(
            std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
        REQUIRE(kernel->state().flow_stack().size() == 2);
        CHECK(kernel->state().presented_text()->text == "Done");
        complete_input(*kernel);
        auto completed = kernel->run_until_blocked(100, "en");
        const auto* mode = std::get_if<core::FlowModeChangedOutcome>(&completed);
        REQUIRE(mode != nullptr);
        CHECK(std::holds_alternative<core::EndedMode>(mode->mode));
    }

    SECTION("a failing line effect preserves its exact effect cursor")
    {
        RuntimeFixture fixture;
        auto project = make_minimal_dialogue_project("everything", true, true,
                                                     "error('dialogue effect failed')");
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        REQUIRE(
            std::holds_alternative<core::FlowBlockedOutcome>(kernel->run_until_blocked(100, "en")));
        complete_input(*kernel);
        const auto before = active_dialogue(*kernel).position;
        auto failed = kernel->run_until_blocked(1, "en");
        REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(failed));
        CHECK(active_dialogue(*kernel).position == before);
        CHECK(active_dialogue(*kernel).position.next_effect == 0);
        CHECK(kernel->state().execution_fault());
    }

    SECTION("an invalid child start block leaves the caller position and stack unchanged")
    {
        RuntimeFixture fixture;
        install_dialogue_functions(fixture.runtime);
        auto project = decode_document(load_document("dialogue-program.json"),
                                       "dialogue-invalid-child-target.json");
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        const auto before = active_dialogue(*kernel).position;
        const auto stack_size = kernel->state().flow_stack().size();
        auto called =
            kernel->flow().call_child(core::DialogueId::create("intro").value(),
                                      core::DialogueBlockId::create("missing-block").value(),
                                      core::FlowFramePosition{before});
        REQUIRE_FALSE(called);
        REQUIRE(kernel->state().flow_stack().size() == stack_size);
        CHECK(active_dialogue(*kernel).position == before);
        CHECK(kernel->state().execution_fault());
    }
}

} // namespace noveltea::script::test
