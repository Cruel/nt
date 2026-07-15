#include "noveltea/runtime_presentation_bridge.hpp"

#include "noveltea/core/session_state.hpp"

#include <algorithm>
#include <type_traits>

namespace noveltea {
namespace {
core::Diagnostics one(core::Diagnostic diagnostic) { return {std::move(diagnostic)}; }
} // namespace

RuntimePresentationBridge::RuntimePresentationBridge(RuntimeAudioAdapter& audio)
    : m_audio(audio), m_coordinator(this, this)
{
}

RuntimePresentationDispatchResult
RuntimePresentationBridge::accept(const core::PresentationOperation& operation)
{
    auto accepted = m_coordinator.accept(operation);
    return accepted ? RuntimePresentationDispatchResult{}
                    : RuntimePresentationDispatchResult{{}, std::move(accepted).error()};
}

RuntimePresentationDispatchResult
RuntimePresentationBridge::accept(const core::AudioOperation& operation)
{
    auto accepted = m_coordinator.accept(operation);
    if (!accepted)
        return {{}, std::move(accepted).error()};
    return {};
}

RuntimePresentationDispatchResult RuntimePresentationBridge::flush()
{
    auto delivered = m_coordinator.deliver_pending();
    if (!delivered)
        return {{}, std::move(delivered).error()};
    return drain_backend_facts();
}

core::Result<void, core::Diagnostics>
RuntimePresentationBridge::realize(const core::CoordinatedOperationDelivery& delivery)
{
    if (const auto* audio = std::get_if<core::AudioOperation>(&delivery.operation)) {
        auto applied = m_audio.apply(*audio);
        if (!applied) {
            m_backend_facts.push_back(
                {delivery.metadata.operation, delivery.metadata.sequence, delivery.metadata.owner,
                 core::BackendOperationFailed{core::PresentationFailureDomain::AudioPresentation,
                                              applied.error()}});
        } else if (*applied.value_if() == TypedRuntimeOperationDisposition::Completed &&
                   delivery.metadata.checkpoint_class == core::CheckpointClass::CausalBarrier &&
                   (audio->action == core::compiled::AudioAction::Play ||
                    audio->action == core::compiled::AudioAction::FadeIn) &&
                   !audio->completion) {
            m_backend_facts.push_back({delivery.metadata.operation, delivery.metadata.sequence,
                                       delivery.metadata.owner, core::BackendOperationRunning{}});
        } else if (*applied.value_if() == TypedRuntimeOperationDisposition::Completed) {
            m_backend_facts.push_back({delivery.metadata.operation, delivery.metadata.sequence,
                                       delivery.metadata.owner, core::BackendOperationCompleted{}});
        } else {
            m_backend_facts.push_back({delivery.metadata.operation, delivery.metadata.sequence,
                                       delivery.metadata.owner, core::BackendOperationRunning{}});
        }
        return core::Result<void, core::Diagnostics>::success();
    }
    if (std::holds_alternative<core::ActiveTextPresentationOperation>(delivery.operation)) {
        m_backend_facts.push_back({delivery.metadata.operation, delivery.metadata.sequence,
                                   delivery.metadata.owner, core::BackendOperationRunning{}});
        return core::Result<void, core::Diagnostics>::success();
    }
    m_backend_facts.push_back({delivery.metadata.operation, delivery.metadata.sequence,
                               delivery.metadata.owner, core::BackendOperationCompleted{}});
    return core::Result<void, core::Diagnostics>::success();
}

RuntimePresentationDispatchResult RuntimePresentationBridge::drain_backend_facts()
{
    RuntimePresentationDispatchResult result;
    auto facts = std::move(m_backend_facts);
    m_backend_facts.clear();
    for (const auto& fact : facts) {
        const auto found = std::find_if(
            m_coordinator.lifecycles().begin(), m_coordinator.lifecycles().end(),
            [&](const auto& lifecycle) { return lifecycle.metadata.operation == fact.operation; });
        if (found == m_coordinator.lifecycles().end())
            continue;
        const auto lifecycle = *found;
        const bool completed = std::holds_alternative<core::BackendOperationCompleted>(fact.fact);
        auto acknowledged = m_coordinator.acknowledge(fact);
        if (!acknowledged) {
            core::append_diagnostics(result.diagnostics, std::move(acknowledged).error());
            continue;
        }
        if (auto input = terminal_input(lifecycle, completed))
            result.inputs.push_back(std::move(*input));
        if (const auto* failed = std::get_if<core::BackendOperationFailed>(&fact.fact))
            result.diagnostics.push_back(failed->diagnostic);
    }
    return result;
}

std::optional<core::RuntimeInputMessage>
RuntimePresentationBridge::terminal_input(const core::PresentationOperationLifecycle& lifecycle,
                                          bool completed) const
{
    return std::visit(
        [&](const auto& target) -> std::optional<core::RuntimeInputMessage> {
            using T = std::decay_t<decltype(target)>;
            if constexpr (std::is_same_v<T, core::PresentationFlowCompletion>) {
                return completed ? core::RuntimeInputMessage{core::CompletePresentationInput{
                                       std::get<core::PresentationOperationId>(
                                           lifecycle.metadata.operation),
                                       target.owner, target.blocker}}
                                 : core::RuntimeInputMessage{core::CancelPresentationInput{
                                       std::get<core::PresentationOperationId>(
                                           lifecycle.metadata.operation),
                                       target.owner, target.blocker}};
            } else if constexpr (std::is_same_v<T, core::AudioFlowCompletion>) {
                const auto operation =
                    std::get<core::AudioOperationId>(lifecycle.metadata.operation);
                return completed ? core::RuntimeInputMessage{core::CompleteAudioInput{
                                       operation, target.owner, target.blocker}}
                                 : core::RuntimeInputMessage{core::CancelAudioInput{
                                       operation, target.owner, target.blocker}};
            } else if constexpr (std::is_same_v<T, core::ScriptAudioCompletion>) {
                const auto operation =
                    std::get<core::AudioOperationId>(lifecycle.metadata.operation);
                const core::AudioCompletionHandle completion = target.invocation;
                return completed ? core::RuntimeInputMessage{core::CompleteAudioInput{
                                       operation, target.owner, completion}}
                                 : core::RuntimeInputMessage{
                                       core::CancelAudioInput{operation, target.owner, completion}};
            }
            return std::nullopt;
        },
        lifecycle.metadata.completion);
}

RuntimePresentationDispatchResult RuntimePresentationBridge::poll_audio()
{
    RuntimePresentationDispatchResult result;
    for (const auto& completion : m_audio.take_completions()) {
        const auto found =
            std::find_if(m_coordinator.lifecycles().begin(), m_coordinator.lifecycles().end(),
                         [&](const auto& lifecycle) {
                             return lifecycle.metadata.operation ==
                                    core::PresentationOperationRef{completion.operation};
                         });
        if (found == m_coordinator.lifecycles().end())
            continue;
        auto acknowledged =
            m_coordinator.acknowledge({found->metadata.operation, found->metadata.sequence,
                                       found->metadata.owner, core::BackendOperationCompleted{}});
        if (!acknowledged)
            core::append_diagnostics(result.diagnostics, std::move(acknowledged).error());
        else
            result.inputs.emplace_back(completion);
    }
    for (const auto& termination : m_audio.take_terminations()) {
        const auto found =
            std::find_if(m_coordinator.lifecycles().begin(), m_coordinator.lifecycles().end(),
                         [&](const auto& lifecycle) {
                             return lifecycle.metadata.operation ==
                                    core::PresentationOperationRef{termination.operation};
                         });
        if (found != m_coordinator.lifecycles().end()) {
            auto acknowledged = m_coordinator.acknowledge(
                {found->metadata.operation, found->metadata.sequence, found->metadata.owner,
                 core::BackendOperationCompleted{}});
            if (!acknowledged)
                core::append_diagnostics(result.diagnostics, std::move(acknowledged).error());
        }
        result.inputs.emplace_back(termination);
    }
    return result;
}

core::Diagnostics
RuntimePresentationBridge::set_active_text_phase(core::ActiveTextPresentationPhase phase)
{
    if (phase == m_active_text_phase)
        return {};
    if (phase != core::ActiveTextPresentationPhase::Stable) {
        if (!m_allocate_presentation_id)
            return one({.code = "presentation.id_allocator_unavailable",
                        .message = "ActiveText requires the runtime presentation ID allocator"});
        const auto operation = m_allocate_presentation_id();
        auto accepted = m_coordinator.accept(core::ActiveTextPresentationOperation{
            operation, phase, core::LayoutClockDomain::Gameplay});
        if (!accepted)
            return std::move(accepted).error();
        if (m_active_text_operation) {
            auto replaced = m_coordinator.replace(*m_active_text_operation, operation);
            if (!replaced) {
                auto diagnostics = std::move(replaced).error();
                auto cancelled = m_coordinator.cancel(
                    operation, core::PresentationCancellationReason::ExplicitRequest);
                if (!cancelled)
                    core::append_diagnostics(diagnostics, std::move(cancelled).error());
                return diagnostics;
            }
        }
        m_active_text_operation = operation;
        m_active_text_phase = phase;
        return {};
    }
    if (!m_active_text_operation) {
        m_active_text_phase = phase;
        return {};
    }
    const auto lifecycle =
        std::find_if(m_coordinator.lifecycles().begin(), m_coordinator.lifecycles().end(),
                     [&](const auto& value) {
                         return value.metadata.operation ==
                                core::PresentationOperationRef{*m_active_text_operation};
                     });
    if (lifecycle == m_coordinator.lifecycles().end())
        return one({.code = "presentation.active_text_lifecycle_missing",
                    .message = "ActiveText causal operation has no coordinator lifecycle"});
    auto completed = m_coordinator.acknowledge(
        {*m_active_text_operation, lifecycle->metadata.sequence,
         core::PresentationOperationOwner::GameplayRuntime, core::BackendOperationCompleted{}});
    if (!completed)
        return std::move(completed).error();
    m_active_text_operation.reset();
    m_active_text_phase = phase;
    return {};
}

core::Diagnostics RuntimePresentationBridge::reconcile(const core::CompiledProject& project,
                                                       const core::SessionState& state)
{
    auto published = m_publisher.reproject(project, state);
    if (!published)
        return std::move(published).error();
    if (const auto* snapshot = m_publisher.published()) {
        auto reconciled = m_coordinator.reconcile_snapshot(*snapshot);
        if (!reconciled)
            return std::move(reconciled).error();
    }
    return {};
}

core::Diagnostics RuntimePresentationBridge::reconcile()
{
    if (!m_project || !m_state_provider)
        return one({.code = "presentation.runtime_unbound",
                    .message = "Presentation snapshot projection requires a bound runtime"});
    return reconcile(*m_project, m_state_provider());
}

core::Result<void, core::Diagnostics>
RuntimePresentationBridge::reconcile(const core::RuntimePresentationSnapshot& snapshot)
{
    if (m_snapshot_backend)
        return m_snapshot_backend(snapshot);
    return core::Result<void, core::Diagnostics>::success();
}

void RuntimePresentationBridge::terminate(core::PresentationCancellationReason reason)
{
    m_coordinator.cancel_all(reason);
    m_coordinator.reset_backends(reason);
    m_coordinator.clear_session();
    m_active_text_operation.reset();
    m_active_text_phase = core::ActiveTextPresentationPhase::Stable;
    m_backend_facts.clear();
    m_publisher = {};
}

void RuntimePresentationBridge::reset(core::PresentationCancellationReason reason)
{
    m_audio.reset(reason);
}

void RuntimePresentationBridge::bind_presentation_id_allocator(
    std::function<core::PresentationOperationId()> allocator)
{
    m_allocate_presentation_id = std::move(allocator);
}

void RuntimePresentationBridge::bind_snapshot_backend(
    std::function<core::Result<void, core::Diagnostics>(const core::RuntimePresentationSnapshot&)>
        backend)
{
    m_snapshot_backend = std::move(backend);
}

void RuntimePresentationBridge::bind_runtime(
    const core::CompiledProject* project, std::function<const core::SessionState&()> state_provider)
{
    m_project = project;
    m_state_provider = std::move(state_provider);
}
} // namespace noveltea
