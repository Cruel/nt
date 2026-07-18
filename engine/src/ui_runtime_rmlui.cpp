#include "ui/rmlui/runtime_ui.hpp"

#include "noveltea/presentation/runtime_layout_manager.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <RmlUi/Core.h>
#include <RmlUi/Core/Box.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Variant.h>
#include <sol/sol.hpp>
#include "ui/rmlui/active_text_presenter.hpp"
#include "ui/rmlui/rmlui_document_registry.hpp"
#include "ui/rmlui/rmlui_custom_components.hpp"
#include "ui/rmlui/rmlui_host.hpp"
#include "ui/rmlui/runtime_ui_binder.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/rmlui/rmlui_template_resolver.hpp"

namespace noveltea {

using presentation::RuntimeLayoutBuiltinDocument;

namespace {
using ui::rmlui::kRuntimeGameDocumentId;
using ui::rmlui::kRuntimeLoadMenuDocumentId;
using ui::rmlui::kRuntimeModalDocumentId;
using ui::rmlui::kRuntimePauseMenuDocumentId;
using ui::rmlui::kRuntimeSaveMenuDocumentId;
using ui::rmlui::kRuntimeSettingsMenuDocumentId;
using ui::rmlui::kRuntimeTextLogDocumentId;
using ui::rmlui::kRuntimeTitleDocumentId;

const char* runtime_shell_screen_name(core::RuntimeShellScreen screen)
{
    switch (screen) {
    case core::RuntimeShellScreen::None:
        return "none";
    case core::RuntimeShellScreen::Title:
        return "title";
    case core::RuntimeShellScreen::Pause:
        return "pause";
    case core::RuntimeShellScreen::Settings:
        return "settings";
    case core::RuntimeShellScreen::Save:
        return "save";
    case core::RuntimeShellScreen::Load:
        return "load";
    case core::RuntimeShellScreen::TextLog:
        return "text-log";
    case core::RuntimeShellScreen::Confirmation:
        return "confirmation";
    case core::RuntimeShellScreen::Debug:
        return "debug";
    }
    return "none";
}

std::string runtime_shell_slot_label(core::TypedSaveSlotId slot)
{
    return slot.is_autosave() ? "Autosave" : "Slot " + std::to_string(slot.number());
}

std::uint64_t runtime_shell_thumbnail_fingerprint(std::string_view bytes) noexcept
{
    std::uint64_t fingerprint = 14695981039346656037ull;
    for (const unsigned char byte : bytes) {
        fingerprint ^= byte;
        fingerprint *= 1099511628211ull;
    }
    return fingerprint;
}

void set_shell_element_rml(Rml::ElementDocument& document, const char* id, std::string_view value)
{
    if (auto* element = document.GetElementById(id))
        element->SetInnerRML(ui::rmlui::escape_rml(value));
}

Rml::Element* find_first_tag(Rml::ElementDocument& doc, const char* tag)
{
    Rml::ElementList elements;
    doc.GetElementsByTagName(elements, tag);
    return elements.empty() ? nullptr : elements.front();
}

Rml::Element* find_ancestor_tag(Rml::Element* element, const char* tag)
{
    for (auto* current = element; current; current = current->GetParentNode()) {
        if (current->GetTagName() == tag) {
            return current;
        }
    }
    return nullptr;
}

std::string stable_label(std::string value, std::string fallback)
{
    return value.empty() ? std::move(fallback) : std::move(value);
}

Rect content_rect(Rml::Element& element)
{
    const Rml::Vector2f offset = element.GetAbsoluteOffset(Rml::BoxArea::Content);
    const Rml::Vector2f size = element.GetBox().GetSize(Rml::BoxArea::Content);
    return {offset.x, offset.y, size.x, size.y};
}

Color element_text_color(Rml::Element& element)
{
    if (const auto* property = element.GetProperty(Rml::PropertyId::Color)) {
        const auto color = property->Get<Rml::Colourb>();
        return Color::from_rgba8(color.red, color.green, color.blue, color.alpha);
    }
    return Color::from_rgba8(247, 244, 237);
}

std::string element_text_language(Rml::Element& element)
{
    if (const auto* property = element.GetProperty(Rml::PropertyId::RmlUi_Language)) {
        return property->Get<Rml::String>();
    }
    return "und";
}

std::optional<ui::rmlui::ActiveTextPresenterSurface>
active_text_surface(Rml::ElementDocument& document)
{
    auto* active = find_first_tag(document, "nt-active-text");
    if (!active)
        return std::nullopt;
    return ui::rmlui::ActiveTextPresenterSurface{.bounds = content_rect(*active),
                                                 .text_color = element_text_color(*active),
                                                 .language = element_text_language(*active)};
}
} // namespace

struct RuntimeUI::State {
    using ContextKey = ui::rmlui::LifecycleContextKey;
    void refresh_runtime_document();
    void refresh_active_text_layout();
    void load_runtime_document();
    void show_game_document();
    bool dispatch_typed_input(const core::RuntimeInputMessage& input);
    bool dispatch_shell_command(const core::RuntimeShellCommand& command);
    bool dispatch_layout_typed_input(const core::RuntimeInputMessage& input);
    void install_shell_lua_api();
    void remove_shell_lua_api() noexcept;
    void refresh_runtime_shell_documents();
    Rml::Context* context_for(ContextKey key);
    Rml::ElementDocument* document(const std::string& id) const;
    struct RuntimeInputListener final : Rml::EventListener {
        explicit RuntimeInputListener(State& owner_state) : owner(owner_state) {}
        void ProcessEvent(Rml::Event& event) override;
        State& owner;
    };
    std::unique_ptr<ui::rmlui::RmlUiHost> host;
    std::unique_ptr<ui::rmlui::RmlUiDocumentRegistry> document_registry;
    std::unique_ptr<ui::rmlui::RuntimeUiBinder> binder;
    std::unique_ptr<ui::rmlui::ActiveTextPresenter> active_text_presenter;
    std::unique_ptr<ui::rmlui::RuntimeUiPlaybackDriver> playback_driver;
    ui::rmlui::RuntimeUiTemplateResolver* template_resolver = nullptr;
    ui::rmlui::RuntimeUiComponentRegistry* component_registry = nullptr;
    std::unique_ptr<RuntimeInputListener> runtime_input_listener;
    std::function<void()> game_started_handler;
    std::optional<core::RuntimeShellViewState> runtime_shell_view;
    core::Diagnostics typed_diagnostics;
    lua_State* lua_state = nullptr;
    script::ScriptRuntime* scripts = nullptr;
    std::string typed_notification;
};

Rml::Context* RuntimeUI::State::context_for(ContextKey key)
{
    return host ? host->context_for(key) : nullptr;
}

Rml::ElementDocument* RuntimeUI::State::document(const std::string& id) const
{
    return document_registry ? document_registry->document(id) : nullptr;
}

void RuntimeUI::State::load_runtime_document()
{
    if (!document_registry || !template_resolver)
        return;
    const std::string path = template_resolver->resolve_runtime_document();
    if (path.empty()) {
        std::fprintf(stderr, "[runtime_ui] no runtime game document found; runtime UI disabled\n");
        return;
    }
    if (!document_registry->load_builtin(RuntimeLayoutBuiltinDocument::GameHud, path, false)) {
        return;
    }
}

void RuntimeUI::State::show_game_document()
{
    if (!document_registry)
        return;
    (void)document_registry->hide(ui::rmlui::kRuntimeTitleDocumentId);
    if (!document_registry->has_document(ui::rmlui::kRuntimeGameDocumentId))
        load_runtime_document();
    if (document_registry->show(ui::rmlui::kRuntimeGameDocumentId))
        refresh_runtime_document();
}

bool RuntimeUI::State::dispatch_typed_input(const core::RuntimeInputMessage& input)
{
    return binder && binder->dispatch_input(input);
}

bool RuntimeUI::State::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    return binder && binder->dispatch_shell_command(command);
}

