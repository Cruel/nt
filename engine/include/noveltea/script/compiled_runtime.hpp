#pragma once

#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/script/typed_runtime_session.hpp"

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea::script {

struct CompiledRuntimeLoadInput {
    nlohmann::json gameplay;
    nlohmann::json manifest;
    std::optional<nlohmann::json> shader_materials;
    std::vector<core::RuntimePackageFile> files;
    std::string gameplay_source_path = "gameplay.json";
    std::string manifest_source_path = "manifest.json";
    std::string shader_materials_source_path = "shader-materials.json";
    std::string runtime_locale;
};

class CompiledRuntime final {
public:
    CompiledRuntime() = delete;
    CompiledRuntime(const CompiledRuntime&) = delete;
    CompiledRuntime& operator=(const CompiledRuntime&) = delete;

    [[nodiscard]] static core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
    load(CompiledRuntimeLoadInput input, ScriptRuntime& scripts, core::TypedSaveSlotStore& saves);
    [[nodiscard]] static core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
    load_preview(nlohmann::json gameplay, std::optional<nlohmann::json> shader_materials,
                 ScriptRuntime& scripts, core::TypedSaveSlotStore& saves,
                 std::string runtime_locale = {});

    [[nodiscard]] const core::LoadedCompiledPackage& package() const noexcept { return m_package; }
    [[nodiscard]] TypedRuntimeSession& session() noexcept { return *m_session; }
    [[nodiscard]] const TypedRuntimeSession& session() const noexcept { return *m_session; }
    [[nodiscard]] const TypedRuntimeSessionResult& startup_result() const noexcept
    {
        return m_startup_result;
    }

private:
    explicit CompiledRuntime(core::LoadedCompiledPackage package) noexcept;

    core::LoadedCompiledPackage m_package;
    std::unique_ptr<TypedRuntimeSession> m_session;
    TypedRuntimeSessionResult m_startup_result;
};

[[nodiscard]] core::Diagnostics certify_compiled_project_lua(const core::CompiledProject& project,
                                                             ScriptRuntime& scripts);

} // namespace noveltea::script
