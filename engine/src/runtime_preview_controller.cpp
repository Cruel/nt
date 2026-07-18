#include "noveltea/runtime_preview_controller.hpp"

#include "host/preview_host.hpp"
#include "noveltea/preview_bridge.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

namespace noveltea {
namespace {

std::string typed_mutation_result(host::PreviewMutationResult result)
{
    return nlohmann::json{{"accepted", result.accepted},
                          {"kind", std::move(result.kind)},
                          {"id", std::move(result.id)},
                          {"message", std::move(result.message)}}
        .dump();
}

nlohmann::json preview_entity_ref(std::string type, std::string id, std::string collection = {})
{
    nlohmann::json result = {{"type", std::move(type)}, {"id", std::move(id)}};
    if (!collection.empty())
        result["collection"] = std::move(collection);
    return result;
}

std::string preview_diagnostic_severity(core::ErrorSeverity severity)
{
    switch (severity) {
    case core::ErrorSeverity::Info:
        return "info";
    case core::ErrorSeverity::Warning:
        return "warning";
    case core::ErrorSeverity::Error:
    case core::ErrorSeverity::Fatal:
        return "error";
    }
    return "error";
}

nlohmann::json
encode_preview_checkpoint_snapshot(const core::CheckpointRuntimeObservation* checkpoint)
{
    if (checkpoint == nullptr)
        return nlohmann::json::object();
    nlohmann::json issues = nlohmann::json::array();
    for (const auto& issue : checkpoint->readiness.issues) {
        issues.push_back({{"reason", static_cast<std::uint8_t>(issue.reason)},
                          {"code", issue.diagnostic.code},
                          {"message", issue.diagnostic.message},
                          {"hasBarrier", issue.barrier.has_value()}});
    }
    nlohmann::json retained = nullptr;
    if (checkpoint->retained_revision && checkpoint->retained_metadata) {
        retained = {{"revision", checkpoint->retained_revision->number()},
                    {"saveFormatVersion", checkpoint->retained_metadata->save_format_version},
                    {"project", checkpoint->retained_metadata->project.text()},
                    {"projectVersion", checkpoint->retained_metadata->project_version},
                    {"playTimeMs", checkpoint->retained_metadata->play_time.count()}};
    }
    nlohmann::json reconstructible = nullptr;
    if (checkpoint->presentation.reconstructible_activity) {
        const auto& activity = *checkpoint->presentation.reconstructible_activity;
        reconstructible = {
            {"snapshotRevision", activity.snapshot.number()},
            {"actorIdleCount", activity.actor_idles.size()},
            {"environmentLoopCount", activity.environment_loops.size()},
            {"desiredAudioCount", activity.desired_audio.size()},
        };
    }
    return {
        {"readinessRevision", checkpoint->readiness.revision.number()},
        {"canCapture", checkpoint->readiness.can_capture()},
        {"issues", std::move(issues)},
        {"presentationStatusRevision", checkpoint->presentation.revision.number()},
        {"activeBarrierCount", checkpoint->presentation.active_barriers.size()},
        {"reconstructibleActivity", std::move(reconstructible)},
        {"retained", std::move(retained)},
        {"replayDistance",
         {{"structuralGenerations", checkpoint->replay_distance.structural_generations},
          {"timeGenerations", checkpoint->replay_distance.time_generations},
          {"playTimeMs", checkpoint->replay_distance.play_time.count()}}},
        {"thumbnailAvailable", checkpoint->thumbnail_available},
        {"thumbnailCapturePending", checkpoint->thumbnail_capture_pending},
    };
}

const core::CheckpointRuntimeObservation*
published_checkpoint(const runtime::RuntimePublication& publication)
{
    for (auto it = publication.observations.values.rbegin();
         it != publication.observations.values.rend(); ++it) {
        if (const auto* checkpoint = std::get_if<core::CheckpointRuntimeObservation>(&*it))
            return checkpoint;
    }
    return nullptr;
}

nlohmann::json encode_preview_debug_snapshot(const runtime::RuntimePublication& publication,
                                             const core::Diagnostics& diagnostics,
                                             bool preview_running)
{
    const auto& view = publication.gameplay_ui;
    const auto& presentation = publication.presentation;
    const auto* checkpoint = published_checkpoint(publication);
    nlohmann::json dialogue_options = nlohmann::json::array();
    if (view.dialogue && view.dialogue->choice) {
        for (std::size_t index = 0; index < view.dialogue->choice->options.size(); ++index) {
            const auto& option = view.dialogue->choice->options[index];
            dialogue_options.push_back({{"index", static_cast<int>(index)},
                                        {"label", option.label},
                                        {"enabled", option.enabled}});
        }
    } else if (view.scene && view.scene->choice) {
        for (std::size_t index = 0; index < view.scene->choice->options.size(); ++index) {
            const auto& option = view.scene->choice->options[index];
            dialogue_options.push_back({{"index", static_cast<int>(index)},
                                        {"label", option.label},
                                        {"enabled", option.enabled}});
        }
    }

    nlohmann::json navigation = nlohmann::json::array();
    if (view.room) {
        for (const auto& exit : view.room->exits) {
            navigation.push_back({{"index", static_cast<int>(exit.direction)},
                                  {"label", exit.label},
                                  {"enabled", exit.enabled}});
        }
    }

    nlohmann::json actions = nlohmann::json::array();
    const auto& controls = view.room ? view.room->controls : view.inventory.controls;
    for (const auto& control : controls) {
        actions.push_back({{"verbId", control.verb.text()},
                           {"label", control.label},
                           {"objectCount", static_cast<int>(control.arity)},
                           {"selectedCount", static_cast<int>(view.selected_subjects.size())},
                           {"enabled", control.enabled}});
    }

    nlohmann::json selected_subjects = nlohmann::json::array();
    for (const auto& subject : view.selected_subjects)
        selected_subjects.push_back(std::visit(
            [](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                    return nlohmann::json{{"kind", "character"}, {"id", value.character.text()}};
                else
                    return nlohmann::json{{"kind", "interactable"},
                                          {"id", value.interactable.text()}};
            },
            subject));

    nlohmann::json inventory = nlohmann::json::array();
    for (const auto& item : view.inventory.items) {
        inventory.push_back(
            {{"id", item.interactable.text()},
             {"label", item.display_name},
             {"selected", std::find(view.selected_subjects.begin(), view.selected_subjects.end(),
                                    core::compiled::InteractionSubject{
                                        core::compiled::InteractableInteractionSubject{
                                            item.interactable}}) != view.selected_subjects.end()},
             {"enabled", item.enabled}});
    }

    nlohmann::json diagnostic_list = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        nlohmann::json encoded = {{"severity", preview_diagnostic_severity(diagnostic.severity)},
                                  {"message", diagnostic.message},
                                  {"category", diagnostic.code}};
        if (!diagnostic.source_path.empty())
            encoded["path"] = diagnostic.source_path;
        diagnostic_list.push_back(std::move(encoded));
    }

