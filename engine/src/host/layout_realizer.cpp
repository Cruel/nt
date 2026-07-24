#include "host/layout_realizer.hpp"

#include "ui/rmlui/runtime_ui.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <string_view>
#include <type_traits>
#include <unordered_set>
#include <utility>

namespace noveltea::host {

using presentation::RuntimeLayoutBuiltinDocument;
using presentation::RuntimeMountedLayout;

namespace {

class RuntimeUiLayoutBackend final : public LayoutRealizer::Backend {
public:
    explicit RuntimeUiLayoutBackend(RuntimeUI& runtime_ui) noexcept : m_runtime_ui(runtime_ui) {}

    bool document_exists(const std::string& document_id) const override
    {
        return m_runtime_ui.has_document(document_id);
    }

    bool load_builtin(RuntimeLayoutBuiltinDocument document,
                      const core::MountedLayoutPolicy& policy,
                      LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                      core::LayoutScalePolicy scale_policy,
                      LayoutContextCompatibilityGroup compatibility_group) override
    {
        return m_runtime_ui.load_builtin_for_layout(document, policy, composition_group, owner,
                                                    scale_policy, compatibility_group);
    }

    bool load_path(const std::string& document_id, const std::string& logical_path,
                   const core::MountedLayoutPolicy& policy,
                   LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                   core::LayoutScalePolicy scale_policy,
                   LayoutContextCompatibilityGroup compatibility_group) override
    {
        return m_runtime_ui.load_document_for_layout(document_id, logical_path, false, policy,
                                                     composition_group, owner, scale_policy,
                                                     compatibility_group);
    }

    bool load_memory(const std::string& document_id, const std::string& rml,
                     const std::string& source_url, const core::MountedLayoutPolicy& policy,
                     LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                     core::LayoutScalePolicy scale_policy,
                     LayoutContextCompatibilityGroup compatibility_group) override
    {
        return m_runtime_ui.load_document_from_memory_for_layout(
            document_id, rml, source_url, false, policy, composition_group, owner, scale_policy,
            compatibility_group);
    }

    bool apply_policy(const std::string& document_id, const core::MountedLayoutPolicy& policy,
                      LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                      core::LayoutScalePolicy scale_policy,
                      LayoutContextCompatibilityGroup compatibility_group) override
    {
        return m_runtime_ui.apply_layout_policy(document_id, policy, composition_group, owner,
                                                scale_policy, compatibility_group);
    }

    bool set_visible(const std::string& document_id, bool visible) override
    {
        return visible ? m_runtime_ui.show_document(document_id)
                       : m_runtime_ui.hide_document(document_id);
    }

    bool set_opacity(const std::string& document_id, float opacity) override
    {
        return m_runtime_ui.set_document_opacity(document_id, opacity);
    }

    bool apply_order(const std::vector<std::string>& ordered_document_ids) override
    {
        return m_runtime_ui.apply_layout_order(ordered_document_ids);
    }

    bool unload(const std::string& document_id) override
    {
        return !document_exists(document_id) || m_runtime_ui.unload_document(document_id);
    }

private:
    RuntimeUI& m_runtime_ui;
};

const char* owner_name(core::MountedLayoutOwner owner) noexcept
{
    switch (owner) {
    case core::MountedLayoutOwner::Gameplay:
        return "gameplay";
    case core::MountedLayoutOwner::Shell:
        return "shell";
    }
    return "unknown";
}

const char* plane_name(core::PresentationPlane plane) noexcept
{
    switch (plane) {
    case core::PresentationPlane::WorldBackground:
        return "world-background";
    case core::PresentationPlane::WorldContent:
        return "world-content";
    case core::PresentationPlane::WorldOverlay:
        return "world-overlay";
    case core::PresentationPlane::GameUi:
        return "game-ui";
    case core::PresentationPlane::MenuOverlay:
        return "menu-overlay";
    case core::PresentationPlane::Modal:
        return "modal";
    case core::PresentationPlane::Transition:
        return "transition";
    case core::PresentationPlane::Debug:
        return "debug";
    }
    return "unknown";
}

std::string source_name(const LayoutRealizationSource& source)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ProjectLayoutRealizationSource>) {
                return "project-resource";
            } else if constexpr (std::is_same_v<T, BuiltinLayoutRealizationSource>) {
                return "builtin:" + std::to_string(static_cast<unsigned>(value.document));
            } else if constexpr (std::is_same_v<T, AssetLayoutRealizationSource>) {
                return "asset:" + value.logical_path;
            } else if constexpr (std::is_same_v<T, FragmentLayoutRealizationSource>) {
                return "fragment:" + value.source_url;
            } else {
                return "memory:" + value.source_url;
            }
        },
        source);
}

std::string source_path(const LayoutRealizationSource& source)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, AssetLayoutRealizationSource>)
                return value.logical_path;
            else if constexpr (std::is_same_v<T, FragmentLayoutRealizationSource> ||
                               std::is_same_v<T, MemoryLayoutRealizationSource>)
                return value.source_url;
            else
                return {};
        },
        source);
}

std::string sanitize_identifier(std::string value)
{
    for (char& ch : value) {
        if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_')
            ch = '_';
    }
    return value;
}

void replace_all(std::string& target, std::string_view token, std::string_view replacement)
{
    if (token.empty())
        return;
    std::size_t position = 0;
    while ((position = target.find(token, position)) != std::string::npos) {
        target.replace(position, token.size(), replacement);
        position += replacement.size();
    }
}

} // namespace

