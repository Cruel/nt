#include "noveltea/ui_runtime.hpp"

#include "noveltea/active_text_playback.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/typed_runtime_session.hpp"
#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/text/text.hpp"
#include "noveltea/text/text_asset_loader.hpp"
#include "noveltea/tween_service.hpp"
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
#include <unordered_set>
#include <unordered_map>
#include <utility>
#include <vector>

#include <SDL3/SDL.h>

#include <RmlUi/Core.h>
#include <RmlUi/Core/Box.h>
#include <RmlUi/Core/DataModelHandle.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Variant.h>
#include <RmlUi/Lua.h>
#include <sol/sol.hpp>
#include "ui/rmlui/rmlui_document_binder.hpp"
#include "ui/rmlui/rmlui_custom_components.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"
#include "ui/rmlui/rmlui_input_sdl3.hpp"
#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"
#include "ui/rmlui/rmlui_template_resolver.hpp"
#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

namespace noveltea {

namespace {
constexpr const char* kRuntimeUiFontAsset = "project:/rmlui/LiberationSans.ttf";
constexpr const char* kRuntimeUiSystemFontAsset = "system:/fonts/LiberationSans.ttf";
constexpr const char* kRuntimeUiDocumentAsset = "project:/rmlui/demo.rml";
constexpr const char* kRuntimeTitleDocumentId = "runtime_title";
constexpr const char* kRuntimeGameDocumentId = "runtime_game";
constexpr const char* kRuntimePauseMenuDocumentId = "runtime_pause_menu";
constexpr const char* kRuntimeTitleDocumentAsset = "system:/ui/title/default-title.rml";
constexpr const char* kRuntimePauseMenuDocumentAsset = "system:/ui/menu/pause-menu.rml";
constexpr float kActiveTextRevealGlyphsPerSecond = 32.0f;

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

class HeadlessRenderInterface final : public Rml::RenderInterface {
public:
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>,
                                                Rml::Span<const int>) override
    {
        return ++m_next_geometry;
    }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i& texture_dimensions, const Rml::String&) override
    {
        texture_dimensions = {0, 0};
        return 0;
    }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte>, Rml::Vector2i) override
    {
        return ++m_next_texture;
    }
    void ReleaseTexture(Rml::TextureHandle) override {}
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}

private:
    Rml::CompiledGeometryHandle m_next_geometry = 0;
    Rml::TextureHandle m_next_texture = 0;
};

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

float active_text_reveal_duration_seconds(const core::RichTextDocument& document)
{
    return static_cast<float>(
               std::max<std::size_t>(text::utf8_grapheme_count(document.plain_text), 1u)) /
           kActiveTextRevealGlyphsPerSecond;
}

core::RichTextDocument typed_active_text_document(const core::TypedRuntimeUIViewState& state)
{
    return ui::rmlui::make_active_text_snapshot(state).rich_text;
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
    struct CallbackListener final : Rml::EventListener {
        explicit CallbackListener(std::function<void()> cb) : callback(std::move(cb)) {}
        void ProcessEvent(Rml::Event&) override
        {
            if (callback)
                callback();
        }
        std::function<void()> callback;
    };
    void refresh_runtime_document();
    void refresh_active_text_layout();
    void load_runtime_document();
    void add_runtime_input_listener(Rml::ElementDocument& doc);
    void show_game_document();
    bool dispatch_typed_input(const core::RuntimeInputMessage& input, std::size_t depth = 0);
    bool dispatch_layout_typed_input(const core::RuntimeInputMessage& input)
    {
        return (!layout_gameplay_admission || layout_gameplay_admission()) &&
               dispatch_typed_input(input);
    }
    void install_typed_lua_api();
    struct RuntimeInputListener final : Rml::EventListener {
        explicit RuntimeInputListener(State& owner_state) : owner(owner_state) {}
        void ProcessEvent(Rml::Event& event) override;
        State& owner;
    };
    struct ListenerRecord {
        Rml::Element* element = nullptr;
        std::string event;
        std::unique_ptr<CallbackListener> listener;
    };
    Rml::Context* context = nullptr;
    Rml::ElementDocument* demo_document = nullptr;
    SDL_Window* window = nullptr;
    ui::rmlui::AssetRmlFileInterface* file_interface = nullptr;
    ui::rmlui::SdlSystemInterface* system_interface = nullptr;
    Rml::RenderInterface* render_interface = nullptr;
    ui::rmlui::BgfxRenderInterface* bgfx_render_interface = nullptr;
    ui::rmlui::RuntimeUiTemplateResolver* template_resolver = nullptr;
    ui::rmlui::RuntimeUiDocumentBinder* document_binder = nullptr;
    const RuntimeUiAssetResolver* asset_resolver = nullptr;
    ui::rmlui::RuntimeUiComponentRegistry* component_registry = nullptr;
    const assets::AssetManager* assets = nullptr;
    std::unordered_map<std::string, Rml::ElementDocument*> documents;
    std::unordered_map<std::uintptr_t, ListenerRecord> listeners;
    std::unordered_map<std::string, std::unique_ptr<Rml::DataModelConstructor>> data_models;
    std::unique_ptr<RuntimeInputListener> runtime_input_listener;
    script::TypedRuntimeSession* typed_runtime_session = nullptr;
    std::function<bool()> layout_gameplay_admission;
    std::function<void()> game_started_handler;
    TypedRuntimePresentationSink* typed_presentation_sink = nullptr;
    TypedRuntimeAudioSink* typed_audio_sink = nullptr;
    std::optional<core::TypedRuntimeUIViewState> typed_runtime_view;
    core::Diagnostics typed_diagnostics;
    lua_State* lua_state = nullptr;
    std::string typed_notification;
    TweenService* tweens = nullptr;
    std::uintptr_t next_listener_id = 1;
    std::string runtime_document_path;
    ActiveTextPlaybackState active_text_playback;
    ActiveTextPlaybackConfig active_text_playback_config{};
    std::uint64_t active_text_page_instance_id = 0;
    std::size_t active_text_page_index = 0;
    std::size_t active_text_local_page_count = 1;
    float active_text_reveal_progress = 1.0f;
    float active_text_tween_reveal = 1.0f;
    float active_text_tween_alpha = 1.0f;
    bool rml_initialized = false;
    std::unique_ptr<text::TextEngine> active_text_engine;
    std::unique_ptr<text::TextFontAssetLoader> active_text_font_loader;
    FontHandle active_text_font;
    ActiveTextLayout active_text_layout;
    double active_text_time_seconds = 0.0;
    bool active_text_direct_enabled = true;
};