    std::string waiting_kind = "none";
    std::string waiting_reason;
    if (!dialogue_options.empty()) {
        waiting_kind = "choice";
        waiting_reason = "runtime choices are available";
    } else if (!navigation.empty()) {
        waiting_kind = "navigation";
        waiting_reason = "room navigation is available";
    } else if (!actions.empty()) {
        waiting_kind = "action";
        waiting_reason = "runtime actions are available";
    } else if (view.can_continue) {
        waiting_kind = "continue";
        waiting_reason = "runtime is waiting for continue";
    } else if (view.mode == "title") {
        waiting_kind = "title";
        waiting_reason = "title UI is active";
    } else if (view.mode == "ended") {
        waiting_kind = "paused";
        waiting_reason = "runtime has ended";
    }

    nlohmann::json waiting = {{"kind", waiting_kind}, {"canContinue", view.can_continue}};
    if (!waiting_reason.empty())
        waiting["reason"] = std::move(waiting_reason);

    nlohmann::json snapshot = {
        {"loaded", true},
        {"running", preview_running},
        {"shellMode", view.mode},
        {"runtimeMode", view.mode},
        {"gameplayPaused", view.gameplay_paused},
        {"waiting", std::move(waiting)},
        {"availableInputs",
         {{"continue", view.can_continue},
          {"dialogueOptions", std::move(dialogue_options)},
          {"navigation", std::move(navigation)},
          {"actions", std::move(actions)},
          {"selectedSubjects", selected_subjects},
          {"clickableTargets", nlohmann::json::array()}}},
        {"variables", nlohmann::json::array()},
        {"inventory", std::move(inventory)},
        {"selectedSubjects", std::move(selected_subjects)},
        {"diagnostics", std::move(diagnostic_list)},
        {"saveSnapshot", encode_preview_checkpoint_snapshot(checkpoint)},
        {"publication",
         {{"revision", publication.revision.number()},
          {"presentationRevision", presentation.revision.number()},
          {"observationCount", publication.observations.values.size()},
          {"actorCount", presentation.actors.size()},
          {"interactableCount", presentation.interactables.size()},
          {"propCount", presentation.props.size()},
          {"environmentCount", presentation.environments.size()},
          {"layoutCount", presentation.layouts.size()},
          {"desiredAudioCount", presentation.desired_audio.size()}}},
    };