LayoutRealizer::LayoutRealizer(assets::AssetManager& assets, RuntimeUI& runtime_ui)
    : m_assets(assets), m_owned_backend(std::make_unique<RuntimeUiLayoutBackend>(runtime_ui)),
      m_backend(*m_owned_backend)
{
}

LayoutRealizer::LayoutRealizer(assets::AssetManager& assets, Backend& backend,
                               BorrowedBackendForTesting) noexcept
    : m_assets(assets), m_backend(backend), m_require_resident_font_leases(false)
{
}

LayoutRealizer::~LayoutRealizer() = default;

core::Result<void, core::Diagnostics>
LayoutRealizer::validate_project(const core::CompiledProject& project) const
{
    return validate_project(project, m_assets);
}

core::Result<void, core::Diagnostics>
LayoutRealizer::validate_project(const core::CompiledProject& project,
                                 const assets::AssetManager& project_assets) const
{
    core::Diagnostics diagnostics;
    const auto validate_asset = [&](const core::AssetId& asset_id, const core::LayoutId& layout,
                                    std::string_view usage) {
        const auto* asset = project.find_asset(asset_id);
        if (!asset) {
            diagnostics.push_back({.code = "layout_realizer.asset_missing",
                                   .message = "operation=validate layout=" + layout.text() +
                                              " source=asset:" + asset_id.text() +
                                              " owner=unknown plane=unknown: missing " +
                                              std::string(usage) + " asset"});
            return;
        }
        const std::string logical_path = "project:/" + asset->path;
        if (!project_assets.exists(logical_path)) {
            diagnostics.push_back({.code = "layout_realizer.asset_unreadable",
                                   .message = "operation=validate layout=" + layout.text() +
                                              " source=asset:" + logical_path +
                                              " owner=unknown plane=unknown: unreadable " +
                                              std::string(usage) + " asset",
                                   .source_path = logical_path});
        }
    };
    const auto validate_source = [&](const core::compiled::LayoutSource& source,
                                     const core::LayoutId& layout, std::string_view usage) {
        if (const auto* asset = std::get_if<core::compiled::AssetLayoutSource>(&source))
            validate_asset(asset->asset, layout, usage);
    };

    for (const auto& layout : project.layouts()) {
        validate_source(layout.rml, layout.id, "RML");
        validate_source(layout.rcss, layout.id, "RCSS");
        validate_source(layout.lua, layout.id, "Lua");
        for (const auto& asset : layout.dependencies.fonts)
            validate_asset(asset, layout.id, "font dependency");
        for (const auto& asset : layout.dependencies.images)
            validate_asset(asset, layout.id, "image dependency");
        for (const auto& asset : layout.dependencies.scripts)
            validate_asset(asset, layout.id, "script dependency");
        for (const auto& asset : layout.dependencies.stylesheets)
            validate_asset(asset, layout.id, "stylesheet dependency");
    }
    if (!diagnostics.empty())
        return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
LayoutRealizer::bind_session(const core::CompiledProject& project, HostGeneration generation)
{
    if (m_project && m_project != &project && !m_realized.empty()) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.project_replace_with_live_realizations",
              .message = "operation=bind-session layout=unknown instance=unknown "
                         "source=project-resource owner=unknown plane=unknown: project replacement "
                         "requires logical Layout teardown first"}});
    }
    m_project = &project;
    m_host_generation = generation;
    return core::Result<void, core::Diagnostics>::success();
}

void LayoutRealizer::clear_session() noexcept
{
    m_project = nullptr;
    m_host_generation.reset();
    m_realized.clear();
}

core::Result<void, core::Diagnostics>
LayoutRealizer::realize_authored_preview(AuthoredPreviewRequest request)
{
    const std::string document_id(authored_preview_document_id());
    if (request.rml.empty()) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.authored_preview_empty",
              .message = "Authored Layout preview RML must not be empty",
              .source_path = request.source_url}});
    }

    const core::MountedLayoutPolicy policy{
        .plane = core::PresentationPlane::GameUi,
        .local_order = 0,
        .clock = core::LayoutClockDomain::Gameplay,
        .input = core::LayoutInputMode::Normal,
        .gameplay_pause = core::GameplayPausePolicy::Continue,
        .visibility = core::LayoutVisibility::Visible,
        .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
        .entrance_operation = std::nullopt,
        .exit_operation = std::nullopt,
    };
    const auto composition_group =
        layout_composition_group(core::PresentationCompositionGroup::Interface);

    if (m_backend.document_exists(document_id) && !m_backend.unload(document_id)) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.authored_preview_unload_failed",
              .message = "Failed to replace the existing authored Layout preview",
              .source_path = request.source_url}});
    }
    if (!m_backend.load_memory(document_id, request.rml, request.source_url, policy,
                               composition_group, core::MountedLayoutOwner::Gameplay,
                               request.scale_policy, 0)) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.authored_preview_load_failed",
              .message = "Failed to realize authored Layout preview in its scale-domain context",
              .source_path = request.source_url}});
    }
    if (!m_backend.set_visible(document_id, true)) {
        (void)m_backend.unload(document_id);
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.authored_preview_visibility_failed",
              .message = "Failed to show the authored Layout preview",
              .source_path = request.source_url}});
    }
    return core::Result<void, core::Diagnostics>::success();
}

void LayoutRealizer::clear_authored_preview() noexcept
{
    const std::string document_id(authored_preview_document_id());
    if (m_backend.document_exists(document_id))
        (void)m_backend.unload(document_id);
}

