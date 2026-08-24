#pragma once

#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/presentation/runtime_presentation_model.hpp"
#include "noveltea/runtime/runtime_executor.hpp"
#include "noveltea/runtime/runtime_session.hpp"

#include <utility>

namespace noveltea::test_support {

inline presentation::RuntimePresentationModel& presentation_model()
{
    static presentation::RuntimePresentationModel model;
    return model;
}

inline const core::JsonSaveStateCodec& save_codec()
{
    static const core::JsonSaveStateCodec codec;
    return codec;
}

template<class ScriptPort>
auto create_execution_kernel(const core::CompiledProject& project, ScriptPort& scripts)
{
    using Result =
        decltype(runtime::RuntimeExecutor::create(project, scripts, presentation_model()));
    if constexpr (requires {
                      scripts.prepare_project_modules(project);
                      scripts.run_project_bootstrap();
                      scripts.freeze_project_hooks();
                  }) {
        auto prepared = scripts.prepare_project_modules(project);
        if (!prepared)
            return Result::failure({core::Diagnostic{.code = "test.script_prepare_failed",
                                                     .message = prepared.error().message}});
        auto bootstrapped = scripts.run_project_bootstrap();
        if (!bootstrapped)
            return Result::failure({core::Diagnostic{.code = "test.script_bootstrap_failed",
                                                     .message = bootstrapped.error().message}});
        auto frozen = scripts.freeze_project_hooks();
        if (!frozen)
            return Result::failure({core::Diagnostic{.code = "test.script_hooks_failed",
                                                     .message = frozen.error().message}});
    }
    return runtime::RuntimeExecutor::create(project, scripts, presentation_model());
}

template<class ScriptPort>
auto create_execution_kernel(const core::CompiledProject& project, ScriptPort& scripts,
                             runtime::CapabilityGeneration generation)
{
    return runtime::RuntimeExecutor::create(project, scripts, presentation_model(), generation);
}

template<class ScriptPort, class PresentationPort, class SaveStore, class... Args>
auto create_runtime_session(const core::CompiledProject& project, ScriptPort& scripts,
                            PresentationPort& presentation, SaveStore& saves, Args&&... args)
{
    using Result = decltype(runtime::RuntimeSession::create(project, scripts, presentation_model(),
                                                            presentation, saves, save_codec(),
                                                            std::forward<Args>(args)...));
    if constexpr (requires {
                      scripts.prepare_project_modules(project);
                      scripts.run_project_bootstrap();
                      scripts.freeze_project_hooks();
                  }) {
        auto prepared = scripts.prepare_project_modules(project);
        if (!prepared)
            return Result::failure({core::Diagnostic{.code = "test.script_prepare_failed",
                                                     .message = prepared.error().message}});
        auto bootstrapped = scripts.run_project_bootstrap();
        if (!bootstrapped)
            return Result::failure({core::Diagnostic{.code = "test.script_bootstrap_failed",
                                                     .message = bootstrapped.error().message}});
        auto frozen = scripts.freeze_project_hooks();
        if (!frozen)
            return Result::failure({core::Diagnostic{.code = "test.script_hooks_failed",
                                                     .message = frozen.error().message}});
    }
    return runtime::RuntimeSession::create(project, scripts, presentation_model(), presentation,
                                           saves, save_codec(), std::forward<Args>(args)...);
}

inline auto restore_session(const core::CompiledProject& project, const core::SaveState& save)
{
    return core::FlowExecutor::restore_session(project, save, save_codec());
}

} // namespace noveltea::test_support
