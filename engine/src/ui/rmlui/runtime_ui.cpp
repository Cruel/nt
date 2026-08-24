#include "ui/rmlui/runtime_ui.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/presentation/runtime_layout_manager.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
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
#include "ui/rmlui/runtime_ui_action_gateway.hpp"
#include "ui/rmlui/runtime_ui_data_model.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/rmlui/rmlui_template_resolver.hpp"

namespace noveltea {

using presentation::RuntimeLayoutBuiltinDocument;

namespace {

char g_layout_state_null_marker;

[[nodiscard]] sol::object mount_layout_state_null(sol::state_view lua)
{
    return sol::make_object(lua, sol::lightuserdata_value{&g_layout_state_null_marker});
}

[[nodiscard]] bool is_mount_layout_state_null(const sol::object& object)
{
    return object.valid() && object.get_type() == sol::type::lightuserdata &&
           object.as<void*>() == &g_layout_state_null_marker;
}

sol::object mount_lua_value(sol::state_view lua, const core::RuntimeValue& value)
{
    return std::visit(
        [&lua](const auto& item) -> sol::object {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, std::monostate>)
                return sol::make_object(lua, sol::lua_nil);
            else
                return sol::make_object(lua, item);
        },
        value);
}

std::optional<core::RuntimeValue> mount_runtime_value(const sol::object& object)
{
    if (!object.valid() || object == sol::lua_nil)
        return core::RuntimeValue{std::monostate{}};
    switch (object.get_type()) {
    case sol::type::boolean:
        return core::RuntimeValue{object.as<bool>()};
    case sol::type::number:
        if (object.is<std::int64_t>())
            return core::RuntimeValue{object.as<std::int64_t>()};
        if (const double value = object.as<double>(); std::isfinite(value))
            return core::RuntimeValue{value};
        return std::nullopt;
    case sol::type::string:
        return core::RuntimeValue{object.as<std::string>()};
    default:
        return std::nullopt;
    }
}

std::optional<core::LayoutStateScope> mount_layout_state_scope(std::string_view scope) noexcept
{
    if (scope == "visit")
        return core::LayoutStateScope::Visit;
    if (scope == "room")
        return core::LayoutStateScope::Room;
    if (scope == "flow")
        return core::LayoutStateScope::Flow;
    if (scope == "session")
        return core::LayoutStateScope::Session;
    return std::nullopt;
}

sol::object mount_persistable_lua_value(sol::state_view lua, const core::PersistableValue& value)
{
    return std::visit(
        [&](const auto& item) -> sol::object {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, std::monostate>) {
                return mount_layout_state_null(lua);
            } else if constexpr (std::is_same_v<T, core::PersistableValue::Array>) {
                sol::table table = lua.create_table(static_cast<int>(item.size()), 0);
                for (std::size_t index = 0; index < item.size(); ++index)
                    table[index + 1] = mount_persistable_lua_value(lua, item[index]);
                return sol::make_object(lua, std::move(table));
            } else if constexpr (std::is_same_v<T, core::PersistableValue::Object>) {
                sol::table table = lua.create_table(0, static_cast<int>(item.size()));
                for (const auto& [key, child] : item)
                    table[key] = mount_persistable_lua_value(lua, child);
                return sol::make_object(lua, std::move(table));
            } else {
                return sol::make_object(lua, item);
            }
        },
        value.value);
}

std::optional<core::PersistableValue>
mount_persistable_value(const sol::object& object, const core::LayoutStateShape& shape,
                        std::unordered_set<const void*>& active_tables)
{
    if (!object.valid() || object == sol::lua_nil || is_mount_layout_state_null(object))
        return shape.nullable
                   ? std::optional<core::PersistableValue>{core::PersistableValue{std::monostate{}}}
                   : std::nullopt;
    switch (shape.type) {
    case core::LayoutStateShapeType::Boolean:
        return object.get_type() == sol::type::boolean
                   ? std::optional<core::PersistableValue>{core::PersistableValue{
                         object.as<bool>()}}
                   : std::nullopt;
    case core::LayoutStateShapeType::Integer:
        return object.get_type() == sol::type::number && object.is<std::int64_t>()
                   ? std::optional<core::PersistableValue>{core::PersistableValue{
                         object.as<std::int64_t>()}}
                   : std::nullopt;
    case core::LayoutStateShapeType::Number:
        if (object.get_type() != sol::type::number)
            return std::nullopt;
        if (object.is<std::int64_t>())
            return core::PersistableValue{object.as<std::int64_t>()};
        if (const double value = object.as<double>(); std::isfinite(value))
            return core::PersistableValue{value};
        return std::nullopt;
    case core::LayoutStateShapeType::String:
        return object.get_type() == sol::type::string
                   ? std::optional<core::PersistableValue>{core::PersistableValue{
                         object.as<std::string>()}}
                   : std::nullopt;
    case core::LayoutStateShapeType::Array:
    case core::LayoutStateShapeType::Object:
        break;
    }
    if (object.get_type() != sol::type::table)
        return std::nullopt;

    lua_State* state = object.lua_state();
    const int pushed = sol::stack::push(state, object);
    const int table_index = lua_absindex(state, -1);
    if (lua_getmetatable(state, table_index) != 0) {
        lua_pop(state, 1 + pushed);
        return std::nullopt;
    }
    const void* identity = lua_topointer(state, table_index);
    lua_pop(state, pushed);
    if (!identity || !active_tables.insert(identity).second)
        return std::nullopt;

    const auto finish = [&](std::optional<core::PersistableValue> result) {
        active_tables.erase(identity);
        return result;
    };
    const sol::table table = object.as<sol::table>();
    if (shape.type == core::LayoutStateShapeType::Array) {
        if (shape.items.size() != 1)
            return finish(std::nullopt);
        core::PersistableValue::Array values;
        std::size_t highest = 0;
        for (const auto& entry : table) {
            const sol::object key = entry.first;
            if (key.get_type() != sol::type::number || !key.is<std::int64_t>())
                return finish(std::nullopt);
            const auto index = key.as<std::int64_t>();
            if (index <= 0 ||
                static_cast<std::uint64_t>(index) >
                    static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()))
                return finish(std::nullopt);
            highest = std::max(highest, static_cast<std::size_t>(index));
        }
        if (highest != table.size())
            return finish(std::nullopt);
        values.reserve(highest);
        for (std::size_t index = 1; index <= highest; ++index) {
            sol::object member = table[index];
            auto converted = mount_persistable_value(member, shape.items.front(), active_tables);
            if (!converted)
                return finish(std::nullopt);
            values.push_back(std::move(*converted));
        }
        return finish(core::PersistableValue{std::move(values)});
    }

    core::PersistableValue::Object values;
    values.reserve(table.size());
    for (const auto& entry : table) {
        const sol::object key = entry.first;
        if (key.get_type() != sol::type::string)
            return finish(std::nullopt);
        const auto name = key.as<std::string>();
        if (name.empty())
            return finish(std::nullopt);
        const auto field =
            std::find_if(shape.fields.begin(), shape.fields.end(), [&](const auto& candidate) {
                return candidate.id == name && candidate.shape.size() == 1;
            });
        if (field == shape.fields.end())
            return finish(std::nullopt);
        auto converted = mount_persistable_value(entry.second, field->shape.front(), active_tables);
        if (!converted)
            return finish(std::nullopt);
        values.emplace_back(name, std::move(*converted));
    }
    std::sort(values.begin(), values.end(),
              [](const auto& left, const auto& right) { return left.first < right.first; });
    core::PersistableValue result{std::move(values)};
    return core::persistable_value_matches(shape, result) ? finish(std::move(result))
                                                          : finish(std::nullopt);
}
using ui::rmlui::kRuntimeCommandBuilderDocumentId;
using ui::rmlui::kRuntimeGameDocumentId;
using ui::rmlui::kRuntimeLoadMenuDocumentId;
using ui::rmlui::kRuntimeModalDocumentId;
using ui::rmlui::kRuntimePauseMenuDocumentId;
using ui::rmlui::kRuntimeSaveMenuDocumentId;
using ui::rmlui::kRuntimeSceneChoiceDocumentId;
using ui::rmlui::kRuntimeSceneTextDocumentId;
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