core::Result<void, core::Diagnostics>
LayoutRealizer::reconcile_layouts(const std::vector<RuntimeMountedLayout>& desired)
{
    return reconcile(desired, false);
}

LayoutRealizationResult LayoutRealizer::apply_layout_realization(LayoutRealizationRequest request)
{
    return std::visit(
        [this](auto&& value) -> LayoutRealizationResult {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RealizeLayoutRequest>) {
                RuntimeMountedLayout desired{.mounted = value.mounted,
                                             .source = value.source,
                                             .composition_group = value.composition_group,
                                             .publication_revision = value.publication_revision};
                if (!m_host_generation || value.host_generation != *m_host_generation)
                    return stale_result(value.host_generation, value.mounted.instance, &desired,
                                        "realize");

                const auto previous = m_realized.find(value.mounted.instance.number());
                LayoutRealizationDisposition disposition = LayoutRealizationDisposition::Created;
                if (previous != m_realized.end()) {
                    const auto& old = previous->second.desired;
                    if (old.mounted.layout != desired.mounted.layout ||
                        old.source != desired.source)
                        disposition = LayoutRealizationDisposition::Replaced;
                    else if (old.mounted.owner != desired.mounted.owner ||
                             old.mounted.policy != desired.mounted.policy ||
                             old.mounted.scale_overrides != desired.mounted.scale_overrides ||
                             old.composition_group != desired.composition_group ||
                             old.publication_revision != desired.publication_revision)
                        disposition = LayoutRealizationDisposition::Updated;
                    else
                        disposition = LayoutRealizationDisposition::Unchanged;
                }

                std::vector<RuntimeMountedLayout> next;
                next.reserve(m_realized.size() + (previous == m_realized.end() ? 1 : 0));
                for (const auto& [_, realized] : m_realized) {
                    if (realized.desired.mounted.instance != value.mounted.instance)
                        next.push_back(realized.desired);
                }
                next.push_back(std::move(desired));
                auto reconciled = reconcile(std::move(next), false);
                if (!reconciled) {
                    return {.disposition = LayoutRealizationDisposition::Failed,
                            .instance = value.mounted.instance,
                            .document_id = {},
                            .affected_count = 0,
                            .diagnostics = std::move(reconciled).error()};
                }
                return {.disposition = disposition,
                        .instance = value.mounted.instance,
                        .document_id = document_id(value.mounted.instance).value_or(std::string{}),
                        .affected_count = disposition == LayoutRealizationDisposition::Unchanged
                                              ? std::size_t{0}
                                              : std::size_t{1},
                        .diagnostics = {}};
            } else if constexpr (std::is_same_v<T, RemoveLayoutRealizationRequest>) {
                if (!m_host_generation || value.host_generation != *m_host_generation)
                    return stale_result(value.host_generation, value.instance, nullptr, "remove");
                const auto previous = m_realized.find(value.instance.number());
                if (previous == m_realized.end()) {
                    return {.disposition = LayoutRealizationDisposition::Removed,
                            .instance = value.instance,
                            .document_id = {},
                            .affected_count = 0,
                            .diagnostics = {}};
                }
                const auto removed_document = previous->second.document_id;
                std::vector<RuntimeMountedLayout> next;
                next.reserve(m_realized.size() - 1);
                for (const auto& [_, realized] : m_realized) {
                    if (realized.desired.mounted.instance != value.instance)
                        next.push_back(realized.desired);
                }
                auto reconciled = reconcile(std::move(next), false);
                if (!reconciled) {
                    return {.disposition = LayoutRealizationDisposition::Failed,
                            .instance = value.instance,
                            .document_id = removed_document,
                            .affected_count = 0,
                            .diagnostics = std::move(reconciled).error()};
                }
                return {.disposition = LayoutRealizationDisposition::Removed,
                        .instance = value.instance,
                        .document_id = removed_document,
                        .affected_count = 1,
                        .diagnostics = {}};
            } else {
                if (!m_host_generation || value.host_generation != *m_host_generation)
                    return stale_result(value.host_generation, std::nullopt, nullptr, "recreate");
                if (value.backend_generation < m_backend_generation) {
                    LayoutRealizationResult result;
                    result.disposition = LayoutRealizationDisposition::RejectedStale;
                    result.diagnostics.push_back(
                        {.code = "layout_realizer.stale_backend_generation",
                         .message =
                             "operation=recreate layout=unknown instance=unknown "
                             "source=unknown owner=unknown plane=unknown: backend generation " +
                             std::to_string(value.backend_generation.number()) +
                             " is older than active generation " +
                             std::to_string(m_backend_generation.number())});
                    return result;
                }
                std::vector<RuntimeMountedLayout> desired;
                desired.reserve(m_realized.size());
                for (const auto& [_, realized] : m_realized)
                    desired.push_back(realized.desired);
                auto reconciled = reconcile(std::move(desired), true);
                if (!reconciled) {
                    return {.disposition = LayoutRealizationDisposition::Failed,
                            .instance = std::nullopt,
                            .document_id = {},
                            .affected_count = 0,
                            .diagnostics = std::move(reconciled).error()};
                }
                m_backend_generation = value.backend_generation;
                return {.disposition = LayoutRealizationDisposition::Recreated,
                        .instance = std::nullopt,
                        .document_id = {},
                        .affected_count = m_realized.size(),
                        .diagnostics = {}};
            }
        },
        std::move(request));
}

