#include <noveltea/core/save_state_codec_port.hpp>
#include <noveltea/core/typed_save_slot_store.hpp>
#include <noveltea/runtime/runtime_ports.hpp>

#include "public_header_probe_guard.hpp"

#include <string>
#include <string_view>
#include <type_traits>

namespace {

using noveltea::core::Diagnostics;

class FakeScriptInvocationPort final : public noveltea::runtime::ScriptInvocationPort {
public:
    [[nodiscard]] noveltea::core::Result<noveltea::runtime::ScriptInvocationOutcome,
                                         noveltea::runtime::ScriptInvocationError>
    invoke(const noveltea::runtime::ScriptInvocationRequest&,
           const noveltea::runtime::RuntimeCapabilitySet&) override
    {
        return noveltea::core::Result<noveltea::runtime::ScriptInvocationOutcome,
                                      noveltea::runtime::ScriptInvocationError>::failure({});
    }

    [[nodiscard]] noveltea::core::Result<noveltea::runtime::ScriptInvocationOutcome,
                                         noveltea::runtime::ScriptInvocationError>
    resume(const noveltea::core::ScriptInvocationHandle&,
           const noveltea::runtime::RuntimeCapabilitySet&) override
    {
        return noveltea::core::Result<noveltea::runtime::ScriptInvocationOutcome,
                                      noveltea::runtime::ScriptInvocationError>::failure({});
    }

    void cancel(const noveltea::core::ScriptInvocationHandle&,
                noveltea::runtime::ScriptCancellationReason) override
    {
    }

    void invalidate_capabilities(noveltea::runtime::CapabilityGeneration) noexcept override {}
};

class FakePresentationModelPort final : public noveltea::runtime::PresentationModelPort {
public:
    [[nodiscard]] noveltea::core::Result<noveltea::core::PresentationTargetDraft, Diagnostics>
    build_transition_target(
        const noveltea::core::PresentationTargetDraft&,
        const std::vector<noveltea::core::TransitionGroupTargetMutation>&) const override
    {
        return noveltea::core::Result<noveltea::core::PresentationTargetDraft,
                                      Diagnostics>::failure({});
    }

    [[nodiscard]] noveltea::core::Result<noveltea::core::PreparedRoomNavigationTarget, Diagnostics>
    prepare_room_navigation(const noveltea::core::CompiledProject&,
                            const noveltea::core::SessionState&,
                            const noveltea::core::RoomNavigationPreparationInput&,
                            noveltea::core::RoomPresentationConditionEvaluator,
                            noveltea::core::RoomPresentationTextResolver,
                            noveltea::core::RoomCompositionCallback*) const override
    {
        return noveltea::core::Result<noveltea::core::PreparedRoomNavigationTarget,
                                      Diagnostics>::failure({});
    }

    [[nodiscard]] noveltea::core::Result<noveltea::core::RoomPresentationResolution, Diagnostics>
    resolve_room(const noveltea::core::CompiledProject&, const noveltea::core::SessionState&,
                 const noveltea::core::RoomVisitContext&,
                 noveltea::core::RoomPresentationConditionEvaluator,
                 noveltea::core::RoomPresentationTextResolver,
                 noveltea::core::RoomCompositionCallback*) const override
    {
        return noveltea::core::Result<noveltea::core::RoomPresentationResolution,
                                      Diagnostics>::failure({});
    }

    [[nodiscard]] noveltea::core::Result<noveltea::core::RuntimePresentationSnapshot, Diagnostics>
    project(const noveltea::core::CompiledProject&, const noveltea::core::SessionState&,
            const noveltea::core::ResolvedRoomPresentation*) const override
    {
        return noveltea::core::Result<noveltea::core::RuntimePresentationSnapshot,
                                      Diagnostics>::failure({});
    }
};

class FakePresentationRuntimePort final : public noveltea::runtime::PresentationRuntimePort {
public:
    [[nodiscard]] noveltea::core::Result<void, Diagnostics>
    reconcile_snapshot(const noveltea::core::RuntimePresentationSnapshot&) override
    {
        return noveltea::core::Result<void, Diagnostics>::success();
    }

    [[nodiscard]] noveltea::core::Result<noveltea::runtime::PresentationAcceptance, Diagnostics>
    accept(const noveltea::core::PresentationOperation&) override
    {
        return noveltea::core::Result<noveltea::runtime::PresentationAcceptance,
                                      Diagnostics>::success({.accepted = true});
    }

    [[nodiscard]] noveltea::core::Result<noveltea::runtime::PresentationAcceptance, Diagnostics>
    accept(const noveltea::core::AudioOperation&) override
    {
        return noveltea::core::Result<noveltea::runtime::PresentationAcceptance,
                                      Diagnostics>::success({.accepted = true});
    }

    [[nodiscard]] const noveltea::core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return m_status;
    }

    void terminate(noveltea::core::PresentationCancellationReason) override {}

private:
    noveltea::core::PresentationCheckpointStatus m_status{
        .revision = noveltea::core::CheckpointStatusRevision::from_number(0),
    };
};

class FakeSaveStateCodecPort final : public noveltea::core::SaveStateCodecPort {
public:
    [[nodiscard]] noveltea::core::Result<void, Diagnostics>
    validate(const noveltea::core::CompiledProject&, const noveltea::core::SaveState&,
             std::string) const override
    {
        return noveltea::core::Result<void, Diagnostics>::success();
    }

    [[nodiscard]] noveltea::core::Result<std::string, Diagnostics>
    encode(const noveltea::core::CompiledProject&, const noveltea::core::SaveState&) const override
    {
        return noveltea::core::Result<std::string, Diagnostics>::success({});
    }

    [[nodiscard]] noveltea::core::Result<noveltea::core::SaveState, Diagnostics>
    decode(const noveltea::core::CompiledProject&, std::string_view, std::string) const override
    {
        return noveltea::core::Result<noveltea::core::SaveState, Diagnostics>::failure({});
    }
};

class FakeSaveSlotStore final : public noveltea::core::TypedSaveSlotStore {
public:
    [[nodiscard]] noveltea::core::Result<bool, Diagnostics>
    has_slot(noveltea::core::TypedSaveSlotId) const override
    {
        return noveltea::core::Result<bool, Diagnostics>::success(false);
    }

    [[nodiscard]] noveltea::core::Result<std::string, Diagnostics>
    read_slot(noveltea::core::TypedSaveSlotId) const override
    {
        return noveltea::core::Result<std::string, Diagnostics>::failure({});
    }

    [[nodiscard]] noveltea::core::Result<void, Diagnostics>
    write_slot(noveltea::core::TypedSaveSlotId, std::string_view) override
    {
        return noveltea::core::Result<void, Diagnostics>::success();
    }

    [[nodiscard]] noveltea::core::Result<void, Diagnostics>
    delete_slot(noveltea::core::TypedSaveSlotId) override
    {
        return noveltea::core::Result<void, Diagnostics>::success();
    }
};

static_assert(!std::is_abstract_v<FakeScriptInvocationPort>);
static_assert(!std::is_abstract_v<FakePresentationModelPort>);
static_assert(!std::is_abstract_v<FakePresentationRuntimePort>);
static_assert(!std::is_abstract_v<FakeSaveStateCodecPort>);
static_assert(!std::is_abstract_v<FakeSaveSlotStore>);

} // namespace
