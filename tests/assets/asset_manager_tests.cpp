#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
#include "core/editor_asset_profiler_service.hpp"
#endif

#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <thread>

using namespace noveltea::assets;

static AssetBytes asset_bytes(std::string_view text)
{
    return AssetBytes(text.begin(), text.end());
}

static std::shared_ptr<MemoryAssetSource> memory_source(std::string_view path, AssetBytes bytes)
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add(path, std::move(bytes));
    return source;
}

template<class T> class TestLoaderPreparationTask final : public AssetPreparationTask<T> {
public:
    using Loader = std::function<AssetLoadResult<T>()>;

    explicit TestLoaderPreparationTask(Loader loader, ResidencyCost cost = {})
        : m_loader(std::move(loader)), m_cost(cost)
    {
    }

    [[nodiscard]] ResidencyCost estimated_cost_on_owner() const noexcept override { return m_cost; }

    [[nodiscard]] noveltea::jobs::JobStepOutcome
    step(noveltea::jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = noveltea::jobs::JobStepStatus::Completed, .diagnostics = {}};
        m_ready = true;
        return {.status = noveltea::jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] noveltea::core::Result<PreparedAsset<T>, noveltea::core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        if (!m_ready) {
            return noveltea::core::Result<PreparedAsset<T>, noveltea::core::Diagnostics>::failure(
                {{.code = "test.loader_not_ready", .message = "test loader task is not ready"}});
        }
        auto loaded = m_loader();
        if (!loaded) {
            return noveltea::core::Result<PreparedAsset<T>, noveltea::core::Diagnostics>::failure(
                {{.code = "test.loader_failed", .message = std::move(loaded.error)}});
        }
        return noveltea::core::Result<PreparedAsset<T>, noveltea::core::Diagnostics>::success(
            {.asset = std::move(*loaded.value), .cost = m_cost, .destroy_on_owner = {}});
    }

private:
    Loader m_loader;
    ResidencyCost m_cost;
    bool m_ready = false;
};

class ShortReadReader final : public AssetReader {
public:
    [[nodiscard]] AssetResult<std::uint64_t> size() const noexcept override { return {4, {}}; }

    AssetResult<std::size_t> read(void* destination, std::size_t bytes) noexcept override
    {
        if (bytes == 0 || m_read)
            return {std::size_t{0}, {}};
        static constexpr char payload[] = "ab";
        const std::size_t count = std::min<std::size_t>(2, bytes);
        std::memcpy(destination, payload, count);
        m_read = true;
        return {count, {}};
    }

    AssetResult<void> seek(std::int64_t, AssetSeekOrigin) noexcept override
    {
        return {false, AssetSourceError{.code = std::string(asset_source_error_code::seek_failed),
                                        .message = "unsupported test seek",
                                        .logical_path = {},
                                        .source_description = "short-read-source"}};
    }
    [[nodiscard]] AssetResult<std::uint64_t> tell() const noexcept override
    {
        return {m_read ? 2u : 0u, {}};
    }

private:
    bool m_read = false;
};

class ShortReadSource final : public AssetSource {
public:
    [[nodiscard]] AssetResult<AssetEntryMetadata> stat(const AssetPath& path) const override
    {
        if (!exists(path)) {
            return {std::nullopt,
                    AssetSourceError{.code = std::string(asset_source_error_code::not_found),
                                     .message = "missing",
                                     .logical_path = path,
                                     .source_description = describe()}};
        }
        return {AssetEntryMetadata{
                    .uncompressed_size = 4, .compressed_size = std::nullopt, .seekable = false},
                {}};
    }

    [[nodiscard]] bool exists(const AssetPath& path) const override
    {
        return path.logical_path() == "project:/short.bin";
    }

    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override
    {
        if (!exists(path)) {
            return {std::nullopt,
                    AssetSourceError{.code = std::string(asset_source_error_code::not_found),
                                     .message = "missing",
                                     .logical_path = path,
                                     .source_description = describe()}};
        }
        return {std::make_unique<ShortReadReader>(), {}};
    }

    [[nodiscard]] std::string describe() const override { return "short-read-source"; }
    [[nodiscard]] const char* kind() const override { return "test-short-read"; }
};

