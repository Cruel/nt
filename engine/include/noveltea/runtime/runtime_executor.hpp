#pragma once

#include "noveltea/core/save_state.hpp"
#include "noveltea/core/room_presentation.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/shared_evaluator.hpp"
#include "noveltea/runtime/runtime_command_gateway.hpp"
#include "noveltea/runtime/runtime_ports.hpp"

#include <memory>
#include <string>
#include <string_view>
#include <variant>

namespace noveltea::runtime {

using RuntimeExecutionError = std::variant<core::Diagnostics, ScriptInvocationError>;
using RuntimeEffectOutcome = std::variant<core::WaitCompleted, ScriptInvocationSuspended>;

struct PendingSceneTransitionGroupOperation {
    core::compiled::TransitionKind kind = core::compiled::TransitionKind::Fade;
    std::chrono::milliseconds duration{0};
    std::optional<std::string> color;
    bool skippable = true;
    std::optional<core::PresentationFlowCompletion> completion;
};

struct PendingRoomNavigationOperation {
    std::optional<core::RoomId> source_room;
    core::RoomId target_room;
    core::compiled::TransitionKind kind = core::compiled::TransitionKind::Fade;
    std::chrono::milliseconds duration{0};
    std::optional<std::string> color;
    bool skippable = true;
    core::PresentationFlowCompletion completion;
};

struct PendingBackgroundOperation {
    std::chrono::milliseconds duration{0};
    bool skippable = true;
    std::optional<core::PresentationFlowCompletion> completion;
};

struct PendingActorOperation {
    core::ActorPresentationKey target;
    core::ActorOperationKind kind = core::ActorOperationKind::Fade;
    std::chrono::milliseconds duration{0};
    bool skippable = true;
    std::optional<core::PresentationFlowCompletion> completion;
};

struct PendingLayoutOperation {
    core::MountedLayoutPresentationKey target;
    std::chrono::milliseconds duration{0};
    bool skippable = true;
    std::optional<core::PresentationFlowCompletion> completion;
};

struct PendingAudioOperation {
    core::compiled::AudioAction action = core::compiled::AudioAction::Play;
    core::compiled::AudioChannel channel = core::compiled::AudioChannel::SoundEffect;
    std::optional<core::AssetId> asset;
    std::chrono::milliseconds fade{0};
    double volume = 1.0;
    std::optional<core::AudioFlowCompletion> completion;
    core::AudioOperationTarget target = core::NewAudioPlaybackTarget{};
    core::AudioOperationPurpose purpose = core::AudioOperationPurpose::Gameplay;
    bool skippable = true;
};

using PendingPresentationOperation =
    std::variant<PendingSceneTransitionGroupOperation, PendingRoomNavigationOperation,
                 PendingBackgroundOperation, PendingActorOperation, PendingLayoutOperation>;

// Backend-neutral program executor for Scene, Dialogue, Interaction, and Room-transition frames.
// External adapters remain outside this type and communicate through typed runtime ports.
class RuntimeExecutor {
public:
    [[nodiscard]] static core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics> create(
        const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
        runtime::CapabilityGeneration generation = *runtime::CapabilityGeneration::from_number(1));
    [[nodiscard]] static core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics> restore(
        const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
        const core::SaveState& save,
        runtime::CapabilityGeneration generation = *runtime::CapabilityGeneration::from_number(1));
    ~RuntimeExecutor() = default;
    RuntimeExecutor(const RuntimeExecutor&) = delete;
    RuntimeExecutor& operator=(const RuntimeExecutor&) = delete;
    RuntimeExecutor(RuntimeExecutor&&) = delete;
    RuntimeExecutor& operator=(RuntimeExecutor&&) = delete;

    [[nodiscard]] core::SessionState& state() noexcept { return m_state; }
    [[nodiscard]] const core::SessionState& state() const noexcept { return m_state; }
    [[nodiscard]] core::FlowExecutor& flow() noexcept { return m_flow; }
    [[nodiscard]] runtime::RuntimeCommandGateway& gateway() noexcept { return m_gateway; }
    [[nodiscard]] const runtime::RuntimeCommandGateway& gateway() const noexcept
    {
        return m_gateway;
    }
    [[nodiscard]] core::Result<bool, RuntimeExecutionError>
    evaluate(const core::Condition& condition);
    [[nodiscard]] core::Result<RuntimeEffectOutcome, RuntimeExecutionError>
    apply(const core::Effect& effect, std::string_view chunk_name = "typed-effect");
    [[nodiscard]] core::Result<std::string, RuntimeExecutionError>
    resolve(const core::TextSource& source, std::string_view runtime_locale);

    [[nodiscard]] core::Result<core::WaitEvaluation, core::Diagnostics>
    begin(const core::WaitSpec& wait);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    complete(const core::FlowFrameId& owner, const core::AnyFlowBlockerHandle& handle);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    cancel(const core::FlowFrameId& owner, const core::AnyFlowBlockerHandle& handle);
    [[nodiscard]] core::Result<bool, core::Diagnostics>
    advance(const core::FlowFrameId& owner, const core::DurationFlowBlockerHandle& handle,
            std::chrono::milliseconds elapsed);

    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptInvocationError>
    resume_script(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation);
    [[nodiscard]] core::Result<void, ScriptInvocationError>
    cancel_script(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation);

