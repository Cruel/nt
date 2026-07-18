#pragma once

#include "noveltea/runtime_ui_contracts.hpp"
#include "ui/rmlui/rmlui_document_binder.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string_view>

struct lua_State;

namespace Rml {
class ElementDocument;
}

namespace noveltea::ui::rmlui {

class RuntimeUiBinder {
public:
    explicit RuntimeUiBinder(core::Diagnostics& diagnostics);
    ~RuntimeUiBinder();

    RuntimeUiBinder(const RuntimeUiBinder&) = delete;
    RuntimeUiBinder& operator=(const RuntimeUiBinder&) = delete;

    void set_lua_state(lua_State* state) noexcept;
    void bind_input_sink(RuntimeUiInputSink* sink) noexcept;
    void bind_asset_service(const RuntimeUiAssetService* service) noexcept;
    void bind_layout_gameplay_admission(std::function<bool()> admission);

    [[nodiscard]] bool apply(const RuntimeUiGameplayValues& values);
    void clear_gameplay_values();

    [[nodiscard]] const core::TypedRuntimeUIViewState* view() const noexcept;
    [[nodiscard]] std::uint64_t revision() const noexcept;
    [[nodiscard]] bool has_input_sink() const noexcept { return m_input_sink != nullptr; }

    void bind_document(Rml::ElementDocument& document, std::string_view notification = {});

    [[nodiscard]] bool dispatch_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] bool dispatch_layout_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] bool dispatch_shell_command(const core::RuntimeShellCommand& command);
    [[nodiscard]] bool dispatch_layout_event(core::MountedLayoutOwner owner,
                                             const std::function<bool()>& dispatch);

private:
    void install_lua_api();
    void remove_lua_api() noexcept;
    [[nodiscard]] bool invalid(std::string code, std::string message);

    core::Diagnostics& m_diagnostics;
    RuntimeUiDocumentBinder m_document_binder;
    lua_State* m_lua_state = nullptr;
    RuntimeUiInputSink* m_input_sink = nullptr;
    const RuntimeUiAssetService* m_asset_service = nullptr;
    std::function<bool()> m_layout_gameplay_admission;
    std::optional<RuntimeUiGameplayValues> m_values;
};

} // namespace noveltea::ui::rmlui
