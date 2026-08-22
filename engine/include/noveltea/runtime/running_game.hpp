#pragma once

#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/runtime/runtime_session.hpp"

#include <memory>
#include <string>
#include <utility>

namespace noveltea::runtime {

class SessionScriptInvocationPort;

class RuntimeSessionCandidate final {
public:
    RuntimeSessionCandidate(const RuntimeSessionCandidate&) = delete;
    RuntimeSessionCandidate& operator=(const RuntimeSessionCandidate&) = delete;
    RuntimeSessionCandidate(RuntimeSessionCandidate&&) = delete;
    RuntimeSessionCandidate& operator=(RuntimeSessionCandidate&&) = delete;
    ~RuntimeSessionCandidate();

    [[nodiscard]] const RuntimeDispatchResult& initial_result() const noexcept
    {
        return m_initial_result;
    }
    [[nodiscard]] RuntimeDispatchResult take_initial_result() noexcept
    {
        return std::move(m_initial_result);
    }

private:
    friend class RunningGame;
    RuntimeSessionCandidate(std::unique_ptr<SessionScriptInvocationPort> scripts,
                            std::unique_ptr<RuntimeSession> session,
                            RuntimeDispatchResult initial_result) noexcept;

    std::unique_ptr<SessionScriptInvocationPort> m_scripts;
    std::unique_ptr<RuntimeSession> m_session;
    RuntimeDispatchResult m_initial_result;
};

class RunningGame final {
public:
    RunningGame() = delete;
    ~RunningGame();
    RunningGame(const RunningGame&) = delete;
    RunningGame& operator=(const RunningGame&) = delete;

    [[nodiscard]] static core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
    create(core::LoadedCompiledPackage package, ScriptCertificationPort& script_certifier,
           ScriptInvocationPort& scripts, PresentationModelPort& presentation_model,
           PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
           const core::SaveStateCodecPort& save_codec, std::string runtime_locale = {});

    [[nodiscard]] const core::LoadedCompiledPackage& package() const noexcept { return m_package; }
    [[nodiscard]] RuntimeSession& session() noexcept { return *m_session; }
    [[nodiscard]] const RuntimeSession& session() const noexcept { return *m_session; }
    [[nodiscard]] core::Result<std::unique_ptr<RuntimeSessionCandidate>, core::Diagnostics>
    prepare_reset_candidate(ScriptInvocationPort& scripts, PresentationRuntimePort& presentation);
    [[nodiscard]] core::Result<std::unique_ptr<RuntimeSessionCandidate>, core::Diagnostics>
    prepare_load_candidate(core::TypedSaveSlotId slot, ScriptInvocationPort& scripts,
                           PresentationRuntimePort& presentation);
    [[nodiscard]] std::unique_ptr<RuntimeSessionCandidate>
    commit_candidate(std::unique_ptr<RuntimeSessionCandidate> candidate) noexcept;

private:
    explicit RunningGame(core::LoadedCompiledPackage package) noexcept;

    core::LoadedCompiledPackage m_package;
    std::unique_ptr<SessionScriptInvocationPort> m_script_binding;
    std::unique_ptr<RuntimeSession> m_session;
    PresentationModelPort* m_presentation_model = nullptr;
    core::TypedSaveSlotStore* m_saves = nullptr;
    const core::SaveStateCodecPort* m_save_codec = nullptr;
    std::string m_runtime_locale;
};

} // namespace noveltea::runtime
