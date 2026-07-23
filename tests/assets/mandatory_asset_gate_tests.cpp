#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"

#include <atomic>
#include <chrono>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

assets::ResidencyBudget matrix_budget()
{
    return {.source_bytes = 4096,
            .prepared_cpu_bytes = 4096,
            .gpu_bytes = 4096,
            .audio_bytes = 4096,
            .temporary_bytes = 4096};
}

template<class T> class MatrixPreparationTask final : public assets::AssetPreparationTask<T> {
public:
    explicit MatrixPreparationTask(T asset) : m_asset(std::move(asset)) {}

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 1};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        m_ready = !context.cancellation_requested();
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<T>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        if (!m_ready) {
            return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::failure(
                {{.code = "test.matrix_canceled", .message = "matrix task was canceled"}});
        }
        return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::success(
            {.asset = std::move(m_asset),
             .cost = {.prepared_cpu_bytes = 1},
             .destroy_on_owner = {}});
    }

private:
    T m_asset;
    bool m_ready = false;
};

struct MatrixState {
    bool reject_material = false;
    std::vector<std::string> submissions;
};

class MatrixFontLoader final : public assets::FontAssetLoader {
public:
    explicit MatrixFontLoader(MatrixState& state) : m_state(state) {}
    assets::AssetLoadResult<assets::FontAsset>
    load_font(const assets::FontAssetRequest& request) override
    {
        return {assets::FontAsset{.resolved_alias = request.alias}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::FontAsset>>
    create_font_preparation_task(const assets::FontAssetRequest& request) override
    {
        m_state.submissions.push_back("font:" + request.alias);
        return std::make_unique<MatrixPreparationTask<assets::FontAsset>>(
            assets::FontAsset{.resolved_alias = request.alias});
    }

private:
    MatrixState& m_state;
};

class MatrixTextureLoader final : public assets::TextureAssetLoader {
public:
    explicit MatrixTextureLoader(MatrixState& state) : m_state(state) {}
    assets::AssetLoadResult<assets::TextureAsset>
    load_texture(const assets::TextureAssetRequest& request) override
    {
        return {assets::TextureAsset{.handle = 11, .path = request.path}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_texture_preparation_task(const assets::TextureAssetRequest& request) override
    {
        m_state.submissions.push_back("texture:" + request.path);
        return std::make_unique<MatrixPreparationTask<assets::TextureAsset>>(
            assets::TextureAsset{.handle = 11, .path = request.path, .sampler = request.sampler});
    }

private:
    MatrixState& m_state;
};

class MatrixShaderLoader final : public assets::ShaderProgramAssetLoader {
public:
    explicit MatrixShaderLoader(MatrixState& state) : m_state(state) {}
    assets::AssetLoadResult<assets::ShaderProgramAsset>
    load_shader_program(const assets::ShaderProgramAssetRequest& request) override
    {
        return {assets::ShaderProgramAsset{.handle = 12, .key = request.resolution.key}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::ShaderProgramAsset>>
    create_shader_program_preparation_task(
        const assets::ShaderProgramAssetRequest& request) override
    {
        m_state.submissions.push_back("shader:" + request.resolution.key.material_id);
        return std::make_unique<MatrixPreparationTask<assets::ShaderProgramAsset>>(
            assets::ShaderProgramAsset{.handle = 12, .key = request.resolution.key});
    }

private:
    MatrixState& m_state;
};

class MatrixMaterialLoader final : public assets::MaterialAssetLoader {
public:
    explicit MatrixMaterialLoader(MatrixState& state) : m_state(state) {}
    assets::AssetLoadResult<assets::MaterialAsset>
    load_material(const assets::MaterialAssetRequest& request) override
    {
        return {assets::MaterialAsset{.id = request.id}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::MaterialAsset>>
    create_material_preparation_task(const assets::MaterialAssetRequest& request) override
    {
        m_state.submissions.push_back("material:" + request.id);
        if (m_state.reject_material)
            return {};
        return std::make_unique<MatrixPreparationTask<assets::MaterialAsset>>(
            assets::MaterialAsset{.id = request.id});
    }

private:
    MatrixState& m_state;
};

class MatrixAudioLoader final : public assets::AudioAssetLoader {
public:
    explicit MatrixAudioLoader(MatrixState& state) : m_state(state) {}
    assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        return {assets::AudioAsset{.clip = AudioClipHandle{13},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
    create_audio_preparation_task(const assets::AudioAssetRequest& request) override
    {
        m_state.submissions.push_back("audio:" + request.path);
        return std::make_unique<MatrixPreparationTask<assets::AudioAsset>>(
            assets::AudioAsset{.clip = AudioClipHandle{13},
                               .path = request.path,
                               .mode = request.mode,
                               .kind = request.kind});
    }

private:
    MatrixState& m_state;
};

assets::ShaderProgramAssetRequest matrix_shader(std::size_t index)
{
    assets::ShaderProgramAssetRequest request;
    request.resolution.key.material_id = "matrix-" + std::to_string(index);
    request.resolution.key.variant = "glsl-120";
    request.resolution.key.vertex_path =
        "project:/shaders/matrix-" + std::to_string(index) + ".vs.bin";
    request.resolution.key.fragment_path =
        "project:/shaders/matrix-" + std::to_string(index) + ".fs.bin";
    return request;
}

template<class Request>
assets::StructuredAssetRequestDescriptor matrix_descriptor(
    Request request, assets::AssetSourceGeneration generation)
{
    assets::AssetCacheKey key;
    if constexpr (std::is_same_v<Request, assets::FontAssetRequest>)
        key = assets::make_font_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::TextureAssetRequest>)
        key = assets::make_texture_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::ShaderProgramAssetRequest>)
        key = assets::make_shader_program_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::MaterialAssetRequest>)
        key = assets::make_material_cache_key(request, generation);
    else
        key = assets::make_audio_cache_key(request, generation);
    return {.request = std::move(request), .cache_key = std::move(key)};
}

std::vector<assets::StructuredAssetRequestDescriptor>
matrix_requests(assets::AssetSourceGeneration generation)
{
    std::vector<assets::StructuredAssetRequestDescriptor> requests;
    for (std::size_t index = 0; index < 4; ++index) {
        requests.push_back(matrix_descriptor(
            assets::FontAssetRequest{.alias = "matrix-font-" + std::to_string(index)},
            generation));
        requests.push_back(matrix_descriptor(
            assets::TextureAssetRequest{
                .path = "project:/textures/matrix-" + std::to_string(index) + ".png"},
            generation));
        requests.push_back(matrix_descriptor(matrix_shader(index), generation));
        requests.push_back(matrix_descriptor(
            assets::MaterialAssetRequest{.id = "matrix-material-" + std::to_string(index)},
            generation));
        requests.push_back(matrix_descriptor(
            assets::AudioAssetRequest{
                .path = "project:/audio/matrix-" + std::to_string(index) + ".ogg",
                .mode = AudioLoadMode::Stream,
                .kind = AudioClipKind::Music},
            generation));
    }
    return requests;
}

template<class Predicate>
bool drive_until(jobs::CooperativeJobExecutor& executor, Predicate&& predicate)
{
    for (std::size_t iteration = 0; iteration < 1024; ++iteration) {
        executor.pump(10ms);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::SdlThreadPoolJobExecutor& executor, Predicate&& predicate)
{
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (std::chrono::steady_clock::now() < deadline) {
        executor.pump(0ns);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
        std::this_thread::sleep_for(1ms);
    }
    return false;
}

void shutdown(jobs::CooperativeJobExecutor& executor)
{
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}

void shutdown(jobs::SdlThreadPoolJobExecutor& executor)
{
    executor.begin_shutdown();
    REQUIRE(drive_until(executor, [&] { return executor.shutdown_complete(); }));
}

template<class Executor> void run_twenty_asset_matrix(Executor& executor)
{
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget());
    assets::AssetManager manager;
    MatrixState state;
    MatrixFontLoader fonts(state);
    MatrixTextureLoader textures(state);
    MatrixShaderLoader shaders(state);
    MatrixMaterialLoader materials(state);
    MatrixAudioLoader audio(state);
    REQUIRE(manager.configure_async_requests(executor, residency));
    manager.bind_font_loader(&fonts);
    manager.bind_texture_loader(&textures);
    manager.bind_shader_program_loader(&shaders);
    manager.bind_material_loader(&materials);
    manager.bind_audio_loader(&audio);

    const auto requests = matrix_requests(manager.source_generation_on_owner());
    const auto started = assets::MandatoryAssetRequestGroup::Clock::time_point{};
    assets::MandatoryAssetRequestGroup group(
        manager, requests,
        {.phase = core::LoadingPhase::LoadingRuntimeDemand,
         .reason = assets::AssetRequestReason::Demand,
         .overlay_grace = 100ms,
         .show_overlay_immediately = false,
         .retryable = true},
        started);

    REQUIRE(group.progress_on_owner().state == core::LoadingState::Active);
    REQUIRE(group.progress_on_owner().total_units == 20);
    CHECK_FALSE(group.overlay_visible_on_owner(started + 99ms));
    CHECK(group.overlay_visible_on_owner(started + 100ms));
    group.show_overlay_immediately_on_owner();
    CHECK(group.overlay_visible_on_owner(started));

    std::uint64_t previous_completed = 0;
    REQUIRE(drive_until(executor, [&] {
        group.poll_on_owner();
        const auto completed = group.progress_on_owner().completed_units;
        CHECK(completed >= previous_completed);
        previous_completed = completed;
        return group.state_on_owner() != assets::MandatoryAssetGroupState::Pending;
    }));
    REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    CHECK(group.progress_on_owner().state == core::LoadingState::Completed);
    CHECK(group.progress_on_owner().completed_units == 20);
    CHECK(state.submissions.size() == 20);

    auto leases = group.take_ready_leases_on_owner();
    REQUIRE(leases);
    CHECK(leases->size() == 20);
    manager.stage_candidate_leases_on_owner(std::move(*leases));
    CHECK(manager.has_candidate_leases_on_owner());
    CHECK_FALSE(manager.has_published_leases_on_owner());

    for (const auto& descriptor : requests) {
        CHECK(residency->classification_on_owner(descriptor.cache_key) ==
              assets::ResidencyClass::Pinned);
    }
    const auto& first_texture =
        std::get<assets::TextureAssetRequest>(requests[1].request);
    REQUIRE(manager.leased_texture_on_owner(first_texture));
    manager.commit_candidate_leases_on_owner();
    CHECK_FALSE(manager.has_candidate_leases_on_owner());
    CHECK(manager.has_published_leases_on_owner());
    CHECK_FALSE(residency->evict_on_owner(requests[1].cache_key,
                                         assets::ResidencyEvictionReason::Pressure));

    manager.clear_published_leases_on_owner();
    CHECK_FALSE(manager.has_published_leases_on_owner());
    CHECK(residency->classification_on_owner(requests[1].cache_key) ==
          assets::ResidencyClass::Cold);
}

} // namespace

TEST_CASE("mandatory 20-asset publication matrix is atomic in cooperative execution",
          "[assets][phase-7b][cooperative]")
{
    jobs::CooperativeJobExecutor executor;
    run_twenty_asset_matrix(executor);
    shutdown(executor);
}

TEST_CASE("mandatory 20-asset publication matrix is atomic in threaded execution",
          "[assets][phase-7b][threaded]")
{
    jobs::SdlThreadPoolJobExecutor executor(2);
    run_twenty_asset_matrix(executor);
    shutdown(executor);
}

TEST_CASE("mandatory group retry creates a new loading operation and cancellation is terminal",
          "[assets][phase-7b][retry][cancellation]")
{
    jobs::CooperativeJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget());
    assets::AssetManager manager;
    MatrixState state{.reject_material = true};
    MatrixMaterialLoader materials(state);
    REQUIRE(manager.configure_async_requests(executor, residency));
    manager.bind_material_loader(&materials);
    const auto request = matrix_descriptor(assets::MaterialAssetRequest{.id = "retry-material"},
                                           manager.source_generation_on_owner());
    assets::MandatoryAssetRequestGroup group(manager, {request});
    group.poll_on_owner();
    REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Failed);
    REQUIRE(group.progress_on_owner().state == core::LoadingState::Failed);
    REQUIRE(group.progress_on_owner().retryable);
    const auto failed_operation = group.progress_on_owner().operation;

    state.reject_material = false;
    REQUIRE(group.retry_on_owner());
    CHECK(group.progress_on_owner().operation != failed_operation);
    CHECK(group.progress_on_owner().state == core::LoadingState::Active);
    REQUIRE(drive_until(executor, [&] {
        group.poll_on_owner();
        return group.state_on_owner() == assets::MandatoryAssetGroupState::Ready;
    }));

    assets::MandatoryAssetRequestGroup canceled(manager, {request});
    canceled.cancel_on_owner();
    CHECK(canceled.state_on_owner() == assets::MandatoryAssetGroupState::Canceled);
    CHECK(canceled.progress_on_owner().state == core::LoadingState::Canceled);
    CHECK_FALSE(canceled.retry_on_owner());
    shutdown(executor);
}
