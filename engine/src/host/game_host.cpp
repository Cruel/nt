#include "host/game_host.hpp"

#include "noveltea/boundary/running_game_loader.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/world_transition.hpp"

#include <iterator>
#include <utility>
#include <variant>

namespace noveltea::host {
namespace {

core::Diagnostics one(core::Diagnostic diagnostic) { return {std::move(diagnostic)}; }

} // namespace

class GameHost::RunningGamePresentationPort final : public runtime::PresentationRuntimePort {
public:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_snapshot(const core::RuntimePresentationSnapshot& snapshot) override
    {
        m_snapshot = snapshot;
        if (!m_delegate)
            return core::Result<void, core::Diagnostics>::success();
        return m_delegate->reconcile_snapshot(snapshot);
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation& operation) override
    {
        if (m_delegate)
            return m_delegate->accept(operation);
        m_operations.emplace_back(operation);
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation& operation) override
    {
        if (m_delegate)
            return m_delegate->accept(operation);
        m_operations.emplace_back(operation);
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return m_delegate ? m_delegate->checkpoint_status() : m_staged_checkpoint_status;
    }

    void terminate(core::PresentationCancellationReason reason) override
    {
        m_operations.clear();
        if (m_delegate)
            m_delegate->terminate(reason);
    }

    [[nodiscard]] core::Result<void, core::Diagnostics>
    activate(runtime::PresentationRuntimePort& delegate)
    {
        m_delegate = &delegate;
        if (m_snapshot) {
            auto reconciled = m_delegate->reconcile_snapshot(*m_snapshot);
            if (!reconciled) {
                m_delegate = nullptr;
                return reconciled;
            }
        }
        for (const auto& operation : m_operations) {
            auto accepted =
                std::visit([&](const auto& value) { return m_delegate->accept(value); }, operation);
            if (!accepted || !accepted.value_if()->accepted) {
                auto diagnostics = accepted ? one({.code = "host.game_load_presentation_rejected",
                                                   .message = "Prepared presentation operation was "
                                                              "rejected during activation"})
                                            : std::move(accepted).error();
                m_delegate = nullptr;
                return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
            }
        }
        m_operations.clear();
        return core::Result<void, core::Diagnostics>::success();
    }

    void detach() noexcept { m_delegate = nullptr; }

private:
    using StagedOperation = std::variant<core::PresentationOperation, core::AudioOperation>;