bool RuntimeUI::State::dispatch_layout_typed_input(const core::RuntimeInputMessage& input)
{
    return binder && binder->dispatch_layout_input(input);
}

void RuntimeUI::State::install_shell_lua_api()
{
    if (!lua_state)
        return;
    sol::state_view lua(lua_state);
    sol::table game;
    const sol::object existing = lua["Game"];
    if (existing.valid() && existing.get_type() == sol::type::table)
        game = existing.as<sol::table>();
    else {
        game = lua.create_table();
        lua["Game"] = game;
    }
    sol::table shell = lua.create_table();

    game.set_function("start", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::StartGameShellCommand{}});
    });

    shell.set_function("pause", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::OpenPauseShellCommand{}});
    });
    shell.set_function("resume", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::ResumeGameShellCommand{}});
    });
    shell.set_function("open_settings", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::OpenSettingsShellCommand{}});
    });
    shell.set_function("open_save", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::OpenSaveShellCommand{}});
    });
    shell.set_function("open_load", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::OpenLoadShellCommand{}});
    });
    shell.set_function("open_text_log", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::OpenTextLogShellCommand{}});
    });
    shell.set_function("open_debug", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::OpenDebugShellCommand{}});
    });
    shell.set_function("close", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::CloseShellScreenCommand{}});
    });
    shell.set_function("return_to_title", [this]() {
        return dispatch_shell_command(
            core::RuntimeShellCommand{core::RequestReturnToTitleShellCommand{}});
    });
    shell.set_function("quit", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::RequestQuitShellCommand{}});
    });
    shell.set_function("save", [this](std::uint32_t slot) {
        return dispatch_shell_command(core::RuntimeShellCommand{
            core::SaveShellSlotCommand{core::TypedSaveSlotId::manual(slot)}});
    });
    shell.set_function("load", [this](std::uint32_t slot) {
        return dispatch_shell_command(core::RuntimeShellCommand{
            core::RequestLoadShellSlotCommand{core::TypedSaveSlotId::manual(slot)}});
    });
    shell.set_function("load_autosave", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{
            core::RequestLoadShellSlotCommand{core::TypedSaveSlotId::autosave()}});
    });
    shell.set_function("set_text_scale", [this](double scale) {
        return dispatch_shell_command(
            core::RuntimeShellCommand{core::SetRuntimeTextScaleShellCommand{scale}});
    });
    shell.set_function("confirm", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::ConfirmShellCommand{}});
    });
    shell.set_function("cancel", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{core::CancelShellCommand{}});
    });
    shell.set_function("state", [this, lua]() mutable {
        sol::table state = lua.create_table();
        if (!runtime_shell_view)
            return state;
        state["screen"] = runtime_shell_screen_name(runtime_shell_view->screen);
        state["game_active"] = runtime_shell_view->game_active;
        state["text_scale"] = runtime_shell_view->settings.text_scale();
        state["status"] = runtime_shell_view->status;
        if (runtime_shell_view->checkpoint) {
            state["checkpoint_ready"] = runtime_shell_view->checkpoint->readiness.can_capture();
            state["checkpoint_retained"] =
                runtime_shell_view->checkpoint->retained_revision.has_value();
            state["thumbnail_available"] = runtime_shell_view->checkpoint->thumbnail_available;
            state["replay_structural_generations"] =
                runtime_shell_view->checkpoint->replay_distance.structural_generations;
            state["replay_time_generations"] =
                runtime_shell_view->checkpoint->replay_distance.time_generations;
            state["replay_play_time_ms"] =
                runtime_shell_view->checkpoint->replay_distance.play_time.count();
        }
        sol::table slots = lua.create_table();
        std::size_t index = 1;
        for (const auto& slot : runtime_shell_view->slots) {
            sol::table item = lua.create_table();
            item["autosave"] = slot.slot.is_autosave();
            item["number"] = slot.slot.number();
            item["occupied"] = slot.occupied;
            item["thumbnail_available"] = slot.thumbnail.has_value();
            if (slot.metadata) {
                item["play_time_ms"] = slot.metadata->play_time.count();
                item["project_version"] = slot.metadata->project_version;
            }
            slots[index++] = std::move(item);
        }
        state["slots"] = std::move(slots);
        if (runtime_shell_view->confirmation)
            state["confirmation_prompt"] = runtime_shell_view->confirmation->prompt;
        return state;
    });

    game["shell"] = std::move(shell);
}

