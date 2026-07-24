#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
#include "core/editor_asset_profiler_service.hpp"
#endif

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
    MatrixPreparationTask(T asset, std::size_t* finalized)
        : m_asset(std::move(asset)), m_finalized(finalized)
    {
    }

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
        if (m_finalized != nullptr)
            ++*m_finalized;
        return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::success(
            {.asset = std::move(m_asset),
             .cost = {.prepared_cpu_bytes = 1},
             .destroy_on_owner = {}});
    }

private:
    T m_asset;
    std::size_t* m_finalized = nullptr;
    bool m_ready = false;
};

template<class T>
class MatrixFailingPreparationTask final : public assets::AssetPreparationTask<T> {
public:
    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 1};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "test.matrix_async_failure",
                                 .message = "matrix asynchronous preparation failed"}}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<T>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::failure(
            {{.code = "test.matrix_async_failure_finalize",
              .message = "failed matrix preparation must not finalize"}});
    }
};

struct MatrixState {
    bool reject_material = false;
    std::vector<std::string> submissions;
    std::size_t finalized = 0;
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
            assets::FontAsset{.resolved_alias = request.alias}, &m_state.finalized);
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
            assets::TextureAsset{.handle = 11, .path = request.path, .sampler = request.sampler},
            &m_state.finalized);
    }

private:
    MatrixState& m_state;
};

class RetryingMatrixTextureLoader final : public assets::TextureAssetLoader {
public:
    explicit RetryingMatrixTextureLoader(MatrixState& state) : m_state(state) {}