    runtime::PresentationRuntimePort* m_delegate = nullptr;
    std::optional<core::RuntimePresentationSnapshot> m_snapshot;
    std::vector<StagedOperation> m_operations;
    core::PresentationCheckpointStatus m_staged_checkpoint_status{
        core::CheckpointStatusRevision::from_number(1), {}, std::nullopt};
};

GameHost::GameHost(Dependencies dependencies) noexcept
    : m_dependencies(dependencies), m_save_slots(&dependencies.save_slots),
      m_runtime_audio_adapter(dependencies.audio, m_runtime_ui_asset_resolver),
      m_runtime_presentation(m_runtime_audio_adapter),
      m_system_layouts(dependencies.system_layout_host)
{
    m_runtime_presentation.bind_world_transition_backend(dependencies.world_transitions);
}

GameHost::~GameHost() = default;

void GameHost::replace_running_game(std::unique_ptr<runtime::RunningGame> running_game) noexcept
{
    m_running_game.reset();
    m_running_game_presentation_port.reset();
    m_running_game = std::move(running_game);
    advance_session_generation();
    m_lifecycle_state =
        m_running_game ? LoadedGameLifecycleState::Loaded : LoadedGameLifecycleState::Empty;
}

void GameHost::release_running_game() noexcept
{
    if (m_running_game)
        advance_session_generation();
    m_running_game.reset();
    m_running_game_presentation_port.reset();
    m_lifecycle_state = LoadedGameLifecycleState::Empty;
}

core::Result<void, core::Diagnostics>
GameHost::load_compiled_project(GameHostLoadRequest request, const GameHostLoadHooks& hooks)
{
    auto resolved = runtime::resolve_running_game_source(
        m_dependencies.content_assets, request.logical_path, std::move(request.runtime_locale));
    if (!resolved)
        return core::Result<void, core::Diagnostics>::failure(std::move(resolved).error());

    auto source = std::move(*resolved.value_if());
    assets::AssetManager::NamespaceMounts previous_project_mounts;
    if (source.replaces_project_namespace) {
        previous_project_mounts = m_dependencies.content_assets.replace_namespace(
            "project", std::move(source.project_mounts));
    }
    const auto restore_project_mounts = [&]() {
        if (source.replaces_project_namespace) {
            (void)m_dependencies.content_assets.replace_namespace(
                "project", std::move(previous_project_mounts));
        }
    };

    auto candidate_presentation = std::make_unique<RunningGamePresentationPort>();
    auto loaded = runtime::load_running_game(
        std::move(source.input), m_dependencies.script_certifier, m_dependencies.script_invocations,
        *candidate_presentation, *m_save_slots);
    if (!loaded) {
        restore_project_mounts();
        return core::Result<void, core::Diagnostics>::failure(std::move(loaded).error());
    }

    auto candidate = std::move(*loaded.value_if());
    std::optional<runtime::RuntimePublication> candidate_publication;
    std::vector<runtime::RuntimeEvent> candidate_events;
    const auto dispatch_candidate =
        [&](core::RuntimeInputMessage input) -> core::Result<void, core::Diagnostics> {
        auto result = candidate->session().dispatch(input);
        if (result.publication)
            candidate_publication = std::move(result.publication);
        candidate_events.insert(candidate_events.end(),
                                std::make_move_iterator(result.events.begin()),
                                std::make_move_iterator(result.events.end()));
        if (!result.diagnostics.empty())
            return core::Result<void, core::Diagnostics>::failure(std::move(result.diagnostics));
        if (result.disposition == runtime::RuntimeInputDisposition::Failed) {
            return core::Result<void, core::Diagnostics>::failure(
                one({.code = "host.game_load_runtime_start_failed",
                     .message = "Prepared running game rejected its initial runtime input"}));
        }
        return core::Result<void, core::Diagnostics>::success();
    };

    auto started = dispatch_candidate(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    if (!started) {
        candidate.reset();
        candidate_presentation.reset();
        restore_project_mounts();
        return started;
    }
    if (request.stop_runtime_after_load) {
        auto stopped = dispatch_candidate(core::RuntimeInputMessage{core::StopRuntimeInput{}});
        if (!stopped) {
            candidate.reset();
            candidate_presentation.reset();
            restore_project_mounts();
            return stopped;
        }
    }
    if (!candidate_publication) {
        candidate.reset();
        candidate_presentation.reset();
        restore_project_mounts();
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.game_load_initial_publication_missing",
                 .message = "Prepared running game did not produce an initial publication"}));
    }

    if (hooks.prepare_candidate) {
        auto prepared = hooks.prepare_candidate(*candidate, *candidate_publication);
        if (!prepared) {
            candidate.reset();
            candidate_presentation.reset();
            restore_project_mounts();
            return prepared;
        }
    }

    const bool previous_show_title = !m_system_layouts.game_active();
    const auto previous_lifecycle_state = m_lifecycle_state;
    auto previous_compiled_project_path = std::move(m_compiled_project_path);
    auto previous_pending_runtime_inputs = std::move(m_pending_runtime_inputs);
    auto previous_runtime_publication = std::move(m_runtime_publication);
    auto previous_runtime_events = std::move(m_runtime_events);
    auto previous_runtime_observations = std::move(m_runtime_observations);
    auto previous_runtime_diagnostics = std::move(m_runtime_diagnostics);
    auto previous_runtime_diagnostic_records = std::move(m_runtime_diagnostic_records);

    detach_runtime_bindings();
    if (hooks.detach_current_resources)
        hooks.detach_current_resources();
    if (m_running_game_presentation_port)
        m_running_game_presentation_port->detach();
    m_runtime_presentation.terminate(core::PresentationCancellationReason::ProjectReload);

    auto previous_game = std::move(m_running_game);
    auto previous_presentation = std::move(m_running_game_presentation_port);
    clear_loaded_game_state();

    m_running_game = std::move(candidate);
    m_running_game_presentation_port = std::move(candidate_presentation);
    m_lifecycle_state = request.stop_runtime_after_load ? LoadedGameLifecycleState::Stopped
                                                        : LoadedGameLifecycleState::Running;
    m_compiled_project_path = request.logical_path;
    m_runtime_publication = *candidate_publication;
    m_runtime_events = std::move(candidate_events);
    m_runtime_observations = candidate_publication->observations;
    m_runtime_ui_asset_resolver.bind(m_running_game.get());

    if (hooks.commit_candidate_resources)
        hooks.commit_candidate_resources(*m_running_game, *candidate_publication);
    m_runtime_presentation.bind_presentation_id_allocator(
        [this]() { return m_running_game->session().allocate_presentation_operation_id(); });

    const auto rollback_to_previous = [&](core::Diagnostics diagnostics) {
        detach_runtime_bindings();
        if (m_running_game_presentation_port)
            m_running_game_presentation_port->detach();
        m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);

        auto failed_game = std::move(m_running_game);
        auto failed_presentation = std::move(m_running_game_presentation_port);
        clear_loaded_game_state();
        failed_game.reset();
        failed_presentation.reset();
        restore_project_mounts();

        m_running_game = std::move(previous_game);
        m_running_game_presentation_port = std::move(previous_presentation);
        m_lifecycle_state = previous_lifecycle_state;
        m_compiled_project_path = std::move(previous_compiled_project_path);
        m_pending_runtime_inputs = std::move(previous_pending_runtime_inputs);
        m_runtime_publication = std::move(previous_runtime_publication);
        m_runtime_events = std::move(previous_runtime_events);
        m_runtime_observations = std::move(previous_runtime_observations);
        m_runtime_diagnostics = std::move(previous_runtime_diagnostics);
        m_runtime_diagnostic_records = std::move(previous_runtime_diagnostic_records);

        if (!m_running_game)
            return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));

        m_runtime_ui_asset_resolver.bind(m_running_game.get());
        if (hooks.restore_previous_resources)
            hooks.restore_previous_resources(*m_running_game);
        m_runtime_presentation.bind_presentation_id_allocator(
            [this]() { return m_running_game->session().allocate_presentation_operation_id(); });
        if (m_running_game_presentation_port) {
            auto restored = m_running_game_presentation_port->activate(m_runtime_presentation);
            if (!restored)
                core::append_diagnostics(diagnostics, std::move(restored).error());
        }
        auto rebound = attach_runtime_bindings(previous_show_title);
        if (!rebound)
            core::append_diagnostics(diagnostics, std::move(rebound).error());
        return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
    };

    auto activated = m_running_game_presentation_port->activate(m_runtime_presentation);
    if (!activated)
        return rollback_to_previous(std::move(activated).error());

    auto attached = attach_runtime_bindings(request.load_title_screen);
    if (!attached)
        return rollback_to_previous(std::move(attached).error());

    advance_session_generation();
    previous_game.reset();
    previous_presentation.reset();
    return core::Result<void, core::Diagnostics>::success();
}

