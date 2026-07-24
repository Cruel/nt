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

HostGeneration host_generation(GameSessionGeneration generation)
{
    return *HostGeneration::from_number(generation.number());
}

bool is_start_input(const core::RuntimeInputMessage& input) noexcept
{
    return std::holds_alternative<core::StartRuntimeInput>(input);
}

bool is_stop_input(const core::RuntimeInputMessage& input) noexcept
{
    return std::holds_alternative<core::StopRuntimeInput>(input);
}

bool replaces_runtime_generation(const core::RuntimeInputMessage& input) noexcept
{
    return std::holds_alternative<core::ResetRuntimeInput>(input) ||
           std::holds_alternative<core::LoadRuntimeInput>(input);
}

class CandidateProjectAssetContext final : public runtime::ScriptSourcePort {
public:
    CandidateProjectAssetContext(const assets::AssetManager& live_assets,
                                 const assets::AssetManager::NamespaceMounts& project_mounts)
        : m_live_assets(live_assets)
    {
        for (const auto& source : project_mounts)
            m_candidate_assets.mount("project", source);
    }

    [[nodiscard]] core::Result<std::string, runtime::ScriptSourceError>
    read_script_source(std::string_view logical_path) const override
    {
        const bool project_path = logical_path.find(":/") == std::string_view::npos ||
                                  logical_path.starts_with("project:/");
        return project_path ? m_candidate_assets.read_script_source(logical_path)
                            : m_live_assets.read_script_source(logical_path);
    }

    [[nodiscard]] const assets::AssetManager& project_assets() const noexcept
    {
        return m_candidate_assets;
    }

private:
    const assets::AssetManager& m_live_assets;
    assets::AssetManager m_candidate_assets;
};

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

class GameHost::ScriptInvocationRouter final : public runtime::ScriptInvocationPort {
public:
    explicit ScriptInvocationRouter(runtime::ScriptInvocationPort& delegate) noexcept
        : m_delegate(delegate)
    {
    }

    void bind_candidate_source(const runtime::ScriptSourcePort* source) noexcept
    {
        m_candidate_source = source;
    }

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    invoke(const runtime::ScriptInvocationRequest& request,
           const runtime::RuntimeCapabilitySet& capabilities) override
    {
        if (m_candidate_source == nullptr || !request.asset_path)
            return m_delegate.invoke(request, capabilities);

        auto source = m_candidate_source->read_script_source(*request.asset_path);
        if (!source) {
            return core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>::
                failure({.code = runtime::ScriptInvocationErrorCode::LoadFailed,
                         .message = source.error().message,
                         .chunk = *request.asset_path,
                         .traceback = source.error().message});
        }
        auto resolved = request;
        resolved.source = std::move(*source.value_if());
        resolved.chunk_name = "@" + *request.asset_path;
        resolved.asset_path.reset();
        return m_delegate.invoke(resolved, capabilities);
    }

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    resume(const core::ScriptInvocationHandle& invocation,
           const runtime::RuntimeCapabilitySet& capabilities) override
    {
        return m_delegate.resume(invocation, capabilities);
    }

    void cancel(const core::ScriptInvocationHandle& invocation,
                runtime::ScriptCancellationReason reason) override
    {
        m_delegate.cancel(invocation, reason);
    }

    void invalidate_capabilities(runtime::CapabilityGeneration generation) noexcept override
    {
        m_delegate.invalidate_capabilities(generation);
    }

private:
    runtime::ScriptInvocationPort& m_delegate;
    const runtime::ScriptSourcePort* m_candidate_source = nullptr;
};

class GameHost::RuntimeUiInputAdapter final : public RuntimeUiInputSink {
public:
    RuntimeUiInputAdapter(GameHost& host, GameSessionGeneration generation) noexcept
        : m_host(host), m_generation(generation)
    {
    }

    [[nodiscard]] bool submit_gameplay_input(core::RuntimeInputMessage input) override
    {
        return m_host.submit_runtime_input(m_generation, std::move(input)).accepted();
    }

    [[nodiscard]] bool submit_shell_command(core::RuntimeShellCommand command) override
    {
        return m_host.submit_runtime_ui_shell_command(m_generation, std::move(command));
    }

