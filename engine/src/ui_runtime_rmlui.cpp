#include "noveltea/ui_runtime.hpp"

#include "noveltea/active_text_playback.hpp"
#include "noveltea/runtime_layout_manager.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/runtime_presentation_bridge.hpp"
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
#include "ui/rmlui/rmlui_lifecycle.hpp"
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
constexpr const char* kRuntimeSaveMenuDocumentId = "runtime_save_menu";
constexpr const char* kRuntimeLoadMenuDocumentId = "runtime_load_menu";
constexpr const char* kRuntimeSettingsMenuDocumentId = "runtime_settings_menu";
constexpr const char* kRuntimeTextLogDocumentId = "runtime_text_log";
constexpr const char* kRuntimeModalDocumentId = "runtime_modal";
constexpr const char* kRuntimeTitleDocumentAsset = "system:/ui/title/default-title.rml";
constexpr const char* kRuntimePauseMenuDocumentAsset = "system:/ui/menu/pause-menu.rml";
constexpr const char* kRuntimeSaveMenuDocumentAsset = "system:/ui/menu/save-menu.rml";
constexpr const char* kRuntimeLoadMenuDocumentAsset = "system:/ui/menu/load-menu.rml";
constexpr const char* kRuntimeSettingsMenuDocumentAsset = "system:/ui/menu/settings-menu.rml";
constexpr const char* kRuntimeTextLogDocumentAsset = "system:/ui/menu/text-log.rml";
constexpr const char* kRuntimeModalDocumentAsset = "system:/ui/menu/modal.rml";

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

bool is_runtime_input_document_id(std::string_view id)
{
    return id == kRuntimeGameDocumentId || id == kRuntimeTitleDocumentId ||
           id == kRuntimePauseMenuDocumentId || id == kRuntimeSaveMenuDocumentId ||
           id == kRuntimeLoadMenuDocumentId || id == kRuntimeSettingsMenuDocumentId ||
           id == kRuntimeTextLogDocumentId || id == kRuntimeModalDocumentId;
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
    struct ContextRecord {
        ContextKey key;
        std::string name;
        Rml::Context* context = nullptr;
    };
    struct PlaneRenderer {
        core::PresentationPlane plane = core::PresentationPlane::GameUi;
        bool world_transition_source = false;
        std::unique_ptr<Rml::RenderInterface> owned;
        ui::rmlui::BgfxRenderInterface* bgfx = nullptr;
    };
    struct CallbackListener final : Rml::EventListener {
        explicit CallbackListener(std::function<void()> cb) : callback(std::move(cb)) {}
        void ProcessEvent(Rml::Event&) override
        {
            if (callback)
                callback();
        }
        std::function<void()> callback;
    };
    struct DocumentSourceRecord {
        std::string path;
        std::optional<std::string> memory_rml;
    };
    void refresh_runtime_document();
    void refresh_active_text_layout();
    void load_runtime_document();
    void add_runtime_input_listener(Rml::ElementDocument& doc);
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
    Rml::RenderInterface* renderer_for(ContextKey key);
    Rml::Context* context_for(const core::MountedLayoutPolicy& policy)
    {
        return context_for(ContextKey{policy.plane, 0, policy.clock, policy.input,
                                      core::MountedLayoutOwner::Gameplay});
    }
    Rml::Context* document_context(const std::string& id) const;
    Rml::ElementDocument* load_document_source(Rml::Context& target,
                                               const DocumentSourceRecord& source) const;
    void remember_document_order(const std::string& id);
    struct RuntimeInputListener final : Rml::EventListener {
        explicit RuntimeInputListener(State& owner_state) : owner(owner_state) {}
        void ProcessEvent(Rml::Event& event) override;
        State& owner;
    };
    struct ListenerRecord {
        std::string document_id;
        std::string element_id;
        Rml::Element* element = nullptr;
        std::string event;
        std::unique_ptr<CallbackListener> listener;
    };
    Rml::Context* context = nullptr;
    std::vector<ContextRecord> contexts;
    std::vector<PlaneRenderer> plane_renderers;
    std::unordered_set<Rml::Context*> rendered_contexts;
    Rml::ElementDocument* demo_document = nullptr;
    SDL_Window* window = nullptr;
    ui::rmlui::AssetRmlFileInterface* file_interface = nullptr;
    ui::rmlui::SdlSystemInterface* system_interface = nullptr;
    ui::rmlui::RuntimeUiTemplateResolver* template_resolver = nullptr;
    ui::rmlui::RuntimeUiDocumentBinder* document_binder = nullptr;
    const RuntimeUiAssetResolver* asset_resolver = nullptr;
    ui::rmlui::RuntimeUiComponentRegistry* component_registry = nullptr;
    const assets::AssetManager* assets = nullptr;
    const ShaderMaterialProject* shader_materials = nullptr;
    bool headless_render = false;
    bool perf_logging = false;
    bool base_direct_compatibility = false;
    SurfaceMetrics owner_surface{};
    PresentationMetrics owner_presentation{};
    core::RuntimeClockUpdate last_clocks{};
    std::unordered_map<std::string, Rml::ElementDocument*> documents;
    std::unordered_map<std::string, ContextKey> document_context_keys;
    std::unordered_map<std::string, DocumentSourceRecord> document_sources;
    std::vector<std::string> ordered_document_ids;
    std::unordered_map<std::uintptr_t, ListenerRecord> listeners;
    std::unordered_map<std::string, std::unique_ptr<Rml::DataModelConstructor>> data_models;
    std::unique_ptr<RuntimeInputListener> runtime_input_listener;
    std::function<bool(const core::RuntimeInputMessage&)> runtime_input_handler;
    std::function<bool(const core::RuntimeShellCommand&)> runtime_shell_handler;
    std::function<bool()> layout_gameplay_admission;
    std::function<void()> game_started_handler;
    std::optional<core::TypedRuntimeUIViewState> typed_runtime_view;
    std::optional<core::RuntimeShellViewState> runtime_shell_view;
    core::Diagnostics typed_diagnostics;
    lua_State* lua_state = nullptr;
    script::ScriptRuntime* scripts = nullptr;
    std::optional<runtime::RuntimeCapabilitySet> gameplay_layout_event_capabilities;
    std::optional<runtime::RuntimeCapabilitySet> shell_layout_event_capabilities;
    std::string typed_notification;
    std::uintptr_t next_listener_id = 1;
    std::string runtime_document_path;
    ActiveTextPlaybackState active_text_playback;
    ActiveTextPlaybackConfig active_text_playback_config{};
    std::uint64_t active_text_page_instance_id = 0;
    std::size_t active_text_page_index = 0;
    std::size_t active_text_local_page_count = 1;
    float active_text_reveal_progress = 1.0f;
    bool rml_initialized = false;
    std::unique_ptr<text::TextEngine> active_text_engine;
    std::unique_ptr<text::TextFontAssetLoader> active_text_font_loader;
    FontHandle active_text_font;
    ActiveTextLayout active_text_layout;
    double active_text_time_seconds = 0.0;
    bool active_text_direct_enabled = true;
};

