#pragma once

#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/script/typed_runtime_session.hpp"

#include <memory>
#include <string>

namespace noveltea::script {

class CompiledRuntime final {
public:
    CompiledRuntime() = delete;
    CompiledRuntime(const CompiledRuntime&) = delete;
    CompiledRuntime& operator=(const CompiledRuntime&) = delete;

    [[nodiscard]] static core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
    create(core::LoadedCompiledPackage package, ScriptRuntime& scripts,
           core::TypedSaveSlotStore& saves, std::string runtime_locale = {});

    [[nodiscard]] const core::LoadedCompiledPackage& package() const noexcept { return m_package; }
    [[nodiscard]] TypedRuntimeSession& session() noexcept { return *m_session; }
    [[nodiscard]] const TypedRuntimeSession& session() const noexcept { return *m_session; }

private:
    explicit CompiledRuntime(core::LoadedCompiledPackage package) noexcept;

    core::LoadedCompiledPackage m_package;
    std::unique_ptr<TypedRuntimeSession> m_session;
};

[[nodiscard]] core::Diagnostics certify_compiled_project_lua(const core::CompiledProject& project,
                                                             ScriptRuntime& scripts);

} // namespace noveltea::script