    if (view.room) {
        snapshot["currentRoomId"] = view.room->room.text();
        snapshot["currentEntity"] = preview_entity_ref("room", view.room->room.text(), "rooms");
    } else if (view.dialogue) {
        snapshot["currentDialogueId"] = view.dialogue->dialogue.text();
        snapshot["currentEntity"] =
            preview_entity_ref("dialogue", view.dialogue->dialogue.text(), "dialogues");
    } else if (view.scene) {
        snapshot["currentEntity"] = preview_entity_ref("scene", view.scene->scene.text(), "scenes");
    }

    return snapshot;
}

} // namespace

RuntimePreviewController::RuntimePreviewController(host::PreviewHost& preview_host) noexcept
    : m_preview_host(&preview_host)
{
}

bool RuntimePreviewController::load_project(const std::string& logical_path)
{
    return m_preview_host->load_project(logical_path);
}

bool RuntimePreviewController::reset() { return m_preview_host->reset(); }

bool RuntimePreviewController::reload() { return m_preview_host->reload(); }

bool RuntimePreviewController::start() { return m_preview_host->start(); }

bool RuntimePreviewController::stop() { return m_preview_host->stop(); }

bool RuntimePreviewController::step(double delta_seconds)
{
    return m_preview_host->step(delta_seconds);
}

RuntimePreviewHandle RuntimePreviewController::runtime_handle() const noexcept
{
    const auto handle = m_preview_host->runtime_handle();
    return {.session_generation = handle.session_generation.number(),
            .backend_generation = handle.backend_generation.number()};
}

bool RuntimePreviewController::dispatch(RuntimePreviewHandle handle,
                                        core::RuntimeInputMessage input)
{
    const auto session = host::GameSessionGeneration::from_number(handle.session_generation);
    const auto backend = host::BackendGeneration::from_number(handle.backend_generation);
    if (!session || !backend)
        return false;
    return m_preview_host->dispatch(
        {.session_generation = *session, .backend_generation = *backend}, std::move(input));
}

bool RuntimePreviewController::continue_dialogue() { return m_preview_host->continue_dialogue(); }

bool RuntimePreviewController::select_dialogue_option(int option_index)
{
    return m_preview_host->select_dialogue_option(option_index);
}

bool RuntimePreviewController::navigate(int direction)
{
    return m_preview_host->navigate(direction);
}

bool RuntimePreviewController::select_subjects(
    std::vector<core::compiled::InteractionSubject> subjects)
{
    return m_preview_host->select_subjects(std::move(subjects));
}

bool RuntimePreviewController::clear_subject_selection()
{
    return m_preview_host->clear_subject_selection();
}

bool RuntimePreviewController::run_interaction(
    const std::string& verb_id, std::vector<core::compiled::InteractionSubject> operands)
{
    return m_preview_host->run_interaction(verb_id, std::move(operands));
}

std::string RuntimePreviewController::set_variable(const std::string& variable_id,
                                                   core::RuntimeValue value)
{
    return typed_mutation_result(m_preview_host->set_variable(variable_id, std::move(value)));
}

std::string RuntimePreviewController::reset_variable(const std::string& variable_id)
{
    return typed_mutation_result(m_preview_host->reset_variable(variable_id));
}

std::string RuntimePreviewController::give_object(const std::string& object_id)
{
    return typed_mutation_result(m_preview_host->give_object(object_id));
}

std::string RuntimePreviewController::remove_inventory_object(const std::string& object_id)
{
    return typed_mutation_result(m_preview_host->remove_inventory_object(object_id));
}

std::string RuntimePreviewController::teleport_room(const std::string& room_id)
{
    return typed_mutation_result(m_preview_host->teleport_room(room_id));
}

bool RuntimePreviewController::begin_recording() { return m_preview_host->begin_recording(); }

bool RuntimePreviewController::end_recording() { return m_preview_host->end_recording(); }

bool RuntimePreviewController::clear_recording() { return m_preview_host->clear_recording(); }

bool RuntimePreviewController::undo_recording_step()
{
    return m_preview_host->undo_recording_step();
}

bool RuntimePreviewController::replay_recording() { return m_preview_host->replay_recording(); }

bool RuntimePreviewController::load_document(std::string rml, std::string source_url)
{
    return m_preview_host->load_document(
        {.rml = std::move(rml), .source_url = std::move(source_url)});
}

bool RuntimePreviewController::execute_lua(std::string source, std::string chunk_name)
{
    return m_preview_host->execute_lua(
        {.source = std::move(source), .chunk_name = std::move(chunk_name)});
}

bool RuntimePreviewController::apply_editor_document(
    core::editor::TypedEditorPreviewDocument document)
{
    return m_preview_host->apply_editor_document(std::move(document));
}

