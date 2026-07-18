#pragma once

#include "noveltea/runtime_ui_contracts.hpp"

#include <cstdint>
#include <string>

namespace noveltea::core {
enum class ActiveTextPresentationPhase : std::uint8_t;
}

namespace noveltea::host {

// Narrow application-scoped RuntimeUI dependency used by GameHost. The concrete RmlUi facade
// implements this contract, while host unit tests use a backend-free fake.
class RuntimeUiHost {
public:
    virtual ~RuntimeUiHost() = default;

    RuntimeUiHost(const RuntimeUiHost&) = delete;
    RuntimeUiHost& operator=(const RuntimeUiHost&) = delete;
    RuntimeUiHost(RuntimeUiHost&&) = delete;
    RuntimeUiHost& operator=(RuntimeUiHost&&) = delete;

    virtual void bind_input_sink(RuntimeUiInputSink* sink) noexcept = 0;
    virtual void bind_asset_service(const RuntimeUiAssetService* service) noexcept = 0;
    [[nodiscard]] virtual bool apply_gameplay_ui_values(const RuntimeUiGameplayValues& values) = 0;
    virtual void clear_gameplay_ui_values() = 0;
    virtual void clear_runtime_shell_view() = 0;
    virtual void set_runtime_notification(std::string notification) = 0;
    virtual void append_typed_runtime_diagnostics(core::Diagnostics diagnostics) = 0;
    virtual void clear_typed_runtime_diagnostics() = 0;
    [[nodiscard]] virtual core::ActiveTextPresentationPhase
    active_text_presentation_phase() const noexcept = 0;
    virtual void bind_title_document(const std::string& project_title, const std::string& subtitle,
                                     const std::string& start_label) = 0;

protected:
    RuntimeUiHost() = default;
};

} // namespace noveltea::host