HostRuntimeDispatchResult GameHost::submit_runtime_input(core::RuntimeInputMessage input)
{
    if (!m_running_game) {
        HostRuntimeDispatchResult result;
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics = one({.code = "host.runtime_input_without_game",
                                  .message = "Runtime input requires an active running game"});
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);
        return result;
    }
    if (m_dispatch_active) {
        HostRuntimeDispatchResult result;
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics =
            one({.code = "host.reentrant_runtime_dispatch",
                 .message = "GameHost runtime dispatch cannot be called recursively"});
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);
        return result;
    }

    m_dispatch_active = true;
    auto result =
        HostRuntimeDispatchResult::from_runtime(m_running_game->session().dispatch(input));

    {
        auto& gateway = m_running_game->session().gateway();
        runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
        m_dependencies.runtime_ui.bind_layout_event_capabilities(
            issuer.issue(runtime::RuntimeCapabilityProfile::GameplayLayoutEvent),
            issuer.issue(runtime::RuntimeCapabilityProfile::ShellLayoutEvent));
    }

    if (!result.diagnostics.empty())
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);

    m_runtime_events = result.events;
    core::Diagnostics application_diagnostics;
    bool application_accepted = true;
    if (result.publication) {
        application_accepted =
            apply_runtime_publication(*result.publication, result.events, application_diagnostics);
    } else if (m_dependencies.observation_sink) {
        m_dependencies.observation_sink->observe_runtime_outputs(m_runtime_observations,
                                                                 result.events);
    }

    m_dependencies.runtime_ui.deliver_runtime_events(result.events);
    if (!m_defer_presentation_flush) {
        application_accepted =
            flush_runtime_presentation(&application_diagnostics) && application_accepted;
    }
    m_system_layouts.refresh();

    if (!application_diagnostics.empty()) {
        core::append_diagnostics(result.diagnostics, std::move(application_diagnostics));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    }
    if (!application_accepted)
        result.disposition = runtime::RuntimeInputDisposition::Failed;

    m_dispatch_active = false;
    return result;
}