class FakeFontAssetLoader final : public FontAssetLoader {
public:
    AssetLoadResult<FontAsset> load_font(const FontAssetRequest& request) override
    {
        last_request = request;
        return {FontAsset{.face = noveltea::FontHandle{42},
                          .family = noveltea::FontFamilyHandle{7},
                          .resolved_alias = request.alias.empty() ? "default" : request.alias,
                          .requested_style = request.style,
                          .synthetic_style = request.style},
                {}};
    }

    std::unique_ptr<AssetPreparationTask<FontAsset>>
    create_font_preparation_task(const FontAssetRequest& request) override
    {
        return std::make_unique<TestLoaderPreparationTask<FontAsset>>(
            [this, request]() { return load_font(request); });
    }

    std::optional<FontAssetRequest> last_request;
};

class FakeTextureAssetLoader final : public TextureAssetLoader {
public:
    AssetLoadResult<TextureAsset> load_texture(const TextureAssetRequest& request) override
    {
        ++call_count;
        call_thread = std::this_thread::get_id();
        last_request = request;
        if (fail)
            return {std::nullopt, "test texture load failed"};
        return {TextureAsset{.handle = 11, .path = request.path, .width = 4, .height = 5}, {}};
    }

    std::unique_ptr<AssetPreparationTask<TextureAsset>>
    create_texture_preparation_task(const TextureAssetRequest& request) override
    {
        return std::make_unique<TestLoaderPreparationTask<TextureAsset>>(
            [this, request]() { return load_texture(request); }, cost);
    }

    std::optional<TextureAssetRequest> last_request;
    std::uint64_t call_count = 0;
    std::thread::id call_thread{};
    ResidencyCost cost{};
    bool fail = false;
};

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
class ProfilerResidentControl final : public ResidentAssetControl {
public:
    void assert_owner_thread() const noexcept override {}
    void destroy_on_owner(ResidencyEvictionReason) noexcept override {}
};
#endif

class FakeShaderProgramAssetLoader final : public ShaderProgramAssetLoader {
public:
    AssetLoadResult<ShaderProgramAsset>
    load_shader_program(const ShaderProgramAssetRequest& request) override
    {
        last_request = request;
        return {ShaderProgramAsset{.handle = 12, .key = request.resolution.key}, {}};
    }

    std::unique_ptr<AssetPreparationTask<ShaderProgramAsset>>
    create_shader_program_preparation_task(const ShaderProgramAssetRequest& request) override
    {
        return std::make_unique<TestLoaderPreparationTask<ShaderProgramAsset>>(
            [this, request]() { return load_shader_program(request); });
    }

    std::optional<ShaderProgramAssetRequest> last_request;
};

class FakeMaterialAssetLoader final : public MaterialAssetLoader {
public:
    AssetLoadResult<MaterialAsset> load_material(const MaterialAssetRequest& request) override
    {
        last_request = request;
        return {MaterialAsset{.definition = &material, .id = request.id}, {}};
    }

    std::unique_ptr<AssetPreparationTask<MaterialAsset>>
    create_material_preparation_task(const MaterialAssetRequest& request) override
    {
        return std::make_unique<TestLoaderPreparationTask<MaterialAsset>>(
            [this, request]() { return load_material(request); });
    }

    noveltea::MaterialDefinition material;
    std::optional<MaterialAssetRequest> last_request;
};

class FakeAudioAssetLoader final : public AudioAssetLoader {
public:
    AssetLoadResult<AudioAsset> load_audio(const AudioAssetRequest& request) override
    {
        last_request = request;
        return {AudioAsset{.clip = noveltea::AudioClipHandle{99},
                           .path = request.path,
                           .mode = request.mode,
                           .kind = request.kind},
                {}};
    }

    std::unique_ptr<AssetPreparationTask<AudioAsset>>
    create_audio_preparation_task(const AudioAssetRequest& request) override
    {
        return std::make_unique<TestLoaderPreparationTask<AudioAsset>>(
            [this, request]() { return load_audio(request); });
    }

    std::optional<AudioAssetRequest> last_request;
};

TEST_CASE("AssetManager reports missing mounts and missing assets")
{
    AssetManager manager;
    CHECK_FALSE(manager.read_binary("system:/missing"));
    manager.mount("project", memory_source("project:/exists", {'x'}));
    auto missing = manager.read_binary("missing");
    CHECK_FALSE(missing);
    CHECK(missing.error.code == asset_source_error_code::not_found);
    CHECK(missing.error.message.find("searched:") != std::string::npos);
}

