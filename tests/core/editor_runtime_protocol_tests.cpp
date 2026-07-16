#include <noveltea/core/editor_runtime_protocol.hpp>

#include <catch2/catch_test_macros.hpp>

#include <limits>
#include <string>
#include <variant>

using namespace noveltea::core;
using namespace noveltea::core::editor;

TEST_CASE("editor runtime input protocol decodes only closed typed inputs")
{
    const nlohmann::json document = {{"schema", runtime_input_schema},
                                     {"version", 1},
                                     {"input", {{"type", "navigate"}, {"exit", "north-exit"}}}};
    auto result = decode_editor_runtime_input(document);
    REQUIRE(result);
    const auto* input = std::get_if<NavigateRoomInput>(&result.value());
    REQUIRE(input != nullptr);
    CHECK(input->exit.text() == "north-exit");
}

TEST_CASE("editor runtime input protocol rejects malformed and open payloads")
{
    CHECK_FALSE(decode_editor_runtime_input_text("{"));
    CHECK_FALSE(decode_editor_runtime_input(
        {{"schema", runtime_input_schema}, {"version", 2}, {"input", {{"type", "continue"}}}}));
    CHECK_FALSE(decode_editor_runtime_input(
        {{"schema", runtime_input_schema},
         {"version", 1},
         {"input", {{"type", "continue"}, {"payload", nlohmann::json::object()}}}}));
    CHECK_FALSE(
        decode_editor_runtime_input({{"schema", runtime_input_schema},
                                     {"version", 1},
                                     {"input", {{"type", "navigate"}, {"exit", "Missing_ID"}}}}));
    CHECK_FALSE(
        decode_editor_runtime_input({{"schema", runtime_input_schema},
                                     {"version", 1},
                                     {"input",
                                      {{"type", "set-variable"},
                                       {"variable", "score"},
                                       {"value", std::numeric_limits<double>::infinity()}}}}));

    EditorRuntimeProtocolLimits document_limits;
    document_limits.max_document_bytes = 2;
    CHECK_FALSE(decode_editor_runtime_input_text("{}", document_limits));

    EditorRuntimeProtocolLimits string_limits;
    string_limits.max_string_bytes = 3;
    CHECK_FALSE(decode_editor_runtime_input({{"schema", runtime_input_schema},
                                             {"version", 1},
                                             {"input", {{"type", "navigate"}, {"exit", "north"}}}},
                                            string_limits));

    EditorRuntimeProtocolLimits cardinality_limits;
    cardinality_limits.max_ids_per_input = 1;
    CHECK_FALSE(decode_editor_runtime_input(
        {{"schema", runtime_input_schema},
         {"version", 1},
         {"input", {{"type", "select-interactables"}, {"interactables", {"key", "door"}}}}},
        cardinality_limits));

    std::string invalid_utf8{"bad"};
    invalid_utf8.push_back(static_cast<char>(0xff));
    CHECK_FALSE(
        decode_editor_runtime_input({{"schema", runtime_input_schema},
                                     {"version", 1},
                                     {"input", {{"type", "navigate"}, {"exit", invalid_utf8}}}}));

    CHECK_FALSE(decode_editor_runtime_input(
        {{"schema", runtime_input_schema},
         {"version", 1},
         {"input", {{"type", "select-interactables"}, {"interactables", {7}}}}}));
}

TEST_CASE("editor runtime input protocol decodes typed property debugger mutations")
{
    auto result = decode_editor_runtime_input({{"schema", runtime_input_schema},
                                               {"version", 1},
                                               {"input",
                                                {{"type", "set-property"},
                                                 {"owner", {{"kind", "room"}, {"id", "atrium"}}},
                                                 {"property", "mood"},
                                                 {"value", "quiet"}}}});
    REQUIRE(result);
    const auto* input = std::get_if<SetPropertyDebugInput>(&result.value());
    REQUIRE(input != nullptr);
    CHECK(std::get<RoomId>(input->owner).text() == "atrium");
    CHECK(input->property.text() == "mood");

    CHECK_FALSE(decode_editor_runtime_input({{"schema", runtime_input_schema},
                                             {"version", 1},
                                             {"input",
                                              {{"type", "set-property"},
                                               {"owner", {{"kind", "unknown"}, {"id", "atrium"}}},
                                               {"property", "mood"},
                                               {"value", "quiet"}}}}));
}

TEST_CASE("editor playback protocol lowers persisted steps to typed vocabulary")
{
    const nlohmann::json document = {
        {"schema", playback_schema},
        {"version", 1},
        {"id", "smoke"},
        {"steps",
         {{{"index", 0}, {"input", {{"type", "begin-playback"}}}},
          {{"index", 1},
           {"input", {{"type", "select-interactables"}, {"interactables", {"key", "door"}}}}},
          {{"index", 2},
           {"input",
            {{"type", "invoke-interaction"}, {"verb", "look"}, {"operands", {"door"}}}}}}}};
    auto result = decode_editor_playback(document);
    REQUIRE(result);
    REQUIRE(result.value().steps.size() == 3);
    CHECK(std::holds_alternative<BeginPlaybackInput>(result.value().steps[0].input));
    CHECK(std::holds_alternative<SelectInteractablesInput>(result.value().steps[1].input));
    CHECK(std::holds_alternative<InvokeInteractionInput>(result.value().steps[2].input));
}