    assets::AssetLoadResult<assets::TextureAsset>
    load_texture(const assets::TextureAssetRequest& request) override
    {
        return {assets::TextureAsset{.handle = 14, .path = request.path}, {}};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_texture_preparation_task(const assets::TextureAssetRequest& request) override
    {
        m_state.submissions.push_back("texture:" + request.path);
        if (m_attempts++ == 0)
            return std::make_unique<MatrixFailingPreparationTask<assets::TextureAsset>>();
        return std::make_unique<MatrixPreparationTask<assets::TextureAsset>>(
            assets::TextureAsset{.handle = 14, .path = request.path, .sampler = request.sampler},
            &m_state.finalized);
    }

private:
    MatrixState& m_state;
    std::size_t m_attempts = 0;
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
            assets::ShaderProgramAsset{.handle = 12, .key = request.resolution.key},
            &m_state.finalized);
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
            assets::MaterialAsset{.id = request.id}, &m_state.finalized);
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
                               .kind = request.kind},
            &m_state.finalized);
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
assets::StructuredAssetRequestDescriptor matrix_descriptor(Request request,
                                                           assets::AssetSourceGeneration generation)
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
            assets::FontAssetRequest{.alias = "matrix-font-" + std::to_string(index)}, generation));
        requests.push_back(
            matrix_descriptor(assets::TextureAssetRequest{.path = "project:/textures/matrix-" +
                                                                  std::to_string(index) + ".png"},
                              generation));
        requests.push_back(matrix_descriptor(matrix_shader(index), generation));
        requests.push_back(matrix_descriptor(
            assets::MaterialAssetRequest{.id = "matrix-material-" + std::to_string(index)},
            generation));
        requests.push_back(
            matrix_descriptor(assets::AudioAssetRequest{.path = "project:/audio/matrix-" +
                                                                std::to_string(index) + ".ogg",
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
    assets::MandatoryAssetRequestGroup group(manager, requests,
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
    const auto& first_texture = std::get<assets::TextureAssetRequest>(requests[1].request);
    REQUIRE(manager.leased_texture_on_owner(first_texture));
    manager.commit_candidate_leases_on_owner();
    CHECK_FALSE(manager.has_candidate_leases_on_owner());
    CHECK(manager.has_published_leases_on_owner());
    CHECK_FALSE(residency->evict_on_owner(requests[1].cache_key,
                                          assets::ResidencyEvictionReason::BudgetPressure));

    manager.clear_published_leases_on_owner();
    CHECK_FALSE(manager.has_published_leases_on_owner());
    CHECK(residency->classification_on_owner(requests[1].cache_key) ==
          assets::ResidencyClass::Cold);

    assets::MandatoryAssetRequestGroup supplemental_group(manager, {requests[1]});
    REQUIRE(drive_until(executor, [&] {
        supplemental_group.poll_on_owner();
        return supplemental_group.state_on_owner() != assets::MandatoryAssetGroupState::Pending;
    }));
    REQUIRE(supplemental_group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    auto supplemental_leases = supplemental_group.take_ready_leases_on_owner();
    REQUIRE(supplemental_leases);
    manager.set_supplemental_leases_on_owner(std::move(*supplemental_leases));
    CHECK(manager.has_supplemental_leases_on_owner());
    CHECK(manager.leased_texture_on_owner(first_texture));
    CHECK(residency->classification_on_owner(requests[1].cache_key) ==
          assets::ResidencyClass::Pinned);
    manager.clear_supplemental_leases_on_owner();
    CHECK_FALSE(manager.has_supplemental_leases_on_owner());
    CHECK_FALSE(manager.leased_texture_on_owner(first_texture));
    CHECK(residency->classification_on_owner(requests[1].cache_key) ==
          assets::ResidencyClass::Cold);
}

template<class Executor> void run_retry_and_cancellation_matrix(Executor& executor)
{
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget());
    assets::AssetManager manager;
    MatrixState state{.reject_material = true, .submissions = {}, .finalized = 0};
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

    state.reject_material = true;
    const auto fatal_request = matrix_descriptor(
        assets::MaterialAssetRequest{.id = "fatal-material"}, manager.source_generation_on_owner());
    assets::MandatoryAssetRequestGroup fatal(manager, {fatal_request},
                                             {.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                              .reason = assets::AssetRequestReason::Demand,
                                              .overlay_grace = 100ms,
                                              .show_overlay_immediately = false,
                                              .retryable = false});
    fatal.poll_on_owner();
    CHECK(fatal.state_on_owner() == assets::MandatoryAssetGroupState::Failed);
    CHECK(fatal.progress_on_owner().state == core::LoadingState::Failed);
    CHECK_FALSE(fatal.progress_on_owner().retryable);
    CHECK(fatal.overlay_visible_on_owner());
    CHECK_FALSE(fatal.retry_on_owner());
}

template<class Executor> void run_prefetch_outcome_matrix(Executor& executor)
{
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget());
    assets::AssetManager manager;
    MatrixState state;
    MatrixTextureLoader textures(state);
    REQUIRE(manager.configure_async_requests(executor, residency));
    manager.bind_texture_loader(&textures);

    const auto generation = manager.source_generation_on_owner();
    const assets::TextureAssetRequest used{.path = "project:/textures/used.png"};
    const assets::TextureAssetRequest late{.path = "project:/textures/late.png"};
    const assets::TextureAssetRequest unused{.path = "project:/textures/unused.png"};
    const assets::TextureAssetRequest missed{.path = "project:/textures/missed.png"};
    const auto used_descriptor = matrix_descriptor(used, generation);
    const auto late_descriptor = matrix_descriptor(late, generation);
    const auto unused_descriptor = matrix_descriptor(unused, generation);
    const auto missed_descriptor = matrix_descriptor(missed, generation);

    assets::PrefetchPlanner planner(manager);
    assets::StructuredAssetDependencyBuckets speculative;
    speculative.direct_next = {used_descriptor, late_descriptor, unused_descriptor};
    auto prefetched = planner.replace_generation_on_owner(speculative);
    REQUIRE(prefetched);
    CHECK(prefetched.value().direct_next_submitted == 3);

    assets::MandatoryAssetRequestGroup mandatory(manager, {used_descriptor, missed_descriptor},
                                                 {.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                                  .reason = assets::AssetRequestReason::Demand,
                                                  .overlay_grace = 100ms,
                                                  .show_overlay_immediately = true,
                                                  .retryable = true});
    REQUIRE(drive_until(executor, [&] {
        mandatory.poll_on_owner();
        return mandatory.state_on_owner() == assets::MandatoryAssetGroupState::Ready;
    }));
    CHECK(state.finalized == 4);

    auto mandatory_leases = mandatory.take_ready_leases_on_owner();
    REQUIRE(mandatory_leases);
    manager.stage_candidate_leases_on_owner(std::move(*mandatory_leases));
    manager.commit_candidate_leases_on_owner();
    CHECK(residency->classification_on_owner(used_descriptor.cache_key) ==
          assets::ResidencyClass::Pinned);
    CHECK(residency->classification_on_owner(missed_descriptor.cache_key) ==
          assets::ResidencyClass::Pinned);
    CHECK(residency->classification_on_owner(late_descriptor.cache_key) ==
          assets::ResidencyClass::Warm);
    CHECK(residency->classification_on_owner(unused_descriptor.cache_key) ==
          assets::ResidencyClass::Warm);

    auto late_demand = manager.request_texture(late, assets::AssetRequestReason::Demand);
    REQUIRE(late_demand);
    REQUIRE(late_demand.value().state() == assets::AssetRequestState::Ready);
    auto late_lease = std::move(late_demand).value().take_ready();
    REQUIRE(late_lease);
    CHECK(state.finalized == 4);
    CHECK(residency->classification_on_owner(late_descriptor.cache_key) ==
          assets::ResidencyClass::Pinned);

    assets::StructuredAssetDependencyBuckets replacement;
    auto replaced = planner.replace_generation_on_owner(replacement);
    REQUIRE(replaced);
    CHECK(replaced.value().generation != prefetched.value().generation);
    CHECK(residency->classification_on_owner(unused_descriptor.cache_key) ==
          assets::ResidencyClass::Cold);
    CHECK(residency->classification_on_owner(used_descriptor.cache_key) ==
          assets::ResidencyClass::Pinned);
    late_lease->reset();
    CHECK(residency->classification_on_owner(late_descriptor.cache_key) ==
          assets::ResidencyClass::Cold);

    manager.clear_published_leases_on_owner();
    planner.clear_on_owner();
}

} // namespace

TEST_CASE("mandatory 20-asset publication matrix is atomic in cooperative execution",
          "[assets][mandatory-assets][cooperative]")
{
    jobs::CooperativeJobExecutor executor;
    run_twenty_asset_matrix(executor);
    shutdown(executor);
}

TEST_CASE("mandatory 20-asset publication matrix is atomic in threaded execution",
          "[assets][mandatory-assets][threaded]")
{
    jobs::SdlThreadPoolJobExecutor executor(2);
    run_twenty_asset_matrix(executor);
    shutdown(executor);
}

TEST_CASE("mandatory retry and cancellation matrix passes in cooperative execution",
          "[assets][mandatory-assets][cooperative][retry][cancellation]")
{
    jobs::CooperativeJobExecutor executor;
    run_retry_and_cancellation_matrix(executor);
    shutdown(executor);
}

TEST_CASE("mandatory retry and cancellation matrix passes in threaded execution",
          "[assets][mandatory-assets][threaded][retry][cancellation]")
{
    jobs::SdlThreadPoolJobExecutor executor(2);
    run_retry_and_cancellation_matrix(executor);
    shutdown(executor);
}

TEST_CASE("candidate rollback preserves the last valid published lease set",
          "[assets][mandatory-assets][rollback][residency]")
{
    jobs::CooperativeJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget());
    assets::AssetManager manager;
    MatrixState state;
    MatrixTextureLoader textures(state);
    REQUIRE(manager.configure_async_requests(executor, residency));
    manager.bind_texture_loader(&textures);

    const auto generation = manager.source_generation_on_owner();
    const assets::TextureAssetRequest published_request{.path = "project:/textures/published.png"};
    const assets::TextureAssetRequest candidate_request{.path = "project:/textures/candidate.png"};
    const auto published_descriptor = matrix_descriptor(published_request, generation);
    const auto candidate_descriptor = matrix_descriptor(candidate_request, generation);

    assets::MandatoryAssetRequestGroup published_group(manager, {published_descriptor});
    REQUIRE(drive_until(executor, [&] {
        published_group.poll_on_owner();
        return published_group.state_on_owner() == assets::MandatoryAssetGroupState::Ready;
    }));
    auto published_leases = published_group.take_ready_leases_on_owner();
    REQUIRE(published_leases);
    manager.stage_candidate_leases_on_owner(std::move(*published_leases));
    manager.commit_candidate_leases_on_owner();
    REQUIRE(manager.leased_texture_on_owner(published_request));

    assets::MandatoryAssetRequestGroup candidate_group(manager, {candidate_descriptor});
    REQUIRE(drive_until(executor, [&] {
        candidate_group.poll_on_owner();
        return candidate_group.state_on_owner() == assets::MandatoryAssetGroupState::Ready;
    }));
    auto candidate_leases = candidate_group.take_ready_leases_on_owner();
    REQUIRE(candidate_leases);
    manager.stage_candidate_leases_on_owner(std::move(*candidate_leases));
    REQUIRE(manager.leased_texture_on_owner(candidate_request));
    REQUIRE(manager.leased_texture_on_owner(published_request));

    manager.rollback_candidate_leases_on_owner();
    CHECK_FALSE(manager.has_candidate_leases_on_owner());
    CHECK(manager.has_published_leases_on_owner());
    REQUIRE(manager.leased_texture_on_owner(published_request));
    CHECK_FALSE(manager.leased_texture_on_owner(candidate_request));
    CHECK(residency->classification_on_owner(published_descriptor.cache_key) ==
          assets::ResidencyClass::Pinned);
    CHECK(residency->classification_on_owner(candidate_descriptor.cache_key) ==
          assets::ResidencyClass::Cold);

    manager.clear_published_leases_on_owner();
    shutdown(executor);
}