TEST_CASE("AssetManager reports sized-reader short reads without returning partial data")
{
    AssetManager manager;
    manager.mount("project", std::make_shared<ShortReadSource>());

    const auto result = manager.read_binary("project:/short.bin");
    REQUIRE_FALSE(result);
    CHECK(result.error.code == asset_source_error_code::read_failed);
    CHECK(result.error.message.find("short read") != std::string::npos);
    CHECK(result.error.logical_path.logical_path() == "project:/short.bin");
    CHECK(result.error.source_description == "short-read-source");
}

TEST_CASE("AssetManager stores typed project font family config")
{
    AssetManager manager;
    FontAssetConfig config;
    config.default_alias = "body";
    FontFamilyAssetDesc family;
    family.alias = "body";
    family.regular = noveltea::FontDesc{.asset_path = "project:/fonts/body.ttf"};
    family.bold = noveltea::FontDesc{.asset_path = "project:/fonts/body-bold.ttf"};
    family.synthetic_styles = true;
    config.families.push_back(std::move(family));

    manager.configure_fonts(std::move(config));

    CHECK(manager.default_font_alias() == "body");
    REQUIRE(manager.font_config().families.size() == 1);
    CHECK(manager.font_config().families[0].alias == "body");
    CHECK(manager.font_config().families[0].regular.asset_path == "project:/fonts/body.ttf");
    REQUIRE(manager.font_config().families[0].bold);
    CHECK(manager.font_config().families[0].bold->asset_path == "project:/fonts/body-bold.ttf");
}