TEST_CASE("editor playback protocol rejects invalid cardinality indexes and fields")
{
    EditorRuntimeProtocolLimits limits;
    limits.max_steps = 1;
    CHECK_FALSE(decode_editor_playback({{"schema", playback_schema},
                                        {"version", 1},
                                        {"id", "too-many"},
                                        {"steps",
                                         {{{"index", 0}, {"input", {{"type", "continue"}}}},
                                          {{"index", 1}, {"input", {{"type", "continue"}}}}}}},
                                       limits));
    CHECK_FALSE(decode_editor_playback({{"schema", playback_schema},
                                        {"version", 1},
                                        {"id", "duplicate"},
                                        {"steps",
                                         {{{"index", 0}, {"input", {{"type", "continue"}}}},
                                          {{"index", 0}, {"input", {{"type", "continue"}}}}}}}));
    CHECK_FALSE(decode_editor_playback({{"schema", playback_schema},
                                        {"version", 1},
                                        {"id", "open"},
                                        {"steps",
                                         {{{"index", 0},
                                           {"input", {{"type", "continue"}}},
                                           {"payload", nlohmann::json::object()}}}}}));
}

TEST_CASE("typed debug snapshot encoder has stable external shape")
{
    TypedRuntimeUIViewState view;
    view.mode = "room";
    view.can_continue = true;
    auto selected = InteractableId::create("door");
    REQUIRE(selected);
    view.selected_interactables.push_back(std::move(selected.value()));
    std::vector<RuntimeOutputMessage> outputs;
    outputs.push_back(RuntimeObservation{PlaybackObservation{3, true}});
    std::vector<noveltea::runtime::RuntimeEvent> events;
    events.push_back(noveltea::runtime::NotificationEvent{"ready"});
    Diagnostics diagnostics{
        {.code = "runtime.test", .message = "test diagnostic", .severity = ErrorSeverity::Warning}};

    const auto snapshot = encode_editor_debug_snapshot(view, outputs, events, diagnostics, true);
    CHECK(snapshot ==
          nlohmann::json{
              {"schema", debug_snapshot_schema},
              {"version", 1},
              {"previewRunning", true},
              {"view",
               {{"mode", "room"},
                {"gameplayPaused", false},
                {"canContinue", true},
                {"selectedInteractables", {"door"}},
                {"inventory", nlohmann::json::array()},
                {"textLog", nlohmann::json::array()}}},
              {"observations", {{{"type", "playback"}, {"stepIndex", 3}, {"handled", true}}}},
              {"events", {{{"type", "notification"}, {"message", "ready"}}}},
              {"diagnostics",
               {{{"severity", "warning"},
                 {"code", "runtime.test"},
                 {"message", "test diagnostic"},
                 {"sourcePath", ""}}}}});
}

TEST_CASE("typed playback report encoder has stable external shape")
{
    TypedRuntimeUIViewState final_view;
    final_view.mode = "room";
    std::vector<TypedPlaybackStepReport> steps;
    TypedPlaybackStepReport step;
    step.index = 4;
    step.handled = true;
    step.outputs.push_back(RuntimeObservation{PlaybackObservation{4, true}});
    step.events.push_back(noveltea::runtime::NotificationEvent{"saved"});
    step.event_output_offsets.push_back(1);
    step.diagnostics.push_back(
        {.code = "runtime.note", .message = "note", .severity = ErrorSeverity::Info});
    steps.push_back(std::move(step));

    const auto report = encode_editor_playback_report("smoke", steps, final_view, true);
    CHECK(report ==
          nlohmann::json{
              {"schema", playback_report_schema},
              {"version", 1},
              {"id", "smoke"},
              {"passed", true},
              {"steps",
               {{{"index", 4},
                 {"handled", true},
                 {"outputs",
                  {{{"type", "playback-observation"}, {"stepIndex", 4}, {"handled", true}}}},
                 {"events", {{{"type", "notification"}, {"message", "saved"}}}},
                 {"eventOutputOffsets", {1}},
                 {"diagnostics",
                  {{{"severity", "info"},
                    {"code", "runtime.note"},
                    {"message", "note"},
                    {"sourcePath", ""}}}}}}},
              {"finalView",
               {{"mode", "room"},
                {"gameplayPaused", false},
                {"canContinue", false},
                {"selectedInteractables", nlohmann::json::array()},
                {"inventory", nlohmann::json::array()},
                {"textLog", nlohmann::json::array()}}}});
}
