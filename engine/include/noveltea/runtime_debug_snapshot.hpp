#pragma once

#include "noveltea/core/runtime_io.hpp"

#include <string>

#include <nlohmann/json.hpp>

namespace noveltea::core {
class ProjectModel;
struct EntityRef;
} // namespace noveltea::core

namespace noveltea {

enum class RuntimeShellMode;
class RuntimeShell;

std::string runtime_debug_shell_mode_name(RuntimeShellMode mode);
bool runtime_debug_diagnostics_have_error(const nlohmann::json& diagnostics);
nlohmann::json make_runtime_debug_entity_ref(const core::EntityRef& ref,
                                             const core::ProjectModel* project);
nlohmann::json make_runtime_debug_diagnostic_snapshot(const core::RuntimeDiagnostic& diagnostic,
                                                      const core::ProjectModel* project);
std::string make_runtime_debug_snapshot(const RuntimeShell& shell, bool preview_running);

} // namespace noveltea
