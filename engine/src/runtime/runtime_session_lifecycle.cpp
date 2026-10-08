#include "noveltea/runtime/runtime_session.hpp"

#include "noveltea/runtime/runtime_executor.hpp"

namespace noveltea::runtime {
namespace {

core::Diagnostics run_on_game_ready(ScriptInvocationPort& scripts, RuntimeExecutor& kernel)
{
    RuntimeCapabilityIssuer issuer(kernel.gateway(), kernel.gateway().generation());
    const auto capabilities = issuer.issue(RuntimeCapabilityProfile::OnGameReady);
    if (!capabilities)
        return {core::Diagnostic{.code = "runtime.on_game_ready_capability_failed",
                                 .message = "On Game Ready capability profile is unavailable"}};
    auto ready = scripts.run_project_on_game_ready(*capabilities);
    if (ready)
        return {};
    return {core::Diagnostic{.code = "runtime.on_game_ready_failed",
                             .message = ready.error().message,
                             .source_path = ready.error().chunk}};
}

} // namespace

core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics> RuntimeSession::create(
    const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
    runtime::PresentationModelPort& presentation_model,
    runtime::PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
    const core::SaveStateCodecPort& save_codec, std::string runtime_locale,
    runtime::RuntimeBudgetConfiguration runtime_budget, MotionDurationLookup motion_duration_lookup)
{
    if (runtime_budget.instruction_limit == 0 || runtime_budget.command_limit == 0) {
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "runtime.invalid_budget",
                              .message =
                                  "Runtime instruction and command budgets must be positive"}});
    }
    if (runtime_locale.empty())
        runtime_locale = project.localization().default_locale;
    scripts.set_runtime_locale(runtime_locale);
    auto kernel = RuntimeExecutor::create(project, scripts, presentation_model);
    if (!kernel)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(kernel).error());
    auto ready_diagnostics = run_on_game_ready(scripts, **kernel.value_if());
    if (!ready_diagnostics.empty())
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(ready_diagnostics));
    auto session = std::unique_ptr<RuntimeSession>(
        new RuntimeSession(project, scripts, presentation_model, presentation, saves, save_codec,
                           std::move(*kernel.value_if()), std::move(runtime_locale), runtime_budget,
                           std::move(motion_duration_lookup)));
    auto checkpoint = session->m_checkpoint_service.publish_candidate(session->m_kernel->state());
    if (!checkpoint)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(checkpoint).error());
    return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::success(
        std::move(session));
}

core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics> RuntimeSession::restore(
    const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
    runtime::PresentationModelPort& presentation_model,
    runtime::PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
    const core::SaveStateCodecPort& save_codec, core::TypedSaveSlotId slot,
    std::string runtime_locale, runtime::RuntimeBudgetConfiguration runtime_budget,
    MotionDurationLookup motion_duration_lookup)
{
    if (runtime_budget.instruction_limit == 0 || runtime_budget.command_limit == 0) {
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "runtime.invalid_budget",
                              .message =
                                  "Runtime instruction and command budgets must be positive"}});
    }

    auto stored = saves.read_checkpoint(slot);
    if (!stored)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(stored).error());
    auto decoded = save_codec.decode(project, stored.value_if()->encoded_save, "save-slot");
    if (!decoded)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(decoded).error());

    if (runtime_locale.empty())
        runtime_locale = project.localization().default_locale;
    const core::MessageRealizer restore_realizer(project.localization());
    const auto realize_restored =
        [&](const core::CapturedMessageOccurrence& occurrence) -> std::optional<std::string> {
        const auto realized =
            restore_realizer.realize({occurrence.message_id, runtime_locale, occurrence.arguments});
        return realized ? std::optional<std::string>{realized->text} : std::nullopt;
    };
    const auto unavailable = []() {
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{
                .code = "runtime.restored_localized_message_unavailable",
                .message =
                    "Restored localized presentation cannot be realized in the current locale"}});
    };
    if (auto& presented = decoded.value_if()->presented_text;
        presented && presented->localized_message) {
        auto text = realize_restored(*presented->localized_message);
        if (!text)
            return unavailable();
        presented->text = std::move(*text);
    }
    if (auto& choice = decoded.value_if()->active_choice; choice) {
        bool valid = true;
        std::visit(
            [&](auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::SceneChoiceState>) {
                    if (value.localized_prompt) {
                        auto text = realize_restored(*value.localized_prompt);
                        if (text)
                            value.prompt = std::move(*text);
                        else
                            valid = false;
                    }
                }
                for (auto& option : value.options) {
                    if (!option.localized_message)
                        continue;
                    auto text = realize_restored(*option.localized_message);
                    if (text)
                        option.label = std::move(*text);
                    else
                        valid = false;
                }
            },
            *choice);
        if (!valid)
            return unavailable();
    }
    for (auto& entry : decoded.value_if()->text_log) {
        if (!entry.localized_message)
            continue;
        auto text = realize_restored(*entry.localized_message);
        if (!text)
            return unavailable();
        entry.text = std::move(*text);
    }

    scripts.set_runtime_locale(runtime_locale);
    auto kernel = RuntimeExecutor::restore(project, scripts, presentation_model,
                                           *decoded.value_if(), save_codec);
    if (!kernel)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(kernel).error());
    auto ready_diagnostics = run_on_game_ready(scripts, **kernel.value_if());
    if (!ready_diagnostics.empty())
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(ready_diagnostics));

    auto session = std::unique_ptr<RuntimeSession>(
        new RuntimeSession(project, scripts, presentation_model, presentation, saves, save_codec,
                           std::move(*kernel.value_if()), std::move(runtime_locale), runtime_budget,
                           std::move(motion_duration_lookup)));

    auto checkpoint = session->m_checkpoint_service.prepare_loaded_checkpoint(
        std::move(stored.value_if()->encoded_save), *decoded.value_if(),
        std::move(stored.value_if()->metadata), std::move(stored.value_if()->thumbnail));
    if (!checkpoint)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(checkpoint).error());
    session->m_checkpoint_service.commit_loaded_checkpoint(std::move(*checkpoint.value_if()));
    return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::success(
        std::move(session));
}

} // namespace noveltea::runtime
