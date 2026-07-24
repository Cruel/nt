#include "noveltea/runtime_presentation_bridge.hpp"
#include "noveltea/world_transition.hpp"

#include <algorithm>
#include <iterator>
#include <type_traits>

namespace noveltea {
namespace {
core::Diagnostics one(core::Diagnostic diagnostic) { return {std::move(diagnostic)}; }

bool live_lifecycle(const core::PresentationOperationLifecycle& lifecycle) noexcept
{
    return std::holds_alternative<core::PresentationOperationAccepted>(lifecycle.state) ||
           std::holds_alternative<core::PresentationOperationRunning>(lifecycle.state);
}

void append_dispatch_result(RuntimePresentationDispatchResult& destination,
                            RuntimePresentationDispatchResult source)
{
    destination.inputs.insert(destination.inputs.end(),
                              std::make_move_iterator(source.inputs.begin()),
                              std::make_move_iterator(source.inputs.end()));
    core::append_diagnostics(destination.diagnostics, std::move(source.diagnostics));
}
} // namespace

RuntimePresentationBridge::RuntimePresentationBridge(RuntimeAudioAdapter& audio)
    : m_audio(audio), m_coordinator(this, this)
{
}

core::Result<void, core::Diagnostics>
RuntimePresentationBridge::reconcile_snapshot(const core::RuntimePresentationSnapshot& snapshot)
{
    return m_coordinator.reconcile_snapshot(snapshot);
}

core::Result<runtime::PresentationAcceptance, core::Diagnostics>
RuntimePresentationBridge::accept(const core::PresentationOperation& operation)
{
    if (m_pending_mandatory_snapshot && m_mandatory_asset_gate)
        m_mandatory_asset_gate->show_overlay_immediately_on_owner();
    auto accepted = m_coordinator.accept(operation);
    if (!accepted)
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
            std::move(accepted).error());
    return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success(
        runtime::PresentationAcceptance{.accepted = true});
}

core::Result<runtime::PresentationAcceptance, core::Diagnostics>
RuntimePresentationBridge::accept(const core::AudioOperation& operation)
{
    auto accepted = m_coordinator.accept(operation);
    if (!accepted)
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
            std::move(accepted).error());
    const bool starts_playback = operation.action == core::compiled::AudioAction::Play ||
                                 operation.action == core::compiled::AudioAction::FadeIn;
    const bool covered_by_mandatory_gate =
        m_pending_mandatory_snapshot && m_mandatory_asset_gate && starts_playback &&
        operation.purpose != core::AudioOperationPurpose::UiCosmetic;
    if (m_pending_mandatory_snapshot && m_mandatory_asset_gate) {
        auto included = m_mandatory_asset_gate->include_audio_operation_on_owner(operation);
        if (!included) {
            (void)m_coordinator.cancel(operation.id,
                                       core::PresentationCancellationReason::ExplicitRequest);
            return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
                std::move(included).error());
        }
    }
    if (!covered_by_mandatory_gate) {
        auto prepared = m_audio.prepare(operation);
        if (!prepared) {
            auto diagnostics = one(std::move(prepared).error());
            auto cancelled = m_coordinator.cancel(
                operation.id, core::PresentationCancellationReason::ExplicitRequest);
            if (!cancelled)
                core::append_diagnostics(diagnostics, std::move(cancelled).error());
            return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
                std::move(diagnostics));
        }
    }
    return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success(
        runtime::PresentationAcceptance{.accepted = true});
}