std::uint64_t runtime_shell_thumbnail_fingerprint(std::string_view bytes) noexcept
{
    std::uint64_t fingerprint = 14695981039346656037ull;
    for (const unsigned char byte : bytes) {
        fingerprint ^= byte;
        fingerprint *= 1099511628211ull;
    }
    return fingerprint;
}

template<class T> T* first_component_as(Rml::ElementDocument& document, const char* tag)
{
    Rml::ElementList elements;
    document.GetElementsByTagName(elements, tag);
    return elements.empty() ? nullptr : rmlui_dynamic_cast<T*>(elements.front());
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

std::string_view builtin_document_id(core::compiled::SystemLayoutRole role) noexcept
{
    switch (role) {
    case core::compiled::SystemLayoutRole::Title:
        return kRuntimeTitleDocumentId;
    case core::compiled::SystemLayoutRole::GameHud:
        return kRuntimeGameDocumentId;
    case core::compiled::SystemLayoutRole::PauseMenu:
        return kRuntimePauseMenuDocumentId;
    case core::compiled::SystemLayoutRole::SaveMenu:
        return kRuntimeSaveMenuDocumentId;
    case core::compiled::SystemLayoutRole::LoadMenu:
        return kRuntimeLoadMenuDocumentId;
    case core::compiled::SystemLayoutRole::SettingsMenu:
        return kRuntimeSettingsMenuDocumentId;
    case core::compiled::SystemLayoutRole::TextLog:
        return kRuntimeTextLogDocumentId;
    case core::compiled::SystemLayoutRole::Modal:
        return kRuntimeModalDocumentId;
    case core::compiled::SystemLayoutRole::CommandBuilder:
        return kRuntimeCommandBuilderDocumentId;
    case core::compiled::SystemLayoutRole::SceneText:
        return kRuntimeSceneTextDocumentId;
    case core::compiled::SystemLayoutRole::SceneChoice:
        return kRuntimeSceneChoiceDocumentId;
    case core::compiled::SystemLayoutRole::DebugOverlay:
        return {};
    }
    return {};
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
active_text_surface(Rml::ElementDocument& document, const ui::rmlui::RmlUiHost& host)
{
    auto* active = find_first_tag(document, "nt-active-text");
    if (!active)
        return std::nullopt;
    const auto* context_metrics = host.context_metrics(document.GetContext());
    if (!context_metrics)
        return std::nullopt;
    return ui::rmlui::ActiveTextPresenterSurface{
        .bounds = content_rect(*active),
        .text_color = element_text_color(*active),
        .language = element_text_language(*active),
        .text_scale_factor = context_metrics->text_scale_factor,
        .font_raster_scale = context_metrics->font_raster_scale};
}

template<class T> T* find_first_component(Rml::ElementDocument& document, const char* tag)
{
    auto* element = find_first_tag(document, tag);
    return element ? rmlui_dynamic_cast<T*>(element) : nullptr;
}

template<class T, class Function>
void for_each_component(Rml::ElementDocument& document, const char* selector, Function&& function)
{
    Rml::ElementList elements;
    document.QuerySelectorAll(elements, selector);
    for (auto* element : elements) {
        if (auto* component = element ? rmlui_dynamic_cast<T*>(element) : nullptr)
            function(*component);
    }
}
} // namespace

struct RuntimeUI::State {
    using ContextKey = ui::rmlui::LifecycleContextKey;
    void refresh_game_hud_map();
    void refresh_mounted_maps();
    void refresh_active_text_layout();
    void load_runtime_document();
    void show_game_document();
    bool dispatch_shell_command(const core::RuntimeShellCommand& command);
    bool dispatch_layout_typed_input(const core::RuntimeInputMessage& input);
    void install_shell_lua_api();
    void remove_shell_lua_api() noexcept;
    void refresh_text_log_map();
    void refresh_data_model_shell();
    void refresh_action_gateway_shell_slots();
    [[nodiscard]] std::optional<std::string>
    system_document_id(core::compiled::SystemLayoutRole role) const;
    [[nodiscard]] Rml::ElementDocument*
    system_document(core::compiled::SystemLayoutRole role) const;
    [[nodiscard]] std::optional<std::string> mount_document(ContextKey key) const;
    Rml::Context* context_for(ContextKey key);
    Rml::ElementDocument* document(const std::string& id) const;
    struct RuntimeInputListener final : Rml::EventListener {
        explicit RuntimeInputListener(State& owner_state) : owner(owner_state) {}
        void ProcessEvent(Rml::Event& event) override;
        State& owner;
    };
    std::unique_ptr<ui::rmlui::RmlUiHost> host;
    std::unique_ptr<ui::rmlui::RmlUiDocumentRegistry> document_registry;
    std::unique_ptr<ui::rmlui::RuntimeUiActionGateway> action_gateway;
    std::unique_ptr<ui::rmlui::RuntimeUiDataModel> data_model;
    std::unique_ptr<ui::rmlui::ActiveTextPresenter> active_text_presenter;
    std::unique_ptr<ui::rmlui::RuntimeUiPlaybackDriver> playback_driver;
    ui::rmlui::RuntimeUiTemplateResolver* template_resolver = nullptr;
    ui::rmlui::RuntimeUiComponentRegistry* component_registry = nullptr;
    std::unique_ptr<RuntimeInputListener> runtime_input_listener;
    std::function<void()> game_started_handler;
    std::optional<core::RuntimeShellViewState> runtime_shell_view;
    std::unordered_map<core::compiled::SystemLayoutRole, std::string> system_layout_documents;
    std::unordered_map<std::string, RuntimeUiLayoutMountContext> layout_mount_contexts;
    std::optional<std::string> active_layout_mount_document;
    bool system_layout_documents_authoritative = false;
    std::string title_project;
    std::string title_subtitle;
    std::string title_start_label;
    core::Diagnostics typed_diagnostics;
    lua_State* lua_state = nullptr;
    script::ScriptRuntime* scripts = nullptr;
    std::string typed_notification;
};

void RuntimeUI::State::refresh_data_model_shell()
{
    if (!data_model)
        return;
    if (!runtime_shell_view) {
        data_model->clear_shell();
        return;
    }
    std::vector<std::string> thumbnail_urls;
    thumbnail_urls.reserve(runtime_shell_view->slots.size());
    for (const auto& slot : runtime_shell_view->slots) {
        if (!slot.thumbnail) {
            thumbnail_urls.emplace_back();
            continue;
        }
        const std::string suffix =
            slot.slot.is_autosave() ? "autosave" : std::to_string(slot.slot.number());
        const std::string filename =
            "slot-" + suffix + "-thumbnail-" +
            std::to_string(runtime_shell_thumbnail_fingerprint(slot.thumbnail->bytes)) + ".png";
        const std::string path = "project:/generated/shell/" + filename;
        if (document_registry)
            document_registry->set_virtual_file(path, slot.thumbnail->bytes);
        thumbnail_urls.push_back("project:/generated/shell/" + filename);
    }
    data_model->set_shell(*runtime_shell_view, thumbnail_urls);
}

void RuntimeUI::State::refresh_action_gateway_shell_slots()
{
    if (!action_gateway)
        return;
    if (runtime_shell_view)
        action_gateway->set_shell_slots(runtime_shell_view->slots);
    else
        action_gateway->clear_shell_slots();
}

Rml::Context* RuntimeUI::State::context_for(ContextKey key)
{
    return host ? host->context_for(key) : nullptr;
}

Rml::ElementDocument* RuntimeUI::State::document(const std::string& id) const
{
    return document_registry ? document_registry->document(id) : nullptr;
}

std::optional<std::string>
RuntimeUI::State::system_document_id(core::compiled::SystemLayoutRole role) const
{
    const auto found = system_layout_documents.find(role);
    if (found != system_layout_documents.end())
        return found->second;
    if (system_layout_documents_authoritative)
        return std::nullopt;
    const auto fallback = builtin_document_id(role);
    return fallback.empty() ? std::nullopt : std::optional<std::string>(fallback);
}

Rml::ElementDocument* RuntimeUI::State::system_document(core::compiled::SystemLayoutRole role) const
{
    const auto id = system_document_id(role);
    return id && document_registry ? document_registry->document(*id) : nullptr;
}

std::optional<std::string> RuntimeUI::State::mount_document(ContextKey key) const
{
    if (!host || !document_registry)
        return std::nullopt;
    auto* context = host->find_context(key);
    if (!context)
        return std::nullopt;
    std::optional<std::string> result;
    for (const auto& [document_id, _] : layout_mount_contexts) {
        if (document_registry->document_context(document_id) != context)
            continue;
        if (result)
            return std::nullopt;
        result = document_id;
    }
    return result;
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
    if (const auto title = system_document_id(core::compiled::SystemLayoutRole::Title))
        (void)document_registry->hide(*title);
    auto game = system_document_id(core::compiled::SystemLayoutRole::GameHud);
    if (!game && !system_layout_documents_authoritative)
        game = std::string(kRuntimeGameDocumentId);
    if (!game)
        return;
    if (!document_registry->has_document(*game) && *game == kRuntimeGameDocumentId)
        load_runtime_document();
    if (document_registry->show(*game))
        refresh_game_hud_map();
}

bool RuntimeUI::State::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    return action_gateway && action_gateway->dispatch_shell_command(command);
}

