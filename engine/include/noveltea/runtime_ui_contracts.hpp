#pragma once

#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"
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

struct RuntimeUiLayoutMountContext {
    core::PresentationOwner owner;
    core::MountedLayoutPresentationKey key;
    core::LayoutMountOccurrenceId occurrence;
    std::vector<core::LayoutResolvedInput> inputs;
    std::vector<core::LayoutSignalId> connected_signals;
    std::optional<core::LayoutStateShape> state_shape;
    std::vector<core::PresentationLayoutStateValue> state_values;
    std::vector<core::PresentationMaterialParameter> material_parameters;
    double material_camera_zoom = 1.0;
    std::optional<core::TriggerContext> trigger_context;
    bool operator==(const RuntimeUiLayoutMountContext&) const = default;
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
