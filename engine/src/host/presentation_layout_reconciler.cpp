#include "host/presentation_layout_reconciler.hpp"

#include "host/layout_composition.hpp"
#include "host/layout_realizer.hpp"
#include "noveltea/core/compiled_project.hpp"
#include "noveltea/world_presentation.hpp"
#include "noveltea/world_transition.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::host {
namespace {

std::string presentation_layout_owner_text(const core::PresentationOwner& owner)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::ScenePresentationOwner>)
                return "scene/" + std::to_string(value.invocation.number()) + "/" +
                       value.scene.text();
            else if constexpr (std::is_same_v<T, core::DialoguePresentationOwner>)
                return "dialogue/" + std::to_string(value.invocation.number()) + "/" +
                       value.dialogue.text();
            else if constexpr (std::is_same_v<T, core::CurrentRoomPresentationOwner>)
                return "current-room/" + std::to_string(value.visit.number()) + "/" +
                       value.room.text();
            else if constexpr (std::is_same_v<T, core::RoomPresentationOwner>)
                return "room/" + value.room.text();
            else if constexpr (std::is_same_v<T, core::SessionPresentationOwner>)
                return "session/" + std::to_string(value.session.number());
            else
                return "shell/" + std::to_string(value.scope.number());
        },
        owner);
}

std::string presentation_layout_key_text(const core::MountedLayoutPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::ReservedLayoutMountKey>)
                return "reserved/" + std::to_string(static_cast<unsigned>(value.slot));
            else if constexpr (std::is_same_v<T, core::RoomOverlayLayoutMountKey>)
                return "room-overlay/" + value.room.text() + "/" + value.overlay.text();
            else
                return "scoped/" + value.instance.text();
        },
        key);
}

} // namespace

PresentationLayoutReconciler::PresentationLayoutReconciler(
    presentation::RuntimeLayoutManager& layouts, LayoutRealizer& realizer) noexcept
    : m_layouts(layouts), m_realizer(realizer)
{
}

void PresentationLayoutReconciler::bind_project(const core::CompiledProject& project) noexcept
{
    m_project = &project;
}

void PresentationLayoutReconciler::clear_session() noexcept
{
    m_project = nullptr;
    m_current.clear();
    m_retained.clear();
    m_current_revision.reset();
}