TEST_CASE("prefetch outcome matrix passes in cooperative execution",
          "[assets][mandatory-assets][cooperative][prefetch]")
{
    jobs::CooperativeJobExecutor executor;
    run_prefetch_outcome_matrix(executor);
    shutdown(executor);
}

TEST_CASE("prefetch outcome matrix passes in threaded execution",
          "[assets][mandatory-assets][threaded][prefetch]")
{
    jobs::SdlThreadPoolJobExecutor executor(2);
    run_prefetch_outcome_matrix(executor);
    shutdown(executor);
}

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
TEST_CASE("mandatory asset groups emit exact profiler wait lifecycle records",
          "[assets][mandatory-assets][profiler][wait]")
{
    auto now = assets::MandatoryAssetRequestGroup::Clock::time_point{};
    core::EditorAssetProfilerService profiler([&] { return now; });
    jobs::CooperativeJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget(), &profiler,
                                                                     executor.mode());
    assets::AssetManager manager;
    MatrixState state;
    MatrixTextureLoader textures(state);
    REQUIRE(manager.configure_async_requests(executor, residency, &profiler));
    manager.bind_texture_loader(&textures);

    const auto generation = manager.source_generation_on_owner();
    const auto pending = matrix_descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/wait.png"}, generation);
    now = assets::MandatoryAssetRequestGroup::Clock::time_point{100ns};
    assets::MandatoryAssetRequestGroup group(
        manager, {pending},
        {.phase = core::LoadingPhase::LoadingRuntimeDemand,
         .reason = assets::AssetRequestReason::Demand,
         .overlay_grace = 100ms,
         .show_overlay_immediately = false,
         .retryable = true,
         .presentation_revision = core::PresentationSnapshotRevision::from_number(17)},
        now);
    group.poll_on_owner(now);
    CHECK(group.state_on_owner() == assets::MandatoryAssetGroupState::Pending);
    const auto active = profiler.capture_on_owner();
    CHECK(active.outcomes.asset_wait_count == 0);
    CHECK(std::ranges::none_of(active.retained_changes, [](const auto& change) {
        return std::holds_alternative<core::AssetWaitRecord>(change.payload);
    }));

    executor.pump(10ms);
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    now = assets::MandatoryAssetRequestGroup::Clock::time_point{150ns};
    group.poll_on_owner(now);
    REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    const auto completed = profiler.capture_on_owner();
    CHECK(completed.outcomes.asset_wait_count == 1);
    CHECK(completed.outcomes.asset_wait_time_ns == 50);
    std::vector<core::AssetWaitRecord> completed_waits;
    for (const auto& change : completed.retained_changes) {
        if (const auto* wait = std::get_if<core::AssetWaitRecord>(&change.payload))
            completed_waits.push_back(*wait);
    }
    CHECK(completed_waits.size() == 1);
    if (completed_waits.size() == 1) {
        const auto& completed_wait = completed_waits.front();
        CHECK(completed_wait.operation == group.progress_on_owner().operation);
        CHECK(completed_wait.phase == core::LoadingPhase::LoadingRuntimeDemand);
        CHECK(completed_wait.presentation_revision ==
              core::PresentationSnapshotRevision::from_number(17));
        CHECK(completed_wait.started_at_ns == 100);
        CHECK(completed_wait.duration_ns == 50);
        CHECK(completed_wait.result == core::AssetWaitResult::Completed);
        CHECK(completed_wait.waiting_requests.size() == 1);
        if (completed_wait.waiting_requests.size() == 1) {
            CHECK(completed_wait.waiting_requests.front().cache_key == pending.cache_key);
            CHECK(completed_wait.waiting_requests.front().request_id.valid());
        }
    }

    auto leases = group.take_ready_leases_on_owner();
    REQUIRE(leases);
    manager.set_supplemental_leases_on_owner(std::move(*leases));
    now = assets::MandatoryAssetRequestGroup::Clock::time_point{200ns};
    assets::MandatoryAssetRequestGroup ready_group(manager, {pending}, {}, now);
    ready_group.poll_on_owner(now);
    CHECK(ready_group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    CHECK(profiler.capture_on_owner().outcomes.asset_wait_count == 1);
    const auto after_ready = profiler.capture_on_owner();
    CHECK(std::ranges::count_if(after_ready.retained_changes, [](const auto& change) {
              return std::holds_alternative<core::AssetWaitRecord>(change.payload);
          }) == 1);

    const auto canceled_descriptor = matrix_descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/canceled-wait.png"}, generation);
    now = assets::MandatoryAssetRequestGroup::Clock::now();
    assets::MandatoryAssetRequestGroup canceled(manager, {canceled_descriptor}, {}, now);
    canceled.poll_on_owner(now);
    REQUIRE(canceled.state_on_owner() == assets::MandatoryAssetGroupState::Pending);
    canceled.cancel_on_owner();
    canceled.cancel_on_owner();
    const auto after_cancel = profiler.capture_on_owner();
    CHECK(after_cancel.outcomes.asset_wait_count == 1);
    CHECK(after_cancel.outcomes.asset_wait_time_ns == 50);
    std::vector<core::AssetWaitRecord> final_waits;
    for (const auto& change : after_cancel.retained_changes) {
        if (const auto* wait = std::get_if<core::AssetWaitRecord>(&change.payload))
            final_waits.push_back(*wait);
    }
    CHECK(final_waits.size() == 2);
    if (final_waits.size() == 2)
        CHECK(final_waits.back().result == core::AssetWaitResult::Canceled);

    manager.clear_supplemental_leases_on_owner();
    shutdown(executor);
}