Rml::RenderInterface* RuntimeUI::State::renderer_for(ContextKey key)
{
    const bool world_transition_source =
        key.plane == core::PresentationPlane::WorldOverlay &&
        key.composition_group == kWorldTransitionSourceCompositionGroup;
    const auto found =
        std::find_if(plane_renderers.begin(), plane_renderers.end(), [&](const auto& value) {
            return value.plane == key.plane &&
                   value.world_transition_source == world_transition_source;
        });
    if (found != plane_renderers.end())
        return found->owned.get();
    PlaneRenderer renderer;
    renderer.plane = key.plane;
    renderer.world_transition_source = world_transition_source;
    if (headless_render) {
        renderer.owned = std::make_unique<HeadlessRenderInterface>();
    } else {
        const auto views = world_transition_source
                               ? ui::rmlui::rmlui_bgfx_world_source_overlay_view_range()
                               : ui::rmlui::rmlui_bgfx_plane_view_range(key.plane);
        auto bgfx = std::make_unique<ui::rmlui::BgfxRenderInterface>(owner_presentation, *assets,
                                                                     views, shader_materials);
        if (!*bgfx)
            return nullptr;
        bgfx->set_perf_logging_enabled(perf_logging);
        bgfx->set_base_direct_compatibility(base_direct_compatibility);
        renderer.bgfx = bgfx.get();
        renderer.owned = std::move(bgfx);
    }
    plane_renderers.push_back(std::move(renderer));
    return plane_renderers.back().owned.get();
}

Rml::Context* RuntimeUI::State::context_for(ContextKey key)
{
    const auto found = std::find_if(contexts.begin(), contexts.end(),
                                    [&](const auto& value) { return value.key == key; });
    if (found != contexts.end())
        return found->context;
    const std::string name = "runtime-" + std::to_string(static_cast<unsigned>(key.plane)) + "-" +
                             std::to_string(key.composition_group) + "-" +
                             std::to_string(static_cast<unsigned>(key.clock)) + "-" +
                             std::to_string(static_cast<unsigned>(key.input)) + "-" +
                             std::to_string(static_cast<unsigned>(key.owner));
    auto* renderer = renderer_for(key);
    if (!renderer)
        return nullptr;
    auto* created = Rml::CreateContext(
        name, Rml::Vector2i(owner_surface.logical_width, owner_surface.logical_height), renderer);
    if (!created)
        return nullptr;
    created->SetDensityIndependentPixelRatio(owner_surface.scale_x);
    contexts.push_back({key, name, created});
    std::sort(contexts.begin(), contexts.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.key < rhs.key; });
    return created;
}

Rml::Context* RuntimeUI::State::document_context(const std::string& id) const
{
    const auto key = document_context_keys.find(id);
    if (key == document_context_keys.end())
        return context;
    const auto found = std::find_if(contexts.begin(), contexts.end(),
                                    [&](const auto& value) { return value.key == key->second; });
    return found == contexts.end() ? nullptr : found->context;
}

