#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <chrono>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics execution_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

core::Diagnostics script_diagnostics(const ScriptInvocationError& error)
{
    return execution_error("execution.scene_script_failed", error.message);
}

runtime::RuntimeCapabilitySet issue_capabilities(runtime::RuntimeCommandGateway& gateway,
                                                 runtime::RuntimeCapabilityProfile profile)
{
    runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
    return *issuer.issue(profile);
}

const core::compiled::SceneInstruction*
find_instruction(const core::compiled::SceneDefinition& scene, const core::SceneStepId& step)
{
    const auto found = std::find_if(
        scene.program.instructions.begin(), scene.program.instructions.end(),
        [&step](const core::compiled::SceneInstruction& instruction) {
            return std::visit([&step](const auto& value) { return value.id == step; }, instruction);
        });
    return found == scene.program.instructions.end() ? nullptr : &*found;
}

std::optional<core::SceneStepId> next_instruction(const core::compiled::SceneDefinition& scene,
                                                  const core::SceneStepId& step)
{
    for (std::size_t index = 0; index < scene.program.instructions.size(); ++index) {
        const bool matches = std::visit([&step](const auto& value) { return value.id == step; },
                                        scene.program.instructions[index]);
        if (!matches)
            continue;
        if (index + 1 == scene.program.instructions.size())
            return std::nullopt;
        return std::visit([](const auto& value) { return value.id; },
                          scene.program.instructions[index + 1]);
    }
    return std::nullopt;
}

const core::compiled::SceneChoiceOption*
find_choice_option(const core::compiled::ChoiceSceneInstruction& choice,
                   const core::SceneChoiceOptionId& option)
{
    const auto found = std::find_if(choice.options.begin(), choice.options.end(),
                                    [&option](const auto& value) { return value.id == option; });
    return found == choice.options.end() ? nullptr : &*found;
}

core::Result<core::PresentationOwner, core::Diagnostics>
resolve_scene_presentation_owner(const core::SessionState& state, const core::SceneFrame& frame,
                                 core::compiled::ScenePresentationOwner requested)
{
    switch (requested) {
    case core::compiled::ScenePresentationOwner::Invocation:
        return core::Result<core::PresentationOwner, core::Diagnostics>::success(
            core::ScenePresentationOwner{frame.frame_id, frame.scene});
    case core::compiled::ScenePresentationOwner::ActiveRoom: {
        const auto owner = state.current_room_presentation_owner();
        if (!owner)
            return core::Result<core::PresentationOwner, core::Diagnostics>::failure(
                execution_error("execution.scene_active_room_owner_unavailable",
                                "Scene operation requested Active Room ownership without an "
                                "active Room Context"));
        return core::Result<core::PresentationOwner, core::Diagnostics>::success(*owner);
    }
    case core::compiled::ScenePresentationOwner::RuntimeSession:
        return core::Result<core::PresentationOwner, core::Diagnostics>::success(
            state.session_presentation_owner());
    }
    return core::Result<core::PresentationOwner, core::Diagnostics>::failure(
        execution_error("execution.invalid_scene_presentation_owner",
                        "Scene operation has an invalid presentation owner"));
}

core::Result<core::ActorPresentationKey, core::Diagnostics>
scene_actor_key(const core::SceneFrame& frame, core::compiled::ScenePresentationOwner requested,
                const core::PresentationOwner& owner, const core::ActorSlotId& slot)
{
    if (requested == core::compiled::ScenePresentationOwner::Invocation)
        return core::Result<core::ActorPresentationKey, core::Diagnostics>::success(
            core::SceneActorKey{std::get<core::ScenePresentationOwner>(owner), slot});

    auto instance = core::StrongId<core::ScopedActorInstanceTag>::create(
        "scene-" + frame.scene.text() + "-actor-" + slot.text());
    return instance
               ? core::Result<core::ActorPresentationKey, core::Diagnostics>::success(
                     core::ScopedActorKey{std::move(*instance.value_if())})
               : core::Result<core::ActorPresentationKey, core::Diagnostics>::failure(
                     execution_error("execution.invalid_scene_actor_identity",
                                     "Scene actor slot could not form a stable scoped identity"));
}

core::GameplayInstanceRef
runtime_instance_ref(const core::compiled::SceneGameplayInstanceRef& instance)
{
    return std::visit([](const auto& value) -> core::GameplayInstanceRef { return value; },
                      instance);
}

RuntimeInstanceConfigurationRequest
runtime_configuration_request(const core::compiled::SceneInstanceConfigurationSource& source)
{
    return std::visit(
        [](const auto& value) -> RuntimeInstanceConfigurationRequest {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::SceneArchetypeConfigurationSource>)
                return ArchetypeInstanceConfiguration{value.archetype};
            else if constexpr (std::is_same_v<
                                   T, core::compiled::SceneCompiledInstanceConfigurationSource>)
                return CompiledInstanceConfiguration{runtime_instance_ref(value.instance)};
            else
                return EffectiveInstanceConfiguration{runtime_instance_ref(value.instance)};
        },
        source);
}

ItemStackPlacementPolicy
runtime_item_placement(core::compiled::ItemStackPlacementPolicy placement) noexcept
{
    return placement == core::compiled::ItemStackPlacementPolicy::Coalesce
               ? ItemStackPlacementPolicy::Coalesce
               : ItemStackPlacementPolicy::KeepSeparate;
}

void record_direct_world_mutation(MutationImpactJournal& impacts) noexcept
{
    impacts.record(MutationImpact::StructuralStateChanged);
    impacts.record(MutationImpact::GameplayUiInvalidated);
    impacts.record(MutationImpact::PresentationInvalidated);
    impacts.record(MutationImpact::CheckpointReadinessInvalidated);
    impacts.record(MutationImpact::RoomPresentationInvalidated);
}

RuntimeCapabilityGroup
scene_gameplay_operation_capability(const core::compiled::SceneGameplayEffectOperation& operation)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::SetGlobalProperty> ||
                          std::is_same_v<T, core::compiled::SetIdentityPropertySceneOperation> ||
                          std::is_same_v<T, core::compiled::UnsetIdentityPropertySceneOperation>)
                return RuntimeCapabilityGroup::Properties;
            else if constexpr (std::is_same_v<T, core::compiled::MoveCharacterSceneOperation> ||
                               std::is_same_v<T, core::compiled::SetCharacterStateSceneOperation>)
                return RuntimeCapabilityGroup::Character;
            else if constexpr (std::is_same_v<T, core::compiled::MoveInteractableSceneOperation> ||
                               std::is_same_v<T,
                                              core::compiled::SetInteractableStateSceneOperation>)
                return RuntimeCapabilityGroup::Interactable;
            else
                return RuntimeCapabilityGroup::ItemStack;
        },
        operation);
}

RuntimeCapabilityGroup
scene_world_operation_capability(const core::compiled::SceneRuntimeWorldOperation& operation)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::CreateRoomSceneWorldOperation> ||
                          std::is_same_v<T, core::compiled::RetargetRoomExitSceneWorldOperation>)
                return RuntimeCapabilityGroup::Room;
            else if constexpr (std::is_same_v<T,
                                              core::compiled::CreateCharacterSceneWorldOperation>)
                return RuntimeCapabilityGroup::Character;
            else if constexpr (std::is_same_v<
                                   T, core::compiled::CreateInteractableSceneWorldOperation>)
                return RuntimeCapabilityGroup::Interactable;
            else
                return RuntimeCapabilityGroup::Game;
        },
        operation);
}

core::Result<void, core::Diagnostics>
apply_scene_gameplay_operation(const core::compiled::SceneGameplayEffectOperation& operation,
                               RuntimeCommandGateway& gateway, RuntimeWorld& world,
                               MutationImpactJournal& impacts)
{
    return std::visit(
        [&](const auto& value) -> core::Result<void, core::Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::SetGlobalProperty>) {
                return gateway.set_global_property(value.property_id, value.value);
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::SetIdentityPropertySceneOperation>) {
                return gateway.set_property(value.owner, value.property, value.value);
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::UnsetIdentityPropertySceneOperation>) {
                return gateway.unset_property(value.owner, value.property);
            } else if constexpr (std::is_same_v<T, core::compiled::MoveCharacterSceneOperation>) {
                auto changed = world.move_character(value.character, value.location);
                if (changed)
                    record_direct_world_mutation(impacts);
                return changed;
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::SetCharacterStateSceneOperation>) {
                if (value.enabled) {
                    auto changed = world.set_character_enabled(value.character, *value.enabled);
                    if (!changed)
                        return changed;
                }
                if (value.visible) {
                    auto changed = world.set_character_visible(value.character, *value.visible);
                    if (!changed)
                        return changed;
                }
                record_direct_world_mutation(impacts);
                return core::Result<void, core::Diagnostics>::success();
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::MoveInteractableSceneOperation>) {
                auto changed = world.move_interactable(value.interactable, value.location);
                if (changed)
                    record_direct_world_mutation(impacts);
                return changed;
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::SetInteractableStateSceneOperation>) {
                if (value.enabled) {
                    auto changed =
                        world.set_interactable_enabled(value.interactable, *value.enabled);
                    if (!changed)
                        return changed;
                }
                if (value.visible) {
                    auto changed =
                        world.set_interactable_visible(value.interactable, *value.visible);
                    if (!changed)
                        return changed;
                }
                record_direct_world_mutation(impacts);
                return core::Result<void, core::Diagnostics>::success();
            } else if constexpr (std::is_same_v<T, core::compiled::SplitItemStackSceneOperation>) {
                auto changed = gateway.split_item_stack(value.stack, value.quantity);
                return changed ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(changed.error());
            } else if constexpr (std::is_same_v<T, core::compiled::MergeItemStacksSceneOperation>) {
                auto changed = gateway.merge_item_stacks(value.receiver, value.donor);
                return changed ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(changed.error());
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::TransferItemQuantitySceneOperation>) {
                auto changed =
                    gateway.transfer_item_quantity(value.stack, value.quantity, value.location,
                                                   runtime_item_placement(value.placement));
                return changed ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(changed.error());
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::GrantItemQuantitySceneOperation>) {
                auto changed =
                    gateway.grant_item_quantity(value.definition, value.quantity, value.location,
                                                runtime_item_placement(value.placement));
                return changed ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(changed.error());
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::ConsumeItemQuantitySceneOperation>) {
                auto changed = gateway.consume_item_quantity(value.stack, value.quantity);
                return changed ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(changed.error());
            } else {
                static_assert(std::is_same_v<T, void>, "Unhandled Scene gameplay effect operation");
            }
        },
        operation);
}

