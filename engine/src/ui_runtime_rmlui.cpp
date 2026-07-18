#include "noveltea/ui_runtime.hpp"

#include "noveltea/active_text_playback.hpp"
#include "noveltea/runtime_layout_manager.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/text/text.hpp"
#include "noveltea/text/text_asset_loader.hpp"
#include "script/lua/script_runtime_internal.hpp"
#include "text/text_breaks.hpp"
#include "text/text_engine.hpp"

#include <algorithm>
#include <cmath>
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
#include "ui/rmlui/rmlui_document_binder.hpp"
#include "ui/rmlui/rmlui_document_registry.hpp"
#include "ui/rmlui/rmlui_custom_components.hpp"
#include "ui/rmlui/rmlui_host.hpp"
#include "ui/rmlui/rmlui_template_resolver.hpp"
#include "ui/rmlui/rmlui_test_access.hpp"

namespace noveltea {

namespace {
using ui::rmlui::kRuntimeGameDocumentId;
using ui::rmlui::kRuntimeLoadMenuDocumentId;
using ui::rmlui::kRuntimeModalDocumentId;
using ui::rmlui::kRuntimePauseMenuDocumentId;
using ui::rmlui::kRuntimeSaveMenuDocumentId;
using ui::rmlui::kRuntimeSettingsMenuDocumentId;
using ui::rmlui::kRuntimeTextLogDocumentId;
using ui::rmlui::kRuntimeTitleDocumentId;

constexpr const char* kRuntimeUiDocumentAsset = "project:/rmlui/demo.rml";

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

Rml::Element* resolve_playback_target(Rml::ElementDocument& doc, const std::string& selector)
{
    if (selector.empty()) {
        return nullptr;
    }
    if (selector.front() == '#') {
        return selector.size() > 1 ? doc.GetElementById(selector.substr(1)) : nullptr;
    }

    const auto attr_start = selector.find('[');
    const auto attr_end = selector.find(']', attr_start == std::string::npos ? 0 : attr_start);
    if (attr_start != std::string::npos && attr_end != std::string::npos &&
        attr_end > attr_start + 1) {
        const auto tag = attr_start == 0 ? std::string("*") : selector.substr(0, attr_start);
        auto attr = selector.substr(attr_start + 1, attr_end - attr_start - 1);
        std::string expected;
        if (const auto equals = attr.find('='); equals != std::string::npos) {
            expected = attr.substr(equals + 1);
            attr = attr.substr(0, equals);
            if (expected.size() >= 2 && ((expected.front() == '"' && expected.back() == '"') ||
                                         (expected.front() == '\'' && expected.back() == '\''))) {
                expected = expected.substr(1, expected.size() - 2);
            }
        }

        Rml::ElementList elements;
        if (tag == "*") {
            doc.GetElementsByTagName(elements, "button");
        } else {
            doc.GetElementsByTagName(elements, tag);
        }
        for (auto* element : elements) {
            if (!element || !element->HasAttribute(attr)) {
                continue;
            }
            if (expected.empty() || element->GetAttribute<Rml::String>(attr, "") == expected) {
                return element;
            }
        }
        return nullptr;
    }

    Rml::ElementList elements;
    if (selector.front() == '.') {
        if (selector.size() <= 1) {
            return nullptr;
        }
        doc.GetElementsByClassName(elements, selector.substr(1));
    } else {
        doc.GetElementsByTagName(elements, selector);
    }
    return elements.empty() ? nullptr : elements.front();
}

bool has_disabled_ancestor(Rml::Element* element)
{
    for (auto* current = element; current; current = current->GetParentNode()) {
        if (current->HasAttribute("disabled")) {
            return true;
        }
    }
    return false;
}

bool is_descendant_or_self(Rml::Element* candidate, Rml::Element* ancestor)
{
    for (auto* current = candidate; current; current = current->GetParentNode()) {
        if (current == ancestor) {
            return true;
        }
    }
    return false;
}

bool has_runtime_activation_attribute(Rml::Element& element)
{
    return element.HasAttribute("nt-option") || element.HasAttribute("nt-nav") ||
           element.HasAttribute("nt-continue") || element.HasAttribute("nt-object") ||
           element.HasAttribute("nt-action") || element.HasAttribute("nt-clear-selection");
}

bool has_runtime_activation_behavior(Rml::Element& target)
{
    if (target.HasAttribute("onclick") || has_runtime_activation_attribute(target)) {
        return true;
    }
    if (target.GetTagName() == "nt-active-text" || find_ancestor_tag(&target, "nt-active-text")) {
        return true;
    }
    return false;
}

void fill_target_metadata(RuntimeUiPlaybackClickResult& result, Rml::Element& target)
{
    result.target_id = target.GetId();
    result.target_tag = target.GetTagName();
    const Rml::Vector2f offset = target.GetAbsoluteOffset(Rml::BoxArea::Content);
    const Rml::Vector2f size = target.GetBox().GetSize(Rml::BoxArea::Content);
    result.x = offset.x + size.x * 0.5f;
    result.y = offset.y + size.y * 0.5f;
    result.width = size.x;
    result.height = size.y;
}

RuntimeUiPlaybackClickResult make_click_result(RuntimeUiPlaybackClickStatus status,
                                               const RuntimeUiPlaybackClickRequest& request,
                                               std::string message)
{
    RuntimeUiPlaybackClickResult result;
    result.status = status;
    result.message = std::move(message);
    result.document_id = request.document_id;
    result.selector = request.selector;
    return result;
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

core::RichTextDocument typed_active_text_document(const core::TypedRuntimeUIViewState& state)
{
    return ui::rmlui::make_active_text_snapshot(state).rich_text;
}

core::ActiveTextPresentationPhase
coordinated_active_text_phase(ActiveTextPlaybackPhase phase) noexcept
{
    if (phase == ActiveTextPlaybackPhase::Appearing || phase == ActiveTextPlaybackPhase::Revealing)
        return core::ActiveTextPresentationPhase::Reveal;
    if (phase == ActiveTextPlaybackPhase::Disappearing)
        return core::ActiveTextPresentationPhase::Fade;
    return core::ActiveTextPresentationPhase::Stable;
}

ActiveTextPlaybackInput active_text_playback_input(const core::TypedRuntimeUIViewState& state,
                                                   std::size_t page_index, float delta_seconds)
{
    const auto document = typed_active_text_document(state);
    const auto page = active_text_document_page(document, page_index);
    return ActiveTextPlaybackInput{
        .body_key = state.mode + ":" + document.plain_text + ":page:" + std::to_string(page_index),
        .glyph_count = text::utf8_grapheme_count(page.plain_text),
        .delta_seconds = delta_seconds,
        .awaiting_continue = state.can_continue,
        .page_break = page_index + 1u < active_text_page_count(document)};
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
    bool dispatch_layout_typed_input(const core::RuntimeInputMessage& input)
    {
        return (!layout_gameplay_admission || layout_gameplay_admission()) &&
               dispatch_typed_input(input);
    }
    void install_typed_lua_api();
    void refresh_runtime_shell_documents();
    Rml::Context* context_for(ContextKey key);
    Rml::Context* document_context(const std::string& id) const;
    Rml::ElementDocument* document(const std::string& id) const;
    Rml::Element* element(const std::string& document_id, const std::string& element_id) const;
    struct RuntimeInputListener final : Rml::EventListener {
        explicit RuntimeInputListener(State& owner_state) : owner(owner_state) {}
        void ProcessEvent(Rml::Event& event) override;
        State& owner;
    };
    std::unique_ptr<ui::rmlui::RmlUiHost> host;
    std::unique_ptr<ui::rmlui::RmlUiDocumentRegistry> document_registry;
    ui::rmlui::RuntimeUiTemplateResolver* template_resolver = nullptr;
    ui::rmlui::RuntimeUiDocumentBinder* document_binder = nullptr;
    const RuntimeUiAssetService* asset_service = nullptr;
    ui::rmlui::RuntimeUiComponentRegistry* component_registry = nullptr;
    std::unique_ptr<RuntimeInputListener> runtime_input_listener;
    RuntimeUiInputSink* input_sink = nullptr;
    std::function<bool()> layout_gameplay_admission;
    std::function<void()> game_started_handler;
    std::optional<core::TypedRuntimeUIViewState> typed_runtime_view;
    std::uint64_t typed_runtime_view_revision = 0;
    std::optional<core::RuntimeShellViewState> runtime_shell_view;
    core::Diagnostics typed_diagnostics;
    lua_State* lua_state = nullptr;
    script::ScriptRuntime* scripts = nullptr;
    std::string typed_notification;
    ActiveTextPlaybackState active_text_playback;
    ActiveTextPlaybackConfig active_text_playback_config{};
    std::uint64_t active_text_page_instance_id = 0;
    std::size_t active_text_page_index = 0;
    std::size_t active_text_local_page_count = 1;
    float active_text_reveal_progress = 1.0f;
    std::unique_ptr<text::TextEngine> active_text_engine;
    std::unique_ptr<text::TextFontAssetLoader> active_text_font_loader;
    FontHandle active_text_font;
    ActiveTextLayout active_text_layout;
    double active_text_time_seconds = 0.0;
    bool active_text_direct_enabled = true;
};

Rml::Context* RuntimeUI::State::context_for(ContextKey key)
{
    return host ? host->context_for(key) : nullptr;
}

Rml::Context* RuntimeUI::State::document_context(const std::string& id) const
{
    return document_registry ? document_registry->document_context(id) : nullptr;
}

Rml::ElementDocument* RuntimeUI::State::document(const std::string& id) const
{
    return document_registry ? document_registry->document(id) : nullptr;
}

Rml::Element* RuntimeUI::State::element(const std::string& document_id,
                                        const std::string& element_id) const
{
    return document_registry ? document_registry->element(document_id, element_id) : nullptr;
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
    if (!input_sink) {
        typed_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Typed runtime UI input requires a bound input sink"});
        return false;
    }
    return input_sink->submit_gameplay_input(input);
}

bool RuntimeUI::State::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    if (!input_sink) {
        typed_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Runtime shell command requires a bound input sink"});
        return false;
    }
    return input_sink->submit_shell_command(command);
}

void RuntimeUI::State::install_typed_lua_api()
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
    sol::table ui = lua.create_table();
    sol::table shell = lua.create_table();