Rml::ElementDocument*
RuntimeUI::State::load_document_source(Rml::Context& target,
                                       const DocumentSourceRecord& source) const
{
    return source.memory_rml ? target.LoadDocumentFromMemory(*source.memory_rml, source.path)
                             : target.LoadDocument(source.path);
}

void RuntimeUI::State::remember_document_order(const std::string& id)
{
    if (std::find(ordered_document_ids.begin(), ordered_document_ids.end(), id) ==
        ordered_document_ids.end())
        ordered_document_ids.push_back(id);
}

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
    document_sources[kRuntimeGameDocumentId] = {path, std::nullopt};
    remember_document_order(kRuntimeGameDocumentId);
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

bool RuntimeUI::State::dispatch_typed_input(const core::RuntimeInputMessage& input)
{
    if (!runtime_input_handler) {
        typed_diagnostics.push_back(core::Diagnostic{
            .code = "runtime_ui.input_handler_unavailable",
            .message = "Typed runtime UI input requires a bound runtime input handler"});
        return false;
    }
    return runtime_input_handler(input);
}

bool RuntimeUI::State::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    if (!runtime_shell_handler) {
        typed_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.shell_handler_unavailable",
                             .message = "Runtime shell command requires a bound shell handler"});
        return false;
    }
    return runtime_shell_handler(command);
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
        const bool handled_by_shell = static_cast<bool>(runtime_shell_handler);
        const bool started =
            handled_by_shell
                ? dispatch_shell_command(core::RuntimeShellCommand{core::StartGameShellCommand{}})
                : dispatch_typed_input(core::RuntimeInputMessage{core::StartRuntimeInput{}});
        if (started && !handled_by_shell) {
            if (game_started_handler)
                game_started_handler();
            else
                show_game_document();
        }
        return started;
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
    if (!runtime_shell_view)
        return;

    const auto bind_status = [&](const char* document_id) {
        const auto found = documents.find(document_id);
        if (found != documents.end())
            set_shell_element_rml(*found->second, "nt-shell-status", runtime_shell_view->status);
    };
    bind_status(kRuntimeTitleDocumentId);
    bind_status(kRuntimePauseMenuDocumentId);
    bind_status(kRuntimeSaveMenuDocumentId);
    bind_status(kRuntimeLoadMenuDocumentId);
    bind_status(kRuntimeSettingsMenuDocumentId);
    bind_status(kRuntimeTextLogDocumentId);
    bind_status(kRuntimeModalDocumentId);

    if (const auto found = documents.find(kRuntimeSettingsMenuDocumentId);
        found != documents.end()) {
        std::ostringstream value;
        value << runtime_shell_view->settings.text_scale();
        set_shell_element_rml(*found->second, "nt-settings-text-scale", value.str());
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
        const auto found = documents.find(document_id);
        if (found == documents.end())
            return;
        set_shell_element_rml(*found->second, "nt-checkpoint-summary", checkpoint_summary);
        auto* list = found->second->GetElementById("nt-save-slots");
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
            if (slot.thumbnail && file_interface) {
                const std::string suffix =
                    slot.slot.is_autosave() ? "autosave" : std::to_string(slot.slot.number());
                const std::string filename =
                    "slot-" + suffix + "-thumbnail-" +
                    std::to_string(runtime_shell_thumbnail_fingerprint(slot.thumbnail->bytes)) +
                    ".png";
                const std::string path = "project:/generated/shell/" + filename;
                file_interface->set_virtual_file(path, slot.thumbnail->bytes);
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

    if (const auto found = documents.find(kRuntimeTextLogDocumentId);
        found != documents.end() && document_binder && typed_runtime_view) {
        document_binder->bind(*found->second, *typed_runtime_view, asset_resolver,
                              runtime_shell_view->status);
    }
    if (const auto found = documents.find(kRuntimeModalDocumentId); found != documents.end()) {
        set_shell_element_rml(*found->second, "nt-modal-prompt",
                              runtime_shell_view->confirmation
                                  ? runtime_shell_view->confirmation->prompt
                                  : std::string_view{});
    }
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

    if (owner.runtime_input_handler && find_ancestor_tag(target, "nt-active-text")) {
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
    m_state->scripts = nullptr;
    for (auto& context : m_state->contexts) {
        if (context.context)
            context.context->UnloadAllDocuments();
    }
    for (auto& context : m_state->contexts)
        Rml::RemoveContext(context.name);
    m_state->contexts.clear();
    m_state->context = nullptr;
    m_state->documents.clear();
    m_state->document_context_keys.clear();
    m_state->document_sources.clear();
    m_state->ordered_document_ids.clear();
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
    m_state->plane_renderers.clear();
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
    m_state->scripts = scripts;

    m_surface = sanitize_surface_metrics(m_surface);
    m_state->owner_surface = m_surface;
    m_state->owner_presentation = m_presentation;
    m_state->shader_materials = shader_materials;
    m_state->headless_render = headless_render;

    m_state->context = m_state->context_for(
        State::ContextKey{core::PresentationPlane::GameUi, 0, core::LayoutClockDomain::Gameplay,
                          core::LayoutInputMode::Normal, core::MountedLayoutOwner::Gameplay});
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
            m_state->document_sources["demo"] = {kRuntimeUiDocumentAsset, std::nullopt};
            m_state->remember_document_order("demo");
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
        m_state->perf_logging = enabled;
        for (auto& renderer : m_state->plane_renderers)
            if (renderer.bgfx)
                renderer.bgfx->set_perf_logging_enabled(enabled);
    }
}

void RuntimeUI::set_rmlui_base_direct_compatibility(bool enabled)
{
    if (m_state) {
        m_state->base_direct_compatibility = enabled;
        for (auto& renderer : m_state->plane_renderers)
            if (renderer.bgfx)
                renderer.bgfx->set_base_direct_compatibility(enabled);
    }
}

bool RuntimeUI::process_event(const SDL_Event& event, const PresentationMetrics& presentation)
{
    m_last_event_consumed = false;
    if (!m_state || m_state->contexts.empty()) {
        return false;
    }

    const auto dispatch = [&](const SDL_Event& routed) {
        bool consumed = false;
        for (auto it = m_state->contexts.rbegin(); it != m_state->contexts.rend(); ++it) {
            if (!it->context || it->key.input == core::LayoutInputMode::None)
                continue;
            const bool has_visible_document = std::any_of(
                m_state->documents.begin(), m_state->documents.end(), [&](const auto& document) {
                    return document.second->IsVisible() &&
                           m_state->document_context(document.first) == it->context;
                });
            if (!has_visible_document)
                continue;
            const auto& capabilities = it->key.owner == core::MountedLayoutOwner::Shell
                                           ? m_state->shell_layout_event_capabilities
                                           : m_state->gameplay_layout_event_capabilities;
            if (m_state->scripts && capabilities)
                m_state->scripts->replace_runtime_capabilities(*capabilities);
            m_state->system_interface->set_elapsed_time(
                ui::rmlui::domain_time(m_state->last_clocks, it->key.clock));
            consumed =
                ui::rmlui::process_sdl_event(*it->context, m_state->window, routed) || consumed;
            if (m_state->scripts)
                m_state->scripts->clear_runtime_capabilities();
            if (ui::rmlui::stops_lower_presentation_input(it->key.input, consumed))
                break;
        }
        return consumed;
    };

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
                return dispatch(leave);
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
                const bool release_consumed = dispatch(transformed);
                m_pointer_inside = false;
                SDL_Event leave{};
                leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
                const bool leave_consumed = dispatch(leave);
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
                m_last_event_consumed = dispatch(leave);
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

    m_last_event_consumed = dispatch(transformed);
    return m_last_event_consumed;
}

void RuntimeUI::resize(const PresentationMetrics& presentation)
{
    if (m_state && !m_state->contexts.empty()) {
        if (m_pointer_inside) {
            SDL_Event leave{};
            leave.type = SDL_EVENT_WINDOW_MOUSE_LEAVE;
            for (auto& context : m_state->contexts)
                (void)ui::rmlui::process_sdl_event(*context.context, m_state->window, leave);
        }
        for (const std::uint64_t touch_id : m_active_touches) {
            SDL_Event cancel{};
            cancel.type = SDL_EVENT_FINGER_CANCELED;
            cancel.tfinger.fingerID = touch_id;
            for (auto& context : m_state->contexts)
                (void)ui::rmlui::process_sdl_event(*context.context, m_state->window, cancel);
        }
    }
    m_pointer_inside = false;
    m_active_touches.clear();

    m_surface = sanitize_surface_metrics(presentation.game_surface);
    m_presentation = presentation;
    if (m_state && !m_state->contexts.empty()) {
        m_state->owner_surface = m_surface;
        m_state->owner_presentation = presentation;
        for (auto& context : m_state->contexts) {
            context.context->SetDimensions(
                Rml::Vector2i(m_surface.logical_width, m_surface.logical_height));
            context.context->SetDensityIndependentPixelRatio(m_surface.scale_x);
        }
        for (auto& renderer : m_state->plane_renderers)
            if (renderer.bgfx)
                renderer.bgfx->resize(presentation);
    }
}

void RuntimeUI::begin_frame(const core::RuntimeClockUpdate& clocks)
{
    if (m_state && !m_state->contexts.empty()) {
        m_state->rendered_contexts.clear();
        m_state->last_clocks = clocks;
        const float delta_time = std::chrono::duration<float>(clocks.gameplay_delta).count();
        for (auto& renderer : m_state->plane_renderers)
            if (renderer.bgfx)
                renderer.bgfx->begin_frame();
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
        for (auto& context : m_state->contexts) {
            const auto elapsed = ui::rmlui::domain_time(clocks, context.key.clock);
            m_state->system_interface->set_elapsed_time(elapsed);
            context.context->Update();
        }
        m_state->refresh_active_text_layout();
    }
}

void RuntimeUI::set_world_overlay_framebuffers(std::uint16_t source, std::uint16_t target,
                                               bool transition_active)
{
    if (!m_state)
        return;
    for (auto& renderer : m_state->plane_renderers) {
        if (!renderer.bgfx || renderer.plane != core::PresentationPlane::WorldOverlay)
            continue;
        const std::uint16_t handle = renderer.world_transition_source ? source : target;
        const bool local = transition_active && handle != UINT16_MAX;
        bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
        if (local)
            framebuffer = bgfx::FrameBufferHandle{handle};
        renderer.bgfx->set_output_framebuffer(framebuffer, m_state->owner_presentation, local);
    }
}

void RuntimeUI::render_world_overlay_source()
{
    if (!m_state)
        return;
    for (auto& context : m_state->contexts) {
        if (context.key.plane != core::PresentationPlane::WorldOverlay ||
            context.key.composition_group != kWorldTransitionSourceCompositionGroup ||
            m_state->rendered_contexts.contains(context.context))
            continue;
        m_state->system_interface->set_elapsed_time(
            ui::rmlui::domain_time(m_state->last_clocks, context.key.clock));
        context.context->Render();
        m_state->rendered_contexts.insert(context.context);
    }
}

void RuntimeUI::render_world_overlay_target()
{
    if (!m_state)
        return;
    for (auto& context : m_state->contexts) {
        if (context.key.plane != core::PresentationPlane::WorldOverlay ||
            context.key.composition_group == kWorldTransitionSourceCompositionGroup ||
            m_state->rendered_contexts.contains(context.context))
            continue;
        m_state->system_interface->set_elapsed_time(
            ui::rmlui::domain_time(m_state->last_clocks, context.key.clock));
        context.context->Render();
        m_state->rendered_contexts.insert(context.context);
    }
}

void RuntimeUI::end_frame()
{
    if (m_state && !m_state->contexts.empty()) {
        for (auto& context : m_state->contexts) {
            if (m_state->rendered_contexts.contains(context.context))
                continue;
            m_state->system_interface->set_elapsed_time(
                ui::rmlui::domain_time(m_state->last_clocks, context.key.clock));
            context.context->Render();
            m_state->rendered_contexts.insert(context.context);
        }
        for (auto& renderer : m_state->plane_renderers)
            if (renderer.bgfx)
                renderer.bgfx->end_frame();
    }
}

void RuntimeUI::shutdown()
{
    if (!m_initialized)
        return;
    if (m_state) {
        m_state->runtime_input_handler = {};
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
    m_state->document_sources[id] = {path, std::nullopt};
    m_state->remember_document_order(id);
    if (show)
        doc->Show();
    return true;
}

bool RuntimeUI::load_document_for_layout(const std::string& id, const std::string& path, bool show,
                                         const core::MountedLayoutPolicy& policy)
{
    if (!m_state || id.empty())
        return false;
    auto* target = m_state->context_for(policy);
    if (!target)
        return false;
    unload_document(id);
    auto* doc = target->LoadDocument(path);
    if (!doc)
        return false;
    m_state->documents[id] = doc;
    m_state->document_context_keys[id] = {policy.plane, 0, policy.clock, policy.input};
    m_state->document_sources[id] = {path, std::nullopt};
    m_state->remember_document_order(id);
    if (show)
        doc->Show();
    return true;
}

bool RuntimeUI::load_builtin_for_layout(RuntimeLayoutBuiltinDocument builtin_document,
                                        const core::MountedLayoutPolicy& policy)
{
    if (!m_state)
        return false;
    auto* target = m_state->context_for(policy);
    if (!target)
        return false;
    auto* previous = m_state->context;
    m_state->context = target;
    bool loaded = false;
    std::string id;
    switch (builtin_document) {
    case RuntimeLayoutBuiltinDocument::Title:
        loaded = load_title_document();
        id = kRuntimeTitleDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::GameHud:
        loaded = load_runtime_document();
        id = kRuntimeGameDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::PauseMenu:
        loaded = load_pause_menu_document();
        id = kRuntimePauseMenuDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::SaveMenu:
        loaded =
            load_builtin_system_document(kRuntimeSaveMenuDocumentId, kRuntimeSaveMenuDocumentAsset);
        id = kRuntimeSaveMenuDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::LoadMenu:
        loaded =
            load_builtin_system_document(kRuntimeLoadMenuDocumentId, kRuntimeLoadMenuDocumentAsset);
        id = kRuntimeLoadMenuDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::SettingsMenu:
        loaded = load_builtin_system_document(kRuntimeSettingsMenuDocumentId,
                                              kRuntimeSettingsMenuDocumentAsset);
        id = kRuntimeSettingsMenuDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::TextLog:
        loaded =
            load_builtin_system_document(kRuntimeTextLogDocumentId, kRuntimeTextLogDocumentAsset);
        id = kRuntimeTextLogDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::Modal:
        loaded = load_builtin_system_document(kRuntimeModalDocumentId, kRuntimeModalDocumentAsset);
        id = kRuntimeModalDocumentId;
        break;
    case RuntimeLayoutBuiltinDocument::None:
        break;
    }
    m_state->context = previous;
    if (loaded)
        m_state->document_context_keys[id] = {policy.plane, 0, policy.clock, policy.input};
    return loaded;
}

bool RuntimeUI::apply_layout_order(const std::vector<std::string>& ordered_document_ids)
{
    if (!m_state)
        return false;
    for (const auto& id : ordered_document_ids) {
        const auto found = m_state->documents.find(id);
        auto* context = m_state->document_context(id);
        if (found == m_state->documents.end() || !context)
            return false;
        context->PullDocumentToFront(found->second);
    }
    m_state->ordered_document_ids = ordered_document_ids;
    std::sort(m_state->contexts.begin(), m_state->contexts.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.key < rhs.key; });
    return true;
}

bool RuntimeUI::apply_layout_policy(const std::string& document_id,
                                    const core::MountedLayoutPolicy& policy,
                                    std::uint32_t composition_group, core::MountedLayoutOwner owner)
{
    if (!m_state)
        return false;
    const State::ContextKey desired{policy.plane, composition_group, policy.clock, policy.input,
                                    owner};
    const auto current = m_state->document_context_keys.find(document_id);
    if (current != m_state->document_context_keys.end() && current->second == desired) {
        return true;
    }
    const auto document_it = m_state->documents.find(document_id);
    const auto source_it = m_state->document_sources.find(document_id);
    if (document_it == m_state->documents.end() || source_it == m_state->document_sources.end())
        return false;
    auto* target = m_state->context_for(desired);
    if (!target)
        return false;
    auto* replacement = m_state->load_document_source(*target, source_it->second);
    if (!replacement)
        return false;
    std::vector<std::pair<State::ListenerRecord*, Rml::Element*>> rebound_listeners;
    for (auto& [id, listener] : m_state->listeners) {
        (void)id;
        if (listener.document_id != document_id)
            continue;
        auto* element = listener.element_id.empty()
                            ? static_cast<Rml::Element*>(replacement)
                            : replacement->GetElementById(listener.element_id);
        if (!element) {
            replacement->Close();
            return false;
        }
        rebound_listeners.emplace_back(&listener, element);
    }
    const bool visible = document_it->second->IsVisible();
    std::string focused_id;
    if (auto* old_context = m_state->document_context(document_id)) {
        if (auto* focused = old_context->GetFocusElement();
            focused && focused->GetOwnerDocument() == document_it->second)
            focused_id = focused->GetId();
    }
    if (is_runtime_input_document_id(document_id))
        m_state->add_runtime_input_listener(*replacement);
    if (visible)
        replacement->Show(Rml::ModalFlag::None, Rml::FocusFlag::Keep);
    else
        replacement->Hide();
    for (auto& [listener, element] : rebound_listeners) {
        (void)element;
        if (listener->element)
            listener->element->RemoveEventListener(listener->event, listener->listener.get());
    }
    document_it->second->Close();
    document_it->second = replacement;
    m_state->document_context_keys[document_id] = desired;
    for (auto& [listener, element] : rebound_listeners) {
        element->AddEventListener(listener->event, listener->listener.get());
        listener->element = element;
    }
    if (!focused_id.empty()) {
        if (auto* focused = replacement->GetElementById(focused_id))
            focused->Focus();
    }
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
    m_state->document_sources[id] = {source_url, rml};
    m_state->remember_document_order(id);
    if (show)
        doc->Show();
    if (old_doc && old_doc != doc) {
        if (old_doc->IsVisible())
            old_doc->Hide();
        for (auto listener = m_state->listeners.begin(); listener != m_state->listeners.end();) {
            if (listener->second.document_id == id) {
                if (listener->second.element)
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

    if (is_runtime_input_document_id(id) && m_state->runtime_input_listener) {
        it->second->RemoveEventListener("click", m_state->runtime_input_listener.get());
    }

    for (auto listener = m_state->listeners.begin(); listener != m_state->listeners.end();) {
        if (listener->second.document_id == id) {
            if (listener->second.element)
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
    m_state->document_context_keys.erase(id);
    m_state->document_sources.erase(id);
    std::erase(m_state->ordered_document_ids, id);
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

bool RuntimeUI::set_document_opacity(const std::string& id, float opacity)
{
    if (auto* doc = static_cast<Rml::ElementDocument*>(document(id))) {
        opacity = std::clamp(opacity, 0.0f, 1.0f);
        return doc->SetProperty("opacity", std::to_string(opacity));
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
    m_state->document_sources[kRuntimeTitleDocumentId] = {kRuntimeTitleDocumentAsset, std::nullopt};
    m_state->remember_document_order(kRuntimeTitleDocumentId);
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
    return load_builtin_system_document(kRuntimePauseMenuDocumentId,
                                        kRuntimePauseMenuDocumentAsset);
}

bool RuntimeUI::load_builtin_system_document(const std::string& id, const std::string& path)
{
    if (!m_state || !m_state->context || id.empty() || path.empty())
        return false;
    unload_document(id);
    Rml::ElementDocument* doc = m_state->context->LoadDocument(path);
    if (!doc) {
        std::fprintf(stderr, "[runtime_ui] failed to load system document: %s\n", path.c_str());
        return false;
    }
    m_state->documents[id] = doc;
    m_state->document_sources[id] = {path, std::nullopt};
    m_state->remember_document_order(id);
    m_state->add_runtime_input_listener(*doc);
    doc->Show();
    m_state->refresh_runtime_shell_documents();
    std::printf("[runtime_ui] loaded system document: %s\n", path.c_str());
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
    if (!m_state || m_state->contexts.empty())
        return false;

    struct ReloadRecord {
        std::string id;
        State::DocumentSourceRecord source;
        State::ContextKey context;
        bool visible = false;
        std::string focused_element_id;
    };

    std::vector<std::string> reload_order;
    reload_order.reserve(m_state->documents.size());
    for (const auto& id : m_state->ordered_document_ids) {
        if (m_state->documents.contains(id))
            reload_order.push_back(id);
    }
    std::vector<std::string> remaining;
    for (const auto& [id, document] : m_state->documents) {
        (void)document;
        if (std::find(reload_order.begin(), reload_order.end(), id) == reload_order.end())
            remaining.push_back(id);
    }
    std::sort(remaining.begin(), remaining.end());
    reload_order.insert(reload_order.end(), remaining.begin(), remaining.end());

    const State::ContextKey default_context{core::PresentationPlane::GameUi, 0,
                                            core::LayoutClockDomain::Gameplay,
                                            core::LayoutInputMode::Normal};
    std::vector<ReloadRecord> records;
    records.reserve(reload_order.size());
    for (const auto& id : reload_order) {
        const auto document = m_state->documents.find(id);
        const auto source = m_state->document_sources.find(id);
        if (document == m_state->documents.end() || source == m_state->document_sources.end())
            continue;
        const auto key = m_state->document_context_keys.find(id);
        ReloadRecord record{id,
                            source->second,
                            key == m_state->document_context_keys.end() ? default_context
                                                                        : key->second,
                            document->second->IsVisible(),
                            {}};
        if (auto* context = m_state->document_context(id)) {
            if (auto* focused = context->GetFocusElement();
                focused && focused->GetOwnerDocument() == document->second)
                record.focused_element_id = focused->GetId();
        }
        records.push_back(std::move(record));
    }

    for (auto& [id, listener] : m_state->listeners) {
        (void)id;
        if (listener.element)
            listener.element->RemoveEventListener(listener.event, listener.listener.get());
    }
    for (auto& context : m_state->contexts)
        context.context->UnloadAllDocuments();
    m_state->documents.clear();
    m_state->demo_document = nullptr;
    m_state->runtime_document_path.clear();
    for (auto& [id, listener] : m_state->listeners) {
        (void)id;
        listener.element = nullptr;
    }

    bool ok = true;
    for (const auto& record : records) {
        auto* context = m_state->context_for(record.context);
        auto* document = context ? m_state->load_document_source(*context, record.source) : nullptr;
        if (!document) {
            std::fprintf(stderr, "[runtime_ui] failed to reload document: %s\n", record.id.c_str());
            ok = false;
            continue;
        }
        m_state->documents[record.id] = document;
        m_state->document_context_keys[record.id] = record.context;
        if (is_runtime_input_document_id(record.id))
            m_state->add_runtime_input_listener(*document);
        if (record.id == kRuntimeGameDocumentId)
            m_state->runtime_document_path = record.source.path;
        if (record.id == "demo")
            m_state->demo_document = document;
        if (record.visible)
            document->Show(Rml::ModalFlag::None, Rml::FocusFlag::Keep);
        else
            document->Hide();
    }

    for (auto& [id, listener] : m_state->listeners) {
        (void)id;
        const auto document = m_state->documents.find(listener.document_id);
        auto* element = document == m_state->documents.end()
                            ? nullptr
                            : (listener.element_id.empty()
                                   ? static_cast<Rml::Element*>(document->second)
                                   : document->second->GetElementById(listener.element_id));
        if (!element) {
            ok = false;
            continue;
        }
        element->AddEventListener(listener.event, listener.listener.get());
        listener.element = element;
    }

    for (const auto& record : records) {
        if (record.focused_element_id.empty())
            continue;
        const auto document = m_state->documents.find(record.id);
        if (document == m_state->documents.end())
            continue;
        if (auto* focused = document->second->GetElementById(record.focused_element_id))
            focused->Focus();
    }

    for (const auto& id : m_state->ordered_document_ids) {
        const auto document = m_state->documents.find(id);
        auto* context = m_state->document_context(id);
        if (document != m_state->documents.end() && context)
            context->PullDocumentToFront(document->second);
    }
    std::sort(m_state->contexts.begin(), m_state->contexts.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.key < rhs.key; });
    m_state->refresh_runtime_document();
    m_state->refresh_active_text_layout();

    return ok;
}

void RuntimeUI::set_density(float density)
{
    if (m_state)
        for (auto& context : m_state->contexts)
            context.context->SetDensityIndependentPixelRatio(density);
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

void RuntimeUI::bind_runtime_input_handler(
    std::function<bool(const core::RuntimeInputMessage&)> handler)
{
    if (!m_state)
        return;
    m_state->runtime_input_handler = std::move(handler);
    m_state->typed_runtime_view.reset();
    m_state->typed_notification.clear();
    m_state->typed_diagnostics.clear();
    if (m_state->runtime_input_handler)
        m_state->install_typed_lua_api();
    else if (m_state->lua_state) {
        sol::state_view lua(m_state->lua_state);
        const sol::object game_object = lua["Game"];
        if (game_object.valid() && game_object.get_type() == sol::type::table)
            game_object.as<sol::table>()["ui"] = sol::lua_nil;
    }
    m_state->refresh_runtime_document();
}

void RuntimeUI::bind_runtime_shell_handler(
    std::function<bool(const core::RuntimeShellCommand&)> handler)
{
    if (!m_state)
        return;
    m_state->runtime_shell_handler = std::move(handler);
    m_state->runtime_shell_view.reset();
    if (m_state->runtime_shell_handler || m_state->runtime_input_handler)
        m_state->install_typed_lua_api();
    else if (m_state->lua_state) {
        sol::state_view lua(m_state->lua_state);
        const sol::object game_object = lua["Game"];
        if (game_object.valid() && game_object.get_type() == sol::type::table)
            game_object.as<sol::table>()["shell"] = sol::lua_nil;
    }
    m_state->refresh_runtime_shell_documents();
}

void RuntimeUI::apply_runtime_publication(const runtime::RuntimePublication& publication)
{
    if (!m_state)
        return;
    m_state->typed_runtime_view = publication.gameplay_ui;
    m_state->refresh_runtime_document();
    m_state->refresh_runtime_shell_documents();
    m_state->refresh_active_text_layout();
}

void RuntimeUI::apply_runtime_shell_view(core::RuntimeShellViewState view)
{
    if (!m_state)
        return;
    m_state->runtime_shell_view = std::move(view);
    m_state->refresh_runtime_shell_documents();
}

void RuntimeUI::deliver_runtime_events(const std::vector<runtime::RuntimeEvent>& events)
{
    if (!m_state)
        return;
    for (const auto& event : events) {
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, runtime::NotificationEvent>)
                    m_state->typed_notification = value.message;
                else if constexpr (std::is_same_v<T, runtime::SaveOutcomeEvent> ||
                                   std::is_same_v<T, runtime::ObservationEvent>) {
                } else
                    static_assert(sizeof(T) == 0, "Unhandled runtime event");
            },
            event);
    }
    m_state->refresh_runtime_document();
    m_state->refresh_runtime_shell_documents();
}

void RuntimeUI::append_typed_runtime_diagnostics(core::Diagnostics diagnostics)
{
    if (m_state)
        core::append_diagnostics(m_state->typed_diagnostics, std::move(diagnostics));
}

core::ActiveTextPresentationPhase RuntimeUI::active_text_presentation_phase() const noexcept
{
    return m_state ? coordinated_active_text_phase(m_state->active_text_playback.phase)
                   : core::ActiveTextPresentationPhase::Stable;
}

void RuntimeUI::bind_asset_resolver(const RuntimeUiAssetResolver* resolver)
{
    if (!m_state)
        return;
    m_state->asset_resolver = resolver;
    m_state->refresh_runtime_document();
}

void RuntimeUI::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    if (m_state)
        m_state->layout_gameplay_admission = std::move(admission);
}

void RuntimeUI::bind_layout_event_capabilities(
    std::optional<runtime::RuntimeCapabilitySet> gameplay,
    std::optional<runtime::RuntimeCapabilitySet> shell)
{
    if (!m_state)
        return;
    m_state->gameplay_layout_event_capabilities = std::move(gameplay);
    m_state->shell_layout_event_capabilities = std::move(shell);
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
    m_state->listeners.emplace(
        id, State::ListenerRecord{document_id, element_id, target, event, std::move(listener)});
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
    if (!m_state || m_state->contexts.empty()) {
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
    const auto context_key = m_state->document_context_keys.find(request.document_id);
    m_state->system_interface->set_elapsed_time(ui::rmlui::domain_time(
        m_state->last_clocks, context_key == m_state->document_context_keys.end()
                                  ? core::LayoutClockDomain::Gameplay
                                  : context_key->second.clock));
    context->ProcessMouseMove(x, y, 0);
    context->ProcessMouseButtonDown(0, 0);
    context->ProcessMouseButtonUp(0, 0);
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
    return (m_state && !m_state->contexts.empty()) ? "rendering" : "no context";
}

bool RuntimeUI::wants_input() const { return wants_pointer_input() || wants_keyboard_input(); }

bool RuntimeUI::wants_pointer_input() const
{
    return m_state &&
           std::any_of(m_state->contexts.begin(), m_state->contexts.end(), [](const auto& context) {
               return context.context && context.context->IsMouseInteracting();
           });
}

bool RuntimeUI::wants_keyboard_input() const
{
    return m_state &&
           std::any_of(m_state->contexts.begin(), m_state->contexts.end(), [](const auto& context) {
               return context.context && context.context->GetFocusElement();
           });
}

} // namespace noveltea