RuntimePresentationDispatchResult RuntimePresentationBridge::flush()
{
    RuntimePresentationDispatchResult result;
    result.diagnostics = poll_audio_preparations();
    append_dispatch_result(result, drain_backend_facts());
    if (m_audio.causal_preparation_pending())
        return result;

    if (m_pending_mandatory_snapshot && m_mandatory_asset_gate) {
        const auto state = m_mandatory_asset_gate->poll_on_owner();
        if (state.disposition == assets::MandatoryAssetGateDisposition::Pending ||
            state.disposition == assets::MandatoryAssetGateDisposition::Failed)
            return result;
        if (state.disposition == assets::MandatoryAssetGateDisposition::Canceled) {
            core::append_diagnostics(result.diagnostics, state.diagnostics);
            return result;
        }
        auto committed = commit_pending_mandatory_snapshot();
        if (!committed) {
            auto diagnostics = std::move(committed).error();
            const core::Diagnostic failure =
                diagnostics.empty()
                    ? core::Diagnostic{.code = "assets.mandatory_publication_commit_failed",
                                       .message = "Mandatory publication backend commit failed"}
                    : diagnostics.front();
            for (const auto& lifecycle : m_coordinator.lifecycles()) {
                if (!live_lifecycle(lifecycle))
                    continue;
                m_backend_facts.push_back(
                    {lifecycle.metadata.operation, lifecycle.metadata.sequence,
                     lifecycle.metadata.owner,
                     core::BackendOperationFailed{
                         core::PresentationFailureDomain::WorldPresentation, failure}});
            }
            auto terminal = drain_backend_facts();
            if (terminal.diagnostics.empty())
                terminal.diagnostics = std::move(diagnostics);
            append_dispatch_result(result, std::move(terminal));
            return result;
        }
    }
    auto delivered = m_coordinator.deliver_pending();
    if (!delivered) {
        core::append_diagnostics(result.diagnostics, std::move(delivered).error());
        return result;
    }
    if (m_world_transition_backend) {
        auto facts = m_world_transition_backend->take_acknowledgements();
        m_backend_facts.insert(m_backend_facts.end(), std::make_move_iterator(facts.begin()),
                               std::make_move_iterator(facts.end()));
    }
    append_dispatch_result(result, drain_backend_facts());
    return result;
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
    if (std::holds_alternative<core::SceneTransitionGroupOperation>(delivery.operation) ||
        std::holds_alternative<core::RoomNavigationTransitionOperation>(delivery.operation) ||
        std::holds_alternative<core::BackgroundPresentationOperation>(delivery.operation) ||
        std::holds_alternative<core::ActorPresentationOperation>(delivery.operation) ||
        std::holds_alternative<core::LayoutFinitePresentationOperation>(delivery.operation)) {
        if (m_world_transition_backend)
            return m_world_transition_backend->realize(delivery);
        m_backend_facts.push_back(
            {delivery.metadata.operation, delivery.metadata.sequence, delivery.metadata.owner,
             core::BackendOperationFailed{
                 core::PresentationFailureDomain::WorldPresentation,
                 {.code = "presentation.world_transition_backend_unavailable",
                  .message = "Finite world transition has no bound realization backend"}}});
        return core::Result<void, core::Diagnostics>::success();
    }
    m_backend_facts.push_back({delivery.metadata.operation, delivery.metadata.sequence,
                               delivery.metadata.owner, core::BackendOperationCompleted{}});
    return core::Result<void, core::Diagnostics>::success();
}