void RuntimeUI::State::remove_shell_lua_api() noexcept
{
    if (!lua_state)
        return;
    sol::state_view lua(lua_state);
    const sol::object game_object = lua["Game"];
    if (game_object.valid() && game_object.get_type() == sol::type::table)
        game_object.as<sol::table>()["shell"] = sol::lua_nil;
}

void RuntimeUI::State::refresh_runtime_shell_documents()
{
    if (!runtime_shell_view || !document_registry)
        return;

    const auto bind_status = [&](const char* document_id) {
        if (auto* owner = document_registry->document(document_id))
            set_shell_element_rml(*owner, "nt-shell-status", runtime_shell_view->status);
    };
    bind_status(kRuntimeTitleDocumentId);
    bind_status(kRuntimePauseMenuDocumentId);
    bind_status(kRuntimeSaveMenuDocumentId);
    bind_status(kRuntimeLoadMenuDocumentId);
    bind_status(kRuntimeSettingsMenuDocumentId);
    bind_status(kRuntimeTextLogDocumentId);
    bind_status(kRuntimeModalDocumentId);

    if (auto* owner = document_registry->document(kRuntimeSettingsMenuDocumentId)) {
        std::ostringstream value;
        value << runtime_shell_view->settings.text_scale();
        set_shell_element_rml(*owner, "nt-settings-text-scale", value.str());
    }

    const auto checkpoint_summary = [&]() {
        if (!runtime_shell_view->checkpoint)
            return std::string("Checkpoint status unavailable.");
        const auto& checkpoint = *runtime_shell_view->checkpoint;
        std::ostringstream text;
        text << (checkpoint.readiness.can_capture() ? "Ready to capture" : "Capture blocked")
             << " · retained "
             << (checkpoint.retained_revision
                     ? std::to_string(checkpoint.retained_revision->number())
                     : std::string("none"))
             << " · replay distance " << checkpoint.replay_distance.structural_generations
             << " structural / " << checkpoint.replay_distance.time_generations << " time / "
             << checkpoint.replay_distance.play_time.count() << " ms" << " · thumbnail "
             << (checkpoint.thumbnail_capture_pending
                     ? "pending"
                     : (checkpoint.thumbnail_available ? "available" : "unavailable"));
        return text.str();
    }();

    const auto bind_slots = [&](const char* document_id, bool save_mode) {
        auto* owner = document_registry->document(document_id);
        if (!owner)
            return;
        set_shell_element_rml(*owner, "nt-checkpoint-summary", checkpoint_summary);
        auto* list = owner->GetElementById("nt-save-slots");
        if (!list)
            return;
        std::ostringstream rml;
        for (const auto& slot : runtime_shell_view->slots) {
            if (save_mode && slot.slot.is_autosave())
                continue;
            const std::string label = runtime_shell_slot_label(slot.slot);
            std::string detail = slot.occupied ? "Occupied" : "Empty";
            if (slot.metadata) {
                detail = "Play time " + std::to_string(slot.metadata->play_time.count()) +
                         " ms · version " + slot.metadata->project_version;
            }
            rml << "<section class=\"nt-save-slot\"><h2>" << ui::rmlui::escape_rml(label)
                << "</h2><p>" << ui::rmlui::escape_rml(detail) << "</p>";
            if (slot.thumbnail) {
                const std::string suffix =
                    slot.slot.is_autosave() ? "autosave" : std::to_string(slot.slot.number());
                const std::string filename =
                    "slot-" + suffix + "-thumbnail-" +
                    std::to_string(runtime_shell_thumbnail_fingerprint(slot.thumbnail->bytes)) +
                    ".png";
                const std::string path = "project:/generated/shell/" + filename;
                document_registry->set_virtual_file(path, slot.thumbnail->bytes);
                rml << "<img class=\"nt-save-thumbnail\" src=\"project|/generated/shell/"
                    << filename << "\"/>";
            } else {
                rml << "<p class=\"nt-save-thumbnail-missing\">No thumbnail</p>";
            }
            if (save_mode) {
                rml << "<button onclick=\"Game.shell.save(" << slot.slot.number()
                    << ")\">Save</button>";
            } else if (slot.occupied) {
                if (slot.slot.is_autosave())
                    rml << "<button onclick=\"Game.shell.load_autosave()\">Load</button>";
                else
                    rml << "<button onclick=\"Game.shell.load(" << slot.slot.number()
                        << ")\">Load</button>";
            }
            rml << "</section>";
        }
        list->SetInnerRML(rml.str());
    };
    bind_slots(kRuntimeSaveMenuDocumentId, true);
    bind_slots(kRuntimeLoadMenuDocumentId, false);

    if (auto* owner = document_registry->document(kRuntimeTextLogDocumentId); owner && binder)
        binder->bind_document(*owner, runtime_shell_view->status);
    if (auto* owner = document_registry->document(kRuntimeModalDocumentId)) {
        set_shell_element_rml(*owner, "nt-modal-prompt",
                              runtime_shell_view->confirmation
                                  ? runtime_shell_view->confirmation->prompt
                                  : std::string_view{});
    }
}

