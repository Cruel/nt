#pragma once

#include "noveltea/core/runtime_io.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea {

class RuntimeShell;

enum class RuntimeCommandSource {
    Engine,
    Platform,
    RmlUiEvent,
    LayoutLua,
    GameplayLua,
    EditorPreview,
    Playback,
};

enum class RuntimeCommandDomain {
    Shell,
    Gameplay,
    Layout,
    Audio,
    Save,
    Debug,
};

struct RuntimeCommand {
    RuntimeCommandSource source = RuntimeCommandSource::Engine;
    RuntimeCommandDomain domain = RuntimeCommandDomain::Shell;
    std::string name;
    nlohmann::json payload = nlohmann::json::object();
    std::optional<std::uint64_t> playback_step_index;
};

struct RuntimeCommandResult {
    bool handled = false;
    core::RuntimeInputResult input_result;
    std::vector<core::RuntimeOutput> outputs;
    std::vector<core::RuntimeDiagnostic> diagnostics;
};

class RuntimeCommandDispatcher {
public:
    RuntimeCommandDispatcher() = default;
    explicit RuntimeCommandDispatcher(RuntimeShell& shell);

    void bind(RuntimeShell* shell) noexcept;
    [[nodiscard]] RuntimeShell* shell() const noexcept { return m_shell; }

    [[nodiscard]] RuntimeCommandResult dispatch(RuntimeCommand command);

private:
    RuntimeShell* m_shell = nullptr;
};

[[nodiscard]] const char* to_string(RuntimeCommandSource source) noexcept;
[[nodiscard]] const char* to_string(RuntimeCommandDomain domain) noexcept;
[[nodiscard]] RuntimeCommandDomain domain_from_command_name(const std::string& name) noexcept;

} // namespace noveltea