core::Result<void, core::Diagnostics>
LayoutRealizer::apply_policy(core::MountedLayoutInstanceId instance,
                             core::MountedLayoutPolicy policy,
                             LayoutCompositionGroup composition_group)
{
    const auto found = m_realized.find(instance.number());
    if (found == m_realized.end()) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.instance_missing",
              .message =
                  "operation=policy layout=unknown instance=" + std::to_string(instance.number()) +
                  " source=unknown owner=unknown plane=unknown: realization is missing"}});
    }
    auto& realized = found->second;
    auto desired = realized.desired;
    desired.mounted.policy = policy;
    auto scale_policy = resolve_scale_policy(desired);
    if (!scale_policy)
        return core::Result<void, core::Diagnostics>::failure(std::move(scale_policy).error());
    if (!m_backend.apply_policy(realized.document_id, policy, composition_group,
                                realized.desired.mounted.owner, *scale_policy.value_if(),
                                realized.compatibility_group)) {
        const LayoutRealizationSource source = realized.desired.source;
        return core::Result<void, core::Diagnostics>::failure(
            {diagnostic("layout_realizer.policy_failed", "policy", &realized.desired, &source,
                        "RuntimeUI rejected Layout policy")});
    }
    realized.desired.mounted.policy = std::move(policy);
    realized.scale_policy = std::move(*scale_policy.value_if());
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
LayoutRealizer::set_visible(core::MountedLayoutInstanceId instance, bool visible)
{
    const auto found = m_realized.find(instance.number());
    if (found == m_realized.end()) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.instance_missing",
              .message = "operation=visibility layout=unknown instance=" +
                         std::to_string(instance.number()) +
                         " source=unknown owner=unknown plane=unknown: realization is missing"}});
    }
    auto& realized = found->second;
    if (!m_backend.set_visible(realized.document_id, visible)) {
        const LayoutRealizationSource source = realized.desired.source;
        return core::Result<void, core::Diagnostics>::failure(
            {diagnostic("layout_realizer.visibility_failed", "visibility", &realized.desired,
                        &source, "RuntimeUI rejected Layout visibility")});
    }
    realized.desired.mounted.policy.visibility =
        visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
LayoutRealizer::set_opacity(core::MountedLayoutInstanceId instance, float opacity)
{
    const auto found = m_realized.find(instance.number());
    if (found == m_realized.end()) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.instance_missing",
              .message =
                  "operation=opacity layout=unknown instance=" + std::to_string(instance.number()) +
                  " source=unknown owner=unknown plane=unknown: realization is missing"}});
    }
    auto& realized = found->second;
    opacity = std::clamp(opacity, 0.0f, 1.0f);
    if (!m_backend.set_opacity(realized.document_id, opacity)) {
        const LayoutRealizationSource source = realized.desired.source;
        return core::Result<void, core::Diagnostics>::failure(
            {diagnostic("layout_realizer.opacity_failed", "opacity", &realized.desired, &source,
                        "RuntimeUI rejected Layout opacity")});
    }
    realized.opacity = opacity;
    return core::Result<void, core::Diagnostics>::success();
}

std::optional<std::string> LayoutRealizer::document_id(core::MountedLayoutInstanceId instance) const
{
    const auto found = m_realized.find(instance.number());
    return found == m_realized.end() ? std::nullopt
                                     : std::optional<std::string>(found->second.document_id);
}