    auto invalid = [this](std::string code, std::string message) {
        typed_diagnostics.push_back(
            core::Diagnostic{.code = std::move(code), .message = std::move(message)});
        return false;
    };
    auto require_view = [this, invalid]() {
        return typed_runtime_view.has_value() ||
               invalid("runtime_ui.view_unavailable", "Typed runtime view is unavailable");
    };

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

    ui.set_function("continue", [this, require_view, invalid]() {
        if (!require_view())
            return false;
        if (!typed_runtime_view->can_continue)
            return invalid("runtime_ui.continue_unavailable", "Continue is not currently enabled");
        return dispatch_layout_typed_input(core::RuntimeInputMessage{core::ContinueInput{}});
    });
    ui.set_function("choose_scene", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::SceneChoiceOptionId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const auto* choice = typed_runtime_view->scene && typed_runtime_view->scene->choice
                                 ? &*typed_runtime_view->scene->choice
                                 : nullptr;
        const bool enabled =
            choice &&
            std::any_of(choice->options.begin(), choice->options.end(), [&](const auto& option) {
                return option.option == *id.value_if() && option.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_scene_choice",
                           "Scene choice is stale, unknown, or disabled");
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::SelectSceneChoiceInput{*id.value_if()}});
    });
    ui.set_function("choose_dialogue", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::DialogueEdgeId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const auto* choice = typed_runtime_view->dialogue && typed_runtime_view->dialogue->choice
                                 ? &*typed_runtime_view->dialogue->choice
                                 : nullptr;
        const bool enabled =
            choice &&
            std::any_of(choice->options.begin(), choice->options.end(), [&](const auto& option) {
                return option.edge == *id.value_if() && option.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_dialogue_choice",
                           "Dialogue choice is stale, unknown, or disabled");
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::SelectDialogueChoiceInput{*id.value_if()}});
    });
    ui.set_function("navigate_room", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::RoomExitId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const auto* room = typed_runtime_view->room ? &*typed_runtime_view->room : nullptr;
        const bool enabled =
            room && std::any_of(room->exits.begin(), room->exits.end(), [&](const auto& exit) {
                return exit.exit == *id.value_if() && exit.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_room_exit",
                           "Room exit is stale, unknown, or disabled");
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::NavigateRoomInput{*id.value_if()}});
    });
    ui.set_function("navigate_map_connection", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::MapConnectionId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const auto* map = typed_runtime_view->map ? &*typed_runtime_view->map : nullptr;
        const core::MapConnectionView* found = nullptr;
        if (map) {
            const auto it = std::find_if(
                map->connections.begin(), map->connections.end(),
                [&](const auto& connection) { return connection.connection == *id.value_if(); });
            if (it != map->connections.end() && it->selectable)
                found = &*it;
        }
        if (!found)
            return invalid("runtime_ui.invalid_map_connection",
                           "Map connection is stale, unknown, or disabled");
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::NavigateRoomInput{found->exit.exit_id}});
    });
    ui.set_function("toggle_interactable", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::InteractableId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const auto available_in_room =
            typed_runtime_view->room &&
            std::any_of(typed_runtime_view->room->placements.begin(),
                        typed_runtime_view->room->placements.end(), [&](const auto& placement) {
                            return std::any_of(
                                placement.occupants.begin(), placement.occupants.end(),
                                [&](const auto& occupant) {
                                    const auto* subject =
                                        std::get_if<core::compiled::InteractableInteractionSubject>(
                                            &occupant.subject);
                                    return subject != nullptr &&
                                           subject->interactable == *id.value_if() &&
                                           occupant.visible && occupant.enabled;
                                });
                        });
        const auto available_in_inventory = std::any_of(
            typed_runtime_view->inventory.items.begin(), typed_runtime_view->inventory.items.end(),
            [&](const auto& item) {
                return item.interactable == *id.value_if() && item.visible && item.enabled;
            });
        if (!available_in_room && !available_in_inventory)
            return invalid("runtime_ui.invalid_interactable",
                           "Interactable is stale, unknown, hidden, or disabled");
        auto selection = typed_runtime_view->selected_subjects;
        const core::compiled::InteractionSubject subject =
            core::compiled::InteractableInteractionSubject{*id.value_if()};
        const auto selected = std::find(selection.begin(), selection.end(), subject);
        if (selected == selection.end())
            selection.push_back(subject);
        else
            selection.erase(selected);
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{std::move(selection)}});
    });
    ui.set_function("toggle_character", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::CharacterId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const core::compiled::InteractionSubject subject =
            core::compiled::CharacterInteractionSubject{*id.value_if()};
        const bool available =
            typed_runtime_view->room &&
            std::any_of(typed_runtime_view->room->placements.begin(),
                        typed_runtime_view->room->placements.end(), [&](const auto& placement) {
                            return std::any_of(placement.occupants.begin(),
                                               placement.occupants.end(),
                                               [&](const auto& occupant) {
                                                   return occupant.subject == subject &&
                                                          occupant.visible && occupant.enabled;
                                               });
                        });
        if (!available)
            return invalid("runtime_ui.invalid_character",
                           "Character is stale, unknown, hidden, or disabled");
        auto selection = typed_runtime_view->selected_subjects;
        const auto selected = std::find(selection.begin(), selection.end(), subject);
        if (selected == selection.end())
            selection.push_back(subject);
        else
            selection.erase(selected);
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{std::move(selection)}});
    });
    ui.set_function("clear_selection", [this]() {
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::ClearInteractionSubjectSelectionInput{}});
    });
    ui.set_function("invoke_interaction", [this, require_view, invalid](std::string text) {
        if (!require_view())
            return false;
        auto id = core::VerbId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(typed_diagnostics, id.error());
            return false;
        }
        const auto* controls = typed_runtime_view->room ? &typed_runtime_view->room->controls
                                                        : &typed_runtime_view->inventory.controls;
        const auto found =
            std::find_if(controls->begin(), controls->end(),
                         [&](const auto& control) { return control.verb == *id.value_if(); });
        if (found == controls->end() || !found->enabled)
            return invalid("runtime_ui.invalid_interaction",
                           "Interaction verb is stale, unknown, or disabled");
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::InvokeInteractionInput{*id.value_if(), {}}});
    });
    game["ui"] = ui;
    game["shell"] = shell;
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

    if (auto* owner = document_registry->document(kRuntimeTextLogDocumentId);
        owner && document_binder && typed_runtime_view) {
        document_binder->bind(*owner, *typed_runtime_view, asset_service,
                              runtime_shell_view->status);
    }
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
    if (!doc || !document_binder)
        return;
    if (typed_runtime_view)
        document_binder->bind(*doc, *typed_runtime_view, asset_service, typed_notification);
}