void RuntimeUI::State::refresh_runtime_document()
{
    auto* doc = document_registry ? document_registry->document(kRuntimeGameDocumentId) : nullptr;
    if (!doc || !binder)
        return;
    binder->bind_document(*doc, typed_notification);
}

void RuntimeUI::State::refresh_active_text_layout()
{
    if (!active_text_presenter)
        return;
    auto* doc = document_registry ? document_registry->document(kRuntimeGameDocumentId) : nullptr;
    active_text_presenter->refresh_layout(binder ? binder->view() : nullptr,
                                          doc ? active_text_surface(*doc) : std::nullopt);
}

void RuntimeUI::State::RuntimeInputListener::ProcessEvent(Rml::Event& event)
{
    Rml::Element* target = event.GetTargetElement();
    if (!target)
        return;

    if (owner.binder && owner.binder->has_input_sink() && owner.active_text_presenter &&
        find_ancestor_tag(target, "nt-active-text")) {
        const auto* gameplay_view = owner.binder->view();
        const float x = static_cast<float>(event.GetParameter<int>("mouse_x", 0));
        const float y = static_cast<float>(event.GetParameter<int>("mouse_y", 0));
        auto activation = owner.active_text_presenter->activate(gameplay_view, x, y);
        if (activation.local_state_changed) {
            owner.refresh_runtime_document();
            owner.refresh_active_text_layout();
        }
        if (activation.input)
            (void)owner.dispatch_layout_typed_input(*activation.input);
        return;
    }
}

RuntimeUI::RuntimeUI() = default;
RuntimeUI::~RuntimeUI() { shutdown(); }

void RuntimeUI::cleanup_state()
{
    m_last_event_consumed = false;
    if (!m_state)
        return;
    if (m_state->lua_state) {
        m_state->remove_shell_lua_api();
        m_state->lua_state = nullptr;
    }
    m_state->playback_driver.reset();
    m_state->binder.reset();
    m_state->active_text_presenter.reset();
    m_state->scripts = nullptr;
    if (m_state->document_registry) {
        m_state->document_registry->clear();
        m_state->document_registry.reset();
    }
    if (m_state->host)
        m_state->host->shutdown();
    m_state->runtime_input_listener.reset();
    delete m_state->template_resolver;
    m_state->template_resolver = nullptr;
    delete m_state->component_registry;
    m_state->component_registry = nullptr;
    m_state->host.reset();
    delete m_state;
    m_state = nullptr;
}

