#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/runtime_presentation.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/math/geometry.hpp"
#include "noveltea/render/quad_batch.hpp"

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace noveltea {

struct WorldPreparedVisual {
    std::optional<assets::TextureAsset> texture;
    std::optional<MaterialId> material;
    Color tint{};
};

class WorldPresentationResourceResolver {
public:
    virtual ~WorldPresentationResourceResolver() = default;

    [[nodiscard]] virtual core::Result<WorldPreparedVisual, core::Diagnostics>
    resolve(std::optional<core::AssetId> asset, std::optional<core::MaterialId> material,
            std::string_view context) = 0;
};

class AssetWorldPresentationResourceResolver final : public WorldPresentationResourceResolver {
public:
    explicit AssetWorldPresentationResourceResolver(const assets::AssetManager& assets)
        : m_assets(assets)
    {
    }

    void bind_project(const core::CompiledProject& project);
    void clear();

    [[nodiscard]] core::Result<WorldPreparedVisual, core::Diagnostics>
    resolve(std::optional<core::AssetId> asset, std::optional<core::MaterialId> material,
            std::string_view context) override;

private:
    const assets::AssetManager& m_assets;
    std::unordered_map<std::string, std::string> m_image_paths;
};

struct WorldFittedRect {
    Rect rect{};
    Rect uv{0.0f, 0.0f, 1.0f, 1.0f};
};

class WorldPresentationLayoutPolicy {
public:
    [[nodiscard]] static Rect normalized_rect(const core::compiled::NormalizedRect& bounds,
                                              Size viewport) noexcept;
    [[nodiscard]] static WorldFittedRect fit_background(Size viewport, Size texture,
                                                        core::compiled::BackgroundFit fit) noexcept;
    [[nodiscard]] static Rect actor_rect(const core::PresentationActor& actor, Size viewport,
                                         Size texture) noexcept;
};

enum class WorldDrawFamily : std::uint8_t {
    Background,
    Environment,
    Prop,
    Interactable,
    Actor,
    MapUnderlay,
};

struct WorldPresentationDraw {
    core::PresentationPlane plane = core::PresentationPlane::WorldContent;
    WorldDrawFamily family = WorldDrawFamily::Prop;
    std::int32_t order = 0;
    std::string stable_identity;
    std::uint8_t sublayer = 0;
    QuadCommand command;
    std::optional<core::compiled::CharacterIdle> actor_idle;
    std::optional<core::LayoutClockDomain> environment_clock;
    core::compiled::Vector2 environment_scroll_per_second{0.0, 0.0};
};

struct WorldPresentationFrame {
    core::PresentationSnapshotRevision revision =
        core::PresentationSnapshotRevision::from_number(0);
    std::vector<WorldPresentationDraw> draws;
    QuadBatch world_composition_batch;
    QuadBatch game_ui_underlay_batch;
    QuadBatch batch;
};

[[nodiscard]] std::string world_actor_identity(const core::ActorPresentationKey& key);

class WorldPresentationBackend {
public:
    explicit WorldPresentationBackend(WorldPresentationResourceResolver& resources)
        : m_resources(resources)
    {
    }

    [[nodiscard]] core::Result<bool, core::Diagnostics>
    reconcile(const core::RuntimePresentationSnapshot& snapshot, Size viewport);
    void realize(const core::RuntimeClockUpdate& clock);
    [[nodiscard]] core::Result<bool, core::Diagnostics> resize(Size viewport);
    void reset();

    [[nodiscard]] const WorldPresentationFrame* frame() const noexcept;
    [[nodiscard]] const WorldPresentationFrame*
    frame(core::PresentationSnapshotRevision revision) const noexcept;
    [[nodiscard]] const core::RuntimePresentationSnapshot*
    snapshot(core::PresentationSnapshotRevision revision) const noexcept;
    [[nodiscard]] Size viewport() const noexcept { return m_viewport; }
    [[nodiscard]] bool restore_revision(core::PresentationSnapshotRevision revision) noexcept;
    void discard_revision(core::PresentationSnapshotRevision revision) noexcept;
    void retain_only(std::span<const core::PresentationSnapshotRevision> revisions);
    [[nodiscard]] std::uint64_t generation() const noexcept { return m_generation; }

private:
    struct LoopEpoch {
        core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
        std::chrono::microseconds started_at{0};
    };

    void rebuild_batches(WorldPresentationFrame& frame,
                         const core::RuntimeClockUpdate* clock = nullptr);
    void prune_loop_epochs();

    WorldPresentationResourceResolver& m_resources;
    std::optional<core::RuntimePresentationSnapshot> m_snapshot;
    Size m_viewport{};
    std::optional<WorldPresentationFrame> m_frame;
    std::unordered_map<std::uint64_t, core::RuntimePresentationSnapshot> m_snapshots;
    std::unordered_map<std::uint64_t, WorldPresentationFrame> m_frames;
    std::unordered_map<std::string, LoopEpoch> m_loop_epochs;
    std::uint64_t m_generation = 0;
};

} // namespace noveltea