void RuntimeUI::State::refresh_active_text_layout()
{
    auto* doc = document_registry ? document_registry->document(kRuntimeGameDocumentId) : nullptr;
    if (!doc) {
        active_text_layout = {};
        return;
    }

    auto* active = find_first_tag(*doc, "nt-active-text");
    if (!active) {
        active_text_layout = {};
        return;
    }

    const auto active_document = typed_runtime_view
                                     ? typed_active_text_document(*typed_runtime_view)
                                     : core::RichTextDocument{};
    active_text_local_page_count = active_text_page_count(active_document);
    active_text_page_index = std::min(active_text_page_index, active_text_local_page_count - 1u);

    ActiveTextLayoutOptions options;
    options.bounds = content_rect(*active);
    options.default_font_alias = std::string(kSystemFontAlias);
    options.default_text_size = 17.0f;
    options.language = element_text_language(*active);
    options.default_color = element_text_color(*active);
    options.line_spacing = 1.35f;
    options.reveal_progress = active_text_playback.reveal_progress;
    options.alpha = active_text_playback.alpha;
    options.page_index = active_text_page_index;
    options.time_seconds = active_text_time_seconds;

    if (active_text_engine && active_text_font) {
        active_text_layout =
            build_active_text_layout(active_document, options, [this](const StyledText& text) {
                return active_text_engine->layout_text(text);
            });
    } else {
        active_text_layout = build_active_text_layout(active_document, options);
    }
    active_text_layout.page_break = active_text_layout.page_break;
    active_text_layout.awaiting_continue =
        (typed_runtime_view && typed_runtime_view->can_continue) ||
        active_text_layout.awaiting_continue;
    active_text_local_page_count = active_text_layout.page_count;
    active_text_page_index = active_text_layout.page_index;
    active_text_layout.prompt.visible = active_text_playback.prompt_visible;
    active_text_layout.prompt.alpha =
        active_text_playback.prompt_alpha * active_text_playback.alpha;
    active_text_layout.prompt.page_break = active_text_playback.page_break;
    if (active_text_layout.prompt.visible) {
        constexpr float prompt_size = 10.0f;
        active_text_layout.prompt.bounds = {
            options.bounds.x + std::max(options.bounds.width - prompt_size, 0.0f),
            options.bounds.y + std::max(options.bounds.height - prompt_size, 0.0f), prompt_size,
            prompt_size};
    }
}