core::Result<void, core::Diagnostics>
PresentationLayoutReconciler::reconcile(const core::RuntimePresentationSnapshot& snapshot)
{
    if (!m_project) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "presentation.layout_project_unavailable",
              .message = "Presentation Layout reconciliation requires a bound project"}});
    }

    struct Desired {
        std::string identity;
        std::optional<core::MountedLayoutPresentationKey> key;
        core::LayoutId layout;
        std::optional<core::PresentationOwner> semantic_owner;
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
        core::MountedLayoutPolicy policy;
        core::LayoutScaleOverrides scale_overrides{};
        std::optional<core::LayoutMountOccurrenceId> occurrence;
        std::vector<core::LayoutResolvedInput> inputs;
        std::vector<core::LayoutSignalId> connected_signals;
        std::optional<core::LayoutStateShape> state_shape;
        std::vector<core::PresentationLayoutStateValue> state_values;
        std::vector<core::PresentationMaterialParameter> material_parameters;
        double material_camera_zoom = 1.0;
        core::PresentationCompositionGroup composition_group =
            core::PresentationCompositionGroup::Interface;
    };

    std::vector<Desired> desired;
    for (const auto& mount : snapshot.layouts) {
        std::vector<core::PresentationMaterialParameter> material_parameters;
        std::copy_if(snapshot.material_parameters.begin(), snapshot.material_parameters.end(),
                     std::back_inserter(material_parameters), [&](const auto& parameter) {
                         if (parameter.owner != mount.owner)
                             return false;
                         const auto* occurrence =
                             std::get_if<core::LayoutMaterialOccurrence>(&parameter.occurrence);
                         return occurrence != nullptr && occurrence->key == mount.key;
                     });
        desired.push_back(
            {presentation_layout_owner_text(mount.owner) + "/" +
                 presentation_layout_key_text(mount.key),
             mount.key, mount.layout, mount.owner,
             core::presentation_authority(mount.owner) == core::PresentationAuthority::Gameplay
                 ? core::MountedLayoutOwner::Gameplay
                 : core::MountedLayoutOwner::Shell,
             mount.policy, mount.scale_overrides, mount.occurrence, mount.inputs,
             mount.connected_signals, mount.state_shape, mount.state_values,
             std::move(material_parameters), snapshot.camera ? snapshot.camera->view.zoom : 1.0,
             mount.composition_group});
    }
    std::sort(desired.begin(), desired.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.identity < rhs.identity; });

    std::unordered_map<std::string, MountedPresentationLayout> next;
    std::vector<core::MountedLayoutInstanceId> newly_mounted;
    const auto rollback_new_mounts = [&]() {
        for (auto it = newly_mounted.rbegin(); it != newly_mounted.rend(); ++it)
            (void)m_layouts.unmount(*it);
    };
    const auto retain_layout = [&](const MountedPresentationLayout& layout) {
        auto source_policy = layout.policy;
        source_policy.input = core::LayoutInputMode::None;
        source_policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        source_policy.visibility = core::LayoutVisibility::Hidden;
        source_policy.escape_dismissal = core::EscapeDismissalPolicy::Ignore;
        source_policy.entrance_operation.reset();
        source_policy.exit_operation.reset();
        (void)m_layouts.replace_policy(layout.instance, source_policy);
        (void)m_realizer.apply_policy(layout.instance, source_policy,
                                      layout_composition_group(layout.composition_group));
        (void)m_realizer.set_opacity(layout.instance, 1.0f);
        (void)m_realizer.set_visible(layout.instance, false);
        m_retained[layout.revision.number()].push_back(layout);
    };

    for (const auto& item : desired) {
        if (!m_project->find_layout(item.layout)) {
            rollback_new_mounts();
            return core::Result<void, core::Diagnostics>::failure(
                {{.code = "presentation.layout_missing",
                  .message = "Presentation Layout is missing: " + item.layout.text()}});
        }

        const auto existing = m_current.find(item.identity);
        if (existing != m_current.end() && existing->second.layout == item.layout &&
            existing->second.semantic_owner == item.semantic_owner &&
            existing->second.owner == item.owner && existing->second.policy == item.policy &&
            existing->second.scale_overrides == item.scale_overrides &&
            existing->second.occurrence == item.occurrence &&
            existing->second.inputs == item.inputs &&
            existing->second.connected_signals == item.connected_signals &&
            existing->second.state_shape == item.state_shape &&
            existing->second.state_values == item.state_values &&
            existing->second.material_parameters == item.material_parameters &&
            existing->second.material_camera_zoom == item.material_camera_zoom &&
            existing->second.composition_group == item.composition_group) {
            auto reused = existing->second;
            reused.key = item.key;
            reused.revision = snapshot.revision;
            next.emplace(item.identity, std::move(reused));
            continue;
        }

        presentation::RuntimeLayoutMountRequest request;
        request.layout_id = item.layout.text();
        request.owner = item.owner;
        request.policy = item.policy;
        request.scale_overrides = item.scale_overrides;
        request.semantic_owner = item.semantic_owner;
        request.semantic_key = item.key;
        request.occurrence = item.occurrence;
        request.inputs = item.inputs;
        request.connected_signals = item.connected_signals;
        request.state_shape = item.state_shape;
        request.state_values = item.state_values;
        request.material_parameters = item.material_parameters;
        request.material_camera_zoom = item.material_camera_zoom;
        request.source = presentation::RuntimeLayoutProjectSource{};
        request.composition_group = item.composition_group;
        request.publication_revision = snapshot.revision;
        if (existing != m_current.end() && existing->second.layout == item.layout) {
            auto updated = m_layouts.update(existing->second.instance, std::move(request));
            if (!updated) {
                rollback_new_mounts();
                return core::Result<void, core::Diagnostics>::failure(std::move(updated).error());
            }
            next.insert_or_assign(item.identity,
                                  MountedPresentationLayout{
                                      item.key, existing->second.instance, item.layout,
                                      item.semantic_owner, item.owner, item.policy,
                                      item.scale_overrides, item.occurrence, item.inputs,
                                      item.connected_signals, item.state_shape, item.state_values,
                                      item.material_parameters, item.material_camera_zoom,
                                      item.composition_group, snapshot.revision});
            continue;
        }

        auto mounted = m_layouts.mount(std::move(request));
        if (!mounted) {
            rollback_new_mounts();
            return core::Result<void, core::Diagnostics>::failure(std::move(mounted).error());
        }
        newly_mounted.push_back(*mounted.value_if());
        next.insert_or_assign(
            item.identity,
            MountedPresentationLayout{item.key, *mounted.value_if(), item.layout,
                                      item.semantic_owner, item.owner, item.policy,
                                      item.scale_overrides, item.occurrence, item.inputs,
                                      item.connected_signals, item.state_shape, item.state_values,
                                      item.material_parameters, item.material_camera_zoom,
                                      item.composition_group, snapshot.revision});
    }

    for (const auto& [identity, previous] : m_current) {
        const auto next_layout = next.find(identity);
        if (next_layout != next.end() && next_layout->second.instance == previous.instance)
            continue;
        retain_layout(previous);
    }
    m_current = std::move(next);
    m_current_revision = snapshot.revision;
    return core::Result<void, core::Diagnostics>::success();
}

