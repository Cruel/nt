#include "noveltea/ui_runtime.hpp"

#include "noveltea/active_text_playback.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/text/text.hpp"
#include "noveltea/text/text_asset_loader.hpp"
#include "noveltea/tween_service.hpp"
#include "script/lua/script_runtime_internal.hpp"
#include "text/text_breaks.hpp"
#include "text/text_engine.hpp"

#include <algorithm>
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
constexpr const char* kRuntimeTitleDocumentAsset = "system:/ui/title/default-title.rml";
constexpr float kActiveTextRevealGlyphsPerSecond = 32.0f;

void validate_visual_asset(const assets::AssetManager& assets, core::RuntimeUIViewState& state,
                           const std::string& path, std::unordered_set<std::string>& logged)
{
    if (path.empty() || assets.exists(path)) {
        return;
    }
    core::RuntimeUIAssetDiagnostic diagnostic;
    diagnostic.asset_path = path;
    diagnostic.message = "missing visual asset: " + path;
    state.asset_diagnostics.push_back(diagnostic);
    if (logged.insert(path).second) {
        std::fprintf(stderr, "[runtime_ui] %s\n", diagnostic.message.c_str());
    }
}

core::RuntimeUIViewState validated_visual_state(const assets::AssetManager& assets,
                                                core::RuntimeUIViewState state,
                                                std::unordered_set<std::string>& logged)
{
    state.asset_diagnostics.clear();
    if (state.cover_image.empty() && assets.exists("project:/image")) {
        state.cover_image = "project:/image";
    }
    if (state.background_image.empty() && !state.cover_image.empty()) {
        state.background_image = state.cover_image;
    }

    validate_visual_asset(assets, state, state.cover_image, logged);
    validate_visual_asset(assets, state, state.background_image, logged);
    validate_visual_asset(assets, state, state.room_image, logged);
    for (const auto& object : state.objects) {
        validate_visual_asset(assets, state, object.image, logged);
    }
    return state;
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

float active_text_reveal_duration_seconds(const core::RichTextDocument& document)
{
    return static_cast<float>(
               std::max<std::size_t>(text::utf8_grapheme_count(document.plain_text), 1u)) /
           kActiveTextRevealGlyphsPerSecond;
}

std::string active_text_body_key(const core::RuntimeUIViewState& state)
{
    if (state.body.empty()) {
        return {};
    }
    return state.mode + ":" + state.body;
}

ActiveTextPlaybackInput active_text_playback_input(const core::RuntimeUIViewState& state,
                                                   std::size_t page_index, float delta_seconds)
{
    const auto page = active_text_document_page(state.active_text, page_index);
    return ActiveTextPlaybackInput{
        .body_key = active_text_body_key(state) + ":page:" + std::to_string(page_index),
        .glyph_count = text::utf8_grapheme_count(page.plain_text),
        .delta_seconds = delta_seconds,
        .awaiting_continue = state.awaiting_continue,
        .page_break =
            state.page_break || page_index + 1u < active_text_page_count(state.active_text)};
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
    void show_title_diagnostic(const std::vector<core::RuntimeDiagnostic>& diagnostics);
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
    ui::rmlui::BgfxRenderInterface* render_interface = nullptr;
    ui::rmlui::RuntimeUiTemplateResolver* template_resolver = nullptr;
    ui::rmlui::RuntimeUiDocumentBinder* document_binder = nullptr;
    ui::rmlui::RuntimeUiComponentRegistry* component_registry = nullptr;
    const assets::AssetManager* assets = nullptr;
    std::unordered_map<std::string, Rml::ElementDocument*> documents;
    std::unordered_map<std::uintptr_t, ListenerRecord> listeners;
    std::unordered_map<std::string, std::unique_ptr<Rml::DataModelConstructor>> data_models;
    std::unique_ptr<RuntimeInputListener> runtime_input_listener;
    core::RuntimeSessionHost* runtime_host = nullptr;
    RuntimeCommandDispatcher* runtime_command_dispatcher = nullptr;
    TweenService* tweens = nullptr;
    std::uintptr_t next_listener_id = 1;
    std::string runtime_document_path;
    std::string active_text_body;
    core::RichTextDocument active_text_display_document;
    std::unordered_set<std::string> logged_missing_visual_assets;
    ActiveTextPlaybackState active_text_playback;
    ActiveTextPlaybackConfig active_text_playback_config{};
    std::uint64_t active_text_page_instance_id = 0;
    std::size_t active_text_page_index = 0;
    std::size_t active_text_local_page_count = 1;
    float active_text_reveal_progress = 1.0f;
    float active_text_tween_reveal = 1.0f;
    float active_text_tween_alpha = 1.0f;
    bool rml_initialized = false;
    core::RuntimeUIViewAdapter runtime_view;
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

void RuntimeUI::State::show_title_diagnostic(
    const std::vector<core::RuntimeDiagnostic>& diagnostics)
{
    auto title = documents.find(kRuntimeTitleDocumentId);
    if (title == documents.end())
        return;
    auto* element = title->second->GetElementById("nt-title-diagnostic");
    if (!element)
        return;
    for (auto it = diagnostics.rbegin(); it != diagnostics.rend(); ++it) {
        if (it->severity == core::RuntimeDiagnosticSeverity::Warning ||
            it->severity == core::RuntimeDiagnosticSeverity::Error) {
            element->SetInnerRML(ui::rmlui::escape_rml(it->message));
            return;
        }
    }
}

void RuntimeUI::State::refresh_runtime_document()
{
    auto doc_it = documents.find(kRuntimeGameDocumentId);
    auto* doc = doc_it == documents.end() ? nullptr : doc_it->second;
    if (!doc || !document_binder)
        return;
    const auto& source_state = runtime_host ? runtime_host->view_state() : runtime_view.state();
    if (!source_state.active_text.plain_text.empty()) {
        active_text_display_document = source_state.active_text;
    }
    active_text_body = source_state.body;
    active_text_reveal_progress = active_text_playback.reveal_progress;

    auto state = source_state;
    if (assets) {
        state = validated_visual_state(*assets, std::move(state), logged_missing_visual_assets);
    }
    state.active_text_reveal_progress = active_text_reveal_progress;
    document_binder->bind(*doc, state);
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

    const auto& source_state = runtime_host ? runtime_host->view_state() : runtime_view.state();
    const auto& active_document = source_state.active_text.plain_text.empty()
                                      ? active_text_display_document
                                      : source_state.active_text;
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
    active_text_layout.page_break = source_state.page_break || active_text_layout.page_break;
    active_text_layout.awaiting_continue =
        source_state.awaiting_continue || active_text_layout.awaiting_continue;
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
    if (!owner.runtime_host || !owner.runtime_command_dispatcher)
        return;
    Rml::Element* target = event.GetTargetElement();
    if (!target)
        return;

    auto submit = [this](RuntimeCommand command) {
        const std::string command_name = command.name;
        auto result = owner.runtime_command_dispatcher->dispatch(std::move(command));
        if (result.handled && command_name == "game.start") {
            owner.show_game_document();
        }
        owner.show_title_diagnostic(result.diagnostics);
        owner.runtime_view.apply(owner.runtime_host->last_commands());
        if (!result.outputs.empty() || result.handled || !result.diagnostics.empty()) {
            owner.refresh_runtime_document();
        }
    };

    auto make_command = [](std::string name, nlohmann::json payload = nlohmann::json::object()) {
        RuntimeCommand command;
        command.source = RuntimeCommandSource::RmlUiEvent;
        command.domain = domain_from_command_name(name);
        command.name = std::move(name);
        command.payload = std::move(payload);
        return command;
    };

    auto attribute_command = [&]() -> std::optional<RuntimeCommand> {
        if (target->HasAttribute("nt-option")) {
            const int index = target->GetAttribute<int>("nt-option", -1);
            if (index >= 0) {
                return make_command("runtime.dialogue-option", {{"index", index}});
            }
        }
        if (target->HasAttribute("nt-nav")) {
            const int direction = target->GetAttribute<int>("nt-nav", -1);
            if (direction >= 0) {
                return make_command("runtime.navigate", {{"direction", direction}});
            }
        }
        if (target->HasAttribute("nt-continue")) {
            return make_command("runtime.continue");
        }
        if (target->HasAttribute("nt-object")) {
            const auto object_id = target->GetAttribute<Rml::String>("nt-object", "");
            if (!object_id.empty()) {
                return make_command("runtime.select-object", {{"object_id", object_id}});
            }
        }
        if (target->HasAttribute("nt-action")) {
            const auto verb_id = target->GetAttribute<Rml::String>("nt-action", "");
            if (!verb_id.empty()) {
                return make_command("runtime.run-action", {{"verb_id", verb_id}});
            }
        }
        if (target->HasAttribute("nt-clear-selection")) {
            return make_command("runtime.clear-selection");
        }
        return std::nullopt;
    };

    if (auto command = attribute_command()) {
        submit(std::move(*command));
    } else if (find_ancestor_tag(target, "nt-active-text")) {
        const float x = static_cast<float>(event.GetParameter<int>("mouse_x", 0));
        const float y = static_cast<float>(event.GetParameter<int>("mouse_y", 0));
        if (const auto object_id = owner.active_text_layout.object_at({x, y})) {
            submit(make_command("runtime.select-object", {{"object_id", *object_id}}));
        } else if (owner.active_text_playback.can_skip_reveal) {
            owner.active_text_playback = skip_active_text_reveal(owner.active_text_playback);
            owner.active_text_tween_reveal = 1.0f;
            if (owner.tweens) {
                owner.tweens->kill_channel("active-text-reveal");
            }
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
                submit(make_command("runtime.continue"));
            }
        } else {
            submit(make_command("runtime.continue"));
        }
    }
}

RuntimeUI::RuntimeUI() = default;
RuntimeUI::~RuntimeUI() { shutdown(); }

void RuntimeUI::cleanup_state()
{
    if (!m_state)
        return;
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
                           const ShaderMaterialProject* shader_materials)
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

    m_surface = sanitize_surface_metrics(m_surface);
    m_state->render_interface =
        new ui::rmlui::BgfxRenderInterface(m_surface, *assets, shader_materials);
    if (!*m_state->render_interface) {
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
    if (m_state && m_state->render_interface) {
        m_state->render_interface->set_perf_logging_enabled(enabled);
    }
}

void RuntimeUI::set_rmlui_base_direct_compatibility(bool enabled)
{
    if (m_state && m_state->render_interface) {
        m_state->render_interface->set_base_direct_compatibility(enabled);
    }
}

bool RuntimeUI::process_event(const SDL_Event& event)
{
    m_last_event_consumed = false;
    if (m_state && m_state->context) {
        m_last_event_consumed =
            ui::rmlui::process_sdl_event(*m_state->context, m_state->window, event);
        return m_last_event_consumed;
    }
    return false;
}

void RuntimeUI::resize(const SurfaceMetrics& surface)
{
    m_surface = sanitize_surface_metrics(surface);
    if (m_state && m_state->context) {
        m_state->context->SetDimensions(
            Rml::Vector2i(m_surface.logical_width, m_surface.logical_height));
        m_state->context->SetDensityIndependentPixelRatio(m_surface.scale_x);
        if (m_state->render_interface) {
            m_state->render_interface->resize(m_surface);
        }
    }
}

void RuntimeUI::begin_frame(float delta_time)
{
    if (m_state && m_state->context) {
        if (m_state->render_interface)
            m_state->render_interface->begin_frame();
        const auto& source_state = m_state->runtime_host ? m_state->runtime_host->view_state()
                                                         : m_state->runtime_view.state();
        const auto previous_instance = m_state->active_text_playback.instance_id;
        const auto previous_phase = m_state->active_text_playback.phase;
        const float playback_delta = m_state->tweens ? 0.0f : delta_time;
        m_state->active_text_playback = update_active_text_playback(
            m_state->active_text_playback,
            active_text_playback_input(source_state, m_state->active_text_page_index,
                                       playback_delta),
            m_state->active_text_playback_config);
        if (m_state->tweens) {
            if (m_state->active_text_playback.instance_id != previous_instance) {
                m_state->active_text_tween_reveal = 0.0f;
                m_state->active_text_tween_alpha = 0.0f;
                m_state->tweens->tween_float(
                    "runtime-ui", "active-text-reveal", m_state->active_text_tween_reveal, 0.0f,
                    1.0f,
                    active_text_reveal_duration_seconds(active_text_document_page(
                        source_state.active_text, m_state->active_text_page_index)));
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
            if (!source_state.active_text.plain_text.empty()) {
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
        if (m_state->render_interface)
            m_state->render_interface->end_frame();
    }
}

void RuntimeUI::shutdown()
{
    if (!m_initialized)
        return;
    if (m_state) {
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

    if ((id == kRuntimeGameDocumentId || id == kRuntimeTitleDocumentId) &&
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
        return true;
    }
    return false;
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
        if (m_state->runtime_host) {
            bind_runtime_host(m_state->runtime_host);
        }
    }
    if (had_title_doc) {
        ok = load_title_document() && ok;
    }

    return ok;
}

void RuntimeUI::set_density(float density)
{
    if (m_state && m_state->context) {
        m_state->context->SetDensityIndependentPixelRatio(density);
    }
}

void RuntimeUI::apply_controller_commands(const std::vector<core::ControllerCommand>& commands)
{
    if (!m_state)
        return;
    m_state->runtime_view.apply(commands);
    m_state->refresh_runtime_document();
}

const core::RuntimeUIViewState& RuntimeUI::runtime_view_state() const
{
    if (m_state && m_state->runtime_host)
        return m_state->runtime_host->view_state();
    if (m_state)
        return m_state->runtime_view.state();
    static const core::RuntimeUIViewState empty;
    return empty;
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

void RuntimeUI::bind_runtime_host(core::RuntimeSessionHost* host)
{
    if (!m_state)
        return;
    m_state->runtime_host = host;
    if (!host)
        return;
}

void RuntimeUI::bind_runtime_command_dispatcher(RuntimeCommandDispatcher* dispatcher)
{
    if (m_state) {
        m_state->runtime_command_dispatcher = dispatcher;
    }
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
