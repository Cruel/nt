#pragma once

#include "host/layout_realizer.hpp"

#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/core/editor_preview_contracts.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/presentation/runtime_presentation.hpp"
#include "noveltea/runtime_ui_contracts.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/world_presentation.hpp"

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace noveltea {
class RuntimeUI;
namespace host {

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
        WorldPresentationBackend& world;
        LayoutRealizer& layouts;
        script::ScriptRuntime& scripts;
        std::function<core::Result<std::function<void()>, core::Diagnostics>(
            const core::editor::TypedFocusedRoomPreviewEnvironment&)>
            prepare_environment;
        std::function<core::Result<std::function<void()>, core::Diagnostics>(
            const core::editor::TypedEditorAuthoredPreviewEnvironment&)>
            prepare_layout_environment;
        std::function<core::Result<std::function<void()>, core::Diagnostics>()>
            prepare_clear_environment;
        std::function<core::Result<RuntimeUiGameplayValues, core::Diagnostics>(
            RuntimeUiGameplayValues)>
            prepare_ui_values;
        std::function<void(RuntimeUiGameplayValues)> commit_ui_values;
        std::function<void(const ShaderMaterialProject&)> apply_materials;
        std::function<void(const ShaderMaterialProject*)> bind_candidate_materials;
        std::function<void(RuntimeUiInputSink*)> bind_input_sink;
        std::function<void()> retire_legacy_preview;
        std::function<std::string_view()> active_shader_variant;
        std::function<std::string(bool fragment)> standalone_layout_style_prefix;
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
    [[nodiscard]] const core::RoomPresentationResolution*
    committed_room_resolution_for_testing() const noexcept
    {
        return m_committed.room_resolution ? &*m_committed.room_resolution : nullptr;
    }

private:
    struct FocusedState {
        FocusedContentOwnerState owner;
        std::optional<core::editor::TypedFocusedRoomPreviewEnvironment> environment;
        std::optional<ShaderMaterialProject> materials;
        WorldPresentationResourceCatalog world_catalog;
        bool owns_committed_typed_leases = false;
        std::optional<core::editor::TypedFocusedRoomWorldDefinition> world;
        std::optional<core::RoomPresentationResolution> room_resolution;
        std::optional<core::RuntimePresentationSnapshot> snapshot;
        std::uint64_t world_revision = 0;
        std::vector<std::string> layout_instance_ids;
        core::TypedRuntimeUIViewState static_gameplay_values;
        std::vector<core::RuntimeInputMessage> passive_input_baseline;
        core::editor::TypedFocusedRoomQueryState query_state;
        std::optional<core::editor::TypedFocusedRoomCompositionDefinition> composition;
        bool composition_execution_prepared = false;
        script::ScriptEnvironmentHandle script_environment;
        std::shared_ptr<runtime::RuntimeQueryProvider> query_provider;
    };

    struct Candidate {
        core::editor::FocusedEditorDocumentRequest request;
        core::editor::TypedEditorRoomPreviewDocument document;
        FocusedState state;
        std::vector<core::editor::TypedFocusedRoomLayoutDefinition> mounted_layouts;
        std::unique_ptr<assets::MandatoryAssetRequestGroup> asset_group;
        std::unique_ptr<AssetWorldPresentationResourceResolver> prepared_world_resources;
        std::unique_ptr<WorldPresentationBackend> prepared_world;
    };

    struct NonRoomCandidate {
        core::editor::FocusedEditorDocumentRequest request;
        core::editor::TypedEditorPreviewDocument document;
        ShaderMaterialProject materials;
        std::unique_ptr<assets::MandatoryAssetRequestGroup> asset_group;
    };

    class PassiveInputSink final : public RuntimeUiInputSink {
    public:
        explicit PassiveInputSink(FocusedPreviewPresenter& owner) noexcept : m_owner(owner) {}

        [[nodiscard]] bool submit_gameplay_input(core::RuntimeInputMessage input) override
        {
            baseline.push_back(std::move(input));
            return false;
        }
        [[nodiscard]] bool submit_shell_command(core::RuntimeShellCommand) override
        {
            return false;
        }
        [[nodiscard]] bool dispatch_layout_event(core::MountedLayoutOwner owner,
                                                 const std::function<bool()>& dispatch) override
        {
            return m_owner.dispatch_layout_event(owner, dispatch);
        }
        std::vector<core::RuntimeInputMessage> baseline;

    private:
        FocusedPreviewPresenter& m_owner;
    };

    [[nodiscard]] core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                               core::Diagnostics>
    build_asset_requests(const core::editor::FocusedEditorDocumentRequest& request,
                         const ShaderMaterialProject& materials);
    [[nodiscard]] core::Result<FocusedState, core::Diagnostics> prepare_room_state(
        const core::editor::FocusedEditorDocumentRequest& request,
        const core::editor::TypedEditorRoomPreviewDocument& document,
        std::vector<core::editor::TypedFocusedRoomLayoutDefinition>& mounted_layouts);
    void release_state(FocusedState& state) noexcept;
    void supersede_candidate();
    void fail_candidate(core::Diagnostics diagnostics);
    void commit_candidate(assets::StructuredAssetLeaseSet leases);
    void fail_non_room_candidate(core::Diagnostics diagnostics);
    void commit_non_room_candidate(assets::StructuredAssetLeaseSet leases);
    [[nodiscard]] bool dispatch_layout_event(core::MountedLayoutOwner owner,
                                             const std::function<bool()>& dispatch);

    Dependencies m_dependencies;
    FocusedState m_committed;
    FocusedState m_rollback;
    std::optional<Candidate> m_candidate;
    std::optional<NonRoomCandidate> m_non_room_candidate;
    std::string m_project_instance_id;
    std::uint64_t m_latest_apply_sequence = 0;
    std::uint64_t m_resource_generation = 0;
    PassiveInputSink m_passive_input;
};

} // namespace host
} // namespace noveltea