void RuntimeUI::State::RuntimeInputListener::ProcessEvent(Rml::Event& event)
{
    Rml::Element* target = event.GetTargetElement();
    if (!target)
        return;

    if (owner.input_sink && find_ancestor_tag(target, "nt-active-text")) {
        const float x = static_cast<float>(event.GetParameter<int>("mouse_x", 0));
        const float y = static_cast<float>(event.GetParameter<int>("mouse_y", 0));
        if (const auto object_id = owner.active_text_layout.object_at({x, y})) {
            auto interactable = core::InteractableId::create(*object_id);
            if (!interactable) {
                core::append_diagnostics(owner.typed_diagnostics, std::move(interactable).error());
                return;
            }
            const bool available_in_room =
                owner.typed_runtime_view && owner.typed_runtime_view->room &&
                std::any_of(
                    owner.typed_runtime_view->room->placements.begin(),
                    owner.typed_runtime_view->room->placements.end(), [&](const auto& placement) {
                        return std::any_of(
                            placement.occupants.begin(), placement.occupants.end(),
                            [&](const auto& occupant) {
                                const auto* subject =
                                    std::get_if<core::compiled::InteractableInteractionSubject>(
                                        &occupant.subject);
                                return subject != nullptr &&
                                       subject->interactable == *interactable.value_if() &&
                                       occupant.visible && occupant.enabled;
                            });
                    });
            const bool available_in_inventory =
                owner.typed_runtime_view &&
                std::any_of(owner.typed_runtime_view->inventory.items.begin(),
                            owner.typed_runtime_view->inventory.items.end(), [&](const auto& item) {
                                return item.interactable == *interactable.value_if() &&
                                       item.visible && item.enabled;
                            });
            if (!available_in_room && !available_in_inventory) {
                owner.typed_diagnostics.push_back(core::Diagnostic{
                    .code = "runtime_ui.invalid_active_text_interactable",
                    .message = "ActiveText interactable is stale, unknown, hidden, or disabled"});
                return;
            }
            (void)owner.dispatch_layout_typed_input(
                core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{
                    {core::compiled::InteractableInteractionSubject{*interactable.value_if()}}}});
        } else if (owner.active_text_playback.can_skip_reveal) {
            owner.active_text_playback = skip_active_text_reveal(owner.active_text_playback);
            owner.active_text_reveal_progress = owner.active_text_playback.reveal_progress;
            owner.refresh_runtime_document();
            owner.refresh_active_text_layout();
        } else if (owner.active_text_playback.can_continue) {
            if (owner.active_text_page_index + 1u < owner.active_text_local_page_count) {
                ++owner.active_text_page_index;
                owner.active_text_playback = {};
                owner.active_text_reveal_progress = 0.0f;
                owner.active_text_time_seconds = 0.0;
                owner.refresh_runtime_document();
                owner.refresh_active_text_layout();
            } else {
                (void)owner.dispatch_layout_typed_input(
                    core::RuntimeInputMessage{core::ContinueInput{}});
            }
        } else if (owner.typed_runtime_view && owner.typed_runtime_view->can_continue) {
            (void)owner.dispatch_layout_typed_input(
                core::RuntimeInputMessage{core::ContinueInput{}});
        }
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
        sol::state_view lua(m_state->lua_state);
        const sol::object game_object = lua["Game"];
        if (game_object.valid() && game_object.get_type() == sol::type::table)
            game_object.as<sol::table>()["ui"] = sol::lua_nil;
        m_state->lua_state = nullptr;
    }
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
    delete m_state->document_binder;
    m_state->document_binder = nullptr;
    delete m_state->component_registry;
    m_state->component_registry = nullptr;
    m_state->host.reset();
    delete m_state;
    m_state = nullptr;
}