bool RuntimeUI::initialize(const assets::AssetManager* assets, SDL_Window* window,
                           script::ScriptRuntime* scripts,
                           const ShaderMaterialProject* shader_materials, bool headless_render)
{
    if (m_initialized)
        return true;

    if (!assets) {
        std::fprintf(stderr, "[runtime_ui] no AssetManager for RmlUi\n");
        return false;
    }

    if (!m_state)
        m_state = new State;
    if (!m_state->host)
        m_state->host = std::make_unique<ui::rmlui::RmlUiHost>();
    if (!m_state->active_text_presenter) {
        m_state->active_text_presenter =
            std::make_unique<ui::rmlui::ActiveTextPresenter>(m_state->typed_diagnostics);
        m_state->active_text_presenter->initialize(*assets);
    }
    m_state->template_resolver = new ui::rmlui::RuntimeUiTemplateResolver(*assets);

    if (!scripts || !scripts->is_initialized() ||
        !script::detail::ScriptRuntimeAccess::state(*scripts)) {
        std::fprintf(stderr, "[runtime_ui] RmlUi Lua requested but ScriptRuntime is unavailable\n");
        cleanup_state();
        return false;
    }
    m_state->lua_state = script::detail::ScriptRuntimeAccess::state(*scripts);
    m_state->scripts = scripts;
    if (!m_state->binder)
        m_state->binder = std::make_unique<ui::rmlui::RuntimeUiBinder>(m_state->typed_diagnostics);
    m_state->binder->set_lua_state(m_state->lua_state);
    if (m_state->binder->has_input_sink())
        m_state->install_shell_lua_api();
    const auto& pending_presentation = m_state->host->presentation();
    if (!m_state->host->initialize(
            ui::rmlui::RmlUiHost::Config{.assets = assets,
                                         .window = window,
                                         .lua_state = m_state->lua_state,
                                         .shader_materials = shader_materials,
                                         .surface = pending_presentation.game_surface,
                                         .presentation = pending_presentation,
                                         .headless_render = headless_render})) {
        cleanup_state();
        return false;
    }
    script::install_host_print(m_state->lua_state);
    m_state->component_registry = new ui::rmlui::RuntimeUiComponentRegistry;
    m_state->runtime_input_listener = std::make_unique<State::RuntimeInputListener>(*m_state);
    m_state->document_registry = std::make_unique<ui::rmlui::RmlUiDocumentRegistry>(*m_state->host);
    m_state->document_registry->set_runtime_input_listener(m_state->runtime_input_listener.get());
    m_state->playback_driver = std::make_unique<ui::rmlui::RuntimeUiPlaybackDriver>(
        *m_state->host, *m_state->document_registry,
        [state = m_state](core::MountedLayoutOwner owner, const std::function<bool()>& dispatch) {
            return state->binder && state->binder->dispatch_layout_event(owner, dispatch);
        });

    m_initialized = true;
    return true;
}

void RuntimeUI::enable_render_perf_logging(bool enabled)
{
    if (m_state && m_state->host)
        m_state->host->set_perf_logging_enabled(enabled);
}

void ui::rmlui::RuntimeUiFacadeAccess::set_base_direct_compatibility(RuntimeUI& runtime_ui,
                                                                     bool enabled)
{
    if (runtime_ui.m_state && runtime_ui.m_state->host)
        runtime_ui.m_state->host->set_base_direct_compatibility(enabled);
}

RuntimeUiEventResult RuntimeUI::process_event(const SDL_Event& event,
                                              const PresentationMetrics& presentation)
{
    RuntimeUiEventResult result;
    m_last_event_consumed = false;
    if (!m_state || !m_state->host || m_state->host->contexts().empty()) {
        return result;
    }

    if (m_state->binder)
        m_state->binder->begin_event_capture();
    m_last_event_consumed = m_state->host->process_event(
        event, presentation,
        [this](Rml::Context* context) {
            return m_state->document_registry &&
                   m_state->document_registry->has_visible_document(context);
        },
        [this](core::MountedLayoutOwner owner, const std::function<bool()>& dispatch) {
            return m_state->binder && m_state->binder->dispatch_layout_event(owner, dispatch);
        });
    if (m_state->binder)
        result = m_state->binder->finish_event_capture();
    result.consumed = m_last_event_consumed;
    result.wants_pointer = wants_pointer_input();
    result.wants_keyboard = wants_keyboard_input();
    return result;
}

void RuntimeUI::resize(const PresentationMetrics& presentation)
{
    if (!m_state)
        m_state = new State;
    if (!m_state->host)
        m_state->host = std::make_unique<ui::rmlui::RmlUiHost>();
    m_state->host->resize(presentation);
}