TEST_CASE("mandatory asset retry closes and reopens distinct profiler waits",
          "[assets][mandatory-assets][profiler][wait][retry]")
{
    auto now = assets::MandatoryAssetRequestGroup::Clock::time_point{};
    core::EditorAssetProfilerService profiler([&] { return now; });
    jobs::CooperativeJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(matrix_budget(), &profiler,
                                                                     executor.mode());
    assets::AssetManager manager;
    MatrixState state;
    RetryingMatrixTextureLoader textures(state);
    REQUIRE(manager.configure_async_requests(executor, residency, &profiler));
    manager.bind_texture_loader(&textures);

    const auto descriptor =
        matrix_descriptor(assets::TextureAssetRequest{.path = "project:/textures/retry-wait.png"},
                          manager.source_generation_on_owner());
    now = assets::MandatoryAssetRequestGroup::Clock::time_point{100ns};
    assets::MandatoryAssetRequestGroup group(manager, {descriptor}, {}, now);
    group.poll_on_owner(now);
    const auto failed_operation = group.progress_on_owner().operation;
    executor.pump(10ms);
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    now = assets::MandatoryAssetRequestGroup::Clock::time_point{150ns};
    group.poll_on_owner(now);
    REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Failed);

    auto snapshot = profiler.capture_on_owner();
    std::vector<core::AssetWaitRecord> waits;
    for (const auto& change : snapshot.retained_changes) {
        if (const auto* wait = std::get_if<core::AssetWaitRecord>(&change.payload))
            waits.push_back(*wait);
    }
    REQUIRE(waits.size() == 1);
    CHECK(waits.front().operation == failed_operation);
    CHECK(waits.front().result == core::AssetWaitResult::Failed);
    CHECK(waits.front().duration_ns == 50);
    CHECK(snapshot.outcomes.asset_wait_count == 1);
    CHECK(snapshot.outcomes.asset_wait_time_ns == 50);

    now = assets::MandatoryAssetRequestGroup::Clock::time_point{200ns};
    REQUIRE(group.retry_on_owner(now));
    const auto retry_operation = group.progress_on_owner().operation;
    CHECK(retry_operation != failed_operation);
    CHECK(group.state_on_owner() == assets::MandatoryAssetGroupState::Pending);
    snapshot = profiler.capture_on_owner();
    CHECK(snapshot.outcomes.asset_wait_count == 1);
    group.poll_on_owner(now);
    snapshot = profiler.capture_on_owner();
    CHECK(snapshot.outcomes.asset_wait_count == 1);

    executor.pump(10ms);
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    now = assets::MandatoryAssetRequestGroup::Clock::time_point{260ns};
    group.poll_on_owner(now);
    REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    snapshot = profiler.capture_on_owner();
    waits.clear();
    for (const auto& change : snapshot.retained_changes) {
        if (const auto* wait = std::get_if<core::AssetWaitRecord>(&change.payload))
            waits.push_back(*wait);
    }
    REQUIRE(waits.size() == 2);
    CHECK(waits.back().operation == retry_operation);
    CHECK(waits.back().result == core::AssetWaitResult::Completed);
    CHECK(waits.back().duration_ns == 60);
    CHECK(snapshot.outcomes.asset_wait_count == 2);
    CHECK(snapshot.outcomes.asset_wait_time_ns == 110);

    shutdown(executor);
}
#endif