bool GameHost::advance(GameHostAdvanceInput input)
{
    if (!m_running_game)
        return true;

    m_running_game->session().set_effective_gameplay_pause(
        std::move(input.effective_gameplay_pause));
    if (!input.runtime_input_admitted)
        return true;

    // Existing presentation/audio backends advance after this runtime stage. Keep operations
    // accepted by frame inputs staged until that backend update finishes so newly created work does
    // not consume a presentation tick in the same frame.
    const bool previous_defer_presentation_flush = m_defer_presentation_flush;
    m_defer_presentation_flush = true;
    const bool pending_accepted = dispatch_pending_runtime_inputs();
    auto clock_advance = submit_runtime_input(
        core::RuntimeInputMessage{core::AdvanceTimeInput{input.frame_clock.gameplay_delta}});
    m_defer_presentation_flush = previous_defer_presentation_flush;
    return clock_advance.accepted() && pending_accepted;
}

bool GameHost::dispatch_pending_runtime_inputs()
{
    if (!m_running_game)
        return false;

    bool accepted = true;
    auto pending = std::move(m_pending_runtime_inputs);
    m_pending_runtime_inputs.clear();
    for (auto& input : pending) {
        auto result = submit_runtime_input(std::move(input));
        accepted = result.accepted() && accepted;
    }
    return accepted;
}

bool GameHost::flush_runtime_presentation(core::Diagnostics* diagnostics)
{
    if (!m_running_game)
        return true;

    bool accepted = true;
    auto active_text = m_runtime_presentation.set_active_text_phase(
        m_dependencies.runtime_ui.active_text_presentation_phase());
    if (!active_text.empty()) {
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, active_text);
        if (diagnostics)
            core::append_diagnostics(*diagnostics, active_text);
        accepted = false;
    }

    auto flushed = m_runtime_presentation.flush();
    if (!flushed.diagnostics.empty()) {
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, flushed.diagnostics);
        if (diagnostics)
            core::append_diagnostics(*diagnostics, flushed.diagnostics);
        accepted = false;
    }
    m_pending_runtime_inputs.insert(m_pending_runtime_inputs.end(),
                                    std::make_move_iterator(flushed.inputs.begin()),
                                    std::make_move_iterator(flushed.inputs.end()));
    return accepted;
}

void GameHost::poll_runtime_presentation()
{
    if (!m_running_game)
        return;

    auto presentation = m_runtime_presentation.poll_audio();
    if (!presentation.diagnostics.empty())
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, presentation.diagnostics);
    m_pending_runtime_inputs.insert(m_pending_runtime_inputs.end(),
                                    std::make_move_iterator(presentation.inputs.begin()),
                                    std::make_move_iterator(presentation.inputs.end()));
}

void GameHost::mark_running() noexcept
{
    if (m_running_game)
        m_lifecycle_state = LoadedGameLifecycleState::Running;
}

void GameHost::mark_stopped() noexcept
{
    if (m_running_game)
        m_lifecycle_state = LoadedGameLifecycleState::Stopped;
}

void GameHost::advance_session_generation() noexcept
{
    if (const auto next = m_session_generation.next())
        m_session_generation = *next;
}

void GameHost::detach_runtime_bindings() noexcept
{
    m_dependencies.runtime_ui.bind_runtime_shell_handler({});
    m_dependencies.runtime_ui.bind_runtime_input_handler({});
    m_dependencies.runtime_ui.bind_layout_event_capabilities(std::nullopt, std::nullopt);
    m_dependencies.runtime_ui.bind_asset_resolver(nullptr);
    m_system_layouts.reset();
    m_runtime_layouts.reset();
    m_presentation_layout_instances.clear();
    m_retained_presentation_layout_instances.clear();
    m_current_presentation_revision.reset();
    m_runtime_ui_asset_resolver.clear();
}