core::Result<void, core::Diagnostics>
apply_scene_world_operation(const core::compiled::SceneRuntimeWorldOperation& operation,
                            RuntimeCommandGateway& gateway)
{
    return std::visit(
        [&](const auto& value) -> core::Result<void, core::Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::CreateRoomSceneWorldOperation>) {
                auto created = gateway.create_room(runtime_configuration_request(value.source));
                return created ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(created.error());
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::CreateCharacterSceneWorldOperation>) {
                auto created =
                    gateway.create_character(runtime_configuration_request(value.source),
                                             value.location, value.enabled, value.visible);
                return created ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(created.error());
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::CreateInteractableSceneWorldOperation>) {
                auto created =
                    gateway.create_interactable(runtime_configuration_request(value.source),
                                                value.location, value.enabled, value.visible);
                return created ? core::Result<void, core::Diagnostics>::success()
                               : core::Result<void, core::Diagnostics>::failure(created.error());
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::ReplaceConfigurationSceneWorldOperation>) {
                return gateway.replace_instance_configuration(
                    runtime_instance_ref(value.instance),
                    runtime_configuration_request(value.source));
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::ClearConfigurationSceneWorldOperation>) {
                return gateway.clear_instance_configuration(runtime_instance_ref(value.instance));
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::RetargetRoomExitSceneWorldOperation>) {
                return gateway.retarget_room_exit(value.room, value.exit, value.target);
            } else {
                return gateway.destroy_instance(runtime_instance_ref(value.instance));
            }
        },
        operation);
}

} // namespace

RuntimeExecutor::RuntimeExecutor(const core::CompiledProject& project,
                                 ScriptInvocationPort& scripts,
                                 PresentationModelPort& presentation_model,
                                 core::SessionState state, CapabilityGeneration generation) noexcept
    : m_project(project), m_state(std::move(state)), m_world(m_project, m_state),
      m_flow(m_project, m_state, m_world), m_primitives(m_project, m_state, m_flow),
      m_gateway(m_project, m_state, m_world, generation), m_scripts(scripts),
      m_presentation_model(presentation_model),
      m_gameplay_capabilities(
          issue_capabilities(m_gateway, runtime::RuntimeCapabilityProfile::GameplayScript)),
      m_expression_capabilities(
          issue_capabilities(m_gateway, runtime::RuntimeCapabilityProfile::SynchronousExpression)),
      m_room_lifecycle_capabilities(
          issue_capabilities(m_gateway, runtime::RuntimeCapabilityProfile::GameplayLayoutEvent))
{
}

void RuntimeExecutor::stage_pending_presentation(
    PendingPresentationOperation operation, core::SessionState source_state,
    std::optional<core::RoomPresentationResolution> source_room)
{
    m_pending_presentation_operation = std::move(operation);
    m_pending_presentation_source_state = std::move(source_state);
    m_pending_presentation_source_room = std::move(source_room);
    m_pending_presentation_source_locale = m_room_presentation_locale;
    m_pending_presentation_source_dirty = m_room_presentation_dirty;
}

void RuntimeExecutor::commit_pending_presentation() noexcept
{
    m_pending_presentation_operation.reset();
    m_pending_presentation_source_state.reset();
    m_pending_presentation_source_room.reset();
    m_pending_presentation_source_locale.clear();
    m_pending_presentation_source_dirty = true;
}

void RuntimeExecutor::rollback_pending_presentation() noexcept
{
    if (m_pending_presentation_source_state)
        m_state = std::move(*m_pending_presentation_source_state);
    m_room_presentation = std::move(m_pending_presentation_source_room);
    m_room_presentation_locale = std::move(m_pending_presentation_source_locale);
    m_room_presentation_dirty = m_pending_presentation_source_dirty;
    commit_pending_presentation();
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::fail_pending_presentation(std::string code, std::string message)
{
    commit_pending_presentation();
    return m_flow.fault(execution_error(std::move(code), std::move(message)));
}

core::Result<std::optional<core::PresentationFlowCompletion>, core::Diagnostics>
RuntimeExecutor::advance_scene_for_presentation(const core::SceneId& scene,
                                                const core::SceneStepId& step,
                                                std::optional<core::SceneStepId> next,
                                                const core::PresentationInstructionWait& wait)
{
    if (!std::holds_alternative<core::PresentationCompletionWait>(wait)) {
        auto advanced =
            m_flow.advance_scene(scene, step, {std::move(next), core::SceneStepReady{}});
        return advanced ? core::Result<std::optional<core::PresentationFlowCompletion>,
                                       core::Diagnostics>::success(std::nullopt)
                        : core::Result<std::optional<core::PresentationFlowCompletion>,
                                       core::Diagnostics>::failure(advanced.error());
    }

    auto waiting = begin(core::WaitSpec{core::PresentationCompletionWait{}});
    const auto* wait_outcome = waiting.value_if();
    const auto* blocked =
        wait_outcome == nullptr ? nullptr : std::get_if<core::WaitBlocked>(wait_outcome);
    const auto* presentation = blocked == nullptr
                                   ? nullptr
                                   : std::get_if<core::PresentationFlowBlocker>(&blocked->blocker);
    if (presentation == nullptr)
        return core::Result<std::optional<core::PresentationFlowCompletion>, core::Diagnostics>::
            failure(waiting ? execution_error(
                                  "execution.invalid_presentation_wait",
                                  "Presentation wait did not allocate a presentation blocker")
                            : waiting.error());

    auto marked = m_flow.mark_scene_wait(
        scene, step,
        core::SceneInstructionCompletionPosition{std::move(next), false, std::nullopt});
    if (!marked)
        return core::Result<std::optional<core::PresentationFlowCompletion>,
                            core::Diagnostics>::failure(marked.error());
    return core::Result<std::optional<core::PresentationFlowCompletion>,
                        core::Diagnostics>::success(core::PresentationFlowCompletion{
        presentation->owner, presentation->handle});
}

core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>
RuntimeExecutor::create(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                        PresentationModelPort& presentation_model, CapabilityGeneration generation)
{
    auto state = core::SessionState::create(project);
    auto* value = state.value_if();
    if (value == nullptr)
        return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::failure(
            state.error());
    return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::success(
        std::unique_ptr<RuntimeExecutor>(new RuntimeExecutor(project, scripts, presentation_model,
                                                             std::move(*value), generation)));
}

core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>
RuntimeExecutor::restore(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                         PresentationModelPort& presentation_model, const core::SaveState& save,
                         const core::SaveStateCodecPort& save_codec,
                         CapabilityGeneration generation)
{
    auto state = core::FlowExecutor::restore_session(project, save, save_codec);
    auto* value = state.value_if();
    if (value == nullptr)
        return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::failure(
            state.error());
    return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::success(
        std::unique_ptr<RuntimeExecutor>(new RuntimeExecutor(project, scripts, presentation_model,
                                                             std::move(*value), generation)));
}

core::Result<bool, ScriptInvocationError>
RuntimeExecutor::evaluate_script(const core::LuaPredicate& predicate)
{
    runtime::ScriptInvocationRequest request{.source = predicate.source,
                                             .chunk_name = "lua-condition",
                                             .owner = std::nullopt,
                                             .invocation = std::nullopt,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind =
                                                 runtime::ScriptInvocationResultKind::Boolean,
                                             .asset_path = std::nullopt};
    auto result = m_scripts.invoke(request, m_expression_capabilities);
    const auto* outcome = result.value_if();
    if (outcome == nullptr)
        return core::Result<bool, ScriptInvocationError>::failure(result.error());
    const auto* completed = std::get_if<runtime::ScriptInvocationCompleted>(outcome);
    const auto* value = completed == nullptr ? nullptr : std::get_if<bool>(&completed->value);
    return value ? core::Result<bool, ScriptInvocationError>::success(*value)
                 : core::Result<bool, ScriptInvocationError>::failure(
                       ScriptInvocationError{.code = ScriptInvocationErrorCode::InvalidResult,
                                             .message = "Lua condition did not return a boolean",
                                             .chunk = request.chunk_name,
                                             .traceback = {}});
}

core::Result<std::string, ScriptInvocationError>
RuntimeExecutor::resolve_script(const core::LuaTextExpression& expression)
{
    runtime::ScriptInvocationRequest request{.source = expression.source,
                                             .chunk_name = "lua-text-expression",
                                             .owner = std::nullopt,
                                             .invocation = std::nullopt,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind =
                                                 runtime::ScriptInvocationResultKind::String,
                                             .asset_path = std::nullopt};
    auto result = m_scripts.invoke(request, m_expression_capabilities);
    const auto* outcome = result.value_if();
    if (outcome == nullptr)
        return core::Result<std::string, ScriptInvocationError>::failure(result.error());
    const auto* completed = std::get_if<runtime::ScriptInvocationCompleted>(outcome);
    const auto* value =
        completed == nullptr ? nullptr : std::get_if<std::string>(&completed->value);
    return value ? core::Result<std::string, ScriptInvocationError>::success(*value)
                 : core::Result<std::string, ScriptInvocationError>::failure(ScriptInvocationError{
                       .code = ScriptInvocationErrorCode::InvalidResult,
                       .message = "Lua text expression did not return a string",
                       .chunk = request.chunk_name,
                       .traceback = {}});
}

core::Result<ScriptInvocationOutcome, ScriptInvocationError>
RuntimeExecutor::invoke_script(std::string_view source, std::string_view chunk_name)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptInvocationError>;
    auto allocated = m_flow.block_top(core::FlowBlockerKind::Script);
    const auto* blocker = allocated.value_if();
    if (blocker == nullptr) {
        const std::string message = allocated.error().empty()
                                        ? "Script invocation blocker is invalid"
                                        : allocated.error().front().message;
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = message,
                                  .chunk = std::string(chunk_name),
                                  .traceback = message});
    }
    const auto* script_blocker = std::get_if<core::ScriptFlowBlocker>(blocker);
    if (script_blocker == nullptr) {
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = "FlowExecutor allocated a non-script blocker",
                                  .chunk = std::string(chunk_name),
                                  .traceback = {}});
    }

    runtime::ScriptInvocationRequest request{.source = std::string(source),
                                             .chunk_name = std::string(chunk_name),
                                             .owner = script_blocker->owner,
                                             .invocation = script_blocker->handle,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind =
                                                 runtime::ScriptInvocationResultKind::None,
                                             .asset_path = std::nullopt};
    auto invoked = m_scripts.invoke(request, m_gameplay_capabilities);
    if (!invoked) {
        (void)m_flow.cancel_blocker(script_blocker->owner, script_blocker->handle);
        return Result::failure(invoked.error());
    }
    const auto* outcome = invoked.value_if();
    if (outcome != nullptr && std::holds_alternative<ScriptInvocationCompleted>(*outcome)) {
        auto completed = m_flow.resume_blocker(script_blocker->owner, script_blocker->handle);
        if (!completed) {
            const std::string message = completed.error().empty()
                                            ? "Script invocation blocker is invalid"
                                            : completed.error().front().message;
            return Result::failure(
                ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                      .message = message,
                                      .chunk = std::string(chunk_name),
                                      .traceback = message});
        }
    }
    return invoked;
}