bool RuntimeUI::initialize(const assets::AssetManager* assets, SDL_Window* window,
                           bool load_demo_document, script::ScriptRuntime* scripts,
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
    m_state->active_text_engine = std::make_unique<text::TextEngine>(*assets);
    if (m_state->active_text_engine->valid()) {
        m_state->active_text_font_loader =
            std::make_unique<text::TextFontAssetLoader>(*assets, *m_state->active_text_engine);
        assets->bind_font_loader(m_state->active_text_font_loader.get());
        auto font = assets->load_font(assets::FontAssetRequest{
            .alias = std::string(kSystemFontAlias), .style = TextFontRegular});
        if (font) {
            m_state->active_text_font = font.value->face;
        }
    }
    m_state->template_resolver = new ui::rmlui::RuntimeUiTemplateResolver(*assets);
    m_state->document_binder = new ui::rmlui::RuntimeUiDocumentBinder;

    if (!scripts || !scripts->is_initialized() ||
        !script::detail::ScriptRuntimeAccess::state(*scripts)) {
        std::fprintf(stderr, "[runtime_ui] RmlUi Lua requested but ScriptRuntime is unavailable\n");
        cleanup_state();
        return false;
    }
    m_state->lua_state = script::detail::ScriptRuntimeAccess::state(*scripts);
    m_state->scripts = scripts;
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

    if (load_demo_document) {
        if (m_state->document_registry->load_path("demo", kRuntimeUiDocumentAsset, true)) {
            std::printf("[runtime_ui] demo document loaded\n");
        } else {
            std::fprintf(stderr, "[runtime_ui] failed to load demo document\n");
        }
    }

    m_initialized = true;
    return true;
}

