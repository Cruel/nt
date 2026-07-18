#pragma once

#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_shell_contracts.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

struct RuntimeUiGameplayValues {
    std::uint64_t revision = 0;
    core::TypedRuntimeUIViewState view;
};

struct RuntimeUiEventResult {
    bool consumed = false;
    bool wants_pointer = false;
    bool wants_keyboard = false;
    std::vector<core::RuntimeInputMessage> runtime_inputs;
    std::vector<core::RuntimeShellCommand> shell_commands;
};

class RuntimeUiInputSink {
public:
    virtual ~RuntimeUiInputSink() = default;

    [[nodiscard]] virtual bool submit_gameplay_input(core::RuntimeInputMessage input) = 0;
    [[nodiscard]] virtual bool submit_shell_command(core::RuntimeShellCommand command) = 0;
    [[nodiscard]] virtual bool dispatch_layout_event(core::MountedLayoutOwner owner,
                                                     const std::function<bool()>& dispatch) = 0;
};

class RuntimeUiAssetService {
public:
    virtual ~RuntimeUiAssetService() = default;

    [[nodiscard]] virtual std::optional<std::string> resolve(const core::AssetId& asset) const = 0;
};

} // namespace noveltea