core::Result<bool, RuntimeExecutionError>
RuntimeExecutor::evaluate(const core::Condition& condition)
{
    if (const auto* lua = std::get_if<core::LuaPredicate>(&condition)) {
        auto result = evaluate_script(*lua);
        const auto* value = result.value_if();
        return value ? core::Result<bool, RuntimeExecutionError>::success(*value)
                     : core::Result<bool, RuntimeExecutionError>::failure(result.error());
    }
    auto result = m_primitives.evaluate(condition);
    const auto* value = result.value_if();
    return value ? core::Result<bool, RuntimeExecutionError>::success(*value)
                 : core::Result<bool, RuntimeExecutionError>::failure(result.error());
}

core::Result<RuntimeEffectOutcome, RuntimeExecutionError>
RuntimeExecutor::apply(const core::Effect& effect, std::string_view chunk_name)
{
    if (const auto* lua = std::get_if<core::RunLuaEffect>(&effect)) {
        auto result = invoke_script(lua->source, chunk_name);
        const auto* outcome = result.value_if();
        if (outcome == nullptr)
            return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::failure(
                result.error());
        return std::visit(
            [](const auto& value) -> core::Result<RuntimeEffectOutcome, RuntimeExecutionError> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, ScriptInvocationCompleted>)
                    return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::success(
                        core::WaitCompleted{});
                else
                    return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::success(
                        value);
            },
            *outcome);
    }
    auto result = m_primitives.apply(effect);
    if (!result)
        return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::failure(result.error());
    return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::success(
        core::WaitCompleted{});
}

core::Result<std::string, RuntimeExecutionError>
RuntimeExecutor::resolve(const core::TextSource& source, std::string_view runtime_locale)
{
    if (const auto* lua = std::get_if<core::LuaTextExpression>(&source)) {
        auto result = resolve_script(*lua);
        const auto* value = result.value_if();
        return value ? core::Result<std::string, RuntimeExecutionError>::success(*value)
                     : core::Result<std::string, RuntimeExecutionError>::failure(result.error());
    }
    auto result = m_primitives.resolve(source, runtime_locale);
    const auto* value = result.value_if();
    return value ? core::Result<std::string, RuntimeExecutionError>::success(*value)
                 : core::Result<std::string, RuntimeExecutionError>::failure(result.error());
}

core::Result<core::WaitEvaluation, core::Diagnostics>
RuntimeExecutor::begin(const core::WaitSpec& wait)
{
    return m_primitives.begin(wait);
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::complete(const core::FlowFrameId& owner, const core::AnyFlowBlockerHandle& handle)
{
    return m_primitives.complete(owner, handle);
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::cancel(const core::FlowFrameId& owner, const core::AnyFlowBlockerHandle& handle)
{
    return m_primitives.cancel(owner, handle);
}

core::Result<bool, core::Diagnostics>
RuntimeExecutor::advance(const core::FlowFrameId& owner,
                         const core::DurationFlowBlockerHandle& handle,
                         std::chrono::milliseconds elapsed)
{
    return m_primitives.advance(owner, handle, elapsed);
}

core::Result<bool, core::Diagnostics> RuntimeExecutor::resume_scene_semantic_wait_if_ready()
{
    const auto* blocker =
        m_state.blocker() ? std::get_if<core::InputFlowBlocker>(&*m_state.blocker()) : nullptr;
    const auto* frame = !m_state.flow_stack().empty()
                            ? std::get_if<core::SceneFrame>(&m_state.flow_stack().back())
                            : nullptr;
    if (blocker == nullptr || frame == nullptr)
        return core::Result<bool, core::Diagnostics>::success(false);
    const auto* completion =
        std::get_if<core::SceneInstructionCompletionPosition>(&frame->position.substate);
    if (completion == nullptr || !completion->semantic_wait)
        return core::Result<bool, core::Diagnostics>::success(false);

    bool ready = false;
    if (std::holds_alternative<core::SceneConditionWaitTarget>(*completion->semantic_wait)) {
        if (!frame->position.next_step)
            return core::Result<bool, core::Diagnostics>::failure(
                execution_error("execution.scene_condition_wait_position_missing",
                                "Scene condition wait lost its Event position"));
        const auto* scene = m_project.find_scene(frame->scene);
        const auto* instruction =
            scene ? find_instruction(*scene, *frame->position.next_step) : nullptr;
        const auto* wait = instruction
                               ? std::get_if<core::compiled::WaitConditionInstruction>(instruction)
                               : nullptr;
        if (wait == nullptr)
            return core::Result<bool, core::Diagnostics>::failure(
                execution_error("execution.scene_condition_wait_instruction_missing",
                                "Scene condition wait no longer names a condition wait Event"));
        auto evaluated = evaluate(wait->wait_condition);
        if (!evaluated) {
            if (const auto* diagnostics = std::get_if<core::Diagnostics>(&evaluated.error()))
                return core::Result<bool, core::Diagnostics>::failure(*diagnostics);
            return core::Result<bool, core::Diagnostics>::failure(
                script_diagnostics(std::get<ScriptInvocationError>(evaluated.error())));
        }
        ready = evaluated.value_if() != nullptr && *evaluated.value_if();
    } else if (const auto* target = std::get_if<core::ScenePresentationOperationWaitTarget>(
                   &*completion->semantic_wait)) {
        ready = !m_scene_event_presentation_operation_checker ||
                !m_scene_event_presentation_operation_checker(frame->frame_id, frame->scene,
                                                              target->event);
    } else if (const auto* target =
                   std::get_if<core::SceneAudioOperationWaitTarget>(&*completion->semantic_wait)) {
        ready =
            !m_scene_event_audio_operation_checker ||
            !m_scene_event_audio_operation_checker(frame->frame_id, frame->scene, target->event);
    }
    if (!ready)
        return core::Result<bool, core::Diagnostics>::success(false);
    auto completed = complete(blocker->owner, core::AnyFlowBlockerHandle{blocker->handle});
    return completed ? core::Result<bool, core::Diagnostics>::success(true)
                     : core::Result<bool, core::Diagnostics>::failure(completed.error());
}

core::Result<bool, core::Diagnostics>
RuntimeExecutor::consume_layout_signal_wait(const core::LayoutSignalInput& input)
{
    const auto* blocker =
        m_state.blocker() ? std::get_if<core::InputFlowBlocker>(&*m_state.blocker()) : nullptr;
    const auto* frame = !m_state.flow_stack().empty()
                            ? std::get_if<core::SceneFrame>(&m_state.flow_stack().back())
                            : nullptr;
    if (blocker == nullptr || frame == nullptr)
        return core::Result<bool, core::Diagnostics>::success(false);
    const auto* completion =
        std::get_if<core::SceneInstructionCompletionPosition>(&frame->position.substate);
    const auto* target =
        completion && completion->semantic_wait
            ? std::get_if<core::SceneLayoutSignalWaitTarget>(&*completion->semantic_wait)
            : nullptr;
    if (target == nullptr)
        return core::Result<bool, core::Diagnostics>::success(false);
    auto resolved_owner = resolve_scene_presentation_owner(m_state, *frame, target->owner);
    if (!resolved_owner)
        return core::Result<bool, core::Diagnostics>::failure(resolved_owner.error());
    const core::MountedLayoutPresentationKey key = core::ReservedLayoutMountKey{target->slot};
    if (input.owner != *resolved_owner.value_if() || input.key != key ||
        input.occurrence.number() != target->occurrence || input.signal != target->signal)
        return core::Result<bool, core::Diagnostics>::success(false);
    auto completed = complete(blocker->owner, core::AnyFlowBlockerHandle{blocker->handle});
    return completed ? core::Result<bool, core::Diagnostics>::success(true)
                     : core::Result<bool, core::Diagnostics>::failure(completed.error());
}

core::Result<ScriptInvocationOutcome, ScriptInvocationError>
RuntimeExecutor::resume_script(const core::FlowFrameId& owner,
                               const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptInvocationError>;
    auto valid = m_flow.validate_blocker(owner, invocation);
    if (!valid) {
        const std::string message = valid.error().empty() ? "Script invocation blocker is invalid"
                                                          : valid.error().front().message;
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = message,
                                  .chunk = "resume",
                                  .traceback = message});
    }
    auto resumed = m_scripts.resume(invocation, m_gameplay_capabilities);
    if (!resumed) {
        (void)m_flow.cancel_blocker(owner, invocation);
        return Result::failure(resumed.error());
    }
    const auto* outcome = resumed.value_if();
    if (outcome != nullptr && std::holds_alternative<ScriptInvocationCompleted>(*outcome)) {
        auto completed = m_flow.resume_blocker(owner, invocation);
        if (!completed) {
            const std::string message = completed.error().empty()
                                            ? "Script invocation blocker is invalid"
                                            : completed.error().front().message;
            return Result::failure(
                ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                      .message = message,
                                      .chunk = "resume",
                                      .traceback = message});
        }
    }
    return resumed;
}