    [[nodiscard]] bool dispatch_layout_event(core::MountedLayoutOwner owner,
                                             const std::function<bool()>& dispatch) override
    {
        return m_host.dispatch_runtime_ui_layout_event(m_generation, owner, dispatch);
    }

private:
    GameHost& m_host;
    GameSessionGeneration m_generation;
};

GameHost::GameHost(Dependencies dependencies) noexcept
    : m_dependencies(dependencies), m_save_slots(&dependencies.save_slots),
      m_runtime_audio_adapter(dependencies.audio, m_runtime_ui_asset_service,
                              dependencies.content_assets),
      m_runtime_presentation(m_runtime_audio_adapter),
      m_system_layouts(dependencies.system_layout_host),
      m_script_invocation_router(
          std::make_unique<ScriptInvocationRouter>(dependencies.script_invocations))
{
    m_runtime_presentation.bind_world_transition_backend(dependencies.world_transitions);
}

GameHost::~GameHost() { shutdown(); }

std::optional<core::CheckpointThumbnailCaptureRequest>
GameHost::pending_checkpoint_thumbnail_capture() const noexcept
{
    if (!m_running_game)
        return std::nullopt;
    return m_running_game->session().pending_checkpoint_thumbnail_capture();
}

core::Result<void, core::Diagnostics>
GameHost::attach_checkpoint_thumbnail(const core::CheckpointThumbnailCaptureRequest& request,
                                      core::SaveCheckpointThumbnail thumbnail)
{
    if (!m_running_game) {
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.checkpoint_thumbnail_runtime_unavailable",
                 .message = "Checkpoint thumbnail completion has no active running game."}));
    }
    return m_running_game->session().attach_checkpoint_thumbnail(request, std::move(thumbnail));
}

void GameHost::replace_running_game(std::unique_ptr<runtime::RunningGame> running_game) noexcept
{
    detach_runtime_bindings();
    m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
    m_running_game.reset();
    m_running_game_presentation_port.reset();
    clear_loaded_game_state();
    m_running_game = std::move(running_game);
    advance_session_generation();
    advance_backend_generation();
    bind_runtime_ui_input_sink();
    m_shutdown = false;
    m_lifecycle_state =
        m_running_game ? LoadedGameLifecycleState::Loaded : LoadedGameLifecycleState::Empty;
}

void GameHost::release_running_game() noexcept
{
    if (!m_running_game && m_lifecycle_state == LoadedGameLifecycleState::Empty)
        return;
    advance_session_generation();
    advance_backend_generation();
    detach_runtime_bindings();
    m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
    m_running_game.reset();
    m_running_game_presentation_port.reset();
    clear_loaded_game_state();
    m_lifecycle_state = LoadedGameLifecycleState::Empty;
}

core::Result<void, core::Diagnostics>
GameHost::load_compiled_project(GameHostLoadRequest request, const GameHostLoadHooks& hooks)
{
    return load_compiled_project(std::move(request), {}, hooks);
}

