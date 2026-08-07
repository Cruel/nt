#pragma once

#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/runtime/runtime_session.hpp"

#include <memory>
#include <string>

namespace noveltea::runtime {

class RunningGame final {
public:
    RunningGame() = delete;
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
    [[nodiscard]] core::Result<void, core::Diagnostics>
    recreate_session(PresentationRuntimePort& presentation);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    recreate_session(ScriptInvocationPort& scripts, PresentationRuntimePort& presentation);

private:
    explicit RunningGame(core::LoadedCompiledPackage package) noexcept;

    core::LoadedCompiledPackage m_package;
    std::unique_ptr<RuntimeSession> m_session;
    ScriptInvocationPort* m_scripts = nullptr;
    PresentationModelPort* m_presentation_model = nullptr;
    core::TypedSaveSlotStore* m_saves = nullptr;
    const core::SaveStateCodecPort* m_save_codec = nullptr;
    std::string m_runtime_locale;
};

} // namespace noveltea::runtime