core::Result<void, core::Diagnostics>
LayoutRealizer::reconcile(std::vector<RuntimeMountedLayout> desired, bool recreate)
{
    auto session = require_session(desired.empty() ? nullptr : &desired.front(), "reconcile");
    if (!session)
        return session;
    std::sort(desired.begin(), desired.end(), ordered_before);

    std::unordered_set<std::uint64_t> instances;
    std::unordered_set<std::string> document_ids;
    std::vector<CandidateLayout> candidates;
    candidates.reserve(desired.size());
    for (const auto& item : desired) {
        if (!instances.insert(item.mounted.instance.number()).second) {
            const LayoutRealizationSource source = item.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.instance_conflict", "validate", &item, &source,
                            "duplicate mounted instance identity")});
        }
        auto prepared = prepare_source(item);
        if (!prepared)
            return core::Result<void, core::Diagnostics>::failure(std::move(prepared).error());
        PreparedSource prepared_value = std::move(*prepared.value_if());
        auto scale_policy = resolve_scale_policy(item);
        if (!scale_policy)
            return core::Result<void, core::Diagnostics>::failure(std::move(scale_policy).error());

        std::vector<assets::AssetLease<assets::FontAsset>> font_leases;
        if (m_require_resident_font_leases && m_project) {
            if (const auto* layout = m_project->find_layout(item.mounted.layout)) {
                font_leases.reserve(layout->dependencies.fonts.size());
                for (const auto& font : layout->dependencies.fonts) {
                    const assets::FontAssetRequest request{.alias = font.text(),
                                                           .style = TextFontRegular};
                    const auto* lease = m_assets.leased_font_on_owner(request);
                    if (lease == nullptr) {
                        const LayoutRealizationSource source = item.source;
                        return core::Result<void, core::Diagnostics>::failure({diagnostic(
                            "layout_realizer.font_lease_missing", "validate", &item, &source,
                            "mandatory Layout font dependency is not resident: " + font.text())});
                    }
                    lease->mark_used_on_owner();
                    font_leases.push_back(*lease);
                }
            }
        }

        const auto old = m_realized.find(item.mounted.instance.number());
        const bool content_same = old != m_realized.end() &&
                                  old->second.desired.mounted.layout == item.mounted.layout &&
                                  old->second.desired.source == item.source;
        const bool load_required = recreate || !content_same;
        const std::uint64_t version =
            old == m_realized.end()
                ? 1
                : old->second.realization_version + static_cast<std::uint64_t>(load_required);
        std::string candidate_document_id =
            prepared_value.kind == PreparedSource::Kind::Builtin
                ? builtin_document_id(prepared_value.builtin)
                : (content_same && !recreate ? old->second.document_id
                                             : generated_document_id(item, version));
        if (candidate_document_id.empty() || !document_ids.insert(candidate_document_id).second) {
            const LayoutRealizationSource source = item.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.document_conflict", "validate", &item, &source,
                            "desired Layouts resolve to the same document ID")});
        }
        candidates.push_back(
            {.realized = {.desired = item,
                          .document_id = std::move(candidate_document_id),
                          .realization_version = version,
                          .opacity = old == m_realized.end() ? 1.0f : old->second.opacity,
                          .scale_policy = std::move(*scale_policy.value_if()),
                          .font_leases = std::move(font_leases)},
             .prepared = std::move(prepared_value),
             .load_required = load_required});
    }

    struct ContextCompatibility {
        core::PresentationPlane plane = core::PresentationPlane::GameUi;
        core::PresentationCompositionGroup composition_group =
            core::PresentationCompositionGroup::Interface;
        core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
        core::LayoutInputMode input = core::LayoutInputMode::Normal;
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
        core::LayoutScalePolicy scale_policy{};
        bool operator==(const ContextCompatibility&) const = default;
    };
    std::optional<ContextCompatibility> previous_compatibility;
    LayoutContextCompatibilityGroup compatibility_group = 0;
    for (auto& candidate : candidates) {
        const auto& mounted = candidate.realized.desired.mounted;
        const ContextCompatibility compatibility{
            .plane = mounted.policy.plane,
            .composition_group = candidate.realized.desired.composition_group,
            .clock = mounted.policy.clock,
            .input = mounted.policy.input,
            .owner = mounted.owner,
            .scale_policy = candidate.realized.scale_policy,
        };
        if (previous_compatibility && *previous_compatibility != compatibility)
            ++compatibility_group;
        candidate.realized.compatibility_group = compatibility_group;
        previous_compatibility = compatibility;
    }

    std::vector<std::string> previous_order;
    previous_order.reserve(m_realized.size());
    std::vector<const RealizedLayout*> previous_sorted;
    previous_sorted.reserve(m_realized.size());
    for (const auto& [_, realized] : m_realized)
        previous_sorted.push_back(&realized);
    std::sort(previous_sorted.begin(), previous_sorted.end(), [](const auto* lhs, const auto* rhs) {
        return ordered_before(lhs->desired, rhs->desired);
    });
    for (const auto* realized : previous_sorted)
        previous_order.push_back(realized->document_id);

    std::vector<std::string> staged;
    for (const auto& candidate : candidates) {
        if (!candidate.load_required)
            continue;
        if (!load_candidate(candidate)) {
            for (auto it = staged.rbegin(); it != staged.rend(); ++it)
                (void)m_backend.unload(*it);
            const LayoutRealizationSource source = candidate.realized.desired.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.create_failed", "create", &candidate.realized.desired,
                            &source, "RuntimeUI failed to load validated Layout source")});
        }
        const auto old = m_realized.find(candidate.realized.desired.mounted.instance.number());
        if (old == m_realized.end() || old->second.document_id != candidate.realized.document_id)
            staged.push_back(candidate.realized.document_id);
    }

    const auto rollback = [&]() {
        for (auto it = staged.rbegin(); it != staged.rend(); ++it)
            (void)m_backend.unload(*it);
        (void)restore_previous_backend_state(m_realized, previous_order);
    };

    std::vector<std::string> next_order;
    next_order.reserve(candidates.size());
    for (const auto& candidate : candidates) {
        const auto& realized = candidate.realized;
        const auto composition_group = layout_composition_group(realized.desired.composition_group);
        if (!m_backend.apply_policy(realized.document_id, realized.desired.mounted.policy,
                                    composition_group, realized.desired.mounted.owner,
                                    realized.scale_policy, realized.compatibility_group)) {
            rollback();
            const LayoutRealizationSource source = realized.desired.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.policy_failed", "policy", &realized.desired, &source,
                            "RuntimeUI rejected Layout policy")});
        }
        if (!m_backend.set_opacity(realized.document_id, realized.opacity)) {
            rollback();
            const LayoutRealizationSource source = realized.desired.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.opacity_failed", "opacity", &realized.desired, &source,
                            "RuntimeUI rejected Layout opacity")});
        }
        const bool visible =
            realized.desired.mounted.policy.visibility == core::LayoutVisibility::Visible;
        if (!m_backend.set_visible(realized.document_id, visible)) {
            rollback();
            const LayoutRealizationSource source = realized.desired.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.visibility_failed", "visibility", &realized.desired,
                            &source, "RuntimeUI rejected Layout visibility")});
        }
        next_order.push_back(realized.document_id);
    }
    if (!m_backend.apply_order(next_order)) {
        rollback();
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "layout_realizer.order_failed",
              .message = "operation=order layout=multiple instance=multiple source=multiple "
                         "owner=multiple plane=multiple: RuntimeUI rejected deterministic Layout "
                         "order"}});
    }

    std::unordered_set<std::string> next_documents(next_order.begin(), next_order.end());
    for (const auto* previous : previous_sorted) {
        if (next_documents.contains(previous->document_id))
            continue;
        (void)m_backend.set_visible(previous->document_id, false);
        if (!m_backend.unload(previous->document_id)) {
            rollback();
            const LayoutRealizationSource source = previous->desired.source;
            return core::Result<void, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.remove_failed", "remove", &previous->desired, &source,
                            "RuntimeUI failed to remove obsolete Layout document")});
        }
    }

    RealizedMap next;
    next.reserve(candidates.size());
    for (auto& candidate : candidates) {
        next.emplace(candidate.realized.desired.mounted.instance.number(),
                     std::move(candidate.realized));
    }
    m_realized = std::move(next);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<LayoutRealizer::PreparedSource, core::Diagnostics>