core::Result<void, core::Diagnostics>
GameHost::load_compiled_project(GameHostLoadRequest request,
                                std::shared_ptr<assets::ZipAssetSource> runtime_package_source,
                                const GameHostLoadHooks& hooks)
{
    if (m_dispatch_active) {
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.game_load_during_dispatch",
                 .message = "Project load cannot replace a running game during runtime dispatch"}));
    }
    if (m_backend_reset_active) {
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.game_load_during_backend_reset",
                 .message = "Project load cannot replace a running game during backend reset"}));
    }

    auto resolved = runtime_package_source
                        ? runtime::resolve_running_game_package_source(
                              std::move(runtime_package_source), request.logical_path,
                              std::move(request.runtime_locale))
                        : runtime::resolve_running_game_source(m_dependencies.content_assets,
                                                               request.logical_path,
                                                               std::move(request.runtime_locale));
    if (!resolved)
        return core::Result<void, core::Diagnostics>::failure(std::move(resolved).error());

    auto source = std::move(*resolved.value_if());
    std::optional<CandidateProjectAssetContext> candidate_asset_context;
    std::optional<script::ScriptRuntime::ScopedSourceOverride> candidate_source_override;
    const assets::AssetManager* candidate_project_assets = &m_dependencies.content_assets;
    if (source.replaces_project_namespace) {
        candidate_asset_context.emplace(m_dependencies.content_assets, source.project_mounts);
        candidate_project_assets = &candidate_asset_context->project_assets();
        candidate_source_override.emplace(
            m_dependencies.script_certifier.override_sources(*candidate_asset_context));
        m_script_invocation_router->bind_candidate_source(&*candidate_asset_context);
    }
    struct ClearCandidateInvocationSource final {
        ScriptInvocationRouter& router;
        ~ClearCandidateInvocationSource() { router.bind_candidate_source(nullptr); }
    } clear_candidate_invocation_source{*m_script_invocation_router};

    assets::AssetManager::NamespaceMounts previous_project_mounts;
    bool project_namespace_replaced = false;
    const auto restore_project_mounts = [&]() {
        if (project_namespace_replaced) {
            (void)m_dependencies.content_assets.replace_namespace(
                "project", std::move(previous_project_mounts));
            project_namespace_replaced = false;
        }
    };

    auto candidate_presentation = std::make_unique<RunningGamePresentationPort>();
    auto loaded = runtime::load_running_game(
        std::move(source.input), m_dependencies.script_certifier, *m_script_invocation_router,
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
        auto prepared =
            hooks.prepare_candidate(*candidate, *candidate_publication, *candidate_project_assets);
        if (!prepared) {
            candidate.reset();
            candidate_presentation.reset();
            restore_project_mounts();
            return prepared;
        }
    }

    // Candidate decode, Lua certification, startup dispatch, and host-side validation above run
    // against an isolated project source. Only now, once the candidate is known to be viable, does
    // the live namespace generation advance. The ScriptRuntime continues to reference the normal
    // live AssetManager after the candidate mounts are installed.
    if (source.replaces_project_namespace) {
        previous_project_mounts = m_dependencies.content_assets.replace_namespace(
            "project", std::move(source.project_mounts));
        project_namespace_replaced = true;
        candidate_source_override.reset();
        m_script_invocation_router->bind_candidate_source(nullptr);
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
    m_runtime_ui_asset_service.install(m_running_game->package().project());

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

        m_runtime_ui_asset_service.install(m_running_game->package().project());
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
    advance_backend_generation();
    bind_runtime_ui_input_sink();
    m_shutdown = false;
    previous_game.reset();
    previous_presentation.reset();
    return core::Result<void, core::Diagnostics>::success();
}

HostRuntimeDispatchResult GameHost::submit_runtime_input(core::RuntimeInputMessage input)
{
    return submit_runtime_input(m_session_generation, std::move(input));
}

bool GameHost::submit_runtime_ui_shell_command(GameSessionGeneration generation,
                                               core::RuntimeShellCommand command)
{
    if (!accepts(generation)) {
        retain_runtime_diagnostics(
            HostFrameStage::UpdateRuntimeUi,
            one({.code = "host.stale_runtime_ui_input_generation",
                 .message = "RuntimeUI input generation " + std::to_string(generation.number()) +
                            " was replaced by generation " +
                            std::to_string(m_session_generation.number())}));
        return false;
    }
    auto handled = m_system_layouts.dispatch(command);
    if (handled)
        return true;
    auto diagnostics = std::move(handled).error();
    retain_runtime_diagnostics(HostFrameStage::UpdateRuntimeUi, diagnostics);
    return false;
}

bool GameHost::submit_runtime_ui_shell_command(core::RuntimeShellCommand command)
{
    return submit_runtime_ui_shell_command(m_session_generation, std::move(command));
}

