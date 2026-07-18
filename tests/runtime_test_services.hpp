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
    return runtime::RuntimeSession::create(project, scripts, presentation_model(), presentation,
                                           saves, save_codec(), std::forward<Args>(args)...);
}

inline auto restore_session(const core::CompiledProject& project, const core::SaveState& save)
{
    return core::FlowExecutor::restore_session(project, save, save_codec());
}

} // namespace noveltea::test_support
