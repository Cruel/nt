#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/runtime_user_settings.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"

#include <compare>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

enum class RuntimeShellScreen : std::uint8_t {
    None,
    Title,
    Pause,
    Settings,
    Save,
    Load,
    TextLog,
    Confirmation,
    Debug,
};

enum class RuntimeShellConfirmationKind : std::uint8_t {
    ReturnToTitle,
    Quit,
    LoadSlot,
};

struct RuntimeShellConfirmation {
    RuntimeShellConfirmationKind kind;
    std::optional<TypedSaveSlotId> slot;
    std::string prompt;
    bool operator==(const RuntimeShellConfirmation&) const = default;
};

struct RuntimeShellSaveSlotView {
    TypedSaveSlotId slot;
    bool occupied = false;
    std::optional<SaveCheckpointMetadata> metadata;
    std::optional<SaveCheckpointThumbnail> thumbnail;
    bool operator==(const RuntimeShellSaveSlotView&) const = default;
};

struct RuntimeShellViewState {
    RuntimeShellScreen screen = RuntimeShellScreen::None;
    RuntimeUserSettings settings = RuntimeUserSettings::defaults();
    std::optional<CheckpointRuntimeObservation> checkpoint;
    std::vector<RuntimeShellSaveSlotView> slots;
    TextLogView text_log;
    std::optional<RuntimeShellConfirmation> confirmation;
    std::string status;
    bool game_active = false;
};

struct StartGameShellCommand {
    auto operator<=>(const StartGameShellCommand&) const = default;
};
struct OpenPauseShellCommand {
    auto operator<=>(const OpenPauseShellCommand&) const = default;
};
struct ResumeGameShellCommand {
    auto operator<=>(const ResumeGameShellCommand&) const = default;
};
struct OpenSettingsShellCommand {
    auto operator<=>(const OpenSettingsShellCommand&) const = default;
};
struct OpenSaveShellCommand {
    auto operator<=>(const OpenSaveShellCommand&) const = default;
};
struct OpenLoadShellCommand {
    auto operator<=>(const OpenLoadShellCommand&) const = default;
};
struct OpenTextLogShellCommand {
    auto operator<=>(const OpenTextLogShellCommand&) const = default;
};
struct OpenDebugShellCommand {
    auto operator<=>(const OpenDebugShellCommand&) const = default;
};
struct CloseShellScreenCommand {
    auto operator<=>(const CloseShellScreenCommand&) const = default;
};
struct RequestReturnToTitleShellCommand {
    auto operator<=>(const RequestReturnToTitleShellCommand&) const = default;
};
struct RequestQuitShellCommand {
    auto operator<=>(const RequestQuitShellCommand&) const = default;
};
struct SaveShellSlotCommand {
    TypedSaveSlotId slot;
    auto operator<=>(const SaveShellSlotCommand&) const = default;
};
struct RequestLoadShellSlotCommand {
    TypedSaveSlotId slot;
    auto operator<=>(const RequestLoadShellSlotCommand&) const = default;
};
struct SetRuntimeTextScaleShellCommand {
    double scale = RuntimeUserSettings::default_text_scale;
    auto operator<=>(const SetRuntimeTextScaleShellCommand&) const = default;
};
struct ConfirmShellCommand {
    auto operator<=>(const ConfirmShellCommand&) const = default;
};
struct CancelShellCommand {
    auto operator<=>(const CancelShellCommand&) const = default;
};

using RuntimeShellCommand =
    std::variant<StartGameShellCommand, OpenPauseShellCommand, ResumeGameShellCommand,
                 OpenSettingsShellCommand, OpenSaveShellCommand, OpenLoadShellCommand,
                 OpenTextLogShellCommand, OpenDebugShellCommand, CloseShellScreenCommand,
                 RequestReturnToTitleShellCommand, RequestQuitShellCommand, SaveShellSlotCommand,
                 RequestLoadShellSlotCommand, SetRuntimeTextScaleShellCommand, ConfirmShellCommand,
                 CancelShellCommand>;

} // namespace noveltea::core