void RuntimeUI::begin_frame(const core::RuntimeClockUpdate& clocks)
{
    if (m_state && m_state->host && !m_state->host->contexts().empty()) {
        m_state->host->begin_frame(clocks);
        const float delta_time = std::chrono::duration<float>(clocks.gameplay_delta).count();
        if (m_state->active_text_presenter)
            m_state->active_text_presenter->advance(
                m_state->binder ? m_state->binder->view() : nullptr, delta_time);
        m_state->refresh_runtime_document();
        m_state->host->update_contexts();
        m_state->refresh_active_text_layout();
    }
}

void RuntimeUI::set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                               bool transition_active)
{
    if (m_state && m_state->host)
        m_state->host->set_world_overlay_framebuffers(source, target, transition_active);
}

void RuntimeUI::render_world_overlay_source()
{
    if (m_state && m_state->host)
        m_state->host->render_world_overlay_source();
}

void RuntimeUI::render_world_overlay_target()
{
    if (m_state && m_state->host)
        m_state->host->render_world_overlay_target();
}

void RuntimeUI::end_frame()
{
    if (m_state && m_state->host)
        m_state->host->end_frame();
}

void RuntimeUI::shutdown()
{
    if (m_state)
        cleanup_state();
    m_initialized = false;
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_document(RuntimeUI& runtime_ui, const std::string& id,
                                                     const std::string& path, bool show)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry &&
           runtime_ui.m_state->document_registry->load_path(id, path, show);
}

bool RuntimeUI::load_document_for_layout(const std::string& id, const std::string& path, bool show,
                                         const core::MountedLayoutPolicy& policy,
                                         std::uint32_t composition_group,
                                         core::MountedLayoutOwner owner)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey key{policy.plane, composition_group, policy.clock, policy.input, owner};
    return m_state->document_registry->load_path(id, path, show, key);
}

bool RuntimeUI::load_document_from_memory_for_layout(const std::string& id, const std::string& rml,
                                                     const std::string& source_url, bool show,
                                                     const core::MountedLayoutPolicy& policy,
                                                     std::uint32_t composition_group,
                                                     core::MountedLayoutOwner owner)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey key{policy.plane, composition_group, policy.clock, policy.input, owner};
    return m_state->document_registry->load_memory(id, rml, source_url, show, key);
}

bool RuntimeUI::load_builtin_for_layout(RuntimeLayoutBuiltinDocument builtin_document,
                                        const core::MountedLayoutPolicy& policy,
                                        std::uint32_t composition_group,
                                        core::MountedLayoutOwner owner)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey key{policy.plane, composition_group, policy.clock, policy.input, owner};
    std::string runtime_document_path;
    if (builtin_document == RuntimeLayoutBuiltinDocument::GameHud && m_state->template_resolver)
        runtime_document_path = m_state->template_resolver->resolve_runtime_document();
    const bool loaded = m_state->document_registry->load_builtin(builtin_document,
                                                                 runtime_document_path, true, key);
    if (loaded) {
        if (builtin_document == RuntimeLayoutBuiltinDocument::GameHud)
            m_state->refresh_runtime_document();
        else
            m_state->refresh_runtime_shell_documents();
    }
    return loaded;
}

bool RuntimeUI::apply_layout_order(const std::vector<std::string>& ordered_document_ids)
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->apply_order(ordered_document_ids);
}

bool RuntimeUI::apply_layout_policy(const std::string& document_id,
                                    const core::MountedLayoutPolicy& policy,
                                    std::uint32_t composition_group, core::MountedLayoutOwner owner)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey desired{policy.plane, composition_group, policy.clock, policy.input,
                                    owner};
    return m_state->document_registry->recreate_in_context(document_id, desired);
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_document_from_memory(RuntimeUI& runtime_ui,
                                                                 const std::string& id,
                                                                 const std::string& rml,
                                                                 const std::string& source_url,
                                                                 bool show)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry &&
           runtime_ui.m_state->document_registry->load_memory(id, rml, source_url, show);
}

bool ui::rmlui::RuntimeUiFacadeAccess::hide_document(RuntimeUI& runtime_ui, const std::string& id)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry &&
           runtime_ui.m_state->document_registry->hide(id);
}

void ui::rmlui::RuntimeUiFacadeAccess::set_preview_virtual_file(RuntimeUI& runtime_ui,
                                                                std::string path,
                                                                std::string contents)
{
    if (runtime_ui.m_state && runtime_ui.m_state->document_registry) {
        runtime_ui.m_state->document_registry->set_virtual_file(std::move(path),
                                                                std::move(contents));
    }
}

void ui::rmlui::RuntimeUiFacadeAccess::clear_preview_virtual_files(RuntimeUI& runtime_ui)
{
    if (runtime_ui.m_state && runtime_ui.m_state->document_registry)
        runtime_ui.m_state->document_registry->clear_virtual_files();
}

bool RuntimeUI::unload_document(const std::string& id)
{
    return m_state && m_state->document_registry && m_state->document_registry->unload(id);
}