void RuntimeUI::enable_render_perf_logging(bool enabled)
{
    if (m_state && m_state->host)
        m_state->host->set_perf_logging_enabled(enabled);
}

void RuntimeUI::set_rmlui_base_direct_compatibility(bool enabled)
{
    if (m_state && m_state->host)
        m_state->host->set_base_direct_compatibility(enabled);
}

bool RuntimeUI::process_event(const SDL_Event& event, const PresentationMetrics& presentation)
{
    m_last_event_consumed = false;
    if (!m_state || !m_state->host || m_state->host->contexts().empty()) {
        return false;
    }
    m_last_event_consumed = m_state->host->process_event(
        event, presentation,
        [this](Rml::Context* context) {
            return m_state->document_registry &&
                   m_state->document_registry->has_visible_document(context);
        },
        [this](core::MountedLayoutOwner owner, const std::function<bool()>& dispatch) {
            return m_state->input_sink ? m_state->input_sink->dispatch_layout_event(owner, dispatch)
                                       : dispatch();
        });
    return m_last_event_consumed;
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
        const auto previous_instance = m_state->active_text_playback.instance_id;
        const float playback_delta = delta_time;
        const auto playback_input =
            m_state->typed_runtime_view
                ? active_text_playback_input(*m_state->typed_runtime_view,
                                             m_state->active_text_page_index, playback_delta)
                : ActiveTextPlaybackInput{};
        m_state->active_text_playback = update_active_text_playback(
            m_state->active_text_playback, playback_input, m_state->active_text_playback_config);
        m_state->active_text_reveal_progress = m_state->active_text_playback.reveal_progress;
        if (m_state->active_text_playback.instance_id != previous_instance) {
            m_state->active_text_time_seconds = 0.0;
        } else if (delta_time > 0.0f) {
            m_state->active_text_time_seconds += static_cast<double>(delta_time);
        }
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
    if (m_state) {
        m_state->input_sink = nullptr;
        m_state->asset_service = nullptr;
        cleanup_state();
    }
    m_initialized = false;
}

bool RuntimeUI::load_document(const std::string& id, const std::string& path, bool show)
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->load_path(id, path, show);
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

bool RuntimeUI::load_document_from_memory(const std::string& id, const std::string& rml,
                                          const std::string& source_url, bool show)
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->load_memory(id, rml, source_url, show);
}

void RuntimeUI::set_preview_virtual_file(std::string path, std::string contents)
{
    if (m_state && m_state->document_registry)
        m_state->document_registry->set_virtual_file(std::move(path), std::move(contents));
}

void RuntimeUI::clear_preview_virtual_files()
{
    if (m_state && m_state->document_registry)
        m_state->document_registry->clear_virtual_files();
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

bool RuntimeUI::load_title_document()
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->load_builtin(RuntimeLayoutBuiltinDocument::Title, {}, true);
}