LayoutRealizer::prepare_source(const RuntimeMountedLayout& desired) const
{
    return std::visit(
        [this, &desired](const auto& source) -> core::Result<PreparedSource, core::Diagnostics> {
            using T = std::decay_t<decltype(source)>;
            if constexpr (std::is_same_v<T, ProjectLayoutRealizationSource>) {
                if (!m_project) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        {diagnostic("layout_realizer.project_unbound", "prepare", &desired,
                                    &typed_source, "immutable Layout project is not bound")});
                }
                const auto* definition = m_project->find_layout(desired.mounted.layout);
                if (!definition) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        {diagnostic("layout_realizer.layout_missing", "prepare", &desired,
                                    &typed_source, "immutable Layout resource is missing")});
                }
                auto rml = layout_source_text(definition->rml, desired, "prepare-rml");
                auto rcss = layout_source_text(definition->rcss, desired, "prepare-rcss");
                auto lua = layout_source_text(definition->lua, desired, "prepare-lua");
                if (!rml)
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        std::move(rml).error());
                if (!rcss)
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        std::move(rcss).error());
                if (!lua)
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        std::move(lua).error());

                const std::string additions =
                    "<style>" + *rcss.value_if() + "</style>" +
                    (definition->script_enabled ? "<script>" + *lua.value_if() + "</script>"
                                                : std::string{});
                std::string document;
                if (definition->kind == core::compiled::LayoutKind::Fragment) {
                    const std::string root =
                        definition->default_parent.value_or("nt-layout-fragment-root");
                    document = "<rml><head>" + additions + "</head><body><div id=\"" + root +
                               "\">" + *rml.value_if() + "</div></body></rml>";
                } else {
                    document = *rml.value_if();
                    const auto head_end = document.find("</head>");
                    if (head_end == std::string::npos) {
                        const LayoutRealizationSource typed_source = source;
                        return core::Result<PreparedSource, core::Diagnostics>::failure({diagnostic(
                            "layout_realizer.document_head_missing", "prepare", &desired,
                            &typed_source, "document Layout requires a head element")});
                    }
                    document.insert(head_end, additions);
                }
                return core::Result<PreparedSource, core::Diagnostics>::success(
                    {.kind = PreparedSource::Kind::Memory,
                     .builtin = RuntimeLayoutBuiltinDocument::None,
                     .logical_path = {},
                     .source_url = "project://generated/layouts/" +
                                   sanitize_identifier(desired.mounted.layout.text()) + ".rml",
                     .rml = std::move(document)});
            } else if constexpr (std::is_same_v<T, BuiltinLayoutRealizationSource>) {
                if (source.document == RuntimeLayoutBuiltinDocument::None ||
                    builtin_document_id(source.document).empty()) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        {diagnostic("layout_realizer.builtin_invalid", "prepare", &desired,
                                    &typed_source, "shell built-in descriptor is invalid")});
                }
                return core::Result<PreparedSource, core::Diagnostics>::success(
                    {.kind = PreparedSource::Kind::Builtin,
                     .builtin = source.document,
                     .logical_path = {},
                     .source_url = {},
                     .rml = {}});
            } else if constexpr (std::is_same_v<T, AssetLayoutRealizationSource>) {
                if (source.logical_path.empty() || !m_assets.exists(source.logical_path)) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure({diagnostic(
                        "layout_realizer.asset_unreadable", "prepare", &desired, &typed_source,
                        "logical Layout asset path cannot be resolved")});
                }
                return core::Result<PreparedSource, core::Diagnostics>::success(
                    {.kind = PreparedSource::Kind::Path,
                     .builtin = RuntimeLayoutBuiltinDocument::None,
                     .logical_path = source.logical_path,
                     .source_url = source.logical_path,
                     .rml = {}});
            } else if constexpr (std::is_same_v<T, FragmentLayoutRealizationSource>) {
                if (source.fragment_rml.empty() || source.host_rml.empty()) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure({diagnostic(
                        "layout_realizer.fragment_invalid", "prepare", &desired, &typed_source,
                        "fragment source requires fragment and host RML")});
                }
                std::string document = source.host_rml;
                constexpr std::string_view marker = "__NT_LAYOUT_FRAGMENT__";
                if (document.find(marker) == std::string::npos) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure({diagnostic(
                        "layout_realizer.fragment_marker_missing", "prepare", &desired,
                        &typed_source, "fragment host is missing __NT_LAYOUT_FRAGMENT__")});
                }
                replace_all(document, marker, source.fragment_rml);
                return core::Result<PreparedSource, core::Diagnostics>::success(
                    {.kind = PreparedSource::Kind::Memory,
                     .builtin = RuntimeLayoutBuiltinDocument::None,
                     .logical_path = {},
                     .source_url = source.source_url,
                     .rml = std::move(document)});
            } else {
                if (source.rml.empty()) {
                    const LayoutRealizationSource typed_source = source;
                    return core::Result<PreparedSource, core::Diagnostics>::failure(
                        {diagnostic("layout_realizer.memory_empty", "prepare", &desired,
                                    &typed_source, "memory Layout source is empty")});
                }
                return core::Result<PreparedSource, core::Diagnostics>::success(
                    {.kind = PreparedSource::Kind::Memory,
                     .builtin = RuntimeLayoutBuiltinDocument::None,
                     .logical_path = {},
                     .source_url = source.source_url,
                     .rml = source.rml});
            }
        },
        desired.source);
}

