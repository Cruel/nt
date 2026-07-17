#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <optional>
#include <utility>
#include <vector>

namespace noveltea::host {

struct HostRuntimeDispatchResult {
    runtime::RuntimeInputDisposition disposition = runtime::RuntimeInputDisposition::Unhandled;
    std::optional<runtime::RuntimePublication> publication;
    std::vector<runtime::RuntimeEvent> events;
    core::Diagnostics diagnostics;
    runtime::RuntimeBudgetOutcome budget;

    [[nodiscard]] static HostRuntimeDispatchResult
    from_runtime(runtime::RuntimeDispatchResult result)
    {
        return {.disposition = result.disposition,
                .publication = std::move(result.publication),
                .events = std::move(result.events),
                .diagnostics = std::move(result.diagnostics),
                .budget = result.budget};
    }

    [[nodiscard]] bool accepted() const noexcept
    {
        return disposition != runtime::RuntimeInputDisposition::Failed;
    }

    [[nodiscard]] bool has_publication() const noexcept { return publication.has_value(); }
};

class RuntimeInputSink {
public:
    virtual ~RuntimeInputSink() = default;

    [[nodiscard]] virtual HostRuntimeDispatchResult
    submit_runtime_input(core::RuntimeInputMessage input) = 0;
};

class RuntimeInputSource {
public:
    virtual ~RuntimeInputSource() = default;
    virtual void bind_runtime_input_sink(RuntimeInputSink* sink) noexcept = 0;
};

class RuntimePublicationSink {
public:
    virtual ~RuntimePublicationSink() = default;

    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    apply_runtime_publication(const runtime::RuntimePublication& publication) = 0;
};

} // namespace noveltea::host