TEST_CASE("AssetManager async compatibility requests coalesce and finalize on the owner thread")
{
    noveltea::jobs::InlineJobExecutor executor;
    auto residency =
        std::make_shared<AssetResidencyManager>(ResidencyBudget{.source_bytes = 1024,
                                                                .prepared_cpu_bytes = 1024,
                                                                .gpu_bytes = 1024,
                                                                .audio_bytes = 1024,
                                                                .temporary_bytes = 1024});
    FakeTextureAssetLoader loader;
    const auto owner_thread = std::this_thread::get_id();

    {
        AssetManager manager;
        manager.bind_texture_loader(&loader);
        REQUIRE(manager.configure_async_requests(executor, residency));
        const TextureAssetRequest request{.path = "project:/textures/async.png",
                                          .sampler = noveltea::MaterialTextureSampler::ClampLinear};
        auto first_result = manager.request_texture(request, AssetRequestReason::Demand);
        auto second_result = manager.request_texture(request, AssetRequestReason::Startup);
        REQUIRE(first_result);
        REQUIRE(second_result);
        auto first = std::move(first_result).value();
        auto second = std::move(second_result).value();

        CHECK(loader.call_count == 0);
        REQUIRE(executor.run_until_idle(8));
        CHECK(loader.call_count == 1);
        CHECK(loader.call_thread == owner_thread);
        CHECK(first.state() == AssetRequestState::Ready);
        CHECK(second.state() == AssetRequestState::Ready);

        auto first_lease = std::move(first).take_ready();
        auto second_lease = std::move(second).take_ready();
        REQUIRE(first_lease);
        REQUIRE(second_lease);
        CHECK((*first_lease)->handle == 11);
        CHECK((*second_lease)->path == request.path);
        first_lease->reset();
        second_lease->reset();
    }

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
TEST_CASE("AssetManager profiler inventory joins all typed domains with authoritative residency")
{
    noveltea::jobs::InlineJobExecutor executor;
    auto residency =
        std::make_shared<AssetResidencyManager>(ResidencyBudget{.source_bytes = 4096,
                                                                .prepared_cpu_bytes = 4096,
                                                                .gpu_bytes = 4096,
                                                                .audio_bytes = 4096,
                                                                .temporary_bytes = 4096});
    FakeFontAssetLoader font_loader;
    FakeTextureAssetLoader texture_loader;
    FakeShaderProgramAssetLoader shader_loader;
    FakeMaterialAssetLoader material_loader;
    FakeAudioAssetLoader audio_loader;
    texture_loader.cost = {.gpu_bytes = 80, .temporary_bytes = 12};

    {
        AssetManager manager;
        manager.bind_font_loader(&font_loader);
        manager.bind_texture_loader(&texture_loader);
        manager.bind_shader_program_loader(&shader_loader);
        manager.bind_material_loader(&material_loader);
        manager.bind_audio_loader(&audio_loader);
        REQUIRE(manager.configure_async_requests(executor, residency));
        noveltea::core::EditorAssetProfilerService profiler;
        profiler.set_inventory_provider(manager);
        const auto capture_inventory = [&] {
            profiler.record_inventory_maybe_changed();
            return profiler.capture_on_owner().assets;
        };

        const TextureAssetRequest texture_request{
            .path = "project:/images/hero.png",
            .sampler = noveltea::MaterialTextureSampler::ClampLinear};
        const auto generation = manager.create_prefetch_generation_on_owner();
        REQUIRE(generation);
        auto texture = manager.prefetch_texture(texture_request, generation.value());
        auto font = manager.request_font({.alias = "body", .style = noveltea::TextFontBold},
                                         AssetRequestReason::Demand);
        ShaderProgramAssetRequest shader_request;
        shader_request.resolution.key.material_id = "materials/hero";
        shader_request.resolution.key.variant = "default";
        auto shader = manager.request_shader_program(shader_request, AssetRequestReason::Startup);
        auto material =
            manager.request_material({.id = "materials/hero"}, AssetRequestReason::Demand);
        auto audio = manager.request_audio({.path = "project:/audio/theme.ogg",
                                            .mode = noveltea::AudioLoadMode::Stream,
                                            .kind = noveltea::AudioClipKind::Music},
                                           AssetRequestReason::Demand);
        REQUIRE(texture);
        REQUIRE(font);
        REQUIRE(shader);
        REQUIRE(material);
        REQUIRE(audio);
        auto texture_ticket = std::move(texture).value();
        auto font_handle = std::move(font).value();
        auto shader_handle = std::move(shader).value();
        auto material_handle = std::move(material).value();
        auto audio_handle = std::move(audio).value();
        REQUIRE(executor.run_until_idle(32));
        REQUIRE(font_handle.state() == AssetRequestState::Ready);
        REQUIRE(shader_handle.state() == AssetRequestState::Ready);
        REQUIRE(material_handle.state() == AssetRequestState::Ready);
        REQUIRE(audio_handle.state() == AssetRequestState::Ready);

        auto inventory = capture_inventory();
        REQUIRE(inventory.size() == 5);
        const auto find_type = [&](noveltea::core::AssetProfilerAssetType type) -> const auto& {
            const auto found =
                std::find_if(inventory.begin(), inventory.end(),
                             [type](const auto& row) { return row.asset_type == type; });
            REQUIRE(found != inventory.end());
            return *found;
        };
        const auto& image = find_type(noveltea::core::AssetProfilerAssetType::Image);
        CHECK(image.state == noveltea::core::AssetProfilerState::Prefetched);
        REQUIRE(image.committed_cost.has_value());
        CHECK(image.committed_cost->gpu_bytes == 80);
        CHECK(image.display_identity == "project:/images/hero.png");
        CHECK(image.removable);
        const auto image_key = image.cache_key;
        CHECK(find_type(noveltea::core::AssetProfilerAssetType::Font).state ==
              noveltea::core::AssetProfilerState::InUse);
        CHECK(find_type(noveltea::core::AssetProfilerAssetType::Shader).request_origin ==
              noveltea::core::AssetProfilerRequestOrigin::Startup);
        CHECK(find_type(noveltea::core::AssetProfilerAssetType::Material).display_identity ==
              "materials/hero");
        CHECK(find_type(noveltea::core::AssetProfilerAssetType::Audio).display_identity ==
              "project:/audio/theme.ogg");

        auto font_lease = std::move(font_handle).take_ready();
        auto shader_lease = std::move(shader_handle).take_ready();
        auto material_lease = std::move(material_handle).take_ready();
        auto audio_lease = std::move(audio_handle).take_ready();
        REQUIRE(font_lease);
        REQUIRE(shader_lease);
        REQUIRE(material_lease);
        REQUIRE(audio_lease);
        shader_lease->reset();
        material_lease->reset();
        audio_lease->reset();

        inventory = capture_inventory();
        CHECK(std::ranges::count_if(inventory, [](const auto& row) {
                  return row.state == noveltea::core::AssetProfilerState::Cached;
              }) == 3);

        texture_ticket.reset();
        CHECK(residency->evict_on_owner(image_key, ResidencyEvictionReason::BudgetPressure));
        inventory = capture_inventory();
        CHECK(std::ranges::none_of(inventory,
                                   [&](const auto& row) { return row.cache_key == image_key; }));

        texture_loader.fail = true;
        auto failed_reload = manager.request_texture(texture_request, AssetRequestReason::Demand);
        REQUIRE(failed_reload);
        auto failed_reload_handle = std::move(failed_reload).value();
        REQUIRE(executor.run_until_idle(16));
        CHECK(failed_reload_handle.state() == AssetRequestState::Failed);
        inventory = capture_inventory();
        const auto failed_image =
            std::find_if(inventory.begin(), inventory.end(),
                         [&](const auto& row) { return row.cache_key == image_key; });
        REQUIRE(failed_image != inventory.end());
        CHECK(failed_image->state == noveltea::core::AssetProfilerState::Failed);
        CHECK(failed_image->reload_count == 0);

        texture_loader.fail = false;
        auto texture_reload = manager.request_texture(texture_request, AssetRequestReason::Demand);
        REQUIRE(texture_reload);
        auto texture_reload_handle = std::move(texture_reload).value();
        REQUIRE(executor.run_until_idle(16));
        REQUIRE(texture_reload_handle.state() == AssetRequestState::Ready);
        auto texture_reload_lease = std::move(texture_reload_handle).take_ready();
        REQUIRE(texture_reload_lease);
        inventory = capture_inventory();
        const auto reloaded_image =
            std::find_if(inventory.begin(), inventory.end(),
                         [&](const auto& row) { return row.cache_key == image_key; });
        REQUIRE(reloaded_image != inventory.end());
        CHECK(reloaded_image->state == noveltea::core::AssetProfilerState::InUse);
        CHECK(reloaded_image->reload_count == 1);
        texture_reload_lease->reset();

        CHECK(residency->evict_on_owner(image_key, ResidencyEvictionReason::ExplicitRelease));
        auto explicit_reload = manager.request_texture(texture_request, AssetRequestReason::Demand);
        REQUIRE(explicit_reload);
        auto explicit_reload_handle = std::move(explicit_reload).value();
        REQUIRE(executor.run_until_idle(16));
        auto explicit_reload_lease = std::move(explicit_reload_handle).take_ready();
        REQUIRE(explicit_reload_lease);
        inventory = capture_inventory();
        const auto explicitly_reloaded_image =
            std::find_if(inventory.begin(), inventory.end(),
                         [&](const auto& row) { return row.cache_key == image_key; });
        REQUIRE(explicitly_reloaded_image != inventory.end());
        CHECK(explicitly_reloaded_image->reload_count == 1);
        explicit_reload_lease->reset();

        const auto old_font_key = font_lease->cache_key();
        manager.mount("project", std::make_shared<MemoryAssetSource>());
        inventory = capture_inventory();
        CHECK(std::ranges::none_of(inventory,
                                   [&](const auto& row) { return row.cache_key == image_key; }));
        const auto old_font =
            std::find_if(inventory.begin(), inventory.end(),
                         [&](const auto& row) { return row.cache_key == old_font_key; });
        REQUIRE(old_font != inventory.end());
        CHECK(old_font->state == noveltea::core::AssetProfilerState::InUse);

        auto replacement_generation_texture =
            manager.request_texture(texture_request, AssetRequestReason::Demand);
        REQUIRE(replacement_generation_texture);
        auto replacement_generation_handle = std::move(replacement_generation_texture).value();
        REQUIRE(executor.run_until_idle(16));
        auto replacement_generation_lease = std::move(replacement_generation_handle).take_ready();
        REQUIRE(replacement_generation_lease);
        const auto replacement_generation_key = replacement_generation_lease->cache_key();
        CHECK(replacement_generation_key.source_generation != image_key.source_generation);
        inventory = capture_inventory();
        const auto replacement_generation_row =
            std::find_if(inventory.begin(), inventory.end(), [&](const auto& row) {
                return row.cache_key == replacement_generation_key;
            });
        REQUIRE(replacement_generation_row != inventory.end());
        CHECK(replacement_generation_row->reload_count == 0);
        replacement_generation_lease->reset();

        font_lease->reset();
        inventory = capture_inventory();
        CHECK(std::ranges::none_of(inventory,
                                   [&](const auto& row) { return row.cache_key == old_font_key; }));
    }

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}

TEST_CASE("AssetManager profiler inventory exposes in-flight and resident-only typed assets")
{
    noveltea::jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<AssetResidencyManager>(ResidencyBudget{
        .source_bytes = 4096,
        .prepared_cpu_bytes = 4096,
        .gpu_bytes = 4096,
        .audio_bytes = 4096,
        .temporary_bytes = 4096,
    });
    FakeTextureAssetLoader texture_loader;
    texture_loader.cost = {.gpu_bytes = 64, .temporary_bytes = 24};

    AssetManager manager;
    manager.bind_texture_loader(&texture_loader);
    REQUIRE(manager.configure_async_requests(executor, residency));
    noveltea::core::EditorAssetProfilerService profiler;
    profiler.set_inventory_provider(manager);
    const auto capture_inventory = [&] {
        profiler.record_inventory_maybe_changed();
        return profiler.capture_on_owner().assets;
    };

    const TextureAssetRequest request{.path = "project:/images/pending.png",
                                      .sampler = noveltea::MaterialTextureSampler::ClampLinear};
    auto requested = manager.request_texture(request, AssetRequestReason::Demand);
    REQUIRE(requested);
    auto handle = std::move(requested).value();

    auto inventory = capture_inventory();
    REQUIRE(inventory.size() == 1);
    CHECK(inventory.front().state == noveltea::core::AssetProfilerState::Loading);
    CHECK(inventory.front().loading_memory_bytes == 24);

    REQUIRE(executor.advance_one_step());
    inventory = capture_inventory();
    REQUIRE(inventory.size() == 1);
    CHECK(inventory.front().state == noveltea::core::AssetProfilerState::Finishing);

    REQUIRE(executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max()) == 1);
    auto lease = std::move(handle).take_ready();
    REQUIRE(lease);
    lease->reset();

    const AssetCacheKey resident_only_key{
        .stable_identity = "texture|project:/images/resident-only.png|0",
        .source_generation = manager.source_generation_on_owner(),
    };
    auto admitted = residency->admit_on_owner(
        {.cache_key = resident_only_key,
         .reason = AssetRequestReason::Startup,
         .profiler_request_origin = AssetRequestReason::Startup,
         .profiler_reload_count = 2,
         .estimated_cost = {.gpu_bytes = 96},
         .resident_control = std::make_shared<ProfilerResidentControl>()});
    REQUIRE(admitted.admission == ResidencyAdmission::Admitted);

    inventory = capture_inventory();
    const auto resident_only =
        std::find_if(inventory.begin(), inventory.end(),
                     [&](const auto& row) { return row.cache_key == resident_only_key; });
    REQUIRE(resident_only != inventory.end());
    CHECK(resident_only->asset_type == noveltea::core::AssetProfilerAssetType::Image);
    CHECK(resident_only->display_identity == "project:/images/resident-only.png");
    CHECK(resident_only->state == noveltea::core::AssetProfilerState::Cached);
    CHECK(resident_only->request_origin == noveltea::core::AssetProfilerRequestOrigin::Startup);
    CHECK(resident_only->reload_count == 2);
    REQUIRE(resident_only->committed_cost.has_value());
    CHECK(resident_only->committed_cost->gpu_bytes == 96);
    CHECK(resident_only->removable);

    CHECK(residency->evict_on_owner(resident_only_key, ResidencyEvictionReason::ExplicitRelease));

    const TextureAssetRequest prefetched_request{.path = "project:/images/prefetched-origin.png",
                                                 .sampler =
                                                     noveltea::MaterialTextureSampler::ClampLinear};
    const auto generation = manager.create_prefetch_generation_on_owner();
    REQUIRE(generation);
    auto prefetched = manager.prefetch_texture(prefetched_request, generation.value());
    REQUIRE(prefetched);
    auto prefetch_ticket = std::move(prefetched).value();
    auto demanded = manager.request_texture(prefetched_request, AssetRequestReason::Demand);
    REQUIRE(demanded);
    auto demand_handle = std::move(demanded).value();
    inventory = capture_inventory();
    const auto prefetched_origin =
        std::find_if(inventory.begin(), inventory.end(), [&](const auto& row) {
            return row.display_identity == prefetched_request.path;
        });
    REQUIRE(prefetched_origin != inventory.end());
    CHECK(prefetched_origin->request_origin ==
          noveltea::core::AssetProfilerRequestOrigin::Prefetched);
    REQUIRE(executor.run_until_idle(16));
    auto demand_lease = std::move(demand_handle).take_ready();
    REQUIRE(demand_lease);
    const auto prefetched_key = demand_lease->cache_key();
    demand_lease->reset();
    prefetch_ticket.reset();
    CHECK(residency->evict_on_owner(prefetched_key, ResidencyEvictionReason::ExplicitRelease));

    const TextureAssetRequest canceled_request{.path = "project:/images/canceled.png",
                                               .sampler =
                                                   noveltea::MaterialTextureSampler::ClampLinear};
    auto canceled = manager.request_texture(canceled_request, AssetRequestReason::Demand);
    REQUIRE(canceled);
    auto canceled_handle = std::move(canceled).value();
    canceled_handle.reset();
    REQUIRE(executor.run_until_idle(16));
    inventory = capture_inventory();
    CHECK(std::ranges::none_of(
        inventory, [&](const auto& row) { return row.display_identity == canceled_request.path; }));

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}
#endif