bool GameHost::dispatch_runtime_ui_layout_event(GameSessionGeneration generation,
                                                core::MountedLayoutOwner owner,
                                                const std::function<bool()>& dispatch)
{
    if (!dispatch)
        return false;
    if (!accepts(generation)) {
        retain_runtime_diagnostics(
            HostFrameStage::UpdateRuntimeUi,
            one({.code = "host.stale_runtime_ui_input_generation",
                 .message = "RuntimeUI layout event generation " +
                            std::to_string(generation.number()) + " was replaced by generation " +
                            std::to_string(m_session_generation.number())}));
        return false;
    }
    if (!m_running_game || m_backend_reset_active) {
        retain_runtime_diagnostics(
            HostFrameStage::UpdateRuntimeUi,
            one({.code = "host.layout_event_runtime_unavailable",
                 .message = "Layout event requires an active runtime outside backend reset"}));
        return false;
    }

    auto& gateway = m_running_game->session().gateway();
    runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
    const auto profile = owner == core::MountedLayoutOwner::Shell
                             ? runtime::RuntimeCapabilityProfile::ShellLayoutEvent
                             : runtime::RuntimeCapabilityProfile::GameplayLayoutEvent;
    auto capabilities = issuer.issue(profile);
    if (!capabilities) {
        retain_runtime_diagnostics(
            HostFrameStage::UpdateRuntimeUi,
            one({.code = "host.layout_event_capabilities_unavailable",
                 .message = "Layout event capability profile could not be issued"}));
        return false;
    }

    m_dependencies.script_certifier.replace_runtime_capabilities(std::move(*capabilities));
    const bool consumed = dispatch();
    m_dependencies.script_certifier.clear_runtime_capabilities();
    return consumed;
}

HostRuntimeDispatchResult GameHost::submit_runtime_input(GameSessionGeneration generation,
                                                         core::RuntimeInputMessage input)
{
    if (!accepts(generation))
        return stale_runtime_input_result(generation);
    if (m_backend_reset_active) {
        HostRuntimeDispatchResult result;
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics = one(
            {.code = "host.runtime_input_during_backend_reset",
             .message = "Runtime input cannot be dispatched while presentation backends reset"});
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);
        return result;
    }
    if (m_runtime_presentation.mandatory_assets_pending() && !is_stop_input(input) &&
        !replaces_runtime_generation(input)) {
        HostRuntimeDispatchResult result;
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics = one(
            {.code = "host.runtime_input_blocked_by_mandatory_assets",
             .message = "Runtime input is blocked until mandatory publication assets are ready"});
        return result;
    }
    if (!m_running_game) {
        HostRuntimeDispatchResult result;
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics = one({.code = "host.runtime_input_without_game",
                                  .message = "Runtime input requires an active running game"});
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);
        return result;
    }
    if (is_start_input(input) && m_lifecycle_state == LoadedGameLifecycleState::Running)
        return lifecycle_noop_result();
    if (is_stop_input(input) && m_lifecycle_state == LoadedGameLifecycleState::Stopped)
        return lifecycle_noop_result();
    if (m_dispatch_active) {
        HostRuntimeDispatchResult result;
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics =
            one({.code = "host.reentrant_runtime_dispatch",
                 .message = "GameHost runtime dispatch cannot be called recursively"});
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);
        return result;
    }

    const bool replacing_generation = replaces_runtime_generation(input);
    const bool stopping = is_stop_input(input);
    if (replacing_generation || stopping)
        m_pending_runtime_inputs.clear();

    m_dispatch_active = true;
    auto result =
        HostRuntimeDispatchResult::from_runtime(m_running_game->session().dispatch(input));

    const bool runtime_replaced = replacing_generation && result.accepted();
    if (runtime_replaced) {
        advance_session_generation();
        advance_backend_generation();
    }

    if (!result.diagnostics.empty())
        retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);

    core::Diagnostics application_diagnostics;
    bool application_accepted = true;
    bool publication_deferred = false;
    if (result.publication) {
        application_accepted =
            apply_runtime_publication(*result.publication, result.events, application_diagnostics);
        publication_deferred = m_runtime_presentation.mandatory_assets_pending();
    } else if (m_dependencies.observation_sink) {
        m_runtime_events = result.events;
        m_dependencies.observation_sink->observe_runtime_outputs(m_runtime_observations,
                                                                 result.events);
    } else {
        m_runtime_events = result.events;
    }

    if (!publication_deferred)
        deliver_runtime_ui_events(result.events);
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

    if (result.accepted()) {
        if (is_start_input(input))
            m_lifecycle_state = LoadedGameLifecycleState::Running;
        else if (stopping)
            m_lifecycle_state = LoadedGameLifecycleState::Stopped;
    }
    if (runtime_replaced)
        bind_runtime_ui_input_sink();
    m_dispatch_active = false;
    return result;
}