bool RuntimeUI::show_document(const std::string& id)
{
    return m_state && m_state->document_registry && m_state->document_registry->show(id);
}

bool RuntimeUI::hide_document(const std::string& id)
{
    return m_state && m_state->document_registry && m_state->document_registry->hide(id);
}

bool RuntimeUI::set_document_opacity(const std::string& id, float opacity)
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->set_opacity(id, opacity);
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_title_document(RuntimeUI& runtime_ui)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry &&
           runtime_ui.m_state->document_registry->load_builtin(RuntimeLayoutBuiltinDocument::Title,
                                                               {}, true);
}

void ui::rmlui::RuntimeUiFacadeAccess::bind_title_document(RuntimeUI& runtime_ui,
                                                           const std::string& project_title,
                                                           const std::string& subtitle,
                                                           const std::string& start_label)
{
    auto* doc =
        runtime_ui.m_state ? runtime_ui.m_state->document(kRuntimeTitleDocumentId) : nullptr;
    if (!doc)
        return;
    if (auto* title = doc->GetElementById("nt-title-project")) {
        title->SetInnerRML(ui::rmlui::escape_rml(stable_label(project_title, "NovelTea")));
    }
    if (auto* subtitle_el = doc->GetElementById("nt-title-subtitle")) {
        subtitle_el->SetInnerRML(ui::rmlui::escape_rml(subtitle));
    }
    if (auto* start = doc->GetElementById("nt-title-start")) {
        start->SetInnerRML(ui::rmlui::escape_rml(stable_label(start_label, "Start")));
    }
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_runtime_document(RuntimeUI& runtime_ui)
{
    if (!runtime_ui.m_state || !runtime_ui.m_state->document_registry)
        return false;
    runtime_ui.m_state->load_runtime_document();
    if (runtime_ui.m_state->document_registry->show(kRuntimeGameDocumentId)) {
        runtime_ui.m_state->refresh_runtime_document();
        return true;
    }
    return false;
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_pause_menu_document(RuntimeUI& runtime_ui)
{
    if (!runtime_ui.m_state || !runtime_ui.m_state->document_registry ||
        !runtime_ui.m_state->document_registry->load_builtin(
            RuntimeLayoutBuiltinDocument::PauseMenu, {}, true)) {
        return false;
    }
    runtime_ui.m_state->refresh_runtime_shell_documents();
    return true;
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_builtin_system_document(RuntimeUI& runtime_ui,
                                                                    const std::string& id,
                                                                    const std::string& path)
{
    if (!runtime_ui.m_state || !runtime_ui.m_state->document_registry ||
        !runtime_ui.m_state->document_registry->load_path(
            id, path, true, ui::rmlui::RmlUiDocumentRegistry::default_context_key(), true)) {
        return false;
    }
    runtime_ui.m_state->refresh_runtime_shell_documents();
    return true;
}

bool RuntimeUI::has_document(const std::string& id) const
{
    return m_state && m_state->document_registry && m_state->document_registry->has_document(id);
}

bool RuntimeUI::reload_documents_and_styles()
{
    if (!m_state || !m_state->document_registry)
        return false;
    const bool ok = m_state->document_registry->reload_all();
    m_state->refresh_runtime_document();
    m_state->refresh_runtime_shell_documents();
    m_state->refresh_active_text_layout();
    return ok;
}

bool RuntimeUI::reset_backend()
{
    if (!m_state || !m_state->host || !m_state->document_registry)
        return false;
    m_state->host->reset_backend_state();
    return reload_documents_and_styles();
}

void ui::rmlui::RuntimeUiFacadeAccess::set_density(RuntimeUI& runtime_ui, float density)
{
    if (runtime_ui.m_state && runtime_ui.m_state->host)
        runtime_ui.m_state->host->set_density(density);
}

ActiveTextLayout RuntimeUI::active_text_render_snapshot() const
{
    if (!m_state || !m_state->active_text_presenter ||
        !m_state->active_text_presenter->direct_render_enabled()) {
        return {};
    }
    return m_state->active_text_presenter->render_snapshot();
}

bool RuntimeUI::active_text_direct_render_enabled() const
{
    return m_state && m_state->active_text_presenter &&
           m_state->active_text_presenter->direct_render_enabled();
}

void RuntimeUI::bind_input_sink(RuntimeUiInputSink* sink) noexcept
{
    if (!m_state)
        return;
    if (!m_state->binder) {
        m_state->binder = std::make_unique<ui::rmlui::RuntimeUiBinder>(m_state->typed_diagnostics);
        m_state->binder->set_lua_state(m_state->lua_state);
    }
    m_state->binder->bind_input_sink(sink);
    if (sink) {
        m_state->install_shell_lua_api();
    } else
        m_state->remove_shell_lua_api();
}

bool RuntimeUI::apply_gameplay_ui_values(const RuntimeUiGameplayValues& values)
{
    if (!m_state)
        return values.revision != 0;
    if (!m_state->binder) {
        m_state->binder = std::make_unique<ui::rmlui::RuntimeUiBinder>(m_state->typed_diagnostics);
        m_state->binder->set_lua_state(m_state->lua_state);
    }
    if (!m_state->binder->apply(values))
        return false;
    m_state->refresh_runtime_document();
    m_state->refresh_runtime_shell_documents();
    m_state->refresh_active_text_layout();
    return true;
}

void RuntimeUI::clear_gameplay_ui_values()
{
    if (!m_state)
        return;
    if (m_state->binder)
        m_state->binder->clear_gameplay_values();
    m_state->refresh_runtime_document();
    m_state->refresh_active_text_layout();
}

void RuntimeUI::apply_runtime_shell_view(core::RuntimeShellViewState view)
{
    if (!m_state)
        return;
    m_state->runtime_shell_view = std::move(view);
    m_state->refresh_runtime_shell_documents();
}

void RuntimeUI::clear_runtime_shell_view()
{
    if (!m_state)
        return;
    m_state->runtime_shell_view.reset();
    m_state->refresh_runtime_shell_documents();
}

void RuntimeUI::set_runtime_notification(std::string notification)
{
    if (!m_state)
        return;
    m_state->typed_notification = std::move(notification);
    m_state->refresh_runtime_document();
    m_state->refresh_runtime_shell_documents();
}

void RuntimeUI::append_typed_runtime_diagnostics(core::Diagnostics diagnostics)
{
    if (m_state)
        core::append_diagnostics(m_state->typed_diagnostics, std::move(diagnostics));
}

void RuntimeUI::clear_typed_runtime_diagnostics()
{
    if (m_state)
        m_state->typed_diagnostics.clear();
}

core::ActiveTextPresentationPhase RuntimeUI::active_text_presentation_phase() const noexcept
{
    return m_state && m_state->active_text_presenter
               ? m_state->active_text_presenter->presentation_phase()
               : core::ActiveTextPresentationPhase::Stable;
}

void RuntimeUI::bind_asset_service(const RuntimeUiAssetService* service) noexcept
{
    if (!m_state)
        return;
    if (!m_state->binder) {
        m_state->binder = std::make_unique<ui::rmlui::RuntimeUiBinder>(m_state->typed_diagnostics);
        m_state->binder->set_lua_state(m_state->lua_state);
    }
    m_state->binder->bind_asset_service(service);
    m_state->refresh_runtime_document();
}

void RuntimeUI::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    if (!m_state)
        return;
    if (!m_state->binder) {
        m_state->binder = std::make_unique<ui::rmlui::RuntimeUiBinder>(m_state->typed_diagnostics);
        m_state->binder->set_lua_state(m_state->lua_state);
    }
    m_state->binder->bind_layout_gameplay_admission(std::move(admission));
}

void ui::rmlui::RuntimeUiFacadeAccess::bind_game_started_handler(RuntimeUI& runtime_ui,
                                                                 std::function<void()> handler)
{
    if (runtime_ui.m_state)
        runtime_ui.m_state->game_started_handler = std::move(handler);
}

bool ui::rmlui::RuntimeUiFacadeAccess::dispatch_typed_runtime_input(
    RuntimeUI& runtime_ui, const core::RuntimeInputMessage& input)
{
    return runtime_ui.m_state && runtime_ui.m_state->dispatch_typed_input(input);
}

std::uintptr_t ui::rmlui::RuntimeUiFacadeAccess::add_event_listener(RuntimeUI& runtime_ui,
                                                                    const std::string& document_id,
                                                                    const std::string& element_id,
                                                                    const std::string& event,
                                                                    std::function<void()> callback)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry
               ? runtime_ui.m_state->document_registry->add_event_listener(
                     document_id, element_id, event, std::move(callback))
               : 0;
}

bool ui::rmlui::RuntimeUiFacadeAccess::remove_event_listener(RuntimeUI& runtime_ui,
                                                             std::uintptr_t listener_id)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry &&
           runtime_ui.m_state->document_registry->remove_event_listener(listener_id);
}

const char* RuntimeUI::backend_name() const { return "RmlUi (bgfx)"; }

const char* RuntimeUI::status_text() const
{
    return (m_state && m_state->host && !m_state->host->contexts().empty()) ? "rendering"
                                                                            : "no context";
}

bool RuntimeUI::wants_input() const { return wants_pointer_input() || wants_keyboard_input(); }

bool RuntimeUI::wants_pointer_input() const
{
    return m_state && m_state->host && m_state->host->wants_pointer_input();
}

bool RuntimeUI::wants_keyboard_input() const
{
    return m_state && m_state->host && m_state->host->wants_keyboard_input();
}

ui::rmlui::RuntimeUiPlaybackDriver*
ui::rmlui::RuntimeUiPlaybackDriver::from(RuntimeUI& runtime_ui) noexcept
{
    return runtime_ui.m_state ? runtime_ui.m_state->playback_driver.get() : nullptr;
}

} // namespace noveltea