void RuntimeUI::State::load_runtime_document()
{
    if (!context || !template_resolver)
        return;
    const std::string path = template_resolver->resolve_runtime_document();
    if (path.empty()) {
        std::fprintf(stderr, "[runtime_ui] no runtime game document found; runtime UI disabled\n");
        return;
    }
    Rml::ElementDocument* doc = context->LoadDocument(path);
    if (!doc) {
        std::fprintf(stderr, "[runtime_ui] failed to load runtime document: %s\n", path.c_str());
        return;
    }
    runtime_document_path = path;
    documents[kRuntimeGameDocumentId] = doc;
    doc->Hide();
    add_runtime_input_listener(*doc);
    std::printf("[runtime_ui] loaded runtime document: %s\n", path.c_str());
}

void RuntimeUI::State::add_runtime_input_listener(Rml::ElementDocument& doc)
{
    if (!runtime_input_listener) {
        runtime_input_listener = std::make_unique<RuntimeInputListener>(*this);
    }
    doc.AddEventListener("click", runtime_input_listener.get());
}

void RuntimeUI::State::show_game_document()
{
    if (auto title = documents.find(kRuntimeTitleDocumentId); title != documents.end()) {
        title->second->Hide();
    }
    auto game = documents.find(kRuntimeGameDocumentId);
    if (game == documents.end()) {
        load_runtime_document();
        game = documents.find(kRuntimeGameDocumentId);
    }
    if (game != documents.end()) {
        game->second->Show();
        refresh_runtime_document();
    }
}

