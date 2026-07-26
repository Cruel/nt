#include "host/focused_preview_presenter.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/core/editor_runtime_protocol.hpp"

#include <utility>

namespace noveltea::host {
namespace {

core::Diagnostic error(std::string code, std::string message, std::string pointer = {})
{
    return {
        .code = std::move(code), .message = std::move(message), .json_pointer = std::move(pointer)};
}

FocusedContentKind owner_kind(core::editor::FocusedEditorDocumentKind kind)
{
    switch (kind) {
    case core::editor::FocusedEditorDocumentKind::Layout:
        return FocusedContentKind::Layout;
    case core::editor::FocusedEditorDocumentKind::Shader:
        return FocusedContentKind::Shader;
    case core::editor::FocusedEditorDocumentKind::Room:
        return FocusedContentKind::Room;
    }
    return FocusedContentKind::None;
}

} // namespace

FocusedPreviewPresenter::FocusedPreviewPresenter(Dependencies dependencies) noexcept
    : m_dependencies(std::move(dependencies))
{
}

FocusedPreviewPresenter::~FocusedPreviewPresenter() { clear(); }

void FocusedPreviewPresenter::clear() noexcept
{
    supersede_candidate();
    m_dependencies.layouts.clear_focused_preview();
    m_dependencies.world_resources.clear();
    m_dependencies.assets.clear_focused_published_leases_on_owner();
    m_committed = {};
    m_rollback = {};
    m_project_instance_id.clear();
    m_resource_generation = 0;
}

void FocusedPreviewPresenter::supersede_candidate()
{
    if (!m_candidate)
        return;
    m_candidate->asset_group->cancel_on_owner();
    m_dependencies.complete(m_candidate->request, "superseded", {});
    m_candidate.reset();
}

core::Result<std::vector<assets::StructuredAssetRequestDescriptor>, core::Diagnostics>
FocusedPreviewPresenter::build_asset_requests(
    const core::editor::FocusedEditorDocumentRequest& request,
    const core::editor::TypedEditorRoomPreviewDocument& document) const
{
    std::vector<assets::StructuredAssetRequestDescriptor> result;
    const auto generation = m_dependencies.assets.source_generation_on_owner();
    for (const auto& resource : request.resources) {
        if (resource.source_kind != "authoring-asset")
            continue;
        const auto path = resource.logical_path.find(":/") == std::string::npos
                              ? "project:/" + resource.logical_path
                              : resource.logical_path;
        if (resource.kind == "image") {
            const assets::TextureAssetRequest typed{
                .path = path,
                .sampler = resource.sampling == "nearest" ? MaterialTextureSampler::ClampNearest
                                                          : MaterialTextureSampler::ClampLinear};
            result.push_back(
                {.request = typed, .cache_key = assets::make_texture_cache_key(typed, generation)});
        } else if (resource.kind == "font") {
            const assets::FontAssetRequest typed{
                .alias = resource.asset_id.value_or(resource.resource_id)};
            result.push_back(
                {.request = typed, .cache_key = assets::make_font_cache_key(typed, generation)});
        }
    }
    for (const auto& material : document.shader_materials.materials) {
        const assets::MaterialAssetRequest typed{.id = material.id.string()};
        result.push_back(
            {.request = typed, .cache_key = assets::make_material_cache_key(typed, generation)});
    }
    return core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                        core::Diagnostics>::success(std::move(result));
}

core::Result<FocusedPreviewPresenter::FocusedState, core::Diagnostics>
FocusedPreviewPresenter::prepare_room_state(
    const core::editor::FocusedEditorDocumentRequest& request,
    const core::editor::TypedEditorRoomPreviewDocument& document) const
{
    FocusedState state;
    state.owner = {.kind = FocusedContentKind::Room,
                   .project_instance_id = request.project_instance_id,
                   .record_id = request.record_id,
                   .revision = request.revision,
                   .apply_sequence = request.apply_sequence};
    state.environment = document.environment;
    state.materials = document.shader_materials;
    state.world = document.world;
    state.query_state = document.query_state;
    state.composition = document.composition;
    state.composition_execution_prepared = document.composition.has_value();
    state.world_revision = request.apply_sequence;
    for (const auto& resource : request.resources) {
        if (resource.source_kind != "authoring-asset" || resource.kind != "image" ||
            !resource.asset_id)
            continue;
        const auto asset_id = core::AssetId::create(*resource.asset_id);
        if (!asset_id)
            continue;
        state.world_catalog.images.push_back(
            {.asset_id = *asset_id.value_if(),
             .logical_path = resource.logical_path.find(":/") == std::string::npos
                                 ? "project:/" + resource.logical_path
                                 : resource.logical_path,
             .sampler = resource.sampling == "nearest" ? MaterialTextureSampler::ClampNearest
                                                       : MaterialTextureSampler::ClampLinear});
    }
    for (const auto& layout : document.layouts)
        state.layout_instance_ids.push_back(layout.instance_id);
    return core::Result<FocusedState, core::Diagnostics>::success(std::move(state));
}

bool FocusedPreviewPresenter::apply(core::editor::FocusedEditorDocumentRequest request)
{
    if (request.project_instance_id != m_project_instance_id) {
        supersede_candidate();
        m_project_instance_id = request.project_instance_id;
        m_resource_generation = 0;
    }
    if (request.resource_stage_generation < m_resource_generation) {
        m_dependencies.report({error("editor_preview.stale_resource_generation",
                                     "Focused preview resource generation is stale.")});
        return false;
    }
    if (request.resource_stage_generation > m_resource_generation) {
        auto refreshed = m_dependencies.assets.refresh_namespace_on_owner("project");
        if (!refreshed) {
            m_dependencies.report({std::move(refreshed).error()});
            return false;
        }
        m_resource_generation = request.resource_stage_generation;
    }

    if (request.kind != core::editor::FocusedEditorDocumentKind::Room) {
        const auto kind = request.kind == core::editor::FocusedEditorDocumentKind::Layout
                              ? "layout-preview"
                              : "shader-preview";
        auto decoded = core::editor::decode_editor_preview_document_text(kind, request.data_json);
        if (!decoded) {
            m_dependencies.report(std::move(decoded).error());
            return false;
        }
        const bool applied = m_dependencies.apply_legacy_document(std::move(*decoded.value_if()));
        if (applied) {
            m_rollback = m_committed;
            m_committed = {};
            m_committed.owner = {.kind = owner_kind(request.kind),
                                 .project_instance_id = request.project_instance_id,
                                 .record_id = request.record_id,
                                 .revision = request.revision,
                                 .apply_sequence = request.apply_sequence};
        }
        m_dependencies.complete(request, applied ? "applied" : "failed", {});
        return true;
    }

    auto decoded = core::editor::decode_editor_room_preview_document_text(request.data_json);
    if (!decoded) {
        m_dependencies.report(std::move(decoded).error());
        return false;
    }
    supersede_candidate();
    auto prepared = prepare_room_state(request, *decoded.value_if());
    if (!prepared) {
        m_dependencies.report(std::move(prepared).error());
        return false;
    }
    auto requests = build_asset_requests(request, *decoded.value_if());
    if (!requests) {
        m_dependencies.report(std::move(requests).error());
        return false;
    }
    auto group = std::make_unique<assets::MandatoryAssetRequestGroup>(
        m_dependencies.assets, std::move(*requests.value_if()),
        assets::MandatoryAssetGroupOptions{.show_overlay_immediately = false,
                                           .retryable = false,
                                           .presentation_revision = std::nullopt});
    m_candidate = Candidate{.request = std::move(request),
                            .document = std::move(*decoded.value_if()),
                            .state = std::move(*prepared.value_if()),
                            .asset_group = std::move(group)};
    return true;
}

void FocusedPreviewPresenter::fail_candidate(core::Diagnostics diagnostics)
{
    if (!m_candidate)
        return;
    m_dependencies.complete(m_candidate->request, "failed", diagnostics);
    m_candidate.reset();
}

void FocusedPreviewPresenter::commit_candidate(assets::StructuredAssetLeaseSet leases)
{
    if (!m_candidate)
        return;
    auto candidate = std::move(*m_candidate);
    m_candidate.reset();
    m_dependencies.assets.stage_focused_candidate_leases_on_owner(std::move(leases));
    auto layout_result = m_dependencies.layouts.stage_focused_preview(candidate.document.layouts);
    if (!layout_result) {
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed", std::move(layout_result).error());
        return;
    }
    candidate.state.owns_committed_typed_leases = true;
    if (!m_dependencies.layouts.commit_focused_preview()) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed",
                                {error("editor_preview.room_commit_failed",
                                       "Focused Room prepared swap could not be committed.")});
        return;
    }
    m_dependencies.assets.commit_focused_candidate_leases_on_owner();
    m_dependencies.world_resources.bind_catalog(candidate.state.world_catalog);
    m_rollback = m_committed;
    m_committed = std::move(candidate.state);
    m_dependencies.complete(candidate.request, "applied", {});
}

void FocusedPreviewPresenter::update()
{
    if (!m_candidate)
        return;
    m_candidate->asset_group->poll_on_owner();
    switch (m_candidate->asset_group->state_on_owner()) {
    case assets::MandatoryAssetGroupState::Pending:
        return;
    case assets::MandatoryAssetGroupState::Failed:
    case assets::MandatoryAssetGroupState::Canceled:
        fail_candidate({error("editor_preview.room_candidate_failed",
                              "Focused Room candidate asset preparation failed.")});
        return;
    case assets::MandatoryAssetGroupState::Ready:
        break;
    }
    auto leases = m_candidate->asset_group->take_ready_leases_on_owner();
    if (!leases) {
        fail_candidate({error("editor_preview.room_candidate_leases_missing",
                              "Focused Room candidate completed without typed leases.")});
        return;
    }
    if (!m_fixture_room_commit) {
        fail_candidate({error("editor_preview.room_visual_commit_deferred",
                              "Focused Room visual commit remains fixture-only until Phase 11.")});
        return;
    }
    commit_candidate(std::move(*leases));
}

} // namespace noveltea::host