core::Result<void, ScriptInvocationError>
RuntimeExecutor::cancel_script(const core::FlowFrameId& owner,
                               const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<void, ScriptInvocationError>;
    auto valid = m_flow.validate_blocker(owner, invocation);
    if (!valid) {
        const std::string message = valid.error().empty() ? "Script invocation blocker is invalid"
                                                          : valid.error().front().message;
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = message,
                                  .chunk = "cancel",
                                  .traceback = message});
    }
    m_scripts.cancel(invocation, runtime::ScriptCancellationReason::OwnerEnded);
    auto released = m_flow.cancel_blocker(owner, invocation);
    if (released)
        return Result::success();
    const std::string message = released.error().empty() ? "Script invocation blocker is invalid"
                                                         : released.error().front().message;
    return Result::failure(ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                                 .message = message,
                                                 .chunk = "cancel",
                                                 .traceback = message});
}

core::FlowRunOutcome RuntimeExecutor::run_until_blocked(std::size_t instruction_budget,
                                                        std::string_view runtime_locale,
                                                        bool fast_forward)
{
    if (m_state.gameplay_paused())
        return core::FlowBudgetYieldOutcome{0};

    auto fault = [this](core::Diagnostics diagnostics) -> core::FlowRunOutcome {
        const auto copy = diagnostics;
        (void)m_flow.fault(std::move(diagnostics));
        return core::FlowFaultOutcome{copy};
    };
    auto commit =
        [this, &fault](const core::SceneId& scene, const core::SceneStepId& step,
                       core::SceneFramePosition position) -> std::optional<core::FlowRunOutcome> {
        auto result = m_flow.advance_scene(scene, step, std::move(position));
        if (!result)
            return fault(result.error());
        return std::nullopt;
    };
    auto queue_autosave = [this](const core::SceneId& scene, const core::SceneStepId& step) {
        (void)scene;
        (void)step;
        m_gateway.request_autosave_safe_point();
    };

    auto started = m_flow.begin_run();
    if (!started)
        return core::FlowFaultOutcome{started.error()};
    struct RunGuard {
        core::FlowExecutor& flow;
        ~RunGuard() { flow.end_run(); }
    } run_guard{m_flow};

    if (m_state.execution_fault())
        return core::FlowFaultOutcome{*m_state.execution_fault()};
    if (m_state.blocker())
        return core::FlowBlockedOutcome{*m_state.blocker()};
    if (!std::holds_alternative<core::FlowMode>(m_state.mode()))
        return core::FlowModeChangedOutcome{m_state.mode()};
    if (instruction_budget == 0)
        return core::FlowBudgetYieldOutcome{0};

    std::size_t executed = 0;
    while (executed < instruction_budget) {
        if (m_gateway.has_frame_sensitive_command())
            return core::FlowBudgetYieldOutcome{executed};
        if (m_state.gameplay_paused())
            return core::FlowBudgetYieldOutcome{executed};
        if (m_state.blocker())
            return core::FlowBlockedOutcome{*m_state.blocker()};
        if (!std::holds_alternative<core::FlowMode>(m_state.mode()))
            return core::FlowModeChangedOutcome{m_state.mode()};
        if (m_state.flow_stack().empty())
            return fault(execution_error("execution.invalid_stack",
                                         "Flow mode requires an active typed frame"));
        if (std::holds_alternative<core::RoomTransitionFrame>(m_state.flow_stack().back())) {
            auto outcome = run_room_unit(runtime_locale);
            if (outcome)
                return *outcome;
            ++executed;
            continue;
        }
        if (std::holds_alternative<core::DialogueFrame>(m_state.flow_stack().back())) {
            auto outcome = run_dialogue_unit(runtime_locale);
            if (outcome)
                return *outcome;
            ++executed;
            continue;
        }
        if (std::holds_alternative<core::InteractionFrame>(m_state.flow_stack().back())) {
            auto outcome = run_interaction_unit(runtime_locale);
            if (outcome)
                return *outcome;
            ++executed;
            continue;
        }
        const auto* frame = std::get_if<core::SceneFrame>(&m_state.flow_stack().back());
        if (frame == nullptr)
            return fault(execution_error("execution.invalid_frame_variant",
                                         "The active Flow frame variant is not executable"));
        const auto* scene = m_project.find_scene(frame->scene);
        if (scene == nullptr)
            return fault(execution_error("execution.invalid_scene",
                                         "The active Scene definition is missing"));

        if (!frame->position.stage_initialized) {
            auto initialized = m_flow.mark_scene_stage_initialized(frame->scene);
            if (!initialized)
                return fault(initialized.error());
            ++executed;
            continue;
        }

        if (!frame->position.next_step) {
            auto applied = m_flow.apply_scene_terminal(scene->terminal);
            if (!applied)
                return fault(applied.error());
            ++executed;
            continue;
        }
        const auto step = *frame->position.next_step;
        const auto sequential = next_instruction(*scene, step);

        if (std::holds_alternative<core::SceneStepReady>(frame->position.substate) &&
            m_scene_event_dependency_checker &&
            m_scene_event_dependency_checker(frame->frame_id, frame->scene, step))
            return core::FlowBudgetYieldOutcome{executed};

        if (const auto* completion =
                std::get_if<core::SceneInstructionCompletionPosition>(&frame->position.substate)) {
            if (completion->autosave_safe_point)
                queue_autosave(frame->scene, step);
            if (auto failed =
                    commit(frame->scene, step, {completion->next_step, core::SceneStepReady{}}))
                return *failed;
            ++executed;
            continue;
        }
        if (const auto* pending =
                std::get_if<core::SceneAutosavePendingPosition>(&frame->position.substate)) {
            queue_autosave(frame->scene, pending->completed_step);
            if (auto failed =
                    commit(frame->scene, step, {pending->next_step, core::SceneStepReady{}}))
                return *failed;
            ++executed;
            continue;
        }
        if (const auto* effects =
                std::get_if<core::SceneChoiceEffectPosition>(&frame->position.substate)) {
            const auto* instruction = find_instruction(*scene, step);
            const auto* choice =
                instruction == nullptr
                    ? nullptr
                    : std::get_if<core::compiled::ChoiceSceneInstruction>(instruction);
            const auto* option =
                choice == nullptr ? nullptr : find_choice_option(*choice, effects->option);
            if (choice == nullptr || option == nullptr)
                return fault(execution_error("execution.invalid_scene_choice",
                                             "Active Scene choice position is invalid"));
            if (effects->next_effect >= option->effects.size()) {
                if (choice->autosave_safe_point)
                    queue_autosave(frame->scene, step);
                if (auto failed = commit(frame->scene, step,
                                         {option->target_instruction_id, core::SceneStepReady{}}))
                    return *failed;
                ++executed;
                continue;
            }
            if (effects->awaiting_completion) {
                if (auto failed =
                        commit(frame->scene, step,
                               {step, core::SceneChoiceEffectPosition{
                                          effects->option, effects->next_effect + 1, false}}))
                    return *failed;
                ++executed;
                continue;
            }
            auto applied = apply(option->effects[effects->next_effect], "scene-choice-effect");
            if (!applied) {
                if (const auto* diagnostics = std::get_if<core::Diagnostics>(&applied.error()))
                    return fault(*diagnostics);
                return fault(script_diagnostics(std::get<ScriptInvocationError>(applied.error())));
            }
            const auto* applied_outcome = applied.value_if();
            const bool suspended =
                applied_outcome != nullptr &&
                std::holds_alternative<ScriptInvocationSuspended>(*applied_outcome);
            core::SceneChoiceEffectPosition next{
                effects->option, effects->next_effect + (suspended ? 0 : 1), suspended};
            if (suspended) {
                auto marked = m_flow.mark_scene_wait(frame->scene, step, next);
                if (!marked)
                    return fault(marked.error());
                return core::FlowBlockedOutcome{*m_state.blocker()};
            }
            if (auto failed = commit(frame->scene, step, {step, next}))
                return *failed;
            ++executed;
            continue;
        }
        if (std::holds_alternative<core::SceneChoiceSelectionPosition>(frame->position.substate))
            return fault(execution_error("execution.scene_choice_without_blocker",
                                         "Scene choice selection lost its input blocker"));

        const auto* instruction = find_instruction(*scene, step);
        if (instruction == nullptr)
            return fault(execution_error("execution.invalid_scene_position",
                                         "Active Scene instruction is missing"));

        auto outcome = std::visit(
            [&, this](const auto& value) -> std::optional<core::FlowRunOutcome> {
                using T = std::decay_t<decltype(value)>;
                if (value.condition) {
                    auto condition = evaluate(*value.condition);
                    if (!condition) {
                        if (const auto* diagnostics =
                                std::get_if<core::Diagnostics>(&condition.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(condition.error())));
                    }
                    const auto* condition_value = condition.value_if();
                    if (condition_value == nullptr)
                        return fault(execution_error("execution.invalid_condition_result",
                                                     "Scene condition produced no value"));
                    if (!*condition_value)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                }

                if constexpr (std::is_same_v<T, core::compiled::SetBackgroundInstruction>) {
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    const core::DesiredBackgroundOverride desired{owner, value.background};
                    const auto current =
                        std::find_if(m_state.background_overrides().begin(),
                                     m_state.background_overrides().end(),
                                     [&owner](const core::DesiredBackgroundOverride& candidate) {
                                         return candidate.owner == owner;
                                     });
                    if (current != m_state.background_overrides().end() && *current == desired)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});

                    const core::SessionState source_state = m_state;
                    const auto source_room = m_room_presentation;
                    auto changed = m_state.set_background(m_project, owner, value.background);
                    if (!changed)
                        return fault(changed.error());
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    if (value.transition == core::compiled::BackgroundTransition::Fade) {
                        auto completion = advance_scene_for_presentation(frame->scene, step,
                                                                         sequential, value.wait);
                        if (!completion) {
                            m_state = source_state;
                            return fault(completion.error());
                        }
                        stage_pending_presentation(
                            PendingBackgroundOperation{std::chrono::milliseconds{value.duration_ms},
                                                       value.skippable, *completion.value_if()},
                            source_state, source_room);
                        return completion.value_if()->has_value()
                                   ? std::optional<core::FlowRunOutcome>{core::FlowBlockedOutcome{
                                         *m_state.blocker()}}
                                   : std::optional<core::FlowRunOutcome>{
                                         core::FlowPresentationBoundaryOutcome{}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::ActorCueInstruction>) {
                    const auto* character = m_world.resolved_configuration(value.character);
                    if (character == nullptr)
                        return fault(execution_error("execution.invalid_actor_character",
                                                     "Actor cue Character is missing"));
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    auto resolved_key = scene_actor_key(*frame, value.owner, owner, value.slot_id);
                    if (!resolved_key)
                        return fault(resolved_key.error());
                    const core::ActorPresentationKey key = *resolved_key.value_if();
                    const auto* current = m_state.actor(key, owner);
                    const bool same_character =
                        current != nullptr && current->character == value.character;
                    const auto profile = value.profile_id ? *value.profile_id
                                         : same_character ? current->profile
                                                          : character->defaults.profile_id;
                    const auto profile_definition =
                        std::ranges::find_if(character->profiles, [&](const auto& candidate) {
                            return candidate.id == profile;
                        });
                    if (profile_definition == character->profiles.end())
                        return fault(execution_error("execution.invalid_actor_profile",
                                                     "Actor cue Profile is missing"));
                    const bool preserve_pose = same_character && current->profile == profile;
                    const auto pose = value.pose_id   ? *value.pose_id
                                      : preserve_pose ? current->pose
                                                      : profile_definition->default_pose_id;
                    const auto expression = value.expression_id ? *value.expression_id
                                            : same_character    ? current->expression
                                                                : character->defaults.expression_id;
                    const auto appearance =
                        value.action == core::compiled::ActorCueAction::Appearance
                            ? value.appearance_id
                        : value.appearance_id ? value.appearance_id
                        : same_character      ? current->appearance
                                              : character->defaults.appearance_id;
                    bool visible = current != nullptr && current->visible;
                    if (value.action == core::compiled::ActorCueAction::Show)
                        visible = true;
                    else if (value.action == core::compiled::ActorCueAction::Hide)
                        visible = false;
                    core::DesiredActorPresentation actor{
                        key,
                        owner,
                        value.character,
                        profile,
                        pose,
                        expression,
                        appearance,
                        current != nullptr ? current->idle : character->defaults.idle_id,
                        {value.position, value.offset, value.scale},
                        visible,
                        true};
                    if (current != nullptr && *current == actor)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    const core::SessionState source_state = m_state;
                    const auto source_room = m_room_presentation;
                    auto changed = m_state.set_actor(m_project, std::move(actor));
                    if (!changed)
                        return fault(changed.error());
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    if (value.transition != core::compiled::ActorTransition::None) {
                        auto completion = advance_scene_for_presentation(frame->scene, step,
                                                                         sequential, value.wait);
                        if (!completion) {
                            m_state = source_state;
                            return fault(completion.error());
                        }
                        stage_pending_presentation(
                            PendingActorOperation{key,
                                                  value.transition ==
                                                          core::compiled::ActorTransition::Fade
                                                      ? core::ActorOperationKind::Fade
                                                      : core::ActorOperationKind::Slide,
                                                  std::chrono::milliseconds{value.duration_ms},
                                                  value.skippable, *completion.value_if()},
                            source_state, source_room);
                        return completion.value_if()->has_value()
                                   ? std::optional<core::FlowRunOutcome>{core::FlowBlockedOutcome{
                                         *m_state.blocker()}}
                                   : std::optional<core::FlowRunOutcome>{
                                         core::FlowPresentationBoundaryOutcome{}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::CallSceneSceneInstruction>) {
                    core::SceneStepSubstate substate =
                        value.autosave_safe_point
                            ? core::SceneStepSubstate{core::SceneAutosavePendingPosition{
                                  step, sequential}}
                            : core::SceneStepSubstate{core::SceneStepReady{}};
                    auto called = m_flow.call_child(
                        value.scene, value.inputs,
                        core::SceneFramePosition{value.autosave_safe_point
                                                     ? std::optional<core::SceneStepId>{step}
                                                     : sequential,
                                                 std::move(substate)});
                    return called ? std::nullopt
                                  : std::optional<core::FlowRunOutcome>{fault(called.error())};
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::StartDetachedSceneInstruction>) {
                    auto queued =
                        m_gateway.request_detached(value.scene, value.inputs, value.owner);
                    if (!queued)
                        return fault(queued.error());
                    if (value.autosave_safe_point)
                        queue_autosave(frame->scene, step);
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::CallDialogueSceneInstruction>) {
                    core::SceneStepSubstate substate =
                        value.autosave_safe_point
                            ? core::SceneStepSubstate{core::SceneAutosavePendingPosition{
                                  step, sequential}}
                            : core::SceneStepSubstate{core::SceneStepReady{}};
                    auto called = m_flow.call_child(
                        value.dialogue, value.start_block_id,
                        core::SceneFramePosition{value.autosave_safe_point
                                                     ? std::optional<core::SceneStepId>{step}
                                                     : sequential,
                                                 std::move(substate)});
                    return called ? std::nullopt
                                  : std::optional<core::FlowRunOutcome>{fault(called.error())};
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::ResumeDialogueSceneInstruction>) {
                    auto resumed = m_flow.resume_handed_off_dialogue(
                        core::SceneFramePosition{sequential, core::SceneStepReady{}});
                    if (!resumed)
                        return fault(resumed.error());
                    if (value.autosave_safe_point)
                        m_gateway.request_autosave_safe_point();
                    return core::FlowPresentationBoundaryOutcome{};
                } else if constexpr (std::is_same_v<T, core::compiled::ShowTextInstruction>) {
                    auto text = resolve(value.text.source, runtime_locale);
                    if (!text) {
                        if (const auto* diagnostics = std::get_if<core::Diagnostics>(&text.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(text.error())));
                    }
                    auto* resolved_text = text.value_if();
                    if (resolved_text == nullptr)
                        return fault(execution_error("execution.invalid_text_result",
                                                     "Scene text produced no value"));
                    auto presented = m_state.present_text(
                        m_project, {value.speaker, *resolved_text, value.text.markup});
                    if (!presented)
                        return fault(presented.error());
                    auto logged = m_state.append_text_log(
                        m_project,
                        {core::TextLogEntryKind::Line, core::SceneTextLogOrigin{frame->scene, step},
                         value.speaker, *resolved_text, value.text.markup});
                    if (!logged)
                        return fault(logged.error());
                    if (fast_forward) {
                        if (value.autosave_safe_point)
                            queue_autosave(frame->scene, step);
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    }
                    core::WaitSpec wait = std::visit(
                        [](const auto& item) -> core::WaitSpec { return item; }, value.wait);
                    auto waiting = begin(wait);
                    if (!waiting)
                        return fault(waiting.error());
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        auto marked = m_flow.mark_scene_wait(
                            frame->scene, step,
                            core::SceneInstructionCompletionPosition{
                                sequential, value.autosave_safe_point, std::nullopt});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    if (value.autosave_safe_point)
                        queue_autosave(frame->scene, step);
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::AudioCueInstruction>) {
                    const bool playing = value.action == core::compiled::AudioAction::Play ||
                                         value.action == core::compiled::AudioAction::FadeIn;
                    const bool desired =
                        value.lifetime == core::compiled::AudioLifetime::DesiredLoop;
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    if (desired) {
                        if (!value.instance_id)
                            return fault(execution_error(
                                "execution.desired_audio_identity_missing",
                                "Desired looping audio requires a stable instance ID"));
                        auto instance = core::DesiredAudioInstanceId::create(*value.instance_id);
                        if (!instance)
                            return fault(
                                execution_error("execution.desired_audio_identity_invalid",
                                                "Desired looping audio instance ID is invalid"));
                        if (!playing) {
                            auto changed =
                                m_state.remove_desired_audio(*instance.value_if(), owner);
                            if (!changed)
                                return fault(changed.error());
                            return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                        }
                        if (!value.asset)
                            return fault(execution_error(
                                "execution.desired_audio_asset_missing",
                                "Desired looping audio playback requires an Audio Asset"));
                        std::optional<core::DesiredAudioReplacementKey> replacement;
                        if (value.replacement_group) {
                            auto key =
                                core::DesiredAudioReplacementKey::create(*value.replacement_group);
                            if (!key)
                                return fault(
                                    execution_error("execution.desired_audio_replacement_invalid",
                                                    "Desired audio replacement group is invalid"));
                            replacement = *key.value_if();
                        }
                        auto changed = m_state.upsert_desired_audio(
                            m_project,
                            core::DesiredAudioInstance{
                                *instance.value_if(), owner, value.purpose, value.pause_policy,
                                *value.asset, value.gain, value.pan, value.pan_source,
                                value.action == core::compiled::AudioAction::FadeIn
                                    ? std::chrono::milliseconds{value.fade_ms}
                                    : std::chrono::milliseconds{0},
                                std::chrono::milliseconds{value.fade_ms}, std::move(replacement)});
                        if (!changed)
                            return fault(changed.error());
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    }

                    if (!playing)
                        return fault(
                            execution_error("execution.one_shot_audio_action_invalid",
                                            "One-shot Scene audio must start a new playback"));
                    if (fast_forward &&
                        value.skip_behavior != core::compiled::AudioSkipBehavior::Play)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto resolved_pan =
                        m_state.resolve_audio_pan(m_project, owner, value.pan, value.pan_source);
                    if (!resolved_pan)
                        return fault(std::move(resolved_pan).error());
                    core::WaitSpec wait = std::visit(
                        [](const auto& item) -> core::WaitSpec { return item; }, value.wait);
                    auto waiting = begin(wait);
                    if (!waiting)
                        return fault(waiting.error());
                    std::optional<core::AudioFlowCompletion> completion;
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        const auto* blocker =
                            std::get_if<core::AudioFlowBlocker>(&*m_state.blocker());
                        if (blocker == nullptr)
                            return fault(execution_error(
                                "execution.audio_blocker_missing",
                                "Awaited audio cue did not create an audio flow blocker"));
                        completion = core::AudioFlowCompletion{blocker->owner, blocker->handle};
                    }
                    m_pending_audio_operations.push_back(PendingAudioOperation{
                        value.action, value.purpose, value.pause_policy, owner, value.asset,
                        std::chrono::milliseconds{value.fade_ms}, value.gain,
                        *resolved_pan.value_if(), value.pan_source, completion,
                        core::AudioOperationTarget{core::NewAudioPlaybackTarget{}}, value.causality,
                        value.synchronized, value.skip_behavior,
                        PendingAudioOperation::SceneSource{frame->frame_id, frame->scene, step}});
                    if (completion) {
                        auto marked =
                            m_flow.mark_scene_wait(frame->scene, step,
                                                   core::SceneInstructionCompletionPosition{
                                                       sequential, false, std::nullopt});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::SetGlobalPropertySceneInstruction>) {
                    auto changed =
                        apply(core::Effect{core::SetGlobalProperty{value.property, value.value}});
                    if (!changed) {
                        if (const auto* diagnostics =
                                std::get_if<core::Diagnostics>(&changed.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(changed.error())));
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::GameplayEffectBatchSceneInstruction>) {
                    const core::SceneId scene_id = frame->scene;
                    core::SessionState staged_state = m_state;
                    RuntimeWorld staged_world(m_project, staged_state);
                    RuntimeCommandGateway staged_gateway(m_project, staged_state, staged_world,
                                                         m_gateway.generation());
                    MutationImpactJournal impacts;
                    for (const auto& operation : value.operations) {
                        const auto capability = scene_gameplay_operation_capability(operation);
                        if (!m_gameplay_capabilities.can_command(capability))
                            return fault(execution_error(
                                "execution.scene_gameplay_capability_denied",
                                "Scene Gameplay Effect Batch requires an unavailable gameplay "
                                "capability"));
                        auto changed = apply_scene_gameplay_operation(operation, staged_gateway,
                                                                      staged_world, impacts);
                        if (!changed)
                            return fault(changed.error());
                    }
                    impacts.merge(staged_gateway.take_mutation_impacts());
                    m_state = std::move(staged_state);
                    m_gateway.merge_mutation_impacts(impacts);
                    if (impacts.contains(MutationImpact::RoomPresentationInvalidated))
                        m_room_presentation_dirty = true;
                    return commit(scene_id, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<
                                         T,
                                         core::compiled::RuntimeWorldTransactionSceneInstruction>) {
                    const core::SceneId scene_id = frame->scene;
                    core::SessionState staged_state = m_state;
                    RuntimeWorld staged_world(m_project, staged_state);
                    RuntimeCommandGateway staged_gateway(m_project, staged_state, staged_world,
                                                         m_gateway.generation());
                    for (const auto& operation : value.operations) {
                        const auto capability = scene_world_operation_capability(operation);
                        if (!m_gameplay_capabilities.can_command(capability))
                            return fault(execution_error(
                                "execution.scene_world_capability_denied",
                                "Scene Runtime World Transaction requires an unavailable gameplay "
                                "capability"));
                        auto changed = apply_scene_world_operation(operation, staged_gateway);
                        if (!changed)
                            return fault(changed.error());
                    }
                    auto impacts = staged_gateway.take_mutation_impacts();
                    m_state = std::move(staged_state);
                    m_gateway.merge_mutation_impacts(impacts);
                    if (impacts.contains(MutationImpact::RoomPresentationInvalidated))
                        m_room_presentation_dirty = true;
                    return commit(scene_id, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::DirectedRoomChangeSceneInstruction>) {
                    if (!m_gameplay_capabilities.can_command(RuntimeCapabilityGroup::Room))
                        return fault(execution_error(
                            "execution.scene_room_capability_denied",
                            "Scene Directed Room Change requires the Room gameplay capability"));
                    auto called = m_flow.call_directed_room_change(
                        value.room, core::SceneFramePosition{sequential, core::SceneStepReady{}});
                    if (!called)
                        return fault(called.error());
                    m_room_presentation_dirty = true;
                    return std::nullopt;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::NavigationAttemptSceneInstruction>) {
                    if (!m_gameplay_capabilities.can_command(RuntimeCapabilityGroup::Room))
                        return fault(execution_error(
                            "execution.scene_room_capability_denied",
                            "Scene Navigation Attempt requires the Room gameplay capability"));
                    if (!m_state.room_visit())
                        return fault(execution_error("execution.navigation_without_room",
                                                     "Navigation Attempt requires a Current Room"));
                    auto called = m_flow.call_navigation(
                        value.room,
                        core::compiled::RoomExitRef{m_state.room_visit()->room, value.exit},
                        core::SceneFramePosition{sequential, core::SceneStepReady{}});
                    if (!called)
                        return fault(called.error());
                    return std::nullopt;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::CallInteractionSceneInstruction>) {
                    if (!m_gameplay_capabilities.can_command(RuntimeCapabilityGroup::Flow))
                        return fault(execution_error(
                            "execution.scene_flow_capability_denied",
                            "Scene Interaction call requires the Flow gameplay capability"));
                    std::vector<core::InteractionSubjectBinding> bindings;
                    bindings.reserve(value.bindings.size());
                    for (const auto& binding : value.bindings)
                        bindings.push_back({binding.slot, binding.subject});
                    auto called = interact_in_context(
                        value.verb, std::move(bindings),
                        core::SceneFramePosition{sequential, core::SceneStepReady{}});
                    if (!called) {
                        if (const auto* diagnostics =
                                std::get_if<core::Diagnostics>(&called.error()))
                            return fault(*diagnostics);
                        return fault(execution_error("execution.scene_interaction_failed",
                                                     "Scene Interaction call failed"));
                    }
                    return std::nullopt;
                } else if constexpr (std::is_same_v<T, core::compiled::RunLuaSceneInstruction>) {
                    auto invoked = invoke_script(value.source, "scene-run-lua");
                    if (!invoked)
                        return fault(script_diagnostics(invoked.error()));
                    const auto* invocation_outcome = invoked.value_if();
                    if (invocation_outcome != nullptr &&
                        std::holds_alternative<ScriptInvocationSuspended>(*invocation_outcome)) {
                        if (!value.may_yield) {
                            const auto& suspended =
                                std::get<ScriptInvocationSuspended>(*invocation_outcome);
                            (void)cancel_script(suspended.owner, suspended.invocation);
                            return fault(execution_error("execution.scene_yield_forbidden",
                                                         "Scene RunLua instruction may not yield"));
                        }
                        auto marked = m_flow.mark_scene_wait(
                            frame->scene, step,
                            core::SceneInstructionCompletionPosition{
                                sequential, value.autosave_safe_point, std::nullopt});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    if (value.autosave_safe_point)
                        queue_autosave(frame->scene, step);
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::WaitDurationInstruction>) {
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto waiting = begin(core::WaitSpec{value.wait});
                    if (!waiting)
                        return fault(waiting.error());
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        auto marked =
                            m_flow.mark_scene_wait(frame->scene, step,
                                                   core::SceneInstructionCompletionPosition{
                                                       sequential, false, std::nullopt});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::WaitInputInstruction>) {
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto marked = m_flow.mark_scene_wait(
                        frame->scene, step,
                        core::SceneInstructionCompletionPosition{sequential, false, std::nullopt});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                } else if constexpr (std::is_same_v<T, core::compiled::WaitConditionInstruction>) {
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto condition = evaluate(value.wait_condition);
                    if (!condition) {
                        if (const auto* diagnostics =
                                std::get_if<core::Diagnostics>(&condition.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(condition.error())));
                    }
                    if (const auto* ready = condition.value_if(); ready != nullptr && *ready)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto marked = m_flow.mark_scene_wait(
                        frame->scene, step,
                        core::SceneInstructionCompletionPosition{
                            sequential, false,
                            core::SceneSemanticWaitTarget{core::SceneConditionWaitTarget{}}});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                } else if constexpr (std::is_same_v<T, core::compiled::WaitOperationInstruction>) {
                    const bool active = m_scene_event_presentation_operation_checker &&
                                        m_scene_event_presentation_operation_checker(
                                            frame->frame_id, frame->scene, value.event);
                    if (!active)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto marked = m_flow.mark_scene_wait(
                        frame->scene, step,
                        core::SceneInstructionCompletionPosition{
                            sequential, false,
                            core::SceneSemanticWaitTarget{
                                core::ScenePresentationOperationWaitTarget{value.event}}});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                } else if constexpr (std::is_same_v<T, core::compiled::WaitAudioInstruction>) {
                    const bool pending = std::ranges::any_of(
                        m_pending_audio_operations, [&](const PendingAudioOperation& operation) {
                            return operation.scene_source &&
                                   operation.scene_source->invocation == frame->frame_id &&
                                   operation.scene_source->scene == frame->scene &&
                                   operation.scene_source->event == value.event;
                        });
                    const bool active =
                        pending || (m_scene_event_audio_operation_checker &&
                                    m_scene_event_audio_operation_checker(
                                        frame->frame_id, frame->scene, value.event));
                    if (!active)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto marked = m_flow.mark_scene_wait(
                        frame->scene, step,
                        core::SceneInstructionCompletionPosition{
                            sequential, false,
                            core::SceneSemanticWaitTarget{
                                core::SceneAudioOperationWaitTarget{value.event}}});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::WaitLayoutSignalInstruction>) {
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    const core::MountedLayoutPresentationKey key =
                        core::ReservedLayoutMountKey{value.slot};
                    const auto mounted = std::ranges::find_if(
                        m_state.mounted_layouts(), [&](const core::DesiredMountedLayout& item) {
                            return item.owner == owner && item.key == key;
                        });
                    if (mounted == m_state.mounted_layouts().end() || !mounted->occurrence)
                        return fault(execution_error(
                            "execution.scene_layout_signal_mount_missing",
                            "Scene Layout Signal wait requires a live mounted Layout occurrence"));
                    if (std::ranges::find(mounted->connected_signals, value.signal) ==
                        mounted->connected_signals.end())
                        return fault(execution_error(
                            "execution.scene_layout_signal_not_connected",
                            "Scene Layout Signal wait requires the exact signal to be connected"));
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto marked = m_flow.mark_scene_wait(
                        frame->scene, step,
                        core::SceneInstructionCompletionPosition{
                            sequential, false,
                            core::SceneSemanticWaitTarget{core::SceneLayoutSignalWaitTarget{
                                value.owner, value.slot, mounted->occurrence->number(),
                                value.signal}}});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::ConditionalBranchInstruction>) {
                    for (const auto& branch : value.branches) {
                        auto condition = evaluate(branch.condition);
                        if (!condition) {
                            if (const auto* diagnostics =
                                    std::get_if<core::Diagnostics>(&condition.error()))
                                return fault(*diagnostics);
                            return fault(script_diagnostics(
                                std::get<ScriptInvocationError>(condition.error())));
                        }
                        const auto* condition_value = condition.value_if();
                        if (condition_value == nullptr)
                            return fault(execution_error("execution.invalid_condition_result",
                                                         "Scene branch produced no value"));
                        if (*condition_value)
                            return commit(frame->scene, step,
                                          {branch.target_instruction_id, core::SceneStepReady{}});
                    }
                    return commit(frame->scene, step,
                                  {value.fallback_instruction_id, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::ChoiceSceneInstruction>) {
                    core::SceneChoiceState state{frame->scene, step, std::nullopt, {}};
                    if (value.prompt) {
                        auto prompt = resolve(value.prompt->source, runtime_locale);
                        if (!prompt) {
                            if (const auto* diagnostics =
                                    std::get_if<core::Diagnostics>(&prompt.error()))
                                return fault(*diagnostics);
                            return fault(script_diagnostics(
                                std::get<ScriptInvocationError>(prompt.error())));
                        }
                        auto* prompt_value = prompt.value_if();
                        if (prompt_value == nullptr)
                            return fault(execution_error("execution.invalid_text_result",
                                                         "Scene choice prompt produced no value"));
                        state.prompt = std::move(*prompt_value);
                    }
                    for (const auto& option : value.options) {
                        bool enabled = true;
                        if (option.condition) {
                            auto condition = evaluate(*option.condition);
                            if (!condition) {
                                if (const auto* diagnostics =
                                        std::get_if<core::Diagnostics>(&condition.error()))
                                    return fault(*diagnostics);
                                return fault(script_diagnostics(
                                    std::get<ScriptInvocationError>(condition.error())));
                            }
                            const auto* condition_value = condition.value_if();
                            if (condition_value == nullptr)
                                return fault(
                                    execution_error("execution.invalid_condition_result",
                                                    "Scene choice condition produced no value"));
                            enabled = *condition_value;
                        }
                        auto label = resolve(option.label.source, runtime_locale);
                        if (!label) {
                            if (const auto* diagnostics =
                                    std::get_if<core::Diagnostics>(&label.error()))
                                return fault(*diagnostics);
                            return fault(
                                script_diagnostics(std::get<ScriptInvocationError>(label.error())));
                        }
                        auto* label_value = label.value_if();
                        if (label_value == nullptr)
                            return fault(execution_error("execution.invalid_text_result",
                                                         "Scene choice label produced no value"));
                        state.options.push_back({option.id, std::move(*label_value), enabled});
                    }
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto presented = m_state.present_choice(m_project, std::move(state));
                    if (!presented)
                        return fault(presented.error());
                    auto marked = m_flow.mark_scene_wait(frame->scene, step,
                                                         core::SceneChoiceSelectionPosition{});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowBlockedOutcome{*m_state.blocker()};
                } else if constexpr (std::is_same_v<T, core::compiled::SetLayoutInstruction>) {
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    const core::MountedLayoutPresentationKey key =
                        core::ReservedLayoutMountKey{value.slot};
                    const core::SessionState source_state = m_state;
                    const auto source_room = m_room_presentation;
                    core::Result<void, core::Diagnostics> changed =
                        core::Result<void, core::Diagnostics>::success();
                    if (value.action == core::compiled::LayoutAction::Hide)
                        changed = m_state.clear_layout(owner, value.slot);
                    else if (value.layout)
                        changed = m_state.set_layout(m_project, owner, value.slot, *value.layout,
                                                     value.scale_overrides);
                    else
                        changed = core::Result<void, core::Diagnostics>::failure(
                            execution_error("execution.invalid_scene_layout",
                                            "Scene layout action requires a Layout"));
                    if (!changed)
                        return fault(changed.error());
                    if (m_state.mounted_layouts() == source_state.mounted_layouts())
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    if (value.transition == core::compiled::LayoutTransition::Fade) {
                        auto completion = advance_scene_for_presentation(frame->scene, step,
                                                                         sequential, value.wait);
                        if (!completion) {
                            m_state = source_state;
                            return fault(completion.error());
                        }
                        stage_pending_presentation(
                            PendingLayoutOperation{key, owner,
                                                   std::chrono::milliseconds{value.duration_ms},
                                                   value.skippable, *completion.value_if()},
                            source_state, source_room);
                        return completion.value_if()->has_value()
                                   ? std::optional<core::FlowRunOutcome>{core::FlowBlockedOutcome{
                                         *m_state.blocker()}}
                                   : std::optional<core::FlowRunOutcome>{
                                         core::FlowPresentationBoundaryOutcome{}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::MaterialParameterInstruction>) {
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    const auto occurrence = std::visit(
                        [&](const auto& target)
                            -> core::Result<core::MaterialOccurrence, core::Diagnostics> {
                            using Target = std::decay_t<decltype(target)>;
                            if constexpr (std::is_same_v<Target,
                                                         core::compiled::
                                                             BackgroundMaterialInstructionTarget>) {
                                return core::Result<core::MaterialOccurrence, core::Diagnostics>::
                                    success(core::BackgroundMaterialOccurrence{});
                            } else if constexpr (std::is_same_v<
                                                     Target, core::compiled::
                                                                 ActorMaterialInstructionTarget>) {
                                auto key = scene_actor_key(*frame, value.owner, owner, target.slot);
                                return key ? core::Result<core::MaterialOccurrence,
                                                          core::Diagnostics>::
                                                 success(core::ActorMaterialOccurrence{
                                                     *key.value_if(), target.layer})
                                           : core::Result<core::MaterialOccurrence,
                                                          core::Diagnostics>::failure(key.error());
                            } else if constexpr (std::is_same_v<
                                                     Target, core::compiled::
                                                                 LayoutMaterialInstructionTarget>) {
                                return core::Result<core::MaterialOccurrence, core::Diagnostics>::
                                    success(core::LayoutMaterialOccurrence{
                                        core::MountedLayoutPresentationKey{
                                            core::ReservedLayoutMountKey{target.slot}},
                                        value.material});
                            } else {
                                return core::Result<core::MaterialOccurrence, core::Diagnostics>::
                                    success(core::PostprocessMaterialOccurrence{target.instance});
                            }
                        },
                        value.target);
                    if (!occurrence)
                        return fault(occurrence.error());
                    const auto clock = value.clock == core::compiled::MaterialClock::Gameplay
                                           ? core::MaterialClockPolicy::Gameplay
                                           : core::MaterialClockPolicy::UnscaledPresentation;
                    const auto* current = m_state.material_parameter(
                        *occurrence.value_if(), owner, value.material, value.parameter);
                    if (current && current->binding)
                        return fault(
                            execution_error("execution.material_parameter_binding_authoritative",
                                            "A bound Material Parameter must be unbound before "
                                            "direct assignment or transition"));
                    if (current && current->value == std::optional{value.value} &&
                        current->clock == clock)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});

                    const core::SessionState source_state = m_state;
                    const auto source_room = m_room_presentation;
                    std::optional<core::compiled::MaterialParameterValue> source_value;
                    if (current)
                        source_value = current->value;
                    auto changed = m_state.upsert_material_parameter(
                        m_project, core::DesiredMaterialParameter{
                                       owner, *occurrence.value_if(), value.material,
                                       value.parameter, value.value, std::nullopt, clock});
                    if (!changed)
                        return fault(changed.error());
                    if (value.transition == core::compiled::MaterialParameterTransition::Tween) {
                        if (!source_value) {
                            m_state = source_state;
                            return fault(execution_error(
                                "execution.material_parameter_transition_source_missing",
                                "A finite Material Parameter transition requires an existing "
                                "occurrence-local source value"));
                        }
                        if (fast_forward && value.skippable)
                            return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                        auto completion = advance_scene_for_presentation(frame->scene, step,
                                                                         sequential, value.wait);
                        if (!completion) {
                            m_state = source_state;
                            return fault(completion.error());
                        }
                        const auto easing =
                            value.easing == core::compiled::MaterialEasing::Linear
                                ? core::PresentationEasing::Linear
                            : value.easing == core::compiled::MaterialEasing::EaseIn
                                ? core::PresentationEasing::EaseIn
                            : value.easing == core::compiled::MaterialEasing::EaseOut
                                ? core::PresentationEasing::EaseOut
                                : core::PresentationEasing::EaseInOut;
                        stage_pending_presentation(
                            PendingMaterialParameterOperation{
                                core::MaterialParameterOperationTarget{
                                    owner, *occurrence.value_if(), value.material, value.parameter},
                                std::move(*source_value), value.value,
                                std::chrono::milliseconds{value.duration_ms}, value.skippable,
                                clock, easing, *completion.value_if()},
                            source_state, source_room);
                        return completion.value_if()->has_value()
                                   ? std::optional<core::FlowRunOutcome>{core::FlowBlockedOutcome{
                                         *m_state.blocker()}}
                                   : std::optional<core::FlowRunOutcome>{
                                         core::FlowPresentationBoundaryOutcome{}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::PostprocessEffectInstruction>) {
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    if (value.action == core::compiled::PostprocessEffectAction::Remove) {
                        auto removed = m_state.remove_postprocess_effect(value.instance, owner);
                        if (!removed)
                            return fault(removed.error());
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    }
                    if (!value.material)
                        return fault(
                            execution_error("execution.postprocess_material_missing",
                                            "Postprocess Effect upsert requires a Material"));
                    const core::SessionState source_state = m_state;
                    auto changed = m_state.upsert_postprocess_effect(
                        m_project,
                        core::DesiredPostprocessEffect{
                            value.instance, owner, *value.material, value.scope, value.order,
                            value.clock == core::compiled::MaterialClock::Gameplay
                                ? core::MaterialClockPolicy::Gameplay
                                : core::MaterialClockPolicy::UnscaledPresentation,
                            true});
                    if (!changed)
                        return fault(changed.error());
                    for (const auto& parameter : value.parameters) {
                        auto assigned = m_state.upsert_material_parameter(
                            m_project,
                            core::DesiredMaterialParameter{
                                owner, core::PostprocessMaterialOccurrence{value.instance},
                                *value.material, parameter.name, parameter.value, std::nullopt,
                                value.clock == core::compiled::MaterialClock::Gameplay
                                    ? core::MaterialClockPolicy::Gameplay
                                    : core::MaterialClockPolicy::UnscaledPresentation});
                        if (!assigned) {
                            m_state = source_state;
                            return fault(assigned.error());
                        }
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::TransitionGroupInstruction>) {
                    auto resolved_owner =
                        resolve_scene_presentation_owner(m_state, *frame, value.owner);
                    if (!resolved_owner)
                        return fault(resolved_owner.error());
                    const core::PresentationOwner owner = *resolved_owner.value_if();
                    const core::PresentationTargetDraft source_target{
                        m_state.background_overrides(), m_state.camera_views(), m_state.actors(),
                        m_state.mounted_layouts()};
                    std::vector<core::TransitionGroupTargetMutation> mutations;
                    mutations.reserve(value.children.size());
                    for (const auto& child : value.children) {
                        auto converted = std::visit(
                            [&](const auto& item)
                                -> core::Result<core::TransitionGroupTargetMutation,
                                                core::Diagnostics> {
                                using C = std::decay_t<decltype(item)>;
                                if constexpr (std::is_same_v<
                                                  C, core::compiled::
                                                         TransitionGroupSetBackgroundMutation>) {
                                    return core::Result<core::TransitionGroupTargetMutation,
                                                        core::Diagnostics>::
                                        success(core::TransitionGroupUpsertBackgroundTarget{
                                            core::DesiredBackgroundOverride{owner,
                                                                            item.background}});
                                } else if constexpr (
                                    std::is_same_v<
                                        C,
                                        core::compiled::TransitionGroupClearBackgroundMutation>) {
                                    return core::Result<core::TransitionGroupTargetMutation,
                                                        core::Diagnostics>::
                                        success(core::TransitionGroupClearBackgroundTarget{owner});
                                } else if constexpr (std::is_same_v<
                                                         C, core::compiled::
                                                                TransitionGroupActorMutation>) {
                                    const auto* character =
                                        m_world.resolved_configuration(item.character);
                                    if (character == nullptr)
                                        return core::Result<core::TransitionGroupTargetMutation,
                                                            core::Diagnostics>::
                                            failure(execution_error(
                                                "execution.invalid_actor_character",
                                                "TransitionGroup Actor Character is missing"));
                                    auto resolved_key =
                                        scene_actor_key(*frame, value.owner, owner, item.slot_id);
                                    if (!resolved_key)
                                        return core::Result<
                                            core::TransitionGroupTargetMutation,
                                            core::Diagnostics>::failure(resolved_key.error());
                                    const core::ActorPresentationKey key = *resolved_key.value_if();
                                    const auto* current = m_state.actor(key, owner);
                                    const bool same_character =
                                        current != nullptr && current->character == item.character;
                                    const auto profile = item.profile_id ? *item.profile_id
                                                         : same_character
                                                             ? current->profile
                                                             : character->defaults.profile_id;
                                    const auto profile_definition = std::ranges::find_if(
                                        character->profiles, [&](const auto& candidate) {
                                            return candidate.id == profile;
                                        });
                                    if (profile_definition == character->profiles.end())
                                        return core::Result<core::TransitionGroupTargetMutation,
                                                            core::Diagnostics>::
                                            failure(execution_error(
                                                "execution.invalid_actor_profile",
                                                "TransitionGroup Actor Profile is missing"));
                                    const bool preserve_pose =
                                        same_character && current->profile == profile;
                                    const auto pose = item.pose_id ? *item.pose_id
                                                      : preserve_pose
                                                          ? current->pose
                                                          : profile_definition->default_pose_id;
                                    const auto expression = item.expression_id ? *item.expression_id
                                                            : same_character
                                                                ? current->expression
                                                                : character->defaults.expression_id;
                                    const auto appearance =
                                        item.action == core::compiled::ActorCueAction::Appearance
                                            ? item.appearance_id
                                        : item.appearance_id ? item.appearance_id
                                        : same_character     ? current->appearance
                                                             : character->defaults.appearance_id;
                                    bool visible = current != nullptr && current->visible;
                                    if (item.action == core::compiled::ActorCueAction::Show)
                                        visible = true;
                                    else if (item.action == core::compiled::ActorCueAction::Hide)
                                        visible = false;
                                    return core::Result<core::TransitionGroupTargetMutation,
                                                        core::Diagnostics>::
                                        success(core::TransitionGroupUpsertActorTarget{
                                            core::DesiredActorPresentation{
                                                key,
                                                owner,
                                                item.character,
                                                profile,
                                                pose,
                                                expression,
                                                appearance,
                                                current != nullptr ? current->idle
                                                                   : character->defaults.idle_id,
                                                {item.position, item.offset, item.scale},
                                                visible,
                                                true}});
                                } else {
                                    const core::MountedLayoutPresentationKey key =
                                        core::ReservedLayoutMountKey{item.slot};
                                    if (item.action == core::compiled::LayoutAction::Hide)
                                        return core::Result<core::TransitionGroupTargetMutation,
                                                            core::Diagnostics>::
                                            success(core::TransitionGroupRemoveLayoutTarget{key,
                                                                                            owner});
                                    if (!item.layout)
                                        return core::Result<core::TransitionGroupTargetMutation,
                                                            core::Diagnostics>::
                                            failure(execution_error(
                                                "execution.invalid_scene_layout",
                                                "TransitionGroup Layout action requires a Layout"));
                                    core::SessionState scratch = m_state;
                                    auto changed =
                                        scratch.set_layout(m_project, owner, item.slot,
                                                           *item.layout, item.scale_overrides);
                                    if (!changed)
                                        return core::Result<
                                            core::TransitionGroupTargetMutation,
                                            core::Diagnostics>::failure(changed.error());
                                    const auto mounted = std::find_if(
                                        scratch.mounted_layouts().begin(),
                                        scratch.mounted_layouts().end(),
                                        [&](const core::DesiredMountedLayout& candidate) {
                                            return candidate.key == key && candidate.owner == owner;
                                        });
                                    if (mounted == scratch.mounted_layouts().end())
                                        return core::Result<core::TransitionGroupTargetMutation,
                                                            core::Diagnostics>::
                                            failure(execution_error(
                                                "execution.invalid_scene_layout",
                                                "TransitionGroup Layout target was not created"));
                                    return core::Result<core::TransitionGroupTargetMutation,
                                                        core::Diagnostics>::
                                        success(core::TransitionGroupUpsertLayoutTarget{*mounted});
                                }
                            },
                            child);
                        if (!converted)
                            return fault(converted.error());
                        mutations.push_back(std::move(*converted.value_if()));
                    }

                    auto target =
                        m_presentation_model.build_transition_target(source_target, mutations);
                    if (!target)
                        return fault(target.error());
                    if (*target.value_if() == source_target)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});

                    const core::SessionState source_state = m_state;
                    const auto source_room = m_room_presentation;
                    auto applied = m_state.apply_presentation_target(m_project, *target.value_if());
                    if (!applied)
                        return fault(applied.error());
                    if (fast_forward && value.skippable)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                    auto completion =
                        advance_scene_for_presentation(frame->scene, step, sequential, value.wait);
                    if (!completion) {
                        m_state = source_state;
                        return fault(completion.error());
                    }
                    if (value.transition_kind == core::compiled::TransitionKind::Cut)
                        return core::FlowPresentationBoundaryOutcome{};
                    stage_pending_presentation(
                        PendingSceneTransitionGroupOperation{
                            value.transition_kind, std::chrono::milliseconds{value.duration_ms},
                            value.color, value.skippable, *completion.value_if()},
                        source_state, source_room);
                    return completion.value_if()->has_value()
                               ? std::optional<core::FlowRunOutcome>{core::FlowBlockedOutcome{
                                     *m_state.blocker()}}
                               : std::optional<core::FlowRunOutcome>{
                                     core::FlowPresentationBoundaryOutcome{}};
                } else {
                    static_assert(std::is_same_v<T, void>, "Unhandled Scene instruction");
                }
            },
            *instruction);
        if (outcome)
            return *outcome;
        ++executed;
    }
    return core::FlowBudgetYieldOutcome{executed};
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::choose_scene_option(const core::FlowFrameId& owner,
                                     const core::InputFlowBlockerHandle& handle,
                                     const core::SceneChoiceOptionId& option)
{
    return m_flow.choose_scene_option(owner, handle, option);
}

core::Result<core::SceneView, core::Diagnostics> RuntimeExecutor::scene_view() const
{
    if (m_state.flow_stack().empty())
        return core::Result<core::SceneView, core::Diagnostics>::failure(execution_error(
            "execution.scene_view_unavailable", "Scene view requires an active Scene frame"));
    const auto* frame = std::get_if<core::SceneFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return core::Result<core::SceneView, core::Diagnostics>::failure(execution_error(
            "execution.scene_view_unavailable", "Active flow frame is not a Scene"));
    const core::ScenePresentationOwner owner{frame->frame_id, frame->scene};
    std::optional<core::compiled::BackgroundPresentation> background;
    for (const auto& candidate : m_state.background_overrides()) {
        if (candidate.owner == core::PresentationOwner{owner})
            background = candidate.background;
    }
    core::SceneView view{.scene = frame->scene,
                         .background = std::move(background),
                         .actors = {},
                         .text = m_state.presented_text(),
                         .choice = std::nullopt,
                         .layouts = {},
                         .desired_audio = m_state.desired_audio()};
    if (m_state.active_choice())
        view.choice =
            std::get_if<core::SceneChoiceState>(&*m_state.active_choice())
                ? std::optional<core::SceneChoiceState>{*std::get_if<core::SceneChoiceState>(
                      &*m_state.active_choice())}
                : std::nullopt;
    for (const auto& actor : m_state.actors()) {
        const auto* scene_key = std::get_if<core::SceneActorKey>(&actor.key);
        if (scene_key != nullptr && scene_key->owner == owner)
            view.actors.push_back({actor.key, actor.character, actor.pose, actor.expression,
                                   actor.placement, actor.visible, actor.presentation_complete});
    }
    for (const auto& mount : m_state.mounted_layouts()) {
        if (core::presentation_authority(mount.owner) != core::PresentationAuthority::Gameplay ||
            !m_state.presentation_owner_is_active(mount.owner))
            continue;
        const auto* reserved = std::get_if<core::ReservedLayoutMountKey>(&mount.key);
        if (reserved != nullptr)
            view.layouts.push_back({reserved->slot, mount.layout});
    }
    return core::Result<core::SceneView, core::Diagnostics>::success(std::move(view));
}

} // namespace noveltea::runtime