void RuntimeUI::bind_title_document(const std::string& project_title, const std::string& subtitle,
                                    const std::string& start_label)
{
    auto* doc = m_state ? m_state->document(kRuntimeTitleDocumentId) : nullptr;
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

bool RuntimeUI::load_runtime_document()
{
    if (!m_state || !m_state->document_registry)
        return false;
    m_state->load_runtime_document();
    if (m_state->document_registry->show(kRuntimeGameDocumentId)) {
        m_state->refresh_runtime_document();
        return true;
    }
    return false;
}

bool RuntimeUI::load_pause_menu_document()
{
    if (!m_state || !m_state->document_registry ||
        !m_state->document_registry->load_builtin(RuntimeLayoutBuiltinDocument::PauseMenu, {},
                                                  true)) {
        return false;
    }
    m_state->refresh_runtime_shell_documents();
    return true;
}

bool RuntimeUI::load_builtin_system_document(const std::string& id, const std::string& path)
{
    if (!m_state || !m_state->document_registry ||
        !m_state->document_registry->load_path(
            id, path, true, ui::rmlui::RmlUiDocumentRegistry::default_context_key(), true)) {
        return false;
    }
    m_state->refresh_runtime_shell_documents();
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

void RuntimeUI::set_density(float density)
{
    if (m_state && m_state->host)
        m_state->host->set_density(density);
}

ActiveTextLayout RuntimeUI::active_text_render_snapshot() const
{
    if (!m_state || !m_state->active_text_direct_enabled) {
        return {};
    }
    return m_state->active_text_layout;
}

bool RuntimeUI::active_text_direct_render_enabled() const
{
    return m_state && m_state->active_text_direct_enabled;
}

void RuntimeUI::bind_input_sink(RuntimeUiInputSink* sink) noexcept
{
    if (!m_state)
        return;
    m_state->input_sink = sink;
    if (sink) {
        m_state->install_typed_lua_api();
    } else if (m_state->lua_state) {
        sol::state_view lua(m_state->lua_state);
        const sol::object game_object = lua["Game"];
        if (game_object.valid() && game_object.get_type() == sol::type::table) {
            auto game = game_object.as<sol::table>();
            game["ui"] = sol::lua_nil;
            game["shell"] = sol::lua_nil;
        }
    }
}

bool RuntimeUI::apply_gameplay_ui_values(const RuntimeUiGameplayValues& values)
{
    if (values.revision == 0)
        return false;
    if (!m_state)
        return true;
    if (m_state->typed_runtime_view_revision > values.revision) {
        m_state->typed_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.stale_gameplay_values",
                             .message = "Gameplay UI revision " + std::to_string(values.revision) +
                                        " is older than applied revision " +
                                        std::to_string(m_state->typed_runtime_view_revision)});
        return false;
    }
    m_state->typed_runtime_view = values.view;
    m_state->typed_runtime_view_revision = values.revision;
    m_state->refresh_runtime_document();
    m_state->refresh_runtime_shell_documents();
    m_state->refresh_active_text_layout();
    return true;
}

void RuntimeUI::clear_gameplay_ui_values()
{
    if (!m_state)
        return;
    m_state->typed_runtime_view.reset();
    m_state->typed_runtime_view_revision = 0;
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
    return m_state ? coordinated_active_text_phase(m_state->active_text_playback.phase)
                   : core::ActiveTextPresentationPhase::Stable;
}

void RuntimeUI::bind_asset_service(const RuntimeUiAssetService* service) noexcept
{
    if (!m_state)
        return;
    m_state->asset_service = service;
    m_state->refresh_runtime_document();
}

void RuntimeUI::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    if (m_state)
        m_state->layout_gameplay_admission = std::move(admission);
}

void RuntimeUI::bind_game_started_handler(std::function<void()> handler)
{
    if (m_state)
        m_state->game_started_handler = std::move(handler);
}

bool RuntimeUI::dispatch_typed_runtime_input(const core::RuntimeInputMessage& input)
{
    return m_state && m_state->dispatch_typed_input(input);
}

std::uintptr_t RuntimeUI::add_event_listener(const std::string& document_id,
                                             const std::string& element_id,
                                             const std::string& event,
                                             std::function<void()> callback)
{
    return m_state && m_state->document_registry
               ? m_state->document_registry->add_event_listener(document_id, element_id, event,
                                                                std::move(callback))
               : 0;
}

bool RuntimeUI::remove_event_listener(std::uintptr_t listener_id)
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->remove_event_listener(listener_id);
}