bool RuntimeUI::State::dispatch_layout_typed_input(const core::RuntimeInputMessage& input)
{
    return action_gateway && action_gateway->dispatch_layout_input(input);
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
    lua_State* mount_lua_state = lua_state;
    game.set_function("mount_context", [this,
                                        mount_lua_state](sol::optional<std::string> document_id) {
        sol::state_view lua(mount_lua_state);
        const std::optional<std::string> selected =
            document_id ? std::optional<std::string>{*document_id} : active_layout_mount_document;
        if (!selected)
            return sol::make_object(lua, sol::lua_nil);
        const auto found = layout_mount_contexts.find(*selected);
        if (found == layout_mount_contexts.end())
            return sol::make_object(lua, sol::lua_nil);
        const auto context = std::make_shared<const RuntimeUiLayoutMountContext>(found->second);
        sol::table mount = lua.create_table();
        mount["document_id"] = *selected;
        mount["occurrence"] = context->occurrence.number();
        mount["null"] = mount_layout_state_null(lua);
        mount.set_function("input", [context, mount_lua_state](sol::table, std::string name) {
            sol::state_view lua(mount_lua_state);
            auto id = core::LayoutInputId::create(std::move(name));
            if (!id)
                return sol::make_object(lua, sol::lua_nil);
            const auto input =
                std::find_if(context->inputs.begin(), context->inputs.end(),
                             [&](const auto& value) { return value.input == *id.value_if(); });
            return input == context->inputs.end() ? sol::make_object(lua, sol::lua_nil)
                                                  : mount_lua_value(lua, input->value);
        });
        mount.set_function("state", [context, mount_lua_state](sol::table, std::string scope_name) {
            sol::state_view lua(mount_lua_state);
            const auto scope = mount_layout_state_scope(scope_name);
            if (!scope || !context->state_shape)
                return sol::make_object(lua, sol::lua_nil);
            const auto found =
                std::find_if(context->state_values.begin(), context->state_values.end(),
                             [&](const auto& candidate) { return candidate.scope == *scope; });
            return found == context->state_values.end() || !found->value
                       ? sol::make_object(lua, sol::lua_nil)
                       : mount_persistable_lua_value(lua, *found->value);
        });
        mount.set_function("commit_state", [this, context](sol::table, std::string scope_name,
                                                           sol::object value) {
            const auto scope = mount_layout_state_scope(scope_name);
            if (!scope || !context->state_shape)
                return false;
            std::unordered_set<const void*> active_tables;
            auto converted = mount_persistable_value(value, *context->state_shape, active_tables);
            if (!converted)
                return false;
            return dispatch_layout_typed_input(core::RuntimeInputMessage{
                core::CommitLayoutStateInput{context->owner, context->key, context->occurrence,
                                             *scope, std::move(*converted)}});
        });
        mount.set_function("clear_state", [this, context](sol::table, std::string scope_name) {
            const auto scope = mount_layout_state_scope(scope_name);
            return scope && context->state_shape &&
                   dispatch_layout_typed_input(
                       core::RuntimeInputMessage{core::ClearLayoutStateInput{
                           context->owner, context->key, context->occurrence, *scope}});
        });
        mount.set_function("signal", [this, context](sol::table, std::string name,
                                                     sol::optional<sol::table> payload) {
            auto signal = core::LayoutSignalId::create(std::move(name));
            if (!signal ||
                std::find(context->connected_signals.begin(), context->connected_signals.end(),
                          *signal.value_if()) == context->connected_signals.end())
                return false;
            std::vector<core::LayoutSignalFieldValue> fields;
            if (payload) {
                for (const auto& entry : *payload) {
                    const sol::object key = entry.first;
                    const sol::object value = entry.second;
                    if (key.get_type() != sol::type::string)
                        return false;
                    auto field = core::LayoutSignalFieldId::create(key.as<std::string>());
                    auto runtime_value = mount_runtime_value(value);
                    if (!field || !runtime_value)
                        return false;
                    fields.push_back({std::move(*field.value_if()), std::move(*runtime_value)});
                }
            }
            return dispatch_layout_typed_input(core::RuntimeInputMessage{
                core::LayoutSignalInput{context->owner, context->key, context->occurrence,
                                        std::move(*signal.value_if()), std::move(fields)}});
        });
        return sol::make_object(lua, std::move(mount));
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
        return action_gateway && action_gateway->action_save_slot(slot);
    });
    shell.set_function("load", [this](std::uint32_t slot) {
        return action_gateway && action_gateway->action_load_slot("manual", slot);
    });
    shell.set_function("load_autosave", [this]() {
        return action_gateway && action_gateway->action_load_slot("autosave", 0);
    });
    shell.set_function("set_ui_scale", [this](double scale) {
        return dispatch_shell_command(
            core::RuntimeShellCommand{core::SetRuntimeUiScaleShellCommand{scale}});
    });
    shell.set_function("set_text_scale", [this](double scale) {
        return dispatch_shell_command(
            core::RuntimeShellCommand{core::SetRuntimeTextScaleShellCommand{scale}});
    });
    shell.set_function("set_ui_scale_minimum", [this]() {
        return runtime_shell_view &&
               dispatch_shell_command(core::RuntimeShellCommand{core::SetRuntimeUiScaleShellCommand{
                   runtime_shell_view->accessibility.ui_scale.minimum}});
    });
    shell.set_function("set_ui_scale_default", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{
            core::SetRuntimeUiScaleShellCommand{core::RuntimeUserSettings::default_ui_scale}});
    });
    shell.set_function("set_ui_scale_maximum", [this]() {
        return runtime_shell_view &&
               dispatch_shell_command(core::RuntimeShellCommand{core::SetRuntimeUiScaleShellCommand{
                   runtime_shell_view->accessibility.ui_scale.maximum}});
    });
    shell.set_function("set_text_scale_minimum", [this]() {
        return runtime_shell_view &&
               dispatch_shell_command(
                   core::RuntimeShellCommand{core::SetRuntimeTextScaleShellCommand{
                       runtime_shell_view->accessibility.text_scale.minimum}});
    });
    shell.set_function("set_text_scale_default", [this]() {
        return dispatch_shell_command(core::RuntimeShellCommand{
            core::SetRuntimeTextScaleShellCommand{core::RuntimeUserSettings::default_text_scale}});
    });
    shell.set_function("set_text_scale_maximum", [this]() {
        return runtime_shell_view &&
               dispatch_shell_command(
                   core::RuntimeShellCommand{core::SetRuntimeTextScaleShellCommand{
                       runtime_shell_view->accessibility.text_scale.maximum}});
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
        state["ui_scale"] = runtime_shell_view->settings.ui_scale();
        state["text_scale"] = runtime_shell_view->settings.text_scale();
        state["status"] = runtime_shell_view->status;
        sol::table accessibility = lua.create_table();
        const auto add_policy = [&](const char* name,
                                    const core::compiled::AccessibilityScalePolicy& policy) {
            sol::table value = lua.create_table();
            value["enabled"] = policy.enabled;
            value["minimum"] = policy.minimum;
            value["maximum"] = policy.maximum;
            accessibility[name] = std::move(value);
        };
        add_policy("ui_scale", runtime_shell_view->accessibility.ui_scale);
        add_policy("text_scale", runtime_shell_view->accessibility.text_scale);
        state["accessibility"] = std::move(accessibility);
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
    if (game_object.valid() && game_object.get_type() == sol::type::table) {
        auto game = game_object.as<sol::table>();
        game["shell"] = sol::lua_nil;
        game["mount_context"] = sol::lua_nil;
    }
}

void RuntimeUI::State::refresh_text_log_map()
{
    if (!action_gateway || !action_gateway->view())
        return;
    auto* document = system_document(core::compiled::SystemLayoutRole::TextLog);
    if (!document)
        return;
    for_each_component<ui::rmlui::NtMapViewElement>(
        *document, "nt-map-view", [&](ui::rmlui::NtMapViewElement& map_view) {
            map_view.set_snapshot(ui::rmlui::make_map_view_snapshot(*action_gateway->view(),
                                                                    map_view.requested_map()));
        });
}

void RuntimeUI::State::refresh_game_hud_map()
{
    auto* doc = system_document(core::compiled::SystemLayoutRole::GameHud);
    if (!doc || !action_gateway || !action_gateway->view())
        return;
    for_each_component<ui::rmlui::NtMapViewElement>(
        *doc, "nt-map-view", [&](ui::rmlui::NtMapViewElement& map_view) {
            map_view.set_snapshot(ui::rmlui::make_map_view_snapshot(*action_gateway->view(),
                                                                    map_view.requested_map()));
        });
    refresh_mounted_maps();
}

void RuntimeUI::State::refresh_mounted_maps()
{
    if (!action_gateway || !action_gateway->view())
        return;
    for (const auto& [document_id, context] : layout_mount_contexts) {
        (void)context;
        auto* doc = document(document_id);
        if (!doc)
            continue;
        for_each_component<ui::rmlui::NtMapViewElement>(
            *doc, "nt-map-view", [&](ui::rmlui::NtMapViewElement& map_view) {
                map_view.set_snapshot(ui::rmlui::make_map_view_snapshot(*action_gateway->view(),
                                                                        map_view.requested_map()));
            });
    }
}

void RuntimeUI::State::refresh_active_text_layout()
{
    if (!active_text_presenter)
        return;
    auto* doc = system_document(core::compiled::SystemLayoutRole::GameHud);
    const auto* view = action_gateway ? action_gateway->view() : nullptr;
    if (!view) {
        active_text_presenter->refresh_layout(nullptr, std::nullopt);
        return;
    }
    if (doc) {
        if (auto* active_text =
                find_first_component<ui::rmlui::NtActiveTextElement>(*doc, "nt-active-text")) {
            active_text->set_snapshot(ui::rmlui::make_active_text_snapshot(*view));
        }
    }
    active_text_presenter->refresh_layout(view, doc && host ? active_text_surface(*doc, *host)
                                                            : std::nullopt);
}

void RuntimeUI::State::RuntimeInputListener::ProcessEvent(Rml::Event& event)
{
    Rml::Element* target = event.GetTargetElement();
    if (!target)
        return;

    if (owner.action_gateway && owner.action_gateway->has_input_sink() &&
        owner.active_text_presenter && find_ancestor_tag(target, "nt-active-text")) {
        const auto* gameplay_view = owner.action_gateway->view();
        // RmlUi event coordinates are already in this document's context-logical space. ActiveText
        // hit testing deliberately remains in that same space.
        const float x = static_cast<float>(event.GetParameter<int>("mouse_x", 0));
        const float y = static_cast<float>(event.GetParameter<int>("mouse_y", 0));
        auto activation = owner.active_text_presenter->activate(gameplay_view, x, y);
        if (activation.local_state_changed) {
            owner.refresh_game_hud_map();
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
    m_state->active_text_presenter.reset();
    m_state->scripts = nullptr;
    if (m_state->document_registry) {
        m_state->document_registry->clear();
        m_state->document_registry.reset();
    }
    if (m_state->data_model)
        m_state->data_model->detach_all();
    if (m_state->host)
        m_state->host->set_context_initializer({});
    m_state->data_model.reset();
    if (m_state->host)
        m_state->host->shutdown();
    m_state->action_gateway.reset();
    m_state->runtime_input_listener.reset();
    delete m_state->template_resolver;
    m_state->template_resolver = nullptr;
    delete m_state->component_registry;
    m_state->component_registry = nullptr;
    m_state->host.reset();
    delete m_state;
    m_state = nullptr;
}

bool RuntimeUI::initialize(assets::AssetManager* assets, SDL_Window* window,
                           script::ScriptRuntime* scripts,
                           const ShaderMaterialProject* shader_materials,
                           ui::rmlui::ActiveTextPresenterShaper active_text_shaper,
                           bool headless_render)
{
    if (m_initialized)
        return true;

    if (!assets) {
        std::fprintf(stderr, "[runtime_ui] no AssetManager for RmlUi\n");
        return false;
    }
    if (!active_text_shaper) {
        std::fprintf(stderr,
                     "[runtime_ui] no ActiveText shaper for renderer-owned text pipeline\n");
        return false;
    }

    if (!m_state)
        m_state = new State;
    if (!m_state->host)
        m_state->host = std::make_unique<ui::rmlui::RmlUiHost>();
    if (!m_state->active_text_presenter) {
        m_state->active_text_presenter =
            std::make_unique<ui::rmlui::ActiveTextPresenter>(m_state->typed_diagnostics);
        m_state->active_text_presenter->initialize(*assets, std::move(active_text_shaper));
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
    if (!m_state->action_gateway)
        m_state->action_gateway =
            std::make_unique<ui::rmlui::RuntimeUiActionGateway>(m_state->typed_diagnostics);
    m_state->action_gateway->set_lua_state(m_state->lua_state);
    m_state->refresh_action_gateway_shell_slots();
    if (!m_state->data_model) {
        m_state->data_model =
            std::make_unique<ui::rmlui::RuntimeUiDataModel>(*m_state->action_gateway);
        m_state->data_model->set_project(m_state->title_project, m_state->title_subtitle,
                                         m_state->title_start_label);
        if (const auto* view = m_state->action_gateway->view()) {
            m_state->data_model->set_gameplay(
                RuntimeUiGameplayValues{m_state->action_gateway->revision(), *view},
                m_state->typed_notification);
        } else {
            m_state->data_model->clear_gameplay();
        }
        m_state->refresh_data_model_shell();
    }
    m_state->host->set_context_initializer(
        [model = m_state->data_model.get()](Rml::Context& context) {
            return model && model->attach_context(context);
        });
    if (m_state->action_gateway->has_input_sink())
        m_state->install_shell_lua_api();
    const auto& pending_presentation = m_state->host->presentation();
    if (!m_state->host->initialize(
            ui::rmlui::RmlUiHost::Config{.assets = assets,
                                         .window = window,
                                         .lua_state = m_state->lua_state,
                                         .shader_materials = shader_materials,
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
    m_state->refresh_data_model_shell();
    m_state->playback_driver = std::make_unique<ui::rmlui::RuntimeUiPlaybackDriver>(
        *m_state->host, *m_state->document_registry,
        [state = m_state](core::MountedLayoutOwner owner, const std::function<bool()>& dispatch) {
            return state->action_gateway &&
                   state->action_gateway->dispatch_layout_event(owner, dispatch);
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

void ui::rmlui::RuntimeUiFacadeAccess::set_raster_snapping(RuntimeUI& runtime_ui,
                                                           bool geometry_enabled, bool text_enabled)
{
    if (runtime_ui.m_state && runtime_ui.m_state->host)
        runtime_ui.m_state->host->set_raster_snapping(geometry_enabled, text_enabled);
}

void ui::rmlui::RuntimeUiFacadeAccess::set_context_render_observer(
    RuntimeUI& runtime_ui,
    std::function<void(const LifecycleContextKey&, const ResolvedContextMetrics&)> observer)
{
    if (runtime_ui.m_state && runtime_ui.m_state->host)
        runtime_ui.m_state->host->set_context_render_observer(std::move(observer));
}

RuntimeUiEventResult RuntimeUI::process_event(const SDL_Event& event)
{
    RuntimeUiEventResult result;
    m_last_event_consumed = false;
    if (!m_state || !m_state->host || m_state->host->contexts().empty()) {
        return result;
    }

    if (m_state->action_gateway)
        m_state->action_gateway->begin_event_capture();
    m_last_event_consumed = m_state->host->process_event(
        event,
        [this](Rml::Context* context) {
            return m_state->document_registry &&
                   m_state->document_registry->has_visible_document(context);
        },
        [this](const State::ContextKey& key, core::MountedLayoutOwner owner,
               const std::function<bool()>& dispatch) {
            const auto previous = m_state->active_layout_mount_document;
            m_state->active_layout_mount_document = m_state->mount_document(key);
            const bool handled = m_state->action_gateway &&
                                 m_state->action_gateway->dispatch_layout_event(owner, dispatch);
            m_state->active_layout_mount_document = previous;
            return handled;
        });
    if (m_state->action_gateway)
        result = m_state->action_gateway->finish_event_capture();
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
        if (m_state->active_text_presenter) {
            auto reveal_input = m_state->active_text_presenter->advance(
                m_state->action_gateway ? m_state->action_gateway->view() : nullptr, delta_time);
            if (reveal_input && m_state->action_gateway)
                (void)m_state->action_gateway->dispatch_input(*reveal_input);
        }
        m_state->refresh_game_hud_map();
        m_state->host->update_contexts();
        m_state->refresh_active_text_layout();
    }
}

void RuntimeUI::set_final_output_framebuffer(std::uint16_t framebuffer)
{
    if (m_state && m_state->host)
        m_state->host->set_final_output_framebuffer(framebuffer);
}

void RuntimeUI::set_postprocess_framebuffers(std::uint16_t world, std::uint16_t full_game)
{
    if (m_state && m_state->host)
        m_state->host->set_postprocess_framebuffers(world, full_game);
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

void RuntimeUI::end_frame(bool include_debug_plane)
{
    if (m_state && m_state->host)
        m_state->host->end_frame(include_debug_plane);
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
                                         core::MountedLayoutOwner owner,
                                         core::LayoutScalePolicy scale_policy,
                                         std::uint32_t compatibility_group)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey key = ui::rmlui::make_lifecycle_context_key(
        policy, composition_group, owner, scale_policy, compatibility_group);
    return m_state->document_registry->load_path(id, path, show, key);
}

bool RuntimeUI::load_document_from_memory_for_layout(const std::string& id, const std::string& rml,
                                                     const std::string& source_url, bool show,
                                                     const core::MountedLayoutPolicy& policy,
                                                     std::uint32_t composition_group,
                                                     core::MountedLayoutOwner owner,
                                                     core::LayoutScalePolicy scale_policy,
                                                     std::uint32_t compatibility_group)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey key = ui::rmlui::make_lifecycle_context_key(
        policy, composition_group, owner, scale_policy, compatibility_group);
    return m_state->document_registry->load_memory(id, rml, source_url, show, key);
}

bool RuntimeUI::load_builtin_for_layout(RuntimeLayoutBuiltinDocument builtin_document,
                                        const core::MountedLayoutPolicy& policy,
                                        std::uint32_t composition_group,
                                        core::MountedLayoutOwner owner,
                                        core::LayoutScalePolicy scale_policy,
                                        std::uint32_t compatibility_group)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey key = ui::rmlui::make_lifecycle_context_key(
        policy, composition_group, owner, scale_policy, compatibility_group);
    std::string runtime_document_path;
    if (builtin_document == RuntimeLayoutBuiltinDocument::GameHud && m_state->template_resolver)
        runtime_document_path = m_state->template_resolver->resolve_runtime_document();
    const bool loaded = m_state->document_registry->load_builtin(builtin_document,
                                                                 runtime_document_path, true, key);
    if (loaded) {
        if (builtin_document == RuntimeLayoutBuiltinDocument::GameHud)
            m_state->refresh_game_hud_map();
        else
            m_state->refresh_text_log_map();
    }
    return loaded;
}

void RuntimeUI::set_system_layout_documents(
    const std::vector<presentation::RuntimeSystemLayoutDocumentBinding>& bindings)
{
    if (!m_state && bindings.empty())
        return;
    if (!m_state)
        m_state = new State;

    std::unordered_map<core::compiled::SystemLayoutRole, std::string> next;
    next.reserve(bindings.size());
    for (const auto& binding : bindings)
        next.insert_or_assign(binding.role, binding.document_id);

    if (m_state->document_registry) {
        for (const auto& [role, document_id] : m_state->system_layout_documents) {
            const auto found = next.find(role);
            if (found == next.end() || found->second != document_id)
                (void)m_state->document_registry->set_runtime_input(document_id, false);
        }
    }

    m_state->system_layout_documents = std::move(next);
    m_state->system_layout_documents_authoritative = true;
    if (m_state->document_registry) {
        for (const auto& [_, document_id] : m_state->system_layout_documents)
            (void)m_state->document_registry->set_runtime_input(document_id, true);
    }
    m_state->refresh_game_hud_map();
    m_state->refresh_text_log_map();
    m_state->refresh_active_text_layout();
}

bool RuntimeUI::apply_layout_order(const std::vector<std::string>& ordered_document_ids)
{
    return m_state && m_state->document_registry &&
           m_state->document_registry->apply_order(ordered_document_ids);
}

bool RuntimeUI::apply_layout_policy(const std::string& document_id,
                                    const core::MountedLayoutPolicy& policy,
                                    std::uint32_t composition_group, core::MountedLayoutOwner owner,
                                    core::LayoutScalePolicy scale_policy,
                                    std::uint32_t compatibility_group)
{
    if (!m_state || !m_state->document_registry)
        return false;
    const State::ContextKey desired = ui::rmlui::make_lifecycle_context_key(
        policy, composition_group, owner, scale_policy, compatibility_group);
    const bool applied = m_state->document_registry->recreate_in_context(document_id, desired);
    if (applied) {
        m_state->refresh_game_hud_map();
        m_state->refresh_text_log_map();
        m_state->refresh_active_text_layout();
    }
    return applied;
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
    if (!m_state || !m_state->document_registry)
        return false;
    const bool unloaded = m_state->document_registry->unload(id);
    if (unloaded)
        m_state->layout_mount_contexts.erase(id);
    return unloaded;
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

void RuntimeUI::set_layout_mount_context(const std::string& id,
                                         std::optional<RuntimeUiLayoutMountContext> context)
{
    if (!m_state)
        return;
    if (context) {
        if (m_state->host && m_state->document_registry) {
            m_state->host->set_context_material_parameters(
                m_state->document_registry->document_context(id), context->material_parameters,
                context->material_camera_zoom);
        }
        m_state->layout_mount_contexts.insert_or_assign(id, std::move(*context));
    } else {
        if (m_state->host && m_state->document_registry) {
            m_state->host->set_context_material_parameters(
                m_state->document_registry->document_context(id), {}, 1.0);
        }
        m_state->layout_mount_contexts.erase(id);
    }
    m_state->refresh_mounted_maps();
}

std::optional<RuntimeUiLayoutMountContext>
RuntimeUI::layout_mount_context(const std::string& id) const
{
    if (!m_state)
        return std::nullopt;
    const auto found = m_state->layout_mount_contexts.find(id);
    return found == m_state->layout_mount_contexts.end()
               ? std::nullopt
               : std::optional<RuntimeUiLayoutMountContext>{found->second};
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_title_document(RuntimeUI& runtime_ui)
{
    return runtime_ui.m_state && runtime_ui.m_state->document_registry &&
           runtime_ui.m_state->document_registry->load_builtin(RuntimeLayoutBuiltinDocument::Title,
                                                               {}, true);
}

void RuntimeUI::bind_title_document(const std::string& project_title, const std::string& subtitle,
                                    const std::string& start_label)
{
    if (!m_state)
        return;
    m_state->title_project = project_title;
    m_state->title_subtitle = subtitle;
    m_state->title_start_label = start_label;
    if (m_state->data_model)
        m_state->data_model->set_project(project_title, subtitle, start_label);
}

bool ui::rmlui::RuntimeUiFacadeAccess::load_runtime_document(RuntimeUI& runtime_ui)
{
    if (!runtime_ui.m_state || !runtime_ui.m_state->document_registry)
        return false;
    std::optional<std::string> document_id;
    if (!runtime_ui.m_state->system_layout_documents_authoritative) {
        runtime_ui.m_state->load_runtime_document();
        document_id = std::string(kRuntimeGameDocumentId);
    } else
        document_id =
            runtime_ui.m_state->system_document_id(core::compiled::SystemLayoutRole::GameHud);
    if (document_id && runtime_ui.m_state->document_registry->show(*document_id)) {
        runtime_ui.m_state->refresh_game_hud_map();
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
    runtime_ui.m_state->refresh_text_log_map();
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
    runtime_ui.m_state->refresh_text_log_map();
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
    m_state->refresh_game_hud_map();
    m_state->refresh_text_log_map();
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
    if (!m_state->action_gateway) {
        m_state->action_gateway =
            std::make_unique<ui::rmlui::RuntimeUiActionGateway>(m_state->typed_diagnostics);
        m_state->action_gateway->set_lua_state(m_state->lua_state);
    }
    m_state->refresh_action_gateway_shell_slots();
    m_state->action_gateway->bind_input_sink(sink);
    if (sink) {
        m_state->install_shell_lua_api();
    } else
        m_state->remove_shell_lua_api();
}

bool RuntimeUI::apply_gameplay_ui_values(const RuntimeUiGameplayValues& values)
{
    if (!m_state)
        return values.revision != 0;
    if (!m_state->action_gateway) {
        m_state->action_gateway =
            std::make_unique<ui::rmlui::RuntimeUiActionGateway>(m_state->typed_diagnostics);
        m_state->action_gateway->set_lua_state(m_state->lua_state);
    }
    m_state->refresh_action_gateway_shell_slots();
    if (!m_state->action_gateway->apply(values))
        return false;
    if (m_state->data_model)
        m_state->data_model->set_gameplay(values, m_state->typed_notification);
    m_state->refresh_game_hud_map();
    m_state->refresh_text_log_map();
    m_state->refresh_active_text_layout();
    return true;
}

core::Result<RuntimeUiGameplayValues, core::Diagnostics>
RuntimeUI::prepare_gameplay_ui_values(RuntimeUiGameplayValues values)
{
    if (!m_state)
        m_state = new State;
    if (!m_state->action_gateway) {
        m_state->action_gateway =
            std::make_unique<ui::rmlui::RuntimeUiActionGateway>(m_state->typed_diagnostics);
        m_state->action_gateway->set_lua_state(m_state->lua_state);
    }
    m_state->refresh_action_gateway_shell_slots();
    if (!m_state->action_gateway->can_apply(values)) {
        return core::Result<RuntimeUiGameplayValues, core::Diagnostics>::failure({{
            .code = "runtime_ui.stale_gameplay_values",
            .message = "Gameplay UI revision is zero or older than the applied revision",
        }});
    }
    return core::Result<RuntimeUiGameplayValues, core::Diagnostics>::success(std::move(values));
}

void RuntimeUI::commit_gameplay_ui_values(RuntimeUiGameplayValues values) noexcept
{
    if (!m_state)
        return;
    if (!m_state->action_gateway) {
        m_state->action_gateway =
            std::make_unique<ui::rmlui::RuntimeUiActionGateway>(m_state->typed_diagnostics);
        m_state->action_gateway->set_lua_state(m_state->lua_state);
    }
    m_state->refresh_action_gateway_shell_slots();
    m_state->action_gateway->commit(values);
    if (m_state->data_model)
        m_state->data_model->set_gameplay(values, m_state->typed_notification);
    m_state->refresh_game_hud_map();
    m_state->refresh_text_log_map();
    m_state->refresh_active_text_layout();
}

void RuntimeUI::clear_gameplay_ui_values()
{
    if (!m_state)
        return;
    if (m_state->action_gateway)
        m_state->action_gateway->clear_gameplay_values();
    if (m_state->data_model)
        m_state->data_model->clear_gameplay();
    m_state->refresh_game_hud_map();
    m_state->refresh_active_text_layout();
}

core::Result<void, core::Diagnostics>
RuntimeUI::reconfigure_environment(const PresentationMetrics& presentation,
                                   const core::RuntimeUserSettings& settings)
{
    if (!m_state)
        m_state = new State;
    if (!m_state->host)
        m_state->host = std::make_unique<ui::rmlui::RmlUiHost>();
    return m_state->host->reconfigure_environment(presentation, settings);
}

core::Result<ui::rmlui::RmlUiHost::PreparedEnvironment, core::Diagnostics>
RuntimeUI::prepare_environment(const PresentationMetrics& presentation,
                               const core::RuntimeUserSettings& settings)
{
    if (!m_state)
        m_state = new State;
    if (!m_state->host)
        m_state->host = std::make_unique<ui::rmlui::RmlUiHost>();
    return m_state->host->prepare_environment(presentation, settings);
}

void RuntimeUI::commit_environment(ui::rmlui::RmlUiHost::PreparedEnvironment prepared) noexcept
{
    if (!m_state || !m_state->host)
        return;
    m_state->host->commit_environment(std::move(prepared));
}

core::Result<void, core::Diagnostics>
RuntimeUI::reconfigure_user_settings(const core::RuntimeUserSettings& settings)
{
    if (!m_state)
        m_state = new State;
    if (!m_state->host)
        m_state->host = std::make_unique<ui::rmlui::RmlUiHost>();
    return m_state->host->reconfigure_user_settings(settings);
}

void RuntimeUI::apply_runtime_shell_view(core::RuntimeShellViewState view)
{
    if (!m_state)
        return;
    m_state->runtime_shell_view = std::move(view);
    m_state->refresh_action_gateway_shell_slots();
    m_state->refresh_data_model_shell();
    m_state->refresh_text_log_map();
}

void RuntimeUI::clear_runtime_shell_view()
{
    if (!m_state)
        return;
    m_state->runtime_shell_view.reset();
    m_state->refresh_action_gateway_shell_slots();
    m_state->refresh_data_model_shell();
    m_state->refresh_text_log_map();
}

void RuntimeUI::set_runtime_notification(std::string notification)
{
    if (!m_state)
        return;
    m_state->typed_notification = std::move(notification);
    if (m_state->data_model)
        m_state->data_model->set_gameplay_notification(
            m_state->typed_notification,
            m_state->action_gateway ? m_state->action_gateway->view() : nullptr);
    m_state->refresh_game_hud_map();
    m_state->refresh_text_log_map();
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

void RuntimeUI::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    if (!m_state)
        return;
    if (!m_state->action_gateway) {
        m_state->action_gateway =
            std::make_unique<ui::rmlui::RuntimeUiActionGateway>(m_state->typed_diagnostics);
        m_state->action_gateway->set_lua_state(m_state->lua_state);
    }
    m_state->refresh_action_gateway_shell_slots();
    m_state->action_gateway->bind_layout_gameplay_admission(std::move(admission));
}

void ui::rmlui::RuntimeUiFacadeAccess::bind_game_started_handler(RuntimeUI& runtime_ui,
                                                                 std::function<void()> handler)
{
    if (runtime_ui.m_state)
        runtime_ui.m_state->game_started_handler = std::move(handler);
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