TEST_CASE("AssetManager parses and resolves typed resource aliases")
{
    AssetManager manager;
    manager.mount("project", memory_source("project:/resources/aliases.json", asset_bytes(R"({
        "resources": {
          "audio": {
            "ui.notification": { "path": "project:/audio/notification.mp3", "kind": "sfx", "load": "decode" }
          },
          "textures": {
            "bg.school": { "path": "project:/images/bg/school.png", "sampler": "repeat_linear" }
          },
          "materials": {
            "ui.glow": { "id": "materials/ui_glow" }
          }
        }
    })")));

    auto aliases = manager.load_resource_aliases("project:/resources/aliases.json");
    REQUIRE(aliases);
    auto audio_request = manager.resolve_audio_alias("ui.notification");
    REQUIRE(audio_request);
    CHECK(audio_request->path == "project:/audio/notification.mp3");
    CHECK(audio_request->kind == noveltea::AudioClipKind::Sfx);
    CHECK(audio_request->mode == noveltea::AudioLoadMode::Decode);

    const auto texture_request = manager.resource_aliases().texture_request("bg.school");
    REQUIRE(texture_request);
    CHECK(texture_request->path == "project:/images/bg/school.png");
    CHECK(texture_request->sampler == noveltea::MaterialTextureSampler::RepeatLinear);

    const auto material_request = manager.resource_aliases().material_request("ui.glow");
    REQUIRE(material_request);
    CHECK(material_request->id == "materials/ui_glow");
}

TEST_CASE("AssetManager uses first mounted source that contains the asset")
{
    AssetManager manager;
    manager.mount("project", memory_source("project:/same", {'1'}));
    manager.mount("project", memory_source("project:/same", {'2'}));
    auto blob = manager.read_binary("same");
    REQUIRE(blob);
    CHECK(blob.value->bytes == AssetBytes{'1'});
}

TEST_CASE("AssetManager namespace replacement is reversible")
{
    AssetManager manager;
    auto original = std::make_shared<MemoryAssetSource>();
    original->add("value.txt", AssetBytes{'o', 'l', 'd'}, "original");
    manager.mount("project", original);

    auto replacement = std::make_shared<MemoryAssetSource>();
    replacement->add("value.txt", AssetBytes{'n', 'e', 'w'}, "replacement");
    auto previous = manager.replace_namespace("project", {replacement});

    REQUIRE(previous.size() == 1);
    auto current = manager.read_text("project:/value.txt");
    REQUIRE(current);
    CHECK(*current.value == "new");

    auto displaced = manager.replace_namespace("project", std::move(previous));
    REQUIRE(displaced.size() == 1);
    current = manager.read_text("project:/value.txt");
    REQUIRE(current);
    CHECK(*current.value == "old");
}

TEST_CASE("AssetManager reads binary, text, and streams without native paths")
{
    AssetManager manager;
    manager.mount("project", memory_source("project:/hello.txt", {'h', 'i'}));
    auto text = manager.read_text("hello.txt");
    REQUIRE(text);
    CHECK(*text.value == "hi");
    auto opened = manager.open("hello.txt");
    REQUIRE(opened);
    const auto size = (*opened.value)->size();
    REQUIRE(size);
    CHECK(*size.value == 2);
}
