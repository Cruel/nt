#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/script/runtime_checkpoint_service.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <string>
#include <string_view>

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
    auto decoded =
        core::decode_compiled_project(nlohmann::json::parse(source), std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

core::SessionState make_state(const core::CompiledProject& project)
{
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    return std::move(state).value();
}

template<class Id> Id id(std::string value)
{
    auto parsed = Id::create(std::move(value));
    REQUIRE(parsed);
    return std::move(parsed).value();
}

} // namespace

TEST_CASE(
    "checkpoint service publishes immutable candidates and preserves them on projection failure")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);

    REQUIRE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    const auto retained = *service.latest_checkpoint();
    const auto retained_generations = service.generations();
    CHECK(retained.metadata.play_time == state.play_time());
    CHECK(retained.metadata.generations == service.generations());
    CHECK(retained.metadata.project == project.identity().id);
    CHECK(retained.metadata.project_version == project.identity().version);
    CHECK(retained.revision.number() == 1);

    auto decoded =
        core::decode_save_state_text(project, retained.encoded_save, "checkpoint-candidate-test");
    REQUIRE(decoded);
    CHECK(decoded.value().play_time == retained.metadata.play_time);
    CHECK(decoded.value().metadata.project == retained.metadata.project);
    CHECK(decoded.value().metadata.project_version == retained.metadata.project_version);

    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Presentation));
    REQUIRE_FALSE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    CHECK(*service.latest_checkpoint() == retained);
    CHECK(service.generations() == retained_generations);
    REQUIRE_FALSE(service.readiness().can_capture());
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
}

TEST_CASE("checkpoint service preserves deterministic projection diagnostic ordering")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);

    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Script));

    REQUIRE_FALSE(service.publish_candidate(
        state, core::SaveSnapshotContext{.in_flight_external_requests = 1}));
    REQUIRE(service.readiness().issues.size() == 2);
    CHECK(service.readiness().issues[0].reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues[0].diagnostic.code == "save.external_requests_pending");
    CHECK(service.readiness().issues[1].reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues[1].diagnostic.code == "save.opaque_script_suspension");
}

TEST_CASE("checkpoint service rejects omitted presentation and causal blockers")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);

    REQUIRE(state.present_text(project, core::PresentedTextState{std::nullopt, "Visible text"}));
    REQUIRE_FALSE(service.publish_candidate(state));
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::ReconstructibleStateInvalid);

    state.clear_presented_text();
    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Presentation));
    REQUIRE_FALSE(service.publish_candidate(state));
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues.front().diagnostic.code == "save.presentation_blocker_active");
}

TEST_CASE("checkpoint service preserves retained bytes when encoding fails")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    const auto retained = *service.latest_checkpoint();
    const auto retained_generations = service.generations();

    REQUIRE(state.set_variable(project, id<core::VariableId>("player-name"),
                               core::RuntimeValue{std::string{"\xff"}}));
    REQUIRE(service.record_structural_mutation());
    REQUIRE_FALSE(service.publish_candidate(state));
    CHECK(*service.latest_checkpoint() == retained);
    CHECK(service.generations().captured_structural_generation ==
          retained_generations.captured_structural_generation);
    CHECK(service.generations().captured_time_generation ==
          retained_generations.captured_time_generation);
    REQUIRE_FALSE(service.readiness().can_capture());
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveEncodingFailed);
}

TEST_CASE("checkpoint service preserves retained state when candidate validation fails")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    const auto retained = *service.latest_checkpoint();
    const auto retained_generations = service.generations();

    core::TextLogEntry invalid_entry{
        .kind = core::TextLogEntryKind::Notification,
        .origin = core::SystemTextLogOrigin{},
        .speaker = std::nullopt,
        .text = "Invalid markup candidate",
        .markup = static_cast<core::TextMarkup>(255),
    };
    REQUIRE(state.append_text_log(project, std::move(invalid_entry)));
    REQUIRE(service.record_structural_mutation());

    REQUIRE_FALSE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    CHECK(*service.latest_checkpoint() == retained);
    CHECK(service.generations().captured_structural_generation ==
          retained_generations.captured_structural_generation);
    CHECK(service.generations().captured_time_generation ==
          retained_generations.captured_time_generation);
    REQUIRE_FALSE(service.readiness().can_capture());
    REQUIRE(service.readiness().issues.size() == 1);
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveValidationFailed);
    CHECK(service.readiness().issues.front().diagnostic.code == "save_codec.invalid_text_log");
}

} // namespace noveltea::script::test