bool GameHost::advance(GameHostAdvanceInput input)
{
    if (!m_running_game)
        return true;

    m_running_game->session().set_effective_gameplay_pause(
        std::move(input.effective_gameplay_pause));
    if (m_lifecycle_state != LoadedGameLifecycleState::Running || !input.runtime_input_admitted ||
        m_dependencies.host_values.host_suspended || m_backend_reset_active)
        return true;

    // Existing presentation/audio backends advance after this runtime stage. Keep operations
    // accepted by frame inputs staged until that backend update finishes so newly created work does
    // not consume a presentation tick in the same frame.
    const bool previous_defer_presentation_flush = m_defer_presentation_flush;
    m_defer_presentation_flush = true;
    const bool pending_accepted = dispatch_pending_runtime_inputs();
    if (m_lifecycle_state != LoadedGameLifecycleState::Running) {
        m_defer_presentation_flush = previous_defer_presentation_flush;
        return pending_accepted;
    }
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
    for (auto& pending_input : pending) {
        if (!accepts(pending_input.session_generation, pending_input.backend_generation)) {
            retain_runtime_diagnostics(
                HostFrameStage::AdvanceRuntime,
                one({.code = "host.stale_deferred_runtime_input",
                     .message = "Deferred runtime input belongs to a replaced session or backend "
                                "generation"}));
            continue;
        }
        auto result =
            submit_runtime_input(pending_input.session_generation, std::move(pending_input.input));
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
        if (!m_runtime_presentation.mandatory_assets_pending()) {
            m_pending_runtime_publication.reset();
            m_pending_runtime_publication_events.clear();
        }
        accepted = false;
    }
    for (auto& input : flushed.inputs)
        enqueue_runtime_input(std::move(input));
    if (flushed.diagnostics.empty() && !m_runtime_presentation.mandatory_assets_pending() &&
        m_pending_runtime_publication) {
        core::Diagnostics publication_diagnostics;
        accepted = commit_pending_runtime_publication(publication_diagnostics) && accepted;
        if (!publication_diagnostics.empty()) {
            retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, publication_diagnostics);
            if (diagnostics)
                core::append_diagnostics(*diagnostics, publication_diagnostics);
            accepted = false;
        }
    }
    return accepted;
}

void GameHost::poll_runtime_presentation()
{
    if (!m_running_game)
        return;

    auto presentation = m_runtime_presentation.poll_audio();
    if (!presentation.diagnostics.empty())
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, presentation.diagnostics);
    for (auto& input : presentation.inputs)
        enqueue_runtime_input(std::move(input));
}

void GameHost::enqueue_runtime_input(core::RuntimeInputMessage input)
{
    enqueue_runtime_input(m_session_generation, m_backend_generation, std::move(input));
}

void GameHost::enqueue_runtime_input(GameSessionGeneration session_generation,
                                     BackendGeneration backend_generation,
                                     core::RuntimeInputMessage input)
{
    m_pending_runtime_inputs.push_back({session_generation, backend_generation, std::move(input)});
}

bool GameHost::suspend_host() noexcept
{
    if (m_dependencies.host_values.host_suspended)
        return false;
    m_dependencies.host_values.host_suspended = true;
    return true;
}

bool GameHost::resume_host() noexcept
{
    if (!m_dependencies.host_values.host_suspended)
        return false;
    m_dependencies.host_values.host_suspended = false;
    return true;
}

bool GameHost::begin_backend_reset(BackendResetReason reason) noexcept
{
    (void)reason;
    if (m_backend_reset_active)
        return false;
    m_backend_reset_active = true;
    advance_backend_generation();
    m_pending_runtime_inputs.clear();
    m_runtime_presentation.terminate(core::PresentationCancellationReason::ExplicitRequest);
    return true;
}