void RuntimePreviewController::set_display_override(std::optional<DisplayProfile> profile)
{
    m_preview_host->set_display_override(std::move(profile));
}

bool RuntimePreviewController::request_screenshot(std::string path)
{
    return m_preview_host->request_screenshot(std::move(path));
}

AudioVoiceHandle RuntimePreviewController::play_audio_sfx(const std::string& path, float volume,
                                                          float pitch)
{
    return m_preview_host->play_audio_sfx(path, volume, pitch);
}

AudioTrackHandle RuntimePreviewController::play_audio_track(const AudioTrackId& track_id,
                                                            const std::string& path, float volume,
                                                            bool loop)
{
    return m_preview_host->play_audio_track(track_id, path, volume, loop);
}

void RuntimePreviewController::stop_audio_track(const AudioTrackId& track_id, float fade_seconds)
{
    m_preview_host->stop_audio_track(track_id, fade_seconds);
}

void RuntimePreviewController::stop_all_preview_audio(float fade_seconds)
{
    m_preview_host->stop_all_preview_audio(fade_seconds);
}

std::string RuntimePreviewController::fast_forward_to_input()
{
    constexpr int max_steps = 800;
    constexpr double tick_seconds = 1.0 / 60.0;
    int applied = 0;
    std::string reason = "stabilization-limit";
    for (; applied < max_steps; ++applied) {
        auto presentation = m_preview_host->fast_forward_presentation_once();
        if (!presentation.diagnostics.empty()) {
            reason = "error";
            break;
        }
        if (presentation.disposition ==
            core::PresentationFastForwardDisposition::StoppedAtNonSkippableOperation) {
            reason = "non-skippable-presentation";
            break;
        }
        if (presentation.disposition ==
            core::PresentationFastForwardDisposition::CompletedSkippableOperation) {
            bool dispatched = true;
            for (auto& input : presentation.inputs)
                dispatched = m_preview_host->dispatch(std::move(input)) && dispatched;
            if (!dispatched) {
                reason = "error";
                break;
            }
            continue;
        }
        const auto& publication = m_preview_host->publication();
        const auto* view = publication ? &publication->gameplay_ui : nullptr;
        if (!view) {
            reason = "unloaded";
            break;
        }
        if ((view->dialogue && view->dialogue->choice &&
             !view->dialogue->choice->options.empty()) ||
            (view->scene && view->scene->choice && !view->scene->choice->options.empty())) {
            reason = "choice-available";
            break;
        }
        if (view->room && std::any_of(view->room->exits.begin(), view->room->exits.end(),
                                      [](const auto& exit) { return exit.enabled; })) {
            reason = "navigation-available";
            break;
        }
        const auto& controls = view->room ? view->room->controls : view->inventory.controls;
        if (std::any_of(controls.begin(), controls.end(),
                        [](const auto& control) { return control.enabled; })) {
            reason = "action-available";
            break;
        }
        if (view->can_continue) {
            if (!continue_dialogue()) {
                reason = "error";
                break;
            }
        } else if (!step(tick_seconds)) {
            reason = view->mode == "ended" ? "game-end" : "explicit-input";
            break;
        }
    }
    return nlohmann::json{
        {"reason", reason},
        {"stepsApplied", applied},
        {"ticksApplied", applied},
        {"finalSnapshot", nlohmann::json::parse(debug_snapshot(), nullptr, false)}}
        .dump();
}

std::string RuntimePreviewController::debug_snapshot() const
{
    const auto& publication = m_preview_host->publication();
    if (!publication)
        return {};
    core::Diagnostics diagnostics = m_preview_host->runtime_diagnostics();
    core::append_diagnostics(diagnostics, m_preview_host->preview_diagnostics());
    return encode_preview_debug_snapshot(*publication, diagnostics,
                                         m_preview_host->preview_running())
        .dump();
}

const std::optional<runtime::RuntimePublication>&
RuntimePreviewController::publication() const noexcept
{
    return m_preview_host->publication();
}

const runtime::RuntimeObservationSnapshot& RuntimePreviewController::observations() const noexcept
{
    return m_preview_host->observations();
}

const std::vector<runtime::RuntimeEvent>& RuntimePreviewController::events() const noexcept
{
    return m_preview_host->events();
}

const core::Diagnostics& RuntimePreviewController::preview_diagnostics() const noexcept
{
    return m_preview_host->preview_diagnostics();
}

core::Diagnostics RuntimePreviewController::take_preview_diagnostics()
{
    return m_preview_host->take_preview_diagnostics();
}

void RuntimePreviewController::report_diagnostics(core::Diagnostics diagnostics)
{
    m_preview_host->report_diagnostics(std::move(diagnostics));
}

} // namespace noveltea