core::Diagnostics RuntimePresentationBridge::poll_audio_preparations()
{
    core::Diagnostics diagnostics;
    m_audio.poll_preparations();
    for (auto& failure : m_audio.take_preparation_failures()) {
        const auto found =
            std::find_if(m_coordinator.lifecycles().begin(), m_coordinator.lifecycles().end(),
                         [&](const auto& lifecycle) {
                             return lifecycle.metadata.operation ==
                                    core::PresentationOperationRef{failure.operation};
                         });
        if (found == m_coordinator.lifecycles().end()) {
            diagnostics.push_back(std::move(failure.diagnostic));
            continue;
        }
        m_backend_facts.push_back(
            {found->metadata.operation, found->metadata.sequence, found->metadata.owner,
             core::BackendOperationFailed{core::PresentationFailureDomain::AudioPresentation,
                                          std::move(failure.diagnostic)}});
    }
    core::append_diagnostics(diagnostics, m_audio.take_async_diagnostics());
    return diagnostics;
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
    result.diagnostics = poll_audio_preparations();
    append_dispatch_result(result, drain_backend_facts());
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

RuntimePresentationFastForwardResult RuntimePresentationBridge::fast_forward_one()
{
    RuntimePresentationFastForwardResult result;
    auto advanced = m_coordinator.fast_forward_one();
    if (!advanced) {
        result.diagnostics = std::move(advanced).error();
        return result;
    }
    const auto* advanced_value = advanced.value_if();
    if (advanced_value == nullptr) {
        result.diagnostics.push_back(
            {.code = "presentation.fast_forward_result_missing",
             .message = "Presentation fast-forward returned no result value"});
        return result;
    }
    result.disposition = advanced_value->disposition;
    if (result.disposition !=
            core::PresentationFastForwardDisposition::CompletedSkippableOperation ||
        !advanced_value->operation)
        return result;

    const auto operation = *advanced_value->operation;
    if (const auto* audio = std::get_if<core::AudioOperationId>(&operation))
        m_audio.snap_operation(*audio);
    if (m_world_transition_backend)
        m_world_transition_backend->snap_to_target(operation);
    m_backend_facts.erase(
        std::remove_if(m_backend_facts.begin(), m_backend_facts.end(),
                       [&](const auto& fact) { return fact.operation == operation; }),
        m_backend_facts.end());
    const auto lifecycle =
        std::find_if(m_coordinator.lifecycles().begin(), m_coordinator.lifecycles().end(),
                     [&](const auto& value) { return value.metadata.operation == operation; });
    if (lifecycle == m_coordinator.lifecycles().end()) {
        result.diagnostics.push_back(
            {.code = "presentation.fast_forward_lifecycle_missing",
             .message = "Skipped presentation operation has no coordinator lifecycle"});
        return result;
    }
    if (auto input = terminal_input(*lifecycle, true))
        result.inputs.push_back(std::move(*input));
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

core::Diagnostics
RuntimePresentationBridge::reconcile_publication(const core::RuntimePresentationSnapshot& snapshot)
{
    auto reconciled = m_coordinator.reconcile_snapshot(snapshot);
    return reconciled ? core::Diagnostics{} : std::move(reconciled).error();
}

core::Result<void, core::Diagnostics>
RuntimePresentationBridge::reconcile(const core::RuntimePresentationSnapshot& snapshot)
{
    if (m_published_snapshot && *m_published_snapshot == snapshot)
        return core::Result<void, core::Diagnostics>::success();
    if (m_pending_mandatory_snapshot && *m_pending_mandatory_snapshot == snapshot)
        return core::Result<void, core::Diagnostics>::success();
    if (m_mandatory_asset_gate) {
        auto started = m_mandatory_asset_gate->begin_on_owner(snapshot);
        if (started.disposition == assets::MandatoryAssetGateDisposition::Failed ||
            started.disposition == assets::MandatoryAssetGateDisposition::Canceled) {
            return core::Result<void, core::Diagnostics>::failure(std::move(started.diagnostics));
        }
        m_pending_mandatory_snapshot = snapshot;
        if (started.disposition == assets::MandatoryAssetGateDisposition::Pending)
            return core::Result<void, core::Diagnostics>::success();
        return commit_pending_mandatory_snapshot();
    }

    auto audio = m_audio.reconcile_desired(snapshot.desired_audio);
    if (!audio)
        return audio;
    if (m_snapshot_backend) {
        auto reconciled = m_snapshot_backend(snapshot);
        if (!reconciled) {
            auto rollback = m_audio.reconcile_desired(m_published_desired_audio);
            auto diagnostics = std::move(reconciled).error();
            if (!rollback)
                core::append_diagnostics(diagnostics, std::move(rollback).error());
            return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
        }
    }
    m_published_desired_audio = snapshot.desired_audio;
    m_published_snapshot = snapshot;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimePresentationBridge::commit_pending_mandatory_snapshot()
{
    if (!m_pending_mandatory_snapshot || !m_mandatory_asset_gate)
        return core::Result<void, core::Diagnostics>::success();
    if (!m_mandatory_asset_gate->activate_candidate_on_owner()) {
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "assets.mandatory_candidate_not_ready",
                 .message = "Mandatory asset leases were not ready for publication commit"}));
    }

    const auto candidate = *m_pending_mandatory_snapshot;
    auto audio = m_audio.reconcile_desired(candidate.desired_audio);
    if (!audio) {
        m_mandatory_asset_gate->rollback_candidate_on_owner();
        m_pending_mandatory_snapshot.reset();
        return audio;
    }
    if (m_snapshot_backend) {
        auto reconciled = m_snapshot_backend(candidate);
        if (!reconciled) {
            auto rollback = m_audio.reconcile_desired(m_published_desired_audio);
            auto diagnostics = std::move(reconciled).error();
            if (!rollback)
                core::append_diagnostics(diagnostics, std::move(rollback).error());
            m_mandatory_asset_gate->rollback_candidate_on_owner();
            m_pending_mandatory_snapshot.reset();
            return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
        }
    }
    m_mandatory_asset_gate->commit_candidate_on_owner();
    m_published_desired_audio = candidate.desired_audio;
    m_published_snapshot = candidate;
    m_pending_mandatory_snapshot.reset();
    return core::Result<void, core::Diagnostics>::success();
}

