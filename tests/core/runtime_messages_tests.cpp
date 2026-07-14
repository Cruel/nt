#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <catch2/catch_test_macros.hpp>
#include <type_traits>

using namespace noveltea::core;

namespace {
template<class Id> Id id(const char* value)
{
    auto result = Id::create(value);
    REQUIRE(result);
    return result.value();
}
} // namespace

TEST_CASE("typed runtime message vocabulary is closed and JSON-free")
{
    STATIC_REQUIRE(std::variant_size_v<RuntimeInputMessage> == 20);
    STATIC_REQUIRE(std::variant_size_v<RuntimeOutputMessage> == 7);
    STATIC_REQUIRE(!std::is_constructible_v<RuntimeInputMessage, std::string>);

    RuntimeInputMessage input = NavigateRoomInput{.exit = id<RoomExitId>("north-exit")};
    CHECK(category(input) == RuntimeMessageCategory::Input);
    CHECK(input == RuntimeInputMessage{NavigateRoomInput{.exit = id<RoomExitId>("north-exit")}});
}

TEST_CASE("typed runtime outputs have one explicit category")
{
    RuntimeOutputMessage host = PresentationOperation{
        LayoutPresentationOperation{.id = PresentationOperationId::from_number(4),
                                    .action = compiled::LayoutAction::Show,
                                    .slot = compiled::LayoutSlot::Hud,
                                    .layout = id<LayoutId>("game-hud")}};
    CHECK(category(host) == RuntimeMessageCategory::HostOperation);
    CHECK(output_kind(host) == RuntimeOutputKind::PresentationOperation);

    RuntimeOutputMessage observation =
        RuntimeObservation{PlaybackObservation{.step_index = 3, .handled = true}};
    CHECK(category(observation) == RuntimeMessageCategory::Observation);
    CHECK(output_kind(observation) == RuntimeOutputKind::Observation);

    RuntimeOutputMessage diagnostic = Diagnostic{.code = "runtime.failed", .message = "failed"};
    CHECK(category(diagnostic) == RuntimeMessageCategory::Diagnostic);
    CHECK(output_kind(diagnostic) == RuntimeOutputKind::Diagnostic);
}

TEST_CASE("diagnostics carry typed runtime execution context")
{
    Diagnostic diagnostic{.code = "runtime.scene", .message = "scene failed"};
    diagnostic.runtime_context =
        std::make_shared<RuntimeDiagnosticContext>(RuntimeDiagnosticContext{
            .value = SceneRuntimeContext{.scene = id<SceneId>("opening"),
                                         .step = id<SceneStepId>("show-title")}});

    REQUIRE(diagnostic.runtime_context);
    const auto* context = std::get_if<SceneRuntimeContext>(&diagnostic.runtime_context->value);
    REQUIRE(context != nullptr);
    CHECK(context->scene == id<SceneId>("opening"));
    CHECK(context->step == id<SceneStepId>("show-title"));
}