    [[nodiscard]] core::FlowRunOutcome run_until_blocked(std::size_t instruction_budget,
                                                         std::string_view runtime_locale = {});
    [[nodiscard]] core::Result<void, core::Diagnostics>
    choose_scene_option(const core::FlowFrameId& owner, const core::InputFlowBlockerHandle& handle,
                        const core::SceneChoiceOptionId& option);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    choose_dialogue_option(const core::FlowFrameId& owner,
                           const core::InputFlowBlockerHandle& handle,
                           const core::DialogueEdgeId& edge);
    [[nodiscard]] core::Result<void, core::Diagnostics> navigate(const core::RoomExitId& exit);
    [[nodiscard]] core::Result<void, RuntimeExecutionError>
    interact(core::VerbId verb, std::vector<core::compiled::InteractionSubject> operands);
    [[nodiscard]] core::Result<void, core::Diagnostics> start_transient(const core::SceneId& scene);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    start_transient(const core::DialogueId& dialogue);
    [[nodiscard]] core::Result<core::SceneView, core::Diagnostics> scene_view() const;
    [[nodiscard]] core::Result<core::DialogueView, core::Diagnostics> dialogue_view() const;
    [[nodiscard]] core::Result<core::RoomView, RuntimeExecutionError>
    room_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<core::InteractionView, RuntimeExecutionError>
    interaction_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<core::InventoryView, RuntimeExecutionError>
    inventory_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<void, core::Diagnostics> present_map(
        const core::MapId& map, std::optional<core::compiled::InitialMapMode> mode = std::nullopt,
        bool visible = true, std::optional<core::MapLocationId> focused_location = std::nullopt);
    [[nodiscard]] core::Result<void, core::Diagnostics> hide_map();
    [[nodiscard]] core::Result<core::MapView, RuntimeExecutionError>
    map_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<void, RuntimeExecutionError>
    select_map_location(const core::MapLocationId& location, std::string_view runtime_locale = {});
    [[nodiscard]] core::Result<void, RuntimeExecutionError>
    activate_map_connection(const core::MapConnectionId& connection,
                            std::string_view runtime_locale = {});
    [[nodiscard]] core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>
    runtime_ui_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<void, RuntimeExecutionError>
    refresh_room_presentation(std::string_view runtime_locale);
    [[nodiscard]] const core::RoomPresentationResolution* room_presentation() const noexcept
    {
        return m_room_presentation ? &*m_room_presentation : nullptr;
    }
    void invalidate_room_presentation() noexcept { m_room_presentation_dirty = true; }
    [[nodiscard]] core::Diagnostics take_room_presentation_diagnostics() noexcept
    {
        auto diagnostics = std::move(m_room_presentation_diagnostics);
        m_room_presentation_diagnostics.clear();
        return diagnostics;
    }
    [[nodiscard]] std::vector<PendingAudioOperation> take_pending_audio_operations() noexcept
    {
        auto pending = std::move(m_pending_audio_operations);
        m_pending_audio_operations.clear();
        return pending;
    }
    [[nodiscard]] const std::optional<PendingPresentationOperation>&
    pending_presentation_operation() const noexcept
    {
        return m_pending_presentation_operation;
    }
    [[nodiscard]] const core::SessionState* pending_presentation_source_state() const noexcept
    {
        return m_pending_presentation_source_state ? &*m_pending_presentation_source_state
                                                   : nullptr;
    }
    [[nodiscard]] const core::RoomPresentationResolution*
    pending_presentation_source_room() const noexcept
    {
        return m_pending_presentation_source_room ? &*m_pending_presentation_source_room : nullptr;
    }
    void commit_pending_presentation() noexcept;
    void rollback_pending_presentation() noexcept;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    fail_pending_presentation(std::string code, std::string message);

private:
    friend class RuntimeSession;

    RuntimeExecutor(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                    core::SessionState state, CapabilityGeneration generation) noexcept;
    [[nodiscard]] core::Result<bool, ScriptInvocationError>
    evaluate_script(const core::LuaPredicate& predicate);
    [[nodiscard]] core::Result<std::string, ScriptInvocationError>
    resolve_script(const core::LuaTextExpression& expression);
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptInvocationError>
    invoke_script(std::string_view source, std::string_view chunk_name);
    [[nodiscard]] std::optional<core::FlowRunOutcome>
    run_dialogue_unit(std::string_view runtime_locale);
    [[nodiscard]] std::optional<core::FlowRunOutcome>
    run_room_unit(std::string_view runtime_locale);
    [[nodiscard]] std::optional<core::FlowRunOutcome>
    run_interaction_unit(std::string_view runtime_locale);
    [[nodiscard]] core::Result<std::optional<core::PresentationFlowCompletion>, core::Diagnostics>
    advance_scene_for_presentation(const core::SceneId& scene, const core::SceneStepId& step,
                                   std::optional<core::SceneStepId> next,
                                   const core::PresentationInstructionWait& wait);
    void stage_pending_presentation(PendingPresentationOperation operation,
                                    core::SessionState source_state,
                                    std::optional<core::RoomPresentationResolution> source_room);

    const core::CompiledProject& m_project;
    core::SessionState m_state;
    core::FlowExecutor m_flow;
    core::SharedPrimitiveEvaluator m_primitives;
    RuntimeCommandGateway m_gateway;
    ScriptInvocationPort& m_scripts;
    RuntimeCapabilitySet m_gameplay_capabilities;
    RuntimeCapabilitySet m_expression_capabilities;
    std::optional<core::RoomPresentationResolution> m_room_presentation;
    core::Diagnostics m_room_presentation_diagnostics;
    std::string m_room_presentation_locale;
    bool m_room_presentation_dirty = true;
    std::optional<PendingPresentationOperation> m_pending_presentation_operation;
    std::optional<core::SessionState> m_pending_presentation_source_state;
    std::optional<core::RoomPresentationResolution> m_pending_presentation_source_room;
    std::vector<PendingAudioOperation> m_pending_audio_operations;
    std::string m_pending_presentation_source_locale;
    bool m_pending_presentation_source_dirty = true;
};

} // namespace noveltea::runtime