void RuntimePresentationBridge::bind_mandatory_asset_gate(assets::MandatoryAssetGate* gate) noexcept
{
    if (m_mandatory_asset_gate == gate)
        return;
    if (m_mandatory_asset_gate)
        m_mandatory_asset_gate->rollback_candidate_on_owner();
    m_pending_mandatory_snapshot.reset();
    m_mandatory_asset_gate = gate;
}

bool RuntimePresentationBridge::mandatory_assets_pending() const noexcept
{
    return m_pending_mandatory_snapshot.has_value();
}

bool RuntimePresentationBridge::mandatory_assets_failed() const noexcept
{
    return m_mandatory_asset_gate && m_mandatory_asset_gate->failed_on_owner();
}

bool RuntimePresentationBridge::mandatory_asset_overlay_visible() const noexcept
{
    return m_mandatory_asset_gate && m_mandatory_asset_gate->overlay_visible_on_owner();
}

const core::LoadingProgress* RuntimePresentationBridge::mandatory_asset_progress() const noexcept
{
    return m_mandatory_asset_gate ? m_mandatory_asset_gate->progress_on_owner() : nullptr;
}

bool RuntimePresentationBridge::retry_mandatory_assets() noexcept
{
    return m_mandatory_asset_gate && m_mandatory_asset_gate->retry_on_owner();
}

void RuntimePresentationBridge::terminate(core::PresentationCancellationReason reason)
{
    m_coordinator.cancel_all(reason);
    m_coordinator.reset_backends(reason);
    m_coordinator.clear_session();
    m_active_text_operation.reset();
    if (m_mandatory_asset_gate)
        m_mandatory_asset_gate->rollback_candidate_on_owner();
    m_pending_mandatory_snapshot.reset();
    m_published_snapshot.reset();
    m_active_text_phase = core::ActiveTextPresentationPhase::Stable;
    m_backend_facts.clear();
    m_published_desired_audio.clear();
}

void RuntimePresentationBridge::reset(core::PresentationCancellationReason reason)
{
    m_audio.reset(reason);
    if (m_world_transition_backend)
        m_world_transition_backend->reset(reason);
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

void RuntimePresentationBridge::bind_world_transition_backend(
    WorldTransitionBackend* backend) noexcept
{
    m_world_transition_backend = backend;
}

} // namespace noveltea