core::Result<core::LayoutScalePolicy, core::Diagnostics>
LayoutRealizer::resolve_scale_policy(const RuntimeMountedLayout& desired) const
{
    core::LayoutScalePolicy policy;
    if (std::holds_alternative<ProjectLayoutRealizationSource>(desired.source)) {
        if (!m_project) {
            const LayoutRealizationSource source = desired.source;
            return core::Result<core::LayoutScalePolicy, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.project_unbound", "resolve-scale", &desired, &source,
                            "immutable Layout project is not bound")});
        }
        const auto* definition = m_project->find_layout(desired.mounted.layout);
        if (!definition) {
            const LayoutRealizationSource source = desired.source;
            return core::Result<core::LayoutScalePolicy, core::Diagnostics>::failure(
                {diagnostic("layout_realizer.layout_missing", "resolve-scale", &desired, &source,
                            "immutable Layout resource is missing")});
        }
        policy = definition->scale_policy;
    } else if (desired.mounted.policy.plane == core::PresentationPlane::WorldOverlay) {
        policy.ui = core::LayoutScaleInheritance::Ignore;
        policy.text = core::LayoutScaleInheritance::Inherit;
    }
    return core::Result<core::LayoutScalePolicy, core::Diagnostics>::success(
        core::apply_layout_scale_overrides(policy, desired.mounted.scale_overrides));
}

core::Result<std::string, core::Diagnostics>
LayoutRealizer::layout_source_text(const core::compiled::LayoutSource& source,
                                   const RuntimeMountedLayout& desired, const char* operation) const
{
    if (const auto* inline_source = std::get_if<core::compiled::InlineLayoutSource>(&source))
        return core::Result<std::string, core::Diagnostics>::success(inline_source->text);
    if (!m_project) {
        const LayoutRealizationSource typed_source = desired.source;
        return core::Result<std::string, core::Diagnostics>::failure(
            {diagnostic("layout_realizer.project_unbound", operation, &desired, &typed_source,
                        "immutable Layout project is not bound")});
    }
    const auto& asset_id = std::get<core::compiled::AssetLayoutSource>(source).asset;
    const auto* asset = m_project->find_asset(asset_id);
    if (!asset) {
        const LayoutRealizationSource typed_source = desired.source;
        return core::Result<std::string, core::Diagnostics>::failure(
            {diagnostic("layout_realizer.source_asset_missing", operation, &desired, &typed_source,
                        "Layout source asset is missing: " + asset_id.text())});
    }
    const std::string logical_path = "project:/" + asset->path;
    auto text = m_assets.read_text(logical_path);
    if (!text) {
        const LayoutRealizationSource typed_source =
            AssetLayoutRealizationSource{.logical_path = logical_path};
        return core::Result<std::string, core::Diagnostics>::failure(
            {diagnostic("layout_realizer.source_unreadable", operation, &desired, &typed_source,
                        text.error.message)});
    }
    return core::Result<std::string, core::Diagnostics>::success(std::move(*text.value));
}

bool LayoutRealizer::load_candidate(const CandidateLayout& candidate)
{
    const auto& realized = candidate.realized;
    const auto group = layout_composition_group(realized.desired.composition_group);
    switch (candidate.prepared.kind) {
    case PreparedSource::Kind::Builtin:
        return m_backend.load_builtin(candidate.prepared.builtin, realized.desired.mounted.policy,
                                      group, realized.desired.mounted.owner, realized.scale_policy,
                                      realized.compatibility_group);
    case PreparedSource::Kind::Path:
        return m_backend.load_path(realized.document_id, candidate.prepared.logical_path,
                                   realized.desired.mounted.policy, group,
                                   realized.desired.mounted.owner, realized.scale_policy,
                                   realized.compatibility_group);
    case PreparedSource::Kind::Memory:
        return m_backend.load_memory(realized.document_id, candidate.prepared.rml,
                                     candidate.prepared.source_url, realized.desired.mounted.policy,
                                     group, realized.desired.mounted.owner, realized.scale_policy,
                                     realized.compatibility_group);
    }
    return false;
}