bool RuntimeUI::State::dispatch_typed_input(const core::RuntimeInputMessage& input,
                                            std::size_t depth)
{
    if (!typed_runtime_session) {
        typed_diagnostics.push_back(core::Diagnostic{
            .code = "runtime_ui.typed_session_unavailable",
            .message = "Typed runtime UI input requires a bound typed runtime session"});
        return false;
    }
    if (depth >= 128) {
        typed_diagnostics.push_back(core::Diagnostic{
            .code = "runtime_ui.output_recursion_limit",
            .message = "Typed runtime UI output processing exceeded its bounded recursion limit"});
        return false;
    }

    const bool outermost = depth == 0;
    if (outermost)
        typed_runtime_session->begin_dispatch_transaction();

    auto result = typed_runtime_session->apply(input);
    core::append_diagnostics(typed_diagnostics, result.diagnostics);
    bool ok = result.disposition != script::RuntimeInputDisposition::Failed;
    for (const auto& output : result.outputs) {
        auto accepted = typed_runtime_session->accept_runtime_output(output);
        if (!accepted.empty()) {
            core::append_diagnostics(typed_diagnostics, std::move(accepted));
            ok = false;
        }
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::RuntimeViewPublication>) {
                    typed_runtime_view = value.view;
                } else if constexpr (std::is_same_v<T, core::PresentationOperation>) {
                    auto fail = [&](core::Diagnostic diagnostic) {
                        const auto operation_number = std::visit(
                            [](const auto& operation) { return operation.id.number(); }, value);
                        diagnostic.runtime_context =
                            std::make_shared<const core::RuntimeDiagnosticContext>(
                                core::RuntimeDiagnosticContext{core::HostOperationRuntimeContext{
                                    core::RuntimeHostOperationKind::Presentation,
                                    operation_number}});
                        typed_diagnostics.push_back(std::move(diagnostic));
                        ok = false;
                    };
                    if (!typed_presentation_sink) {
                        fail(core::Diagnostic{.code = "runtime_ui.presentation_sink_unavailable",
                                              .message = "No typed presentation sink is bound"});
                        if (const auto* transition =
                                std::get_if<core::TransitionPresentationOperation>(&value);
                            transition && transition->owner && transition->completion) {
                            (void)dispatch_typed_input(
                                core::RuntimeInputMessage{core::CancelPresentationInput{
                                    transition->id, *transition->owner, *transition->completion}},
                                depth + 1);
                        } else {
                            core::append_diagnostics(
                                typed_diagnostics,
                                typed_runtime_session->commit_transient_operation(std::visit(
                                    [](const auto& operation) -> core::PresentationOperationRef {
                                        return operation.id;
                                    },
                                    value)));
                        }
                    } else {
                        auto applied = typed_presentation_sink->apply(value);
                        if (!applied) {
                            fail(applied.error());
                            if (const auto* transition =
                                    std::get_if<core::TransitionPresentationOperation>(&value);
                                transition && transition->owner && transition->completion) {
                                (void)dispatch_typed_input(
                                    core::RuntimeInputMessage{core::CancelPresentationInput{
                                        transition->id, *transition->owner,
                                        *transition->completion}},
                                    depth + 1);
                            } else {
                                core::append_diagnostics(
                                    typed_diagnostics,
                                    typed_runtime_session->commit_transient_operation(std::visit(
                                        [](const auto& operation)
                                            -> core::PresentationOperationRef {
                                            return operation.id;
                                        },
                                        value)));
                            }
                        } else if (*applied.value_if() ==
                                   TypedRuntimeOperationDisposition::Completed) {
                            if (const auto* transition =
                                    std::get_if<core::TransitionPresentationOperation>(&value);
                                transition && transition->owner && transition->completion) {
                                ok = dispatch_typed_input(
                                         core::RuntimeInputMessage{core::CompletePresentationInput{
                                             transition->id, *transition->owner,
                                             *transition->completion}},
                                         depth + 1) &&
                                     ok;
                            } else {
                                core::append_diagnostics(
                                    typed_diagnostics,
                                    typed_runtime_session->commit_transient_operation(std::visit(
                                        [](const auto& operation)
                                            -> core::PresentationOperationRef {
                                            return operation.id;
                                        },
                                        value)));
                            }
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::AudioOperation>) {
                    auto fail = [&](core::Diagnostic diagnostic) {
                        diagnostic.runtime_context =
                            std::make_shared<const core::RuntimeDiagnosticContext>(
                                core::RuntimeDiagnosticContext{core::HostOperationRuntimeContext{
                                    core::RuntimeHostOperationKind::Audio, value.id.number()}});
                        typed_diagnostics.push_back(std::move(diagnostic));
                        ok = false;
                    };
                    if (!typed_audio_sink) {
                        fail(core::Diagnostic{.code = "runtime_ui.audio_sink_unavailable",
                                              .message = "No typed audio sink is bound"});
                        if (value.owner && value.completion)
                            (void)dispatch_typed_input(
                                core::RuntimeInputMessage{core::CancelAudioInput{
                                    value.id, *value.owner, *value.completion}},
                                depth + 1);
                        else
                            core::append_diagnostics(
                                typed_diagnostics,
                                typed_runtime_session->commit_transient_operation(value.id));
                    } else {
                        auto applied = typed_audio_sink->apply(value);
                        if (!applied) {
                            fail(applied.error());
                            if (value.owner && value.completion)
                                (void)dispatch_typed_input(
                                    core::RuntimeInputMessage{core::CancelAudioInput{
                                        value.id, *value.owner, *value.completion}},
                                    depth + 1);
                            else
                                core::append_diagnostics(
                                    typed_diagnostics,
                                    typed_runtime_session->commit_transient_operation(value.id));
                        } else if (*applied.value_if() ==
                                       TypedRuntimeOperationDisposition::Completed &&
                                   value.owner && value.completion) {
                            ok = dispatch_typed_input(
                                     core::RuntimeInputMessage{core::CompleteAudioInput{
                                         value.id, *value.owner, *value.completion}},
                                     depth + 1) &&
                                 ok;
                        } else if (*applied.value_if() ==
                                   TypedRuntimeOperationDisposition::Completed) {
                            core::append_diagnostics(
                                typed_diagnostics,
                                typed_runtime_session->commit_transient_operation(value.id));
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::TypedHostRequest>) {
                    const auto request_id = std::visit(
                        [&](const auto& request) {
                            using Request = std::decay_t<decltype(request)>;
                            if constexpr (std::is_same_v<Request, core::NotificationHostRequest>)
                                typed_notification = request.message;
                            return request.id;
                        },
                        value);
                    ok = dispatch_typed_input(
                             core::RuntimeInputMessage{
                                 core::AcknowledgeHostRequestInput{request_id}},
                             depth + 1) &&
                         ok;
                } else if constexpr (std::is_same_v<T, core::UserCommunicationOutput>) {
                    std::visit(
                        [&](const auto& communication) {
                            using Communication = std::decay_t<decltype(communication)>;
                            if constexpr (std::is_same_v<Communication, core::NotificationOutput>)
                                typed_notification = communication.message;
                        },
                        value);
                } else if constexpr (std::is_same_v<T, core::Diagnostic>) {
                    // The result-level diagnostics above are canonical; do not duplicate them.
                } else if constexpr (std::is_same_v<T, core::SaveOutcome> ||
                                     std::is_same_v<T, core::RuntimeObservation>) {
                    // These outputs have no runtime-UI side effect in Phase 9C.
                } else {
                    static_assert(sizeof(T) == 0, "Unhandled typed runtime output");
                }
            },
            output);
    }
    refresh_runtime_document();
    refresh_active_text_layout();
    const bool active_text_causal =
        typed_runtime_view && !typed_active_text_document(*typed_runtime_view).plain_text.empty() &&
        active_text_playback.phase != ActiveTextPlaybackPhase::AwaitingContinue &&
        active_text_playback.phase != ActiveTextPlaybackPhase::Complete;
    auto active_text_status =
        typed_runtime_session->update_active_text_checkpoint_status(active_text_causal);
    if (!active_text_status.empty()) {
        core::append_diagnostics(typed_diagnostics, std::move(active_text_status));
        ok = false;
    }
    if (outermost) {
        auto settled = typed_runtime_session->settle_dispatch_transaction();
        if (!settled.empty()) {
            core::append_diagnostics(typed_diagnostics, std::move(settled));
            ok = false;
        }
    }
    return ok;
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
        const bool started =
            dispatch_typed_input(core::RuntimeInputMessage{core::StartRuntimeInput{}});
        if (started) {
            if (game_started_handler)
                game_started_handler();
            else
                show_game_document();
        }
        return started;
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
                            return placement.interactable == *id.value_if() && placement.visible &&
                                   placement.enabled;
                        });
        const auto available_in_inventory = std::any_of(
            typed_runtime_view->inventory.items.begin(), typed_runtime_view->inventory.items.end(),
            [&](const auto& item) {
                return item.interactable == *id.value_if() && item.visible && item.enabled;
            });
        if (!available_in_room && !available_in_inventory)
            return invalid("runtime_ui.invalid_interactable",
                           "Interactable is stale, unknown, hidden, or disabled");
        auto selection = typed_runtime_view->selected_interactables;
        const auto selected = std::find(selection.begin(), selection.end(), *id.value_if());
        if (selected == selection.end())
            selection.push_back(*id.value_if());
        else
            selection.erase(selected);
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::SelectInteractablesInput{std::move(selection)}});
    });
    ui.set_function("clear_selection", [this]() {
        return dispatch_layout_typed_input(
            core::RuntimeInputMessage{core::ClearInteractableSelectionInput{}});
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
}

void RuntimeUI::State::refresh_runtime_document()
{
    auto doc_it = documents.find(kRuntimeGameDocumentId);
    auto* doc = doc_it == documents.end() ? nullptr : doc_it->second;
    if (!doc || !document_binder)
        return;
    if (typed_runtime_view)
        document_binder->bind(*doc, *typed_runtime_view, asset_resolver, typed_notification);
}

void RuntimeUI::State::refresh_active_text_layout()
{
    auto doc_it = documents.find(kRuntimeGameDocumentId);
    auto* doc = doc_it == documents.end() ? nullptr : doc_it->second;
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

    if (owner.typed_runtime_session && find_ancestor_tag(target, "nt-active-text")) {
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
                std::any_of(owner.typed_runtime_view->room->placements.begin(),
                            owner.typed_runtime_view->room->placements.end(),
                            [&](const auto& placement) {
                                return placement.interactable == *interactable.value_if() &&
                                       placement.visible && placement.enabled;
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
            (void)owner.dispatch_layout_typed_input(core::RuntimeInputMessage{
                core::SelectInteractablesInput{{*interactable.value_if()}}});
        } else if (owner.active_text_playback.can_skip_reveal) {
            owner.active_text_playback = skip_active_text_reveal(owner.active_text_playback);
            owner.active_text_tween_reveal = 1.0f;
            if (owner.tweens)
                owner.tweens->kill_channel("active-text-reveal");
            owner.active_text_reveal_progress = owner.active_text_playback.reveal_progress;
            owner.refresh_runtime_document();
            owner.refresh_active_text_layout();
        } else if (owner.active_text_playback.can_continue) {
            if (owner.active_text_page_index + 1u < owner.active_text_local_page_count) {
                ++owner.active_text_page_index;
                owner.active_text_playback = {};
                owner.active_text_reveal_progress = 0.0f;
                owner.active_text_tween_reveal = 0.0f;
                owner.active_text_tween_alpha = 0.0f;
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
    m_pointer_inside = false;
    m_active_touches.clear();
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
    if (m_state->context) {
        m_state->context->UnloadAllDocuments();
        Rml::RemoveContext("main");
        m_state->context = nullptr;
    }
    m_state->documents.clear();
    m_state->listeners.clear();
    m_state->data_models.clear();
    delete m_state->template_resolver;
    m_state->template_resolver = nullptr;
    delete m_state->document_binder;
    m_state->document_binder = nullptr;
    if (m_state->rml_initialized) {
        Rml::Shutdown();
        m_state->rml_initialized = false;
    }
    delete m_state->component_registry;
    m_state->component_registry = nullptr;
    delete m_state->render_interface;
    m_state->render_interface = nullptr;
    m_state->bgfx_render_interface = nullptr;
    Rml::SetSystemInterface(nullptr);
    Rml::SetFileInterface(nullptr);
    delete m_state->system_interface;
    m_state->system_interface = nullptr;
    delete m_state->file_interface;
    m_state->file_interface = nullptr;
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

    m_state = new State;
    m_state->window = window;
    m_state->assets = assets;
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
    m_state->file_interface = new ui::rmlui::AssetRmlFileInterface(*assets);
    m_state->system_interface = new ui::rmlui::SdlSystemInterface(window);
    m_state->template_resolver = new ui::rmlui::RuntimeUiTemplateResolver(*assets);
    m_state->document_binder = new ui::rmlui::RuntimeUiDocumentBinder;
    Rml::SetFileInterface(m_state->file_interface);
    Rml::SetSystemInterface(m_state->system_interface);

    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::Initialise() failed\n");
        delete m_state->document_binder;
        delete m_state->template_resolver;
        delete m_state->system_interface;
        delete m_state->file_interface;
        delete m_state;
        m_state = nullptr;
        return false;
    }
    m_state->rml_initialized = true;
    m_state->component_registry = new ui::rmlui::RuntimeUiComponentRegistry;

    if (!scripts || !scripts->is_initialized() ||
        !script::detail::ScriptRuntimeAccess::state(*scripts)) {
        std::fprintf(stderr, "[runtime_ui] RmlUi Lua requested but ScriptRuntime is unavailable\n");
        cleanup_state();
        return false;
    }
    Rml::Lua::Initialise(script::detail::ScriptRuntimeAccess::state(*scripts));
    script::install_host_print(script::detail::ScriptRuntimeAccess::state(*scripts));
    m_state->lua_state = script::detail::ScriptRuntimeAccess::state(*scripts);

    m_surface = sanitize_surface_metrics(m_surface);
    if (headless_render) {
        m_state->render_interface = new HeadlessRenderInterface;
    } else {
        m_state->bgfx_render_interface =
            new ui::rmlui::BgfxRenderInterface(m_presentation, *assets, shader_materials);
        m_state->render_interface = m_state->bgfx_render_interface;
    }
    if (m_state->bgfx_render_interface && !*m_state->bgfx_render_interface) {
        std::fprintf(stderr, "[runtime_ui] bgfx RmlUi renderer failed to initialize\n");
        cleanup_state();
        return false;
    }

    m_state->context =
        Rml::CreateContext("main", Rml::Vector2i(m_surface.logical_width, m_surface.logical_height),
                           m_state->render_interface);
    if (!m_state->context) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::CreateContext failed\n");
        cleanup_state();
        return false;
    }
    m_state->context->SetDensityIndependentPixelRatio(m_surface.scale_x);

    if (!Rml::LoadFontFace(kRuntimeUiFontAsset, true)) {
        std::fprintf(stderr, "[runtime_ui] failed to load font: %s\n", kRuntimeUiFontAsset);
        if (!Rml::LoadFontFace(kRuntimeUiSystemFontAsset, true)) {
            std::fprintf(stderr, "[runtime_ui] (optional) failed to load font: %s\n",
                         kRuntimeUiSystemFontAsset);
        }
    }

    if (load_demo_document) {
        m_state->demo_document = m_state->context->LoadDocument(kRuntimeUiDocumentAsset);
        if (m_state->demo_document) {
            m_state->documents["demo"] = m_state->demo_document;
            m_state->demo_document->Show();
            std::printf("[runtime_ui] demo document loaded\n");
        } else {
            std::fprintf(stderr, "[runtime_ui] failed to load demo document\n");
        }
    }

    std::printf("[runtime_ui] RmlUi initialized logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
                m_surface.logical_width, m_surface.logical_height, m_surface.framebuffer_width,
                m_surface.framebuffer_height, m_surface.scale_x, m_surface.scale_y);

    m_initialized = true;
    return true;
}

void RuntimeUI::enable_render_perf_logging(bool enabled)
{
    if (m_state) {
        if (auto* render = m_state->bgfx_render_interface) {
            render->set_perf_logging_enabled(enabled);
        }
    }
}

void RuntimeUI::set_rmlui_base_direct_compatibility(bool enabled)
{
    if (m_state) {
        if (auto* render = m_state->bgfx_render_interface) {
            render->set_base_direct_compatibility(enabled);
        }
    }
}

bool RuntimeUI::process_event(const SDL_Event& event, const PresentationMetrics& presentation)
{
    m_last_event_consumed = false;
    if (!m_state || !m_state->context) {
        return false;
    }

    SDL_Event transformed = event;
    const auto transform_pointer = [&](float x, float y) -> std::optional<Vec2> {
        return host_to_game_logical({x, y}, presentation);
    };
    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION: {
        const auto point = transform_pointer(event.motion.x, event.motion.y);
        if (!point) {
            if (m_pointer_inside) {
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                return ui::rmlui::process_sdl_event(*m_state->context, m_state->window, leave);
            }
            return false;
        }
        m_pointer_inside = true;
        transformed.motion.x = point->x;
        transformed.motion.y = point->y;
        break;
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        const auto point = transform_pointer(event.button.x, event.button.y);
        if (!point) {
            if (event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
                const bool release_consumed =
                    ui::rmlui::process_sdl_event(*m_state->context, m_state->window, transformed);
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                const bool leave_consumed =
                    ui::rmlui::process_sdl_event(*m_state->context, m_state->window, leave);
                m_last_event_consumed = release_consumed || leave_consumed;
                return m_last_event_consumed;
            }
            return false;
        }
        m_pointer_inside = true;
        transformed.button.x = point->x;
        transformed.button.y = point->y;
        break;
    }
    case SDL_EVENT_MOUSE_WHEEL: {
        const auto point = transform_pointer(event.wheel.mouse_x, event.wheel.mouse_y);
        if (!point) {
            if (m_pointer_inside) {
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                m_last_event_consumed =
                    ui::rmlui::process_sdl_event(*m_state->context, m_state->window, leave);
                return m_last_event_consumed;
            }
            return false;
        }
        m_pointer_inside = true;
        break;
    }
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED: {
        const std::uint64_t touch_id = static_cast<std::uint64_t>(event.tfinger.fingerID);
        const SurfaceMetrics& host = presentation.host_surface;
        const auto point = transform_pointer(event.tfinger.x * host.logical_width,
                                             event.tfinger.y * host.logical_height);
        if (!point) {
            if (event.type != SDL_EVENT_FINGER_DOWN && m_active_touches.erase(touch_id) > 0) {
                transformed.type = SDL_EVENT_FINGER_CANCELED;
                transformed.tfinger.x = 0.0f;
                transformed.tfinger.y = 0.0f;
                break;
            }
            return false;
        }
        if (event.type == SDL_EVENT_FINGER_DOWN) {
            m_active_touches.insert(touch_id);
        } else if (!m_active_touches.contains(touch_id)) {
            return false;
        } else if (event.type == SDL_EVENT_FINGER_UP || event.type == SDL_EVENT_FINGER_CANCELED) {
            m_active_touches.erase(touch_id);
        }
        transformed.tfinger.x = point->x / presentation.game_surface.logical_width;
        transformed.tfinger.y = point->y / presentation.game_surface.logical_height;
        break;
    }
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        m_pointer_inside = false;
        break;
    default:
        break;
    }

    m_last_event_consumed =
        ui::rmlui::process_sdl_event(*m_state->context, m_state->window, transformed);
    return m_last_event_consumed;
}

void RuntimeUI::resize(const PresentationMetrics& presentation)
{
    if (m_state && m_state->context) {
        if (m_pointer_inside) {
            SDL_Event leave{};
            leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
            (void)ui::rmlui::process_sdl_event(*m_state->context, m_state->window, leave);
        }
        for (const std::uint64_t touch_id : m_active_touches) {
            SDL_Event cancel{};
            cancel.type = SDL_EVENT_FINGER_CANCELED;
            cancel.tfinger.fingerID = touch_id;
            (void)ui::rmlui::process_sdl_event(*m_state->context, m_state->window, cancel);
        }
    }
    m_pointer_inside = false;
    m_active_touches.clear();

    m_surface = sanitize_surface_metrics(presentation.game_surface);
    m_presentation = presentation;
    if (m_state && m_state->context) {
        m_state->context->SetDimensions(
            Rml::Vector2i(m_surface.logical_width, m_surface.logical_height));
        m_state->context->SetDensityIndependentPixelRatio(m_surface.scale_x);
        if (auto* render = m_state->bgfx_render_interface) {
            render->resize(presentation);
        }
    }
}

void RuntimeUI::begin_frame(float delta_time)
{
    if (m_state && m_state->context) {
        if (auto* render = m_state->bgfx_render_interface) {
            render->begin_frame();
        }
        const auto typed_document = m_state->typed_runtime_view
                                        ? typed_active_text_document(*m_state->typed_runtime_view)
                                        : core::RichTextDocument{};
        const auto& active_document = typed_document;
        const auto previous_instance = m_state->active_text_playback.instance_id;
        const auto previous_phase = m_state->active_text_playback.phase;
        const float playback_delta = m_state->tweens ? 0.0f : delta_time;
        const auto playback_input =
            m_state->typed_runtime_view
                ? active_text_playback_input(*m_state->typed_runtime_view,
                                             m_state->active_text_page_index, playback_delta)
                : ActiveTextPlaybackInput{};
        m_state->active_text_playback = update_active_text_playback(
            m_state->active_text_playback, playback_input, m_state->active_text_playback_config);
        if (m_state->typed_runtime_session) {
            const bool was_causal = !active_document.plain_text.empty() &&
                                    previous_phase != ActiveTextPlaybackPhase::AwaitingContinue &&
                                    previous_phase != ActiveTextPlaybackPhase::Complete;
            const bool causal =
                !active_document.plain_text.empty() &&
                m_state->active_text_playback.phase != ActiveTextPlaybackPhase::AwaitingContinue &&
                m_state->active_text_playback.phase != ActiveTextPlaybackPhase::Complete;
            if (causal != was_causal) {
                m_state->typed_runtime_session->begin_dispatch_transaction();
                core::append_diagnostics(
                    m_state->typed_diagnostics,
                    m_state->typed_runtime_session->update_active_text_checkpoint_status(causal));
                core::append_diagnostics(
                    m_state->typed_diagnostics,
                    m_state->typed_runtime_session->settle_dispatch_transaction());
            }
        }
        if (m_state->tweens) {
            if (m_state->active_text_playback.instance_id != previous_instance) {
                m_state->active_text_tween_reveal = 0.0f;
                m_state->active_text_tween_alpha = 0.0f;
                m_state->tweens->tween_float(
                    "runtime-ui", "active-text-reveal", m_state->active_text_tween_reveal, 0.0f,
                    1.0f,
                    active_text_reveal_duration_seconds(active_text_document_page(
                        active_document, m_state->active_text_page_index)));
                m_state->tweens->tween_float("runtime-ui", "active-text-alpha",
                                             m_state->active_text_tween_alpha, 0.0f, 1.0f,
                                             m_state->active_text_playback_config.show_seconds);
            } else if (m_state->active_text_playback.phase ==
                           ActiveTextPlaybackPhase::Disappearing &&
                       previous_phase != ActiveTextPlaybackPhase::Disappearing) {
                m_state->tweens->tween_float("runtime-ui", "active-text-alpha",
                                             m_state->active_text_tween_alpha,
                                             m_state->active_text_playback.alpha, 0.0f,
                                             m_state->active_text_playback_config.hide_seconds);
            }
            if (!active_document.plain_text.empty()) {
                m_state->active_text_playback.reveal_progress = m_state->active_text_tween_reveal;
            }
            m_state->active_text_playback.alpha = m_state->active_text_tween_alpha;
            const bool reveal_complete = m_state->active_text_playback.reveal_progress >= 1.0f;
            const bool waiting = m_state->active_text_playback.wait_for_click ||
                                 m_state->active_text_playback.page_break;
            m_state->active_text_playback.can_skip_reveal = !reveal_complete;
            m_state->active_text_playback.can_continue = reveal_complete && waiting;
            m_state->active_text_playback.prompt_visible =
                m_state->active_text_playback.can_continue &&
                m_state->active_text_playback.alpha > 0.0f;
        }
        m_state->active_text_reveal_progress = m_state->active_text_playback.reveal_progress;
        if (m_state->active_text_playback.instance_id != previous_instance) {
            m_state->active_text_time_seconds = 0.0;
        } else if (delta_time > 0.0f) {
            m_state->active_text_time_seconds += static_cast<double>(delta_time);
        }
        m_state->refresh_runtime_document();
        m_state->context->Update();
        m_state->refresh_active_text_layout();
    }
}

void RuntimeUI::end_frame()
{
    if (m_state && m_state->context) {
        m_state->context->Render();
        if (auto* render = m_state->bgfx_render_interface) {
            render->end_frame();
        }
    }
}

void RuntimeUI::shutdown()
{
    if (!m_initialized)
        return;
    if (m_state) {
        if (m_state->typed_presentation_sink)
            m_state->typed_presentation_sink->reset(
                core::PresentationCancellationReason::OwnerEnded);
        if (m_state->typed_audio_sink)
            m_state->typed_audio_sink->reset(core::PresentationCancellationReason::OwnerEnded);
        if (m_state->typed_runtime_session)
            m_state->typed_runtime_session->bind_transient_reset_handler({});
        m_state->typed_runtime_session = nullptr;
        cleanup_state();
    }
    m_initialized = false;
}

bool RuntimeUI::load_document(const std::string& id, const std::string& path, bool show)
{
    if (!m_state || !m_state->context || id.empty())
        return false;
    unload_document(id);
    Rml::ElementDocument* doc = m_state->context->LoadDocument(path);
    if (!doc)
        return false;
    m_state->documents[id] = doc;
    if (show)
        doc->Show();
    return true;
}

bool RuntimeUI::load_document_from_memory(const std::string& id, const std::string& rml,
                                          const std::string& source_url, bool show)
{
    if (!m_state || !m_state->context || id.empty() || rml.empty())
        return false;
    Rml::ElementDocument* doc = m_state->context->LoadDocumentFromMemory(rml, source_url);
    if (!doc)
        return false;
    Rml::ElementDocument* old_doc = nullptr;
    if (const auto old = m_state->documents.find(id); old != m_state->documents.end())
        old_doc = old->second;
    m_state->documents[id] = doc;
    if (show)
        doc->Show();
    if (old_doc && old_doc != doc) {
        if (old_doc->IsVisible())
            old_doc->Hide();
        for (auto listener = m_state->listeners.begin(); listener != m_state->listeners.end();) {
            if (listener->second.element &&
                listener->second.element->GetOwnerDocument() == old_doc) {
                listener->second.element->RemoveEventListener(listener->second.event,
                                                              listener->second.listener.get());
                listener = m_state->listeners.erase(listener);
            } else {
                ++listener;
            }
        }
        old_doc->Close();
        if (old_doc == m_state->demo_document)
            m_state->demo_document = nullptr;
    }
    return true;
}

void RuntimeUI::set_preview_virtual_file(std::string path, std::string contents)
{
    if (!m_state || !m_state->file_interface)
        return;
    m_state->file_interface->set_virtual_file(std::move(path), std::move(contents));
}

void RuntimeUI::clear_preview_virtual_files()
{
    if (!m_state || !m_state->file_interface)
        return;
    m_state->file_interface->clear_virtual_files();
}

bool RuntimeUI::unload_document(const std::string& id)
{
    if (!m_state || id.empty())
        return false;
    auto it = m_state->documents.find(id);
    if (it == m_state->documents.end())
        return false;

    if ((id == kRuntimeGameDocumentId || id == kRuntimeTitleDocumentId ||
         id == kRuntimePauseMenuDocumentId) &&
        m_state->runtime_input_listener) {
        it->second->RemoveEventListener("click", m_state->runtime_input_listener.get());
    }

    for (auto listener = m_state->listeners.begin(); listener != m_state->listeners.end();) {
        if (listener->second.element &&
            listener->second.element->GetOwnerDocument() == it->second) {
            listener->second.element->RemoveEventListener(listener->second.event,
                                                          listener->second.listener.get());
            listener = m_state->listeners.erase(listener);
        } else {
            ++listener;
        }
    }
    it->second->Close();
    if (it->second == m_state->demo_document)
        m_state->demo_document = nullptr;
    m_state->documents.erase(it);
    return true;
}

bool RuntimeUI::show_document(const std::string& id)
{
    if (auto* doc = static_cast<Rml::ElementDocument*>(document(id))) {
        doc->Show();
        return true;
    }
    return false;
}

bool RuntimeUI::hide_document(const std::string& id)
{
    if (auto* doc = static_cast<Rml::ElementDocument*>(document(id))) {
        doc->Hide();
        return true;
    }
    return false;
}

bool RuntimeUI::load_title_document()
{
    if (!m_state || !m_state->context)
        return false;
    unload_document(kRuntimeTitleDocumentId);
    Rml::ElementDocument* doc = m_state->context->LoadDocument(kRuntimeTitleDocumentAsset);
    if (!doc) {
        std::fprintf(stderr, "[runtime_ui] failed to load title document: %s\n",
                     kRuntimeTitleDocumentAsset);
        return false;
    }
    m_state->documents[kRuntimeTitleDocumentId] = doc;
    m_state->add_runtime_input_listener(*doc);
    doc->Show();
    std::printf("[runtime_ui] loaded title document: %s\n", kRuntimeTitleDocumentAsset);
    return true;
}

void RuntimeUI::bind_title_document(const std::string& project_title, const std::string& subtitle,
                                    const std::string& start_label)
{
    auto* doc = static_cast<Rml::ElementDocument*>(document(kRuntimeTitleDocumentId));
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
    if (!m_state || !m_state->context)
        return false;
    unload_document(kRuntimeGameDocumentId);
    m_state->load_runtime_document();
    if (auto* doc = static_cast<Rml::ElementDocument*>(document(kRuntimeGameDocumentId))) {
        doc->Show();
        m_state->refresh_runtime_document();
        return true;
    }
    return false;
}

bool RuntimeUI::load_pause_menu_document()
{
    if (!m_state || !m_state->context)
        return false;
    unload_document(kRuntimePauseMenuDocumentId);
    Rml::ElementDocument* doc = m_state->context->LoadDocument(kRuntimePauseMenuDocumentAsset);
    if (!doc) {
        std::fprintf(stderr, "[runtime_ui] failed to load pause menu document: %s\n",
                     kRuntimePauseMenuDocumentAsset);
        return false;
    }
    m_state->documents[kRuntimePauseMenuDocumentId] = doc;
    m_state->add_runtime_input_listener(*doc);
    doc->Show();
    std::printf("[runtime_ui] loaded pause menu document: %s\n", kRuntimePauseMenuDocumentAsset);
    return true;
}

void* RuntimeUI::document(const std::string& id) const
{
    if (!m_state)
        return nullptr;
    auto it = m_state->documents.find(id);
    return it == m_state->documents.end() ? nullptr : it->second;
}

void* RuntimeUI::element(const std::string& document_id, const std::string& element_id) const
{
    auto* doc = static_cast<Rml::ElementDocument*>(document(document_id));
    return doc ? doc->GetElementById(element_id) : nullptr;
}

bool RuntimeUI::reload_documents_and_styles()
{
    if (!m_state || !m_state->context)
        return false;

    const bool had_title_doc =
        m_state->documents.find(kRuntimeTitleDocumentId) != m_state->documents.end();
    const bool had_runtime_doc =
        m_state->documents.find(kRuntimeGameDocumentId) != m_state->documents.end();
    const bool had_pause_menu_doc =
        m_state->documents.find(kRuntimePauseMenuDocumentId) != m_state->documents.end();
    const bool had_demo_doc = m_state->demo_document != nullptr;

    m_state->runtime_input_listener.reset();
    m_state->listeners.clear();
    m_state->context->UnloadAllDocuments();
    m_state->documents.clear();
    m_state->demo_document = nullptr;
    m_state->runtime_document_path.clear();

    bool ok = true;
    if (had_demo_doc) {
        m_state->demo_document = m_state->context->LoadDocument(kRuntimeUiDocumentAsset);
        if (m_state->demo_document) {
            m_state->documents["demo"] = m_state->demo_document;
            m_state->demo_document->Show();
        } else {
            std::fprintf(stderr, "[runtime_ui] failed to reload demo document\n");
            ok = false;
        }
    }

    if (had_runtime_doc) {
        m_state->load_runtime_document();
        show_document(kRuntimeGameDocumentId);
    }
    if (had_title_doc) {
        ok = load_title_document() && ok;
    }
    if (had_pause_menu_doc) {
        ok = load_pause_menu_document() && ok;
    }

    return ok;
}

void RuntimeUI::set_density(float density)
{
    if (m_state && m_state->context) {
        m_state->context->SetDensityIndependentPixelRatio(density);
    }
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

void RuntimeUI::bind_typed_runtime_session(script::TypedRuntimeSession* session)
{
    if (!m_state)
        return;
    if (m_state->typed_runtime_session && m_state->typed_runtime_session != session)
        m_state->typed_runtime_session->bind_transient_reset_handler({});
    m_state->typed_runtime_session = session;
    if (session) {
        session->bind_transient_reset_handler(
            [state = m_state](core::PresentationCancellationReason reason) {
                if (state->typed_presentation_sink)
                    state->typed_presentation_sink->reset(reason);
                if (state->typed_audio_sink)
                    state->typed_audio_sink->reset(reason);
            });
    }
    m_state->typed_runtime_view.reset();
    m_state->typed_notification.clear();
    m_state->typed_diagnostics.clear();
    if (session)
        m_state->install_typed_lua_api();
    else if (m_state->lua_state) {
        sol::state_view lua(m_state->lua_state);
        const sol::object game_object = lua["Game"];
        if (game_object.valid() && game_object.get_type() == sol::type::table)
            game_object.as<sol::table>()["ui"] = sol::lua_nil;
    }
    m_state->refresh_runtime_document();
}

void RuntimeUI::bind_asset_resolver(const RuntimeUiAssetResolver* resolver)
{
    if (!m_state)
        return;
    m_state->asset_resolver = resolver;
    m_state->refresh_runtime_document();
}

void RuntimeUI::bind_typed_presentation_sink(TypedRuntimePresentationSink* sink)
{
    if (m_state)
        m_state->typed_presentation_sink = sink;
}

void RuntimeUI::bind_typed_audio_sink(TypedRuntimeAudioSink* sink)
{
    if (m_state)
        m_state->typed_audio_sink = sink;
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

const core::TypedRuntimeUIViewState* RuntimeUI::typed_runtime_view_state() const noexcept
{
    return m_state && m_state->typed_runtime_view ? &*m_state->typed_runtime_view : nullptr;
}

const core::Diagnostics& RuntimeUI::typed_runtime_diagnostics() const noexcept
{
    if (m_state)
        return m_state->typed_diagnostics;
    static const core::Diagnostics empty;
    return empty;
}

void RuntimeUI::bind_tween_service(TweenService* tweens)
{
    if (m_state) {
        m_state->tweens = tweens;
        if (!tweens) {
            m_state->active_text_reveal_progress = 1.0f;
        }
    }
}

std::uintptr_t RuntimeUI::add_event_listener(const std::string& document_id,
                                             const std::string& element_id,
                                             const std::string& event,
                                             std::function<void()> callback)
{
    if (!m_state || event.empty() || !callback)
        return 0;
    Rml::Element* target = nullptr;
    if (element_id.empty()) {
        target = static_cast<Rml::ElementDocument*>(document(document_id));
    } else {
        target = static_cast<Rml::Element*>(element(document_id, element_id));
    }
    if (!target)
        return 0;
    auto listener = std::make_unique<State::CallbackListener>(std::move(callback));
    const std::uintptr_t id = m_state->next_listener_id++;
    target->AddEventListener(event, listener.get());
    m_state->listeners.emplace(id, State::ListenerRecord{target, event, std::move(listener)});
    return id;
}

bool RuntimeUI::remove_event_listener(std::uintptr_t listener_id)
{
    if (!m_state)
        return false;
    auto it = m_state->listeners.find(listener_id);
    if (it == m_state->listeners.end())
        return false;
    if (it->second.element) {
        it->second.element->RemoveEventListener(it->second.event, it->second.listener.get());
    }
    m_state->listeners.erase(it);
    return true;
}

RuntimeUiPlaybackClickResult RuntimeUI::playback_click(const RuntimeUiPlaybackClickRequest& request)
{
    if (!m_state || !m_state->context) {
        return make_click_result(RuntimeUiPlaybackClickStatus::UiNotInitialized, request,
                                 "runtime UI is not initialized");
    }

    auto* doc = static_cast<Rml::ElementDocument*>(document(request.document_id));
    if (!doc) {
        return make_click_result(RuntimeUiPlaybackClickStatus::DocumentNotFound, request,
                                 "document is not loaded: " + request.document_id);
    }
    if (!doc->IsVisible()) {
        return make_click_result(RuntimeUiPlaybackClickStatus::DocumentHidden, request,
                                 "document is hidden: " + request.document_id);
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

    Rml::Element* hit = m_state->context->GetElementAtPoint({result.x, result.y});
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

    bool has_click_listener = has_runtime_activation_behavior(*target);
    for (const auto& [id, record] : m_state->listeners) {
        (void)id;
        if (record.element == target && record.event == "click") {
            has_click_listener = true;
            break;
        }
    }
    if (!has_click_listener) {
        result.status = RuntimeUiPlaybackClickStatus::TargetNotInteractive;
        result.message = "target has no onclick or bound click listener: " + request.selector;
        return result;
    }

    const int x = static_cast<int>(std::lround(result.x));
    const int y = static_cast<int>(std::lround(result.y));
    m_state->context->ProcessMouseMove(x, y, 0);
    m_state->context->ProcessMouseButtonDown(0, 0);
    m_state->context->ProcessMouseButtonUp(0, 0);
    result.dispatched = true;
    result.message = "dispatched ui-click";
    return result;
}

void* RuntimeUI::create_data_model(const std::string& name)
{
    if (!m_state || !m_state->context || name.empty())
        return nullptr;
    auto model =
        std::make_unique<Rml::DataModelConstructor>(m_state->context->CreateDataModel(name));
    void* result = model.get();
    m_state->data_models[name] = std::move(model);
    return result;
}

void* RuntimeUI::data_model(const std::string& name) const
{
    if (!m_state)
        return nullptr;
    auto it = m_state->data_models.find(name);
    return it == m_state->data_models.end() ? nullptr : it->second.get();
}

bool RuntimeUI::remove_data_model(const std::string& name)
{
    if (!m_state || !m_state->context)
        return false;
    const bool removed = m_state->context->RemoveDataModel(name);
    m_state->data_models.erase(name);
    return removed;
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
    return (m_state && m_state->context) ? "rendering" : "no context";
}

bool RuntimeUI::wants_input() const { return wants_pointer_input() || wants_keyboard_input(); }

bool RuntimeUI::wants_pointer_input() const
{
    return m_state && m_state->context && m_state->context->IsMouseInteracting();
}

bool RuntimeUI::wants_keyboard_input() const
{
    return m_state && m_state->context && m_state->context->GetFocusElement();
}

} // namespace noveltea
