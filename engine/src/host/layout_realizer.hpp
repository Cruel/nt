#pragma once

#include "host/layout_composition.hpp"
#include "host/layout_realization_contracts.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/compiled_project.hpp"
#include "noveltea/presentation/runtime_layout_manager.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace noveltea {

class RuntimeUI;

namespace host {

class LayoutRealizer final : public LayoutRealizationSink,
                             public presentation::RuntimeLayoutDocumentHost {
public:
    struct AuthoredPreviewRequest {
        std::string rml;
        std::string source_url;
        core::LayoutScalePolicy scale_policy{};
    };

    struct BorrowedBackendForTesting final {};

    class Backend {
    public:
        virtual ~Backend() = default;

        [[nodiscard]] virtual bool document_exists(const std::string& document_id) const = 0;
        [[nodiscard]] virtual bool
        load_builtin(presentation::RuntimeLayoutBuiltinDocument document,
                     const core::MountedLayoutPolicy& policy,
                     LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                     core::LayoutScalePolicy scale_policy,
                     LayoutContextCompatibilityGroup compatibility_group) = 0;
        [[nodiscard]] virtual bool
        load_path(const std::string& document_id, const std::string& logical_path,
                  const core::MountedLayoutPolicy& policy, LayoutCompositionGroup composition_group,
                  core::MountedLayoutOwner owner, core::LayoutScalePolicy scale_policy,
                  LayoutContextCompatibilityGroup compatibility_group) = 0;
        [[nodiscard]] virtual bool
        load_memory(const std::string& document_id, const std::string& rml,
                    const std::string& source_url, const core::MountedLayoutPolicy& policy,
                    LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                    core::LayoutScalePolicy scale_policy,
                    LayoutContextCompatibilityGroup compatibility_group) = 0;
        [[nodiscard]] virtual bool
        apply_policy(const std::string& document_id, const core::MountedLayoutPolicy& policy,
                     LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                     core::LayoutScalePolicy scale_policy,
                     LayoutContextCompatibilityGroup compatibility_group) = 0;
        [[nodiscard]] virtual bool set_visible(const std::string& document_id, bool visible) = 0;
        [[nodiscard]] virtual bool set_opacity(const std::string& document_id, float opacity) = 0;
        [[nodiscard]] virtual bool
        apply_order(const std::vector<std::string>& ordered_document_ids) = 0;
        [[nodiscard]] virtual bool unload(const std::string& document_id) = 0;
    };

    LayoutRealizer(assets::AssetManager& assets, RuntimeUI& runtime_ui);
    LayoutRealizer(assets::AssetManager& assets, Backend& backend,
                   BorrowedBackendForTesting) noexcept;
    ~LayoutRealizer() override;

    LayoutRealizer(const LayoutRealizer&) = delete;
    LayoutRealizer& operator=(const LayoutRealizer&) = delete;
    LayoutRealizer(LayoutRealizer&&) = delete;
    LayoutRealizer& operator=(LayoutRealizer&&) = delete;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    validate_project(const core::CompiledProject& project) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    bind_session(const core::CompiledProject& project, HostGeneration generation);
    void clear_session() noexcept;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    realize_authored_preview(AuthoredPreviewRequest request);
    void clear_authored_preview() noexcept;
    [[nodiscard]] static constexpr std::string_view authored_preview_document_id() noexcept
    {
        return "editor_authored_layout_preview";
    }

    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_layouts(const std::vector<presentation::RuntimeMountedLayout>& desired) override;
    [[nodiscard]] LayoutRealizationResult
    apply_layout_realization(LayoutRealizationRequest request) override;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    apply_policy(core::MountedLayoutInstanceId instance, core::MountedLayoutPolicy policy,
                 LayoutCompositionGroup composition_group);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_visible(core::MountedLayoutInstanceId instance, bool visible);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_opacity(core::MountedLayoutInstanceId instance, float opacity);
    [[nodiscard]] std::optional<std::string>
    document_id(core::MountedLayoutInstanceId instance) const;
    [[nodiscard]] std::size_t realized_count() const noexcept { return m_realized.size(); }
    [[nodiscard]] std::optional<HostGeneration> host_generation() const noexcept
    {
        return m_host_generation;
    }

private:
    struct PreparedSource {
        enum class Kind : std::uint8_t {
            Builtin,
            Path,
            Memory,
        };

        Kind kind = Kind::Memory;
        presentation::RuntimeLayoutBuiltinDocument builtin =
            presentation::RuntimeLayoutBuiltinDocument::None;
        std::string logical_path;
        std::string source_url;
        std::string rml;
    };

    struct RealizedLayout {
        presentation::RuntimeMountedLayout desired;
        std::string document_id;
        std::uint64_t realization_version = 1;
        float opacity = 1.0f;
        core::LayoutScalePolicy scale_policy{};
        LayoutContextCompatibilityGroup compatibility_group = 0;
        std::vector<assets::AssetLease<assets::FontAsset>> font_leases;
    };

    struct CandidateLayout {
        RealizedLayout realized;
        PreparedSource prepared;
        bool load_required = false;
    };

    using RealizedMap = std::unordered_map<std::uint64_t, RealizedLayout>;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile(std::vector<presentation::RuntimeMountedLayout> desired, bool recreate);
    [[nodiscard]] core::Result<PreparedSource, core::Diagnostics>
    prepare_source(const presentation::RuntimeMountedLayout& desired) const;
    [[nodiscard]] core::Result<core::LayoutScalePolicy, core::Diagnostics>
    resolve_scale_policy(const presentation::RuntimeMountedLayout& desired) const;
    [[nodiscard]] core::Result<std::string, core::Diagnostics>
    layout_source_text(const core::compiled::LayoutSource& source,
                       const presentation::RuntimeMountedLayout& desired,
                       const char* operation) const;
    [[nodiscard]] bool load_candidate(const CandidateLayout& candidate);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    restore_previous_backend_state(const RealizedMap& previous,
                                   const std::vector<std::string>& previous_order);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    require_session(const presentation::RuntimeMountedLayout* desired, const char* operation) const;
    [[nodiscard]] LayoutRealizationResult
    stale_result(HostGeneration requested, std::optional<core::MountedLayoutInstanceId> instance,
                 const presentation::RuntimeMountedLayout* desired, const char* operation) const;
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, const char* operation,
                                              const presentation::RuntimeMountedLayout* desired,
                                              const LayoutRealizationSource* source,
                                              std::string message) const;
    [[nodiscard]] static std::string
    builtin_document_id(presentation::RuntimeLayoutBuiltinDocument document);
    [[nodiscard]] static std::string
    generated_document_id(const presentation::RuntimeMountedLayout& desired, std::uint64_t version);
    [[nodiscard]] static bool
    ordered_before(const presentation::RuntimeMountedLayout& lhs,
                   const presentation::RuntimeMountedLayout& rhs) noexcept;

    assets::AssetManager& m_assets;
    std::unique_ptr<Backend> m_owned_backend;
    Backend& m_backend;
    const core::CompiledProject* m_project = nullptr;
    std::optional<HostGeneration> m_host_generation;
    BackendGeneration m_backend_generation = *BackendGeneration::from_number(1);
    RealizedMap m_realized;
    bool m_require_resident_font_leases = true;
};

} // namespace host
} // namespace noveltea