core::Result<void, core::Diagnostics> GameHost::finish_backend_reset()
{
    if (!m_backend_reset_active)
        return core::Result<void, core::Diagnostics>::success();
    if (!m_running_game || !m_runtime_publication) {
        m_backend_reset_active = false;
        return core::Result<void, core::Diagnostics>::success();
    }

    core::Diagnostics diagnostics;
    if (m_dependencies.layout_realizer) {
        auto recreated = m_dependencies.layout_realizer->apply_layout_realization(
            RecreateLayoutRealizationsRequest{
                .host_generation = host_generation(m_session_generation),
                .backend_generation = m_backend_generation,
            });
        if (recreated.disposition == LayoutRealizationDisposition::Failed ||
            recreated.disposition == LayoutRealizationDisposition::RejectedStale) {
            core::append_diagnostics(diagnostics, std::move(recreated.diagnostics));
        }
    }
    auto reconciled =
        m_runtime_presentation.reconcile_publication(m_runtime_publication->presentation);
    if (!reconciled.empty()) {
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, reconciled);
        core::append_diagnostics(diagnostics, std::move(reconciled));
    }
    if (!diagnostics.empty())
        return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
    if (!flush_runtime_presentation(&diagnostics) || !diagnostics.empty())
        return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
    m_backend_reset_active = false;
    return core::Result<void, core::Diagnostics>::success();
}

void GameHost::shutdown() noexcept
{
    if (m_shutdown)
        return;
    m_shutdown = true;
    advance_session_generation();
    advance_backend_generation();
    detach_runtime_bindings();
    m_runtime_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
    if (m_running_game_presentation_port)
        m_running_game_presentation_port->detach();
    m_running_game.reset();
    m_running_game_presentation_port.reset();
    clear_loaded_game_state();
    m_backend_reset_active = false;
    m_dependencies.host_values.host_suspended = false;
    m_lifecycle_state = LoadedGameLifecycleState::Empty;
}

void GameHost::advance_session_generation() noexcept
{
    if (const auto next = m_session_generation.next())
        m_session_generation = *next;
}

void GameHost::advance_backend_generation() noexcept
{
    if (const auto next = m_backend_generation.next())
        m_backend_generation = *next;
}

void GameHost::detach_runtime_bindings() noexcept
{
    m_dependencies.runtime_ui.bind_input_sink(nullptr);
    m_runtime_ui_input_sink.reset();
    m_retired_runtime_ui_input_sinks.clear();
    m_dependencies.runtime_ui.bind_asset_service(nullptr);
    m_dependencies.runtime_ui.clear_gameplay_ui_values();
    m_dependencies.runtime_ui.clear_runtime_shell_view();
    m_dependencies.runtime_ui.set_runtime_notification({});
    m_dependencies.runtime_ui.clear_typed_runtime_diagnostics();
    m_system_layouts.reset();
    m_runtime_layouts.reset();
    m_runtime_ui_asset_service.clear();
}

void GameHost::clear_loaded_game_state() noexcept
{
    m_pending_runtime_inputs.clear();
    m_runtime_publication.reset();
    m_pending_runtime_publication.reset();
    m_pending_runtime_publication_events.clear();
    m_runtime_events.clear();
    m_runtime_observations = {};
    m_runtime_diagnostics.clear();
    m_runtime_diagnostic_records.clear();
    m_compiled_project_path.clear();
}

void GameHost::bind_runtime_ui_input_sink()
{
    m_retired_runtime_ui_input_sinks.clear();
    if (m_runtime_ui_input_sink)
        m_retired_runtime_ui_input_sinks.push_back(std::move(m_runtime_ui_input_sink));
    m_runtime_ui_input_sink = std::make_unique<RuntimeUiInputAdapter>(*this, m_session_generation);
    m_dependencies.runtime_ui.bind_input_sink(m_runtime_ui_input_sink.get());
}

void GameHost::deliver_runtime_ui_events(std::span<const runtime::RuntimeEvent> events)
{
    for (const auto& event : events) {
        if (const auto* notification = std::get_if<runtime::NotificationEvent>(&event))
            m_dependencies.runtime_ui.set_runtime_notification(notification->message);
    }
}