RuntimeUiPlaybackClickResult RuntimeUI::playback_click(const RuntimeUiPlaybackClickRequest& request)
{
    if (!m_state || !m_state->host || m_state->host->contexts().empty()) {
        return make_click_result(RuntimeUiPlaybackClickStatus::UiNotInitialized, request,
                                 "runtime UI is not initialized");
    }

    auto* doc = m_state->document(request.document_id);
    if (!doc) {
        return make_click_result(RuntimeUiPlaybackClickStatus::DocumentNotFound, request,
                                 "document is not loaded: " + request.document_id);
    }
    if (!doc->IsVisible()) {
        return make_click_result(RuntimeUiPlaybackClickStatus::DocumentHidden, request,
                                 "document is hidden: " + request.document_id);
    }
    auto* context = m_state->document_context(request.document_id);
    if (!context) {
        return make_click_result(RuntimeUiPlaybackClickStatus::DocumentNotFound, request,
                                 "document context is unavailable: " + request.document_id);
    }

    Rml::Element* target = resolve_playback_target(*doc, request.selector);
    if (!target) {
        return make_click_result(RuntimeUiPlaybackClickStatus::TargetNotFound, request,
                                 "target not found: " + request.selector);
    }

    auto result = make_click_result(RuntimeUiPlaybackClickStatus::Dispatched, request, {});
    fill_target_metadata(result, *target);

    if (!target->IsVisible(true)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetHidden;
        result.message = "target or ancestor is hidden: " + request.selector;
        return result;
    }
    if (result.width <= 0.0f || result.height <= 0.0f || !std::isfinite(result.width) ||
        !std::isfinite(result.height)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetEmptyBounds;
        result.message = "target has empty bounds: " + request.selector;
        return result;
    }
    if (has_disabled_ancestor(target)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetDisabled;
        result.message = "target or ancestor is disabled: " + request.selector;
        return result;
    }

    Rml::Element* hit = context->GetElementAtPoint({result.x, result.y});
    if (!has_runtime_activation_attribute(*target) && hit && !is_descendant_or_self(hit, target) &&
        !is_descendant_or_self(target, hit)) {
        result.status = RuntimeUiPlaybackClickStatus::TargetBlocked;
        result.message = "target is not hittable at click point: " + request.selector;
        if (hit) {
            result.message += " hit=";
            result.message += hit->GetTagName();
            if (!hit->GetId().empty()) {
                result.message += "#";
                result.message += hit->GetId();
            }
        }
        return result;
    }

    const bool has_click_listener =
        has_runtime_activation_behavior(*target) ||
        (m_state->document_registry &&
         m_state->document_registry->has_event_listener(*target, "click"));
    if (!has_click_listener) {
        result.status = RuntimeUiPlaybackClickStatus::TargetNotInteractive;
        result.message = "target has no onclick or bound click listener: " + request.selector;
        return result;
    }

    const int x = static_cast<int>(std::lround(result.x));
    const int y = static_cast<int>(std::lround(result.y));
    m_state->host->set_context_clock(
        m_state->document_registry->context_key_or_default(request.document_id));
    context->ProcessMouseMove(x, y, 0);
    context->ProcessMouseButtonDown(0, 0);
    context->ProcessMouseButtonUp(0, 0);
    result.dispatched = true;
    result.message = "dispatched ui-click";
    return result;
}

const char* RuntimeUI::backend_name() const { return "RmlUi (bgfx)"; }

const char* to_string(RuntimeUiPlaybackClickStatus status) noexcept
{
    switch (status) {
    case RuntimeUiPlaybackClickStatus::Dispatched:
        return "dispatched";
    case RuntimeUiPlaybackClickStatus::UiNotInitialized:
        return "ui-not-initialized";
    case RuntimeUiPlaybackClickStatus::DocumentNotFound:
        return "document-not-found";
    case RuntimeUiPlaybackClickStatus::DocumentHidden:
        return "document-hidden";
    case RuntimeUiPlaybackClickStatus::TargetNotFound:
        return "target-not-found";
    case RuntimeUiPlaybackClickStatus::TargetHidden:
        return "target-hidden";
    case RuntimeUiPlaybackClickStatus::TargetEmptyBounds:
        return "target-empty-bounds";
    case RuntimeUiPlaybackClickStatus::TargetDisabled:
        return "target-disabled";
    case RuntimeUiPlaybackClickStatus::TargetBlocked:
        return "target-blocked";
    case RuntimeUiPlaybackClickStatus::TargetNotInteractive:
        return "target-not-interactive";
    }
    return "unknown";
}

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

Rml::ElementDocument* ui::rmlui::RmlUiTestAccess::document(RuntimeUI& runtime_ui,
                                                           const std::string& id)
{
    return runtime_ui.m_state ? runtime_ui.m_state->document(id) : nullptr;
}

Rml::Element* ui::rmlui::RmlUiTestAccess::element(RuntimeUI& runtime_ui,
                                                  const std::string& document_id,
                                                  const std::string& element_id)
{
    return runtime_ui.m_state ? runtime_ui.m_state->element(document_id, element_id) : nullptr;
}

} // namespace noveltea
