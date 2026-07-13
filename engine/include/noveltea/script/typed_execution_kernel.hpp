#pragma once

#include "noveltea/core/script_host_services.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/shared_evaluator.hpp"
#include "noveltea/script/script_invoker.hpp"

#include <memory>
#include <string>
#include <string_view>
#include <variant>

namespace noveltea::script {

class ScriptRuntime;

using TypedExecutionError = std::variant<core::Diagnostics, ScriptError>;
using TypedEffectOutcome = std::variant<core::WaitCompleted, ScriptInvocationSuspended>;

// Additive composition root for the typed execution kernel. Scene, Dialogue, and Room execution are
// implemented here; later Phase 7 slices add the remaining feature visitors and Phase 9 owns
// external adapters.
class TypedExecutionKernel {
public:
    [[nodiscard]] static core::Result<std::unique_ptr<TypedExecutionKernel>, core::Diagnostics>
    create(const core::CompiledProject& project, ScriptRuntime& runtime);

    ~TypedExecutionKernel() = default;
    TypedExecutionKernel(const TypedExecutionKernel&) = delete;
    TypedExecutionKernel& operator=(const TypedExecutionKernel&) = delete;
    TypedExecutionKernel(TypedExecutionKernel&&) = delete;
    TypedExecutionKernel& operator=(TypedExecutionKernel&&) = delete;

    [[nodiscard]] core::SessionState& state() noexcept { return m_state; }
    [[nodiscard]] const core::SessionState& state() const noexcept { return m_state; }
    [[nodiscard]] core::FlowExecutor& flow() noexcept { return m_flow; }
    [[nodiscard]] core::ScriptHostServices& host() noexcept { return m_host; }
    [[nodiscard]] const core::ScriptHostServices& host() const noexcept { return m_host; }

    [[nodiscard]] core::Result<bool, TypedExecutionError>
    evaluate(const core::Condition& condition);
    [[nodiscard]] core::Result<TypedEffectOutcome, TypedExecutionError>
    apply(const core::Effect& effect, std::string_view chunk_name = "typed-effect");
    [[nodiscard]] core::Result<std::string, TypedExecutionError>
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

    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    resume_script(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation);
    [[nodiscard]] core::Result<void, ScriptError>
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
    [[nodiscard]] core::Result<void, TypedExecutionError>
    interact(core::VerbId verb, std::vector<core::InteractableId> operands);
    [[nodiscard]] core::Result<void, core::Diagnostics> start_transient(const core::SceneId& scene);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    start_transient(const core::DialogueId& dialogue);
    [[nodiscard]] core::Result<core::SceneView, core::Diagnostics> scene_view() const;
    [[nodiscard]] core::Result<core::DialogueView, core::Diagnostics> dialogue_view() const;
    [[nodiscard]] core::Result<core::RoomView, TypedExecutionError>
    room_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<core::InteractionView, TypedExecutionError>
    interaction_view(std::string_view runtime_locale);
    [[nodiscard]] core::Result<core::InventoryView, TypedExecutionError>
    inventory_view(std::string_view runtime_locale);

private:
    TypedExecutionKernel(const core::CompiledProject& project, ScriptRuntime& runtime,
                         core::SessionState state) noexcept;
    [[nodiscard]] std::optional<core::FlowRunOutcome>
    run_dialogue_unit(std::string_view runtime_locale);
    [[nodiscard]] std::optional<core::FlowRunOutcome>
    run_room_unit(std::string_view runtime_locale);
    [[nodiscard]] std::optional<core::FlowRunOutcome>
    run_interaction_unit(std::string_view runtime_locale);

    const core::CompiledProject& m_project;
    core::SessionState m_state;
    core::FlowExecutor m_flow;
    core::SharedPrimitiveEvaluator m_primitives;
    core::ScriptHostServices m_host;
    ScriptInvoker m_scripts;
};

} // namespace noveltea::script