HostRuntimeDispatchResult GameHost::stale_runtime_input_result(GameSessionGeneration generation)
{
    HostRuntimeDispatchResult result;
    result.disposition = runtime::RuntimeInputDisposition::Failed;
    result.diagnostics =
        one({.code = "host.stale_runtime_input_generation",
             .message = "Runtime input generation " + std::to_string(generation.number()) +
                        " was replaced by generation " +
                        std::to_string(m_session_generation.number())});
    retain_runtime_diagnostics(HostFrameStage::AdvanceRuntime, result.diagnostics);
    return result;
}

HostRuntimeDispatchResult GameHost::lifecycle_noop_result() const noexcept
{
    HostRuntimeDispatchResult result;
    result.disposition = runtime::RuntimeInputDisposition::Handled;
    return result;
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

void GameHost::report_runtime_diagnostics(HostFrameStage stage, core::Diagnostics diagnostics)
{
    retain_runtime_diagnostics(stage, diagnostics);
}

bool GameHost::apply_runtime_publication(const runtime::RuntimePublication& publication,
                                         std::span<const runtime::RuntimeEvent> events,
                                         core::Diagnostics& application_diagnostics)
{
    auto presentation = m_runtime_presentation.reconcile_publication(publication.presentation);
    if (!presentation.empty()) {
        retain_runtime_diagnostics(HostFrameStage::UpdatePresentation, presentation);
        core::append_diagnostics(application_diagnostics, std::move(presentation));
        return false;
    }
    if (m_runtime_presentation.mandatory_assets_pending()) {
        m_pending_runtime_publication = publication;
        m_pending_runtime_publication_events.assign(events.begin(), events.end());
        return true;
    }
    return publish_runtime_publication(publication, events, application_diagnostics);
}

bool GameHost::publish_runtime_publication(const runtime::RuntimePublication& publication,
                                           std::span<const runtime::RuntimeEvent> events,
                                           core::Diagnostics& application_diagnostics)
{
    bool accepted = true;

    m_runtime_publication = publication;
    m_runtime_events.assign(events.begin(), events.end());
    m_runtime_observations = publication.observations;
    if (!m_dependencies.runtime_ui.apply_gameplay_ui_values(
            RuntimeUiGameplayValues{publication.revision.number(), publication.gameplay_ui})) {
        auto diagnostics = one({.code = "host.runtime_ui_publication_rejected",
                                .message = "RuntimeUI rejected immutable gameplay UI values for "
                                           "publication revision " +
                                           std::to_string(publication.revision.number())});
        retain_runtime_diagnostics(HostFrameStage::UpdateRuntimeUi, diagnostics);
        core::append_diagnostics(application_diagnostics, std::move(diagnostics));
        accepted = false;
    }

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

bool GameHost::commit_pending_runtime_publication(core::Diagnostics& application_diagnostics)
{
    if (!m_pending_runtime_publication)
        return true;
    auto publication = std::move(*m_pending_runtime_publication);
    auto events = std::move(m_pending_runtime_publication_events);
    m_pending_runtime_publication.reset();
    m_pending_runtime_publication_events.clear();
    const bool accepted = publish_runtime_publication(publication, events, application_diagnostics);
    deliver_runtime_ui_events(events);
    return accepted;
}

core::Result<void, core::Diagnostics> GameHost::attach_runtime_bindings(bool show_title)
{
    if (!m_running_game)
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.game_binding_runtime_missing",
                 .message = "Runtime bindings require an active running game"}));

    bind_runtime_ui_input_sink();
    m_dependencies.runtime_ui.bind_asset_service(&m_runtime_ui_asset_service);
    if (m_runtime_publication &&
        !m_dependencies.runtime_ui.apply_gameplay_ui_values(RuntimeUiGameplayValues{
            m_runtime_publication->revision.number(), m_runtime_publication->gameplay_ui})) {
        return core::Result<void, core::Diagnostics>::failure(
            one({.code = "host.game_binding_runtime_ui_rejected",
                 .message = "RuntimeUI rejected the current immutable gameplay UI values"}));
    }
    deliver_runtime_ui_events(m_runtime_events);

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