void PresentationLayoutReconciler::release_retained(const WorldTransitionBackend& transitions,
                                                    WorldPresentationBackend& world)
{
    std::vector<core::PresentationSnapshotRevision> retained = transitions.active_revisions();
    if (m_current_revision &&
        std::find(retained.begin(), retained.end(), *m_current_revision) == retained.end()) {
        retained.push_back(*m_current_revision);
    }

    const auto keep_revision = [&](std::uint64_t revision) {
        return std::any_of(retained.begin(), retained.end(),
                           [&](const auto value) { return value.number() == revision; });
    };
    for (auto it = m_retained.begin(); it != m_retained.end();) {
        if (keep_revision(it->first)) {
            ++it;
            continue;
        }
        for (const auto& layout : it->second)
            (void)m_layouts.unmount(layout.instance);
        it = m_retained.erase(it);
    }
    world.retain_only(retained);
}

void PresentationLayoutReconciler::apply_transition_state(const WorldTransitionBackend& transitions,
                                                          WorldPresentationBackend& world)
{
    const auto apply = [&](const MountedPresentationLayout& layout, bool transition_visible,
                           float opacity) {
        const bool visible =
            transition_visible && layout.policy.visibility == core::LayoutVisibility::Visible;
        (void)m_realizer.set_opacity(layout.instance, std::clamp(opacity, 0.0f, 1.0f));
        (void)m_realizer.set_visible(layout.instance, visible);
    };
    const auto set_source_policy = [&](const MountedPresentationLayout& layout) {
        auto source_policy = layout.policy;
        source_policy.input = core::LayoutInputMode::None;
        source_policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        source_policy.visibility = core::LayoutVisibility::Hidden;
        source_policy.escape_dismissal = core::EscapeDismissalPolicy::Ignore;
        source_policy.entrance_operation.reset();
        source_policy.exit_operation.reset();
        (void)m_layouts.replace_policy(layout.instance, source_policy);
        (void)m_realizer.apply_policy(layout.instance, source_policy,
                                      layout.policy.plane == core::PresentationPlane::WorldOverlay
                                          ? kWorldTransitionSourceCompositionGroup
                                          : layout_composition_group(layout.composition_group));
    };
    const auto find_current =
        [&](const core::LayoutOperationTarget& target) -> const MountedPresentationLayout* {
        const auto identity = presentation_layout_owner_text(target.owner) + "/" +
                              presentation_layout_key_text(target.layout);
        const auto found = m_current.find(identity);
        return found == m_current.end() ? nullptr : &found->second;
    };
    const auto find_retained =
        [&](core::PresentationSnapshotRevision revision,
            const core::LayoutOperationTarget& target) -> const MountedPresentationLayout* {
        const auto found = m_retained.find(revision.number());
        if (found == m_retained.end())
            return nullptr;
        const auto layout =
            std::find_if(found->second.begin(), found->second.end(), [&](const auto& value) {
                return value.key && *value.key == target.layout && value.semantic_owner &&
                       *value.semantic_owner == target.owner;
            });
        return layout == found->second.end() ? nullptr : &*layout;
    };
    const auto snapshot_layout =
        [&](core::PresentationSnapshotRevision revision,
            const core::LayoutOperationTarget& target) -> const core::PresentationMountedLayout* {
        const auto* snapshot = world.snapshot(revision);
        if (!snapshot)
            return nullptr;
        const auto found = std::find_if(
            snapshot->layouts.begin(), snapshot->layouts.end(), [&](const auto& layout) {
                return layout.key == target.layout && layout.owner == target.owner;
            });
        return found == snapshot->layouts.end() ? nullptr : &*found;
    };

    for (const auto& [_, layout] : m_current)
        apply(layout, true, 1.0f);
    for (const auto& [_, layouts] : m_retained)
        for (const auto& layout : layouts)
            apply(layout, false, 1.0f);

    const auto& transition = transitions.render_state();
    if (transition) {
        if (const auto source = m_retained.find(transition->source.number());
            source != m_retained.end()) {
            for (const auto& layout : source->second) {
                if (layout.policy.plane != core::PresentationPlane::WorldOverlay)
                    continue;
                set_source_policy(layout);
                apply(layout, true, 1.0f);
            }
        }
        for (const auto& [_, layout] : m_current)
            if (layout.policy.plane == core::PresentationPlane::WorldOverlay)
                apply(layout, true, 1.0f);
    }

    for (const auto& state : transitions.layout_render_states()) {
        const auto& operation_target = state.target;
        const auto* source_record = snapshot_layout(state.revisions.source, operation_target);
        const auto* target_record = snapshot_layout(state.revisions.target, operation_target);
        const auto* source = find_retained(state.revisions.source, operation_target);
        if (!source && m_current_revision && *m_current_revision == state.revisions.source)
            source = find_current(operation_target);
        const auto* target = find_current(operation_target);
        if (!target)
            target = find_retained(state.revisions.target, operation_target);

        if (source && source_record) {
            set_source_policy(*source);
            apply(*source, true, 1.0f - state.progress);
        }
        if (target && target_record)
            apply(*target, true, state.progress);
    }

    release_retained(transitions, world);
}

} // namespace noveltea::host
