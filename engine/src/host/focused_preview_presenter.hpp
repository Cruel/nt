#pragma once

#include "host/layout_realizer.hpp"

#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/core/editor_preview_contracts.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/world_presentation.hpp"

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace noveltea::host {

enum class FocusedContentKind : std::uint8_t {
    None,
    Layout,
    Shader,
    Room,
};

struct FocusedContentOwnerState {
    FocusedContentKind kind = FocusedContentKind::None;
    std::string project_instance_id;
    std::string record_id;
    std::string revision;
    std::uint64_t apply_sequence = 0;
};

class FocusedPreviewPresenter final {
public:
    struct Dependencies {
        assets::AssetManager& assets;
        AssetWorldPresentationResourceResolver& world_resources;
        LayoutRealizer& layouts;
        std::function<bool(core::editor::TypedEditorPreviewDocument)> apply_legacy_document;
        std::function<void(const core::editor::FocusedEditorDocumentRequest&, std::string_view,
                           const core::Diagnostics&)>
            complete;
        std::function<void(core::Diagnostics)> report;
    };

    explicit FocusedPreviewPresenter(Dependencies dependencies) noexcept;
    ~FocusedPreviewPresenter();

    FocusedPreviewPresenter(const FocusedPreviewPresenter&) = delete;
    FocusedPreviewPresenter& operator=(const FocusedPreviewPresenter&) = delete;

    [[nodiscard]] bool apply(core::editor::FocusedEditorDocumentRequest request);
    void update();
    void clear() noexcept;

    [[nodiscard]] const FocusedContentOwnerState& committed_owner() const noexcept
    {
        return m_committed.owner;
    }

    void enable_fixture_room_commit(bool enabled) noexcept { m_fixture_room_commit = enabled; }

private:
    struct FocusedState {
        FocusedContentOwnerState owner;
        std::optional<core::editor::TypedFocusedRoomPreviewEnvironment> environment;
        std::optional<ShaderMaterialProject> materials;
        WorldPresentationResourceCatalog world_catalog;
        bool owns_committed_typed_leases = false;
        std::optional<core::editor::TypedFocusedRoomWorldDefinition> world;
        std::uint64_t world_revision = 0;
        std::vector<std::string> layout_instance_ids;
        core::TypedRuntimeUIViewState static_gameplay_values;
        std::vector<core::RuntimeInputMessage> passive_input_baseline;
        core::editor::TypedFocusedRoomQueryState query_state;
        std::optional<core::editor::TypedFocusedRoomCompositionDefinition> composition;
        bool composition_execution_prepared = false;
    };

    struct Candidate {
        core::editor::FocusedEditorDocumentRequest request;
        core::editor::TypedEditorRoomPreviewDocument document;
        FocusedState state;
        std::unique_ptr<assets::MandatoryAssetRequestGroup> asset_group;
    };

    [[nodiscard]] core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                               core::Diagnostics>
    build_asset_requests(const core::editor::FocusedEditorDocumentRequest& request,
                         const core::editor::TypedEditorRoomPreviewDocument& document) const;
    [[nodiscard]] core::Result<FocusedState, core::Diagnostics>
    prepare_room_state(const core::editor::FocusedEditorDocumentRequest& request,
                       const core::editor::TypedEditorRoomPreviewDocument& document) const;
    void supersede_candidate();
    void fail_candidate(core::Diagnostics diagnostics);
    void commit_candidate(assets::StructuredAssetLeaseSet leases);

    Dependencies m_dependencies;
    FocusedState m_committed;
    FocusedState m_rollback;
    std::optional<Candidate> m_candidate;
    std::string m_project_instance_id;
    std::uint64_t m_resource_generation = 0;
    bool m_fixture_room_commit = false;
};

} // namespace noveltea::host