core::Result<void, core::Diagnostics>
LayoutRealizer::restore_previous_backend_state(const RealizedMap& previous,
                                               const std::vector<std::string>& previous_order)
{
    core::Diagnostics diagnostics;
    for (const auto& [_, realized] : previous) {
        if (!m_backend.document_exists(realized.document_id)) {
            auto prepared = prepare_source(realized.desired);
            if (!prepared) {
                core::append_diagnostics(diagnostics, std::move(prepared).error());
                continue;
            }
            const CandidateLayout candidate{
                .realized = realized,
                .prepared = std::move(*prepared.value_if()),
                .load_required = true,
            };
            if (!load_candidate(candidate)) {
                const LayoutRealizationSource source = realized.desired.source;
                diagnostics.push_back(diagnostic(
                    "layout_realizer.rollback_reload_failed", "rollback-reload", &realized.desired,
                    &source, "failed to restore removed previous RuntimeUI document"));
                continue;
            }
        }
        const auto group = layout_composition_group(realized.desired.composition_group);
        if (!m_backend.apply_policy(realized.document_id, realized.desired.mounted.policy, group,
                                    realized.desired.mounted.owner, realized.scale_policy,
                                    realized.compatibility_group) ||
            !m_backend.set_opacity(realized.document_id, realized.opacity) ||
            !m_backend.set_visible(realized.document_id,
                                   realized.desired.mounted.policy.visibility ==
                                       core::LayoutVisibility::Visible)) {
            const LayoutRealizationSource source = realized.desired.source;
            diagnostics.push_back(diagnostic("layout_realizer.rollback_failed", "rollback",
                                             &realized.desired, &source,
                                             "failed to restore previous RuntimeUI state"));
        }
    }
    if (!previous_order.empty() && !m_backend.apply_order(previous_order)) {
        diagnostics.push_back({.code = "layout_realizer.rollback_order_failed",
                               .message = "operation=rollback-order layout=multiple "
                                          "instance=multiple source=multiple owner=multiple "
                                          "plane=multiple: failed to restore previous order"});
    }
    if (!diagnostics.empty())
        return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
LayoutRealizer::require_session(const RuntimeMountedLayout* desired, const char* operation) const
{
    if (m_project && m_host_generation)
        return core::Result<void, core::Diagnostics>::success();
    const LayoutRealizationSource* source = desired ? &desired->source : nullptr;
    return core::Result<void, core::Diagnostics>::failure(
        {diagnostic("layout_realizer.session_unbound", operation, desired, source,
                    "Layout realization requires a bound project session")});
}

LayoutRealizationResult
LayoutRealizer::stale_result(HostGeneration requested,
                             std::optional<core::MountedLayoutInstanceId> instance,
                             const RuntimeMountedLayout* desired, const char* operation) const
{
    LayoutRealizationResult result;
    result.disposition = LayoutRealizationDisposition::RejectedStale;
    result.instance = instance;
    const LayoutRealizationSource* source = desired ? &desired->source : nullptr;
    result.diagnostics.push_back(
        diagnostic("layout_realizer.stale_session_generation", operation, desired, source,
                   "request generation " + std::to_string(requested.number()) +
                       " does not match active generation " +
                       (m_host_generation ? std::to_string(m_host_generation->number())
                                          : std::string("none"))));
    return result;
}

core::Diagnostic LayoutRealizer::diagnostic(std::string code, const char* operation,
                                            const RuntimeMountedLayout* desired,
                                            const LayoutRealizationSource* source,
                                            std::string message) const
{
    std::string context = "operation=" + std::string(operation) + " layout=";
    context += desired ? desired->mounted.layout.text() : "unknown";
    context += " instance=";
    context += desired ? std::to_string(desired->mounted.instance.number()) : "unknown";
    context += " source=";
    context += source ? source_name(*source) : "unknown";
    context += " owner=";
    context += desired ? owner_name(desired->mounted.owner) : "unknown";
    context += " plane=";
    context += desired ? plane_name(desired->mounted.policy.plane) : "unknown";
    context += ": " + std::move(message);
    return {.code = std::move(code),
            .message = std::move(context),
            .source_path = source ? source_path(*source) : std::string{}};
}

std::string LayoutRealizer::builtin_document_id(RuntimeLayoutBuiltinDocument document)
{
    switch (document) {
    case RuntimeLayoutBuiltinDocument::Title:
        return "runtime_title";
    case RuntimeLayoutBuiltinDocument::GameHud:
        return "runtime_game";
    case RuntimeLayoutBuiltinDocument::PauseMenu:
        return "runtime_pause_menu";
    case RuntimeLayoutBuiltinDocument::SaveMenu:
        return "runtime_save_menu";
    case RuntimeLayoutBuiltinDocument::LoadMenu:
        return "runtime_load_menu";
    case RuntimeLayoutBuiltinDocument::SettingsMenu:
        return "runtime_settings_menu";
    case RuntimeLayoutBuiltinDocument::TextLog:
        return "runtime_text_log";
    case RuntimeLayoutBuiltinDocument::Modal:
        return "runtime_modal";
    case RuntimeLayoutBuiltinDocument::None:
        return {};
    }
    return {};
}

std::string LayoutRealizer::generated_document_id(const RuntimeMountedLayout& desired,
                                                  std::uint64_t version)
{
    return "layout_" + sanitize_identifier(desired.mounted.layout.text()) + "_instance_" +
           std::to_string(desired.mounted.instance.number()) + "_realization_" +
           std::to_string(version);
}

bool LayoutRealizer::ordered_before(const RuntimeMountedLayout& lhs,
                                    const RuntimeMountedLayout& rhs) noexcept
{
    if (lhs.mounted.policy.plane != rhs.mounted.policy.plane)
        return lhs.mounted.policy.plane < rhs.mounted.policy.plane;
    if (lhs.mounted.policy.local_order != rhs.mounted.policy.local_order)
        return lhs.mounted.policy.local_order < rhs.mounted.policy.local_order;
    return lhs.mounted.instance < rhs.mounted.instance;
}

} // namespace noveltea::host