void GameHost::clear_loaded_game_state() noexcept
{
    m_pending_runtime_inputs.clear();
    m_runtime_publication.reset();
    m_runtime_events.clear();
    m_runtime_observations = {};
    m_runtime_diagnostics.clear();
    m_runtime_diagnostic_records.clear();
    m_compiled_project_path.clear();
}

void GameHost::retain_runtime_diagnostics(HostFrameStage stage,
                                          const core::Diagnostics& diagnostics)
{
    if (diagnostics.empty())
        return;

    m_runtime_diagnostics.insert(m_runtime_diagnostics.end(), diagnostics.begin(),
                                 diagnostics.end());
    for (const auto& diagnostic : diagnostics) {
        m_runtime_diagnostic_records.push_back({stage, diagnostic});
        if (m_dependencies.diagnostic_sink)
            m_dependencies.diagnostic_sink(stage, diagnostic);
    }
    m_dependencies.runtime_ui.append_typed_runtime_diagnostics(diagnostics);
}

bool GameHost::apply_runtime_publication(const runtime::RuntimePublication& publication,
                                         std::span<const runtime::RuntimeEvent> events,
                                         core::Diagnostics& application_diagnostics)
{
    bool accepted = true;
    auto presentation = m_runtime_presentation.reconcile_publication(publication.presentation);
    if (!presentation.empty()) {
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, presentation);
        core::append_diagnostics(application_diagnostics, std::move(presentation));
        accepted = false;
    }

    m_runtime_publication = publication;
    m_runtime_observations = publication.observations;
    m_dependencies.runtime_ui.apply_runtime_publication(publication);

    if (m_dependencies.preview_publication_sink) {
        auto preview =
            m_dependencies.preview_publication_sink->apply_runtime_publication(publication);
        if (!preview) {
            auto diagnostics = std::move(preview).error();
            retain_runtime_diagnostics(HostFrameStage::UpdateRuntimeUi, diagnostics);
            core::append_diagnostics(application_diagnostics, std::move(diagnostics));
            accepted = false;
        }
    }
    if (m_dependencies.observation_sink) {
        m_dependencies.observation_sink->observe_runtime_outputs(publication.observations, events);
    }
    return accepted;
}

core::Result<void, core::Diagnostics> GameHost::attach_runtime_bindings(bool show_title)
{
    if (!m_running_game)
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.game_binding_runtime_missing",
                 .message = "Runtime bindings require an active running game"}));

    auto& gateway = m_running_game->session().gateway();
    runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
    m_dependencies.runtime_ui.bind_layout_event_capabilities(
        issuer.issue(runtime::RuntimeCapabilityProfile::GameplayLayoutEvent),
        issuer.issue(runtime::RuntimeCapabilityProfile::ShellLayoutEvent));
    m_dependencies.runtime_ui.bind_asset_resolver(&m_runtime_ui_asset_resolver);
    if (m_runtime_publication)
        m_dependencies.runtime_ui.apply_runtime_publication(*m_runtime_publication);
    m_dependencies.runtime_ui.deliver_runtime_events(m_runtime_events);
    m_dependencies.runtime_ui.bind_runtime_input_handler(
        [this](const core::RuntimeInputMessage& input) {
            return submit_runtime_input(input).accepted();
        });
    m_dependencies.runtime_ui.bind_runtime_shell_handler(
        [this](const core::RuntimeShellCommand& command) {
            auto handled = m_system_layouts.dispatch(command);
            if (handled)
                return true;
            auto diagnostics = std::move(handled).error();
            m_runtime_diagnostics.insert(m_runtime_diagnostics.end(), diagnostics.begin(),
                                         diagnostics.end());
            m_dependencies.runtime_ui.append_typed_runtime_diagnostics(std::move(diagnostics));
            return false;
        });

    auto initialized_shell = m_system_layouts.initialize(show_title);
    if (!initialized_shell)
        return initialized_shell;

    if (show_title) {
        const auto& project = m_running_game->package().project();
        const auto& identity = project.identity();
        const auto& title_screen = project.settings().title_screen;
        m_dependencies.runtime_ui.bind_title_document(
            title_screen.show_project_title ? identity.name : std::string{}, title_screen.subtitle,
            title_screen.start_label);
    }
    return core::Result<void, core::Diagnostics>::success();
}

} // namespace noveltea::host
