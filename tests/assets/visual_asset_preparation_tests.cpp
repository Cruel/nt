#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"
#include "noveltea/text/text_asset_loader.hpp"
#include "render/bgfx/bgfx_typed_asset_loader.hpp"
#include "text/text_engine.hpp"

#include <atomic>
#include <chrono>
#include <cstring>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

assets::AssetBytes one_pixel_png()
{
    return {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
            0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
}

assets::ResidencyBudget generous_budget()
{
    return {.source_bytes = 16u * 1024u * 1024u,
            .prepared_cpu_bytes = 16u * 1024u * 1024u,
            .gpu_bytes = 16u * 1024u * 1024u,
            .audio_bytes = 16u * 1024u * 1024u,
            .temporary_bytes = 16u * 1024u * 1024u};
}

template<class Predicate> bool drive_until(jobs::InlineJobExecutor& executor, Predicate predicate)
{
    for (std::size_t iteration = 0; iteration < 1024; ++iteration) {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
        if (!executor.advance_one_step())
            return predicate();
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::CooperativeJobExecutor& executor, Predicate predicate)
{
    for (std::size_t iteration = 0; iteration < 1024; ++iteration) {
        executor.pump(5ms);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::SdlThreadPoolJobExecutor& executor, Predicate predicate)
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

void shutdown(jobs::InlineJobExecutor& executor)
{
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
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

struct PreparationProbe {
    std::thread::id owner_thread;
    std::atomic<std::uint64_t> finalizations = 0;
    std::atomic<std::uint64_t> destructions = 0;
    std::atomic<bool> wrong_owner_thread = false;
    std::atomic<std::uint64_t> prepared_bytes = 0;
    std::thread::id source_read_thread;
};

class RecordingAssetReader final : public assets::AssetReader {
public:
    RecordingAssetReader(assets::AssetBytes bytes, std::shared_ptr<PreparationProbe> probe)
        : m_bytes(std::move(bytes)), m_probe(std::move(probe))
    {
    }

    assets::AssetResult<std::uint64_t> size() const noexcept override
    {
        return {m_bytes.size(), {}};
    }

    assets::AssetResult<std::size_t> read(void* destination, std::size_t bytes) noexcept override
    {
        m_probe->source_read_thread = std::this_thread::get_id();
        const std::size_t count = std::min(bytes, m_bytes.size() - m_offset);
        if (count != 0)
            std::memcpy(destination, m_bytes.data() + m_offset, count);
        m_offset += count;
        return {count, {}};
    }

    assets::AssetResult<void> seek(std::int64_t offset,
                                   assets::AssetSeekOrigin origin) noexcept override
    {
        std::int64_t base = 0;
        if (origin == assets::AssetSeekOrigin::Current)
            base = static_cast<std::int64_t>(m_offset);
        else if (origin == assets::AssetSeekOrigin::End)
            base = static_cast<std::int64_t>(m_bytes.size());
        const std::int64_t next = base + offset;
        if (next < 0 || static_cast<std::uint64_t>(next) > m_bytes.size()) {
            return {false,
                    {.code = std::string(assets::asset_source_error_code::seek_failed),
                     .message = "test seek is out of range",
                     .source_description = "recording-source"}};
        }
        m_offset = static_cast<std::size_t>(next);
        return {true, {}};
    }

    assets::AssetResult<std::uint64_t> tell() const noexcept override { return {m_offset, {}}; }

private:
    assets::AssetBytes m_bytes;
    std::shared_ptr<PreparationProbe> m_probe;
    std::size_t m_offset = 0;
};

class RecordingAssetSource final : public assets::AssetSource {
public:
    RecordingAssetSource(std::string path, assets::AssetBytes bytes,
                         std::shared_ptr<PreparationProbe> probe)
        : m_path(std::move(path)), m_bytes(std::move(bytes)), m_probe(std::move(probe))
    {
    }

    assets::AssetResult<assets::AssetEntryMetadata>
    stat(const assets::AssetPath& path) const override
    {
        if (!exists(path)) {
            return {std::nullopt,
                    {.code = std::string(assets::asset_source_error_code::not_found),
                     .message = "missing test asset",
                     .logical_path = path,
                     .source_description = describe()}};
        }
        return {assets::AssetEntryMetadata{.uncompressed_size = m_bytes.size(),
                                           .compressed_size = std::nullopt,
                                           .seekable = true},
                {}};
    }

    bool exists(const assets::AssetPath& path) const override
    {
        return path.relative_path() == m_path;
    }

    assets::AssetResult<assets::AssetReaderPtr> open(const assets::AssetPath& path) const override
    {
        if (!exists(path)) {
            return {std::nullopt,
                    {.code = std::string(assets::asset_source_error_code::not_found),
                     .message = "missing test asset",
                     .logical_path = path,
                     .source_description = describe()}};
        }
        return {std::make_unique<RecordingAssetReader>(m_bytes, m_probe), {}};
    }

    std::string describe() const override { return "recording-source"; }
    const char* kind() const override { return "test-recording"; }

private:
    std::string m_path;
    assets::AssetBytes m_bytes;
    std::shared_ptr<PreparationProbe> m_probe;
};

class TestTextureLoader final : public assets::TextureAssetLoader,
                                public bgfx_backend::TexturePreparationOwner {
public:
    TestTextureLoader(const assets::AssetManager& assets, std::shared_ptr<PreparationProbe> probe)
        : m_assets(assets), m_probe(std::move(probe))
    {
    }

    assets::AssetLoadResult<assets::TextureAsset>
    load_texture(const assets::TextureAssetRequest&) override
    {
        return {std::nullopt, "synchronous texture loading is not used by this test loader"};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_texture_preparation_task(const assets::TextureAssetRequest& request) override
    {
        return std::make_unique<bgfx_backend::TexturePreparationTask>(m_assets, *this, request);
    }

    core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>
    finalize_texture_on_owner(bgfx_backend::PreparedTextureUpload prepared) noexcept override
    {
        if (std::this_thread::get_id() != m_probe->owner_thread)
            m_probe->wrong_owner_thread.store(true, std::memory_order_relaxed);
        m_probe->finalizations.fetch_add(1, std::memory_order_relaxed);
        m_probe->prepared_bytes.store(prepared.bytes.size(), std::memory_order_relaxed);
        auto probe = m_probe;
        return core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>::
            success({.asset = assets::TextureAsset{.handle = 71,
                                                   .path = std::move(prepared.request.path),
                                                   .width = prepared.width,
                                                   .height = prepared.height,
                                                   .sampler = prepared.request.sampler,
                                                   .mip_count = prepared.mip_count},
                     .cost = {.gpu_bytes = prepared.bytes.size()},
                     .destroy_on_owner = [probe = std::move(probe)](assets::TextureAsset&) {
                         if (std::this_thread::get_id() != probe->owner_thread)
                             probe->wrong_owner_thread.store(true, std::memory_order_relaxed);
                         probe->destructions.fetch_add(1, std::memory_order_relaxed);
                     }});
    }

private:
    const assets::AssetManager& m_assets;
    std::shared_ptr<PreparationProbe> m_probe;
};

class TestShaderMaterialLoader final : public assets::ShaderProgramAssetLoader,
                                       public assets::MaterialAssetLoader,
                                       public bgfx_backend::ShaderMaterialPreparationOwner {
public:
    TestShaderMaterialLoader(const assets::AssetManager& assets,
                             std::shared_ptr<PreparationProbe> probe)
        : m_assets(assets), m_probe(std::move(probe))
    {
        m_material.id = *parse_material_id("demo/material").id;
        m_material.shader = *parse_shader_id("demo/shader").id;
        m_material.uniforms.push_back({.name = "u_amount", .value = 1.0f});
        m_material.textures.push_back(
            {.sampler = "s_source", .source = "project:/textures/source.png"});
    }

    assets::AssetLoadResult<assets::ShaderProgramAsset>
    load_shader_program(const assets::ShaderProgramAssetRequest&) override
    {
        return {std::nullopt, "synchronous shader loading is not used by this test loader"};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::ShaderProgramAsset>>
    create_shader_program_preparation_task(
        const assets::ShaderProgramAssetRequest& request) override
    {
        return std::make_unique<
            bgfx_backend::ShaderMaterialPreparationTask<assets::ShaderProgramAsset>>(
            m_assets, *this, request);
    }

    assets::AssetLoadResult<assets::MaterialAsset>
    load_material(const assets::MaterialAssetRequest&) override
    {
        return {std::nullopt, "synchronous material loading is not used by this test loader"};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::MaterialAsset>>
    create_material_preparation_task(const assets::MaterialAssetRequest& request) override
    {
        return std::make_unique<bgfx_backend::ShaderMaterialPreparationTask<assets::MaterialAsset>>(
            *this, request, m_material);
    }

    core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>
    finalize_shader_program_on_owner(bgfx_backend::PreparedShaderProgram prepared) noexcept override
    {
        owner_finalize(prepared.vertex_bytes.size() + prepared.fragment_bytes.size());
        auto probe = m_probe;
        return core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>::
            success({.asset =
                         assets::ShaderProgramAsset{
                             .handle = 72, .key = std::move(prepared.request.resolution.key)},
                     .cost = {.gpu_bytes =
                                  prepared.vertex_bytes.size() + prepared.fragment_bytes.size()},
                     .destroy_on_owner = [probe = std::move(probe)](assets::ShaderProgramAsset&) {
                         probe->destructions.fetch_add(1, std::memory_order_relaxed);
                     }});
    }

    core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>
    finalize_material_on_owner(assets::MaterialAssetRequest request, MaterialDefinition material,
                               std::uint64_t prepared_cpu_bytes) noexcept override
    {
        owner_finalize(prepared_cpu_bytes);
        auto* definition = new MaterialDefinition(std::move(material));
        auto probe = m_probe;
        return core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>::
            success({.asset = assets::MaterialAsset{.definition = definition,
                                                    .id = std::move(request.id)},
                     .cost = {.prepared_cpu_bytes = prepared_cpu_bytes},
                     .destroy_on_owner = [probe = std::move(probe)](assets::MaterialAsset& asset) {
                         delete asset.definition;
                         asset.definition = nullptr;
                         probe->destructions.fetch_add(1, std::memory_order_relaxed);
                     }});
    }

private:
    void owner_finalize(std::uint64_t bytes) noexcept
    {
        if (std::this_thread::get_id() != m_probe->owner_thread)
            m_probe->wrong_owner_thread.store(true, std::memory_order_relaxed);
        m_probe->finalizations.fetch_add(1, std::memory_order_relaxed);
        m_probe->prepared_bytes.fetch_add(bytes, std::memory_order_relaxed);
    }

    const assets::AssetManager& m_assets;
    std::shared_ptr<PreparationProbe> m_probe;
    MaterialDefinition m_material;
};

class TestFontLoader final : public assets::FontAssetLoader,
                             public text::FontSourcePreparationOwner {
public:
    TestFontLoader(const assets::AssetManager& assets, std::shared_ptr<PreparationProbe> probe)
        : m_assets(assets), m_probe(std::move(probe))
    {
    }

    assets::AssetLoadResult<assets::FontAsset> load_font(const assets::FontAssetRequest&) override
    {
        return {std::nullopt, "synchronous font loading is not used by this test loader"};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::FontAsset>>
    create_font_preparation_task(const assets::FontAssetRequest& request) override
    {
        FontFamilyDesc family;
        family.alias = request.alias;
        family.regular = FontDesc{.asset_path = "project:/fonts/regular.ttf"};
        family.bold = FontDesc{.asset_path = "project:/fonts/bold.ttf"};
        return std::make_unique<text::FontSourcePreparationTask>(m_assets, *this, request,
                                                                 std::move(family));
    }

    core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>
    finalize_font_source_on_owner(assets::FontAssetRequest request,
                                  text::PreparedFontSource prepared) noexcept override
    {
        if (std::this_thread::get_id() != m_probe->owner_thread)
            m_probe->wrong_owner_thread.store(true, std::memory_order_relaxed);
        m_probe->finalizations.fetch_add(1, std::memory_order_relaxed);
        const auto bytes = prepared.total_source_bytes();
        m_probe->prepared_bytes.store(bytes, std::memory_order_relaxed);
        auto probe = m_probe;
        return core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>::success(
            {.asset = assets::FontAsset{.face = FontHandle{73},
                                        .family = FontFamilyHandle{74},
                                        .resolved_alias = std::move(request.alias),
                                        .requested_style = request.style},
             .cost = {.source_bytes = bytes},
             .destroy_on_owner = [probe = std::move(probe)](assets::FontAsset&) {
                 probe->destructions.fetch_add(1, std::memory_order_relaxed);
             }});
    }

private:
    const assets::AssetManager& m_assets;
    std::shared_ptr<PreparationProbe> m_probe;
};

template<class Executor> void run_texture_executor_contract(Executor& executor)
{
    auto probe = std::make_shared<PreparationProbe>();
    probe->owner_thread = std::this_thread::get_id();
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());

    {
        assets::AssetManager manager;
        auto source =
            std::make_shared<RecordingAssetSource>("textures/one.png", one_pixel_png(), probe);
        manager.mount("project", source);
        TestTextureLoader loader(manager, probe);
        manager.bind_texture_loader(&loader);
        REQUIRE(manager.configure_async_requests(executor, residency));

        const assets::TextureAssetRequest request{
            .path = "project:/textures/one.png",
            .sampler = MaterialTextureSampler::ClampLinear,
        };
        auto requested = manager.request_texture(request, assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Ready; }));
        CHECK(probe->finalizations.load(std::memory_order_relaxed) == 1);
        CHECK_FALSE(probe->wrong_owner_thread.load(std::memory_order_relaxed));
        CHECK(probe->prepared_bytes.load(std::memory_order_relaxed) == 4);
        if (executor.mode() == jobs::JobExecutionMode::Threaded)
            CHECK(probe->source_read_thread != probe->owner_thread);
        else
            CHECK(probe->source_read_thread == probe->owner_thread);

        auto lease = std::move(handle).take_ready();
        REQUIRE(lease);
        CHECK((*lease)->width == 1);
        CHECK((*lease)->height == 1);
        CHECK((*lease)->mip_count == 1);
        const auto cache_key = lease->cache_key();
        lease->reset();
        CHECK(
            residency->evict_on_owner(cache_key, assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(probe->destructions.load(std::memory_order_relaxed) == 1);

        auto reload_result = manager.request_texture(request, assets::AssetRequestReason::Demand);
        REQUIRE(reload_result);
        auto reload = std::move(reload_result).value();
        REQUIRE(drive_until(executor,
                            [&] { return reload.state() == assets::AssetRequestState::Ready; }));
        CHECK(probe->finalizations.load(std::memory_order_relaxed) == 2);
        auto reloaded_lease = std::move(reload).take_ready();
        REQUIRE(reloaded_lease);
        reloaded_lease->reset();
        CHECK(residency->evict_on_owner(
            assets::make_texture_cache_key(request, manager.source_generation_on_owner()),
            assets::ResidencyEvictionReason::ExplicitRelease));
    }
    shutdown(executor);
}

TEST_CASE("Texture preparation task obeys inline cooperative and threaded executor contracts")
{
    SECTION("inline")
    {
        jobs::InlineJobExecutor executor;
        run_texture_executor_contract(executor);
    }
    SECTION("cooperative")
    {
        jobs::CooperativeJobExecutor executor;
        run_texture_executor_contract(executor);
    }
    SECTION("SDL thread pool")
    {
        jobs::SdlThreadPoolJobExecutor executor(1);
        run_texture_executor_contract(executor);
    }
}

TEST_CASE("Concrete shader material and font-source preparation tasks expose typed residency costs")
{
    jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());
    auto shader_probe = std::make_shared<PreparationProbe>();
    auto font_probe = std::make_shared<PreparationProbe>();
    shader_probe->owner_thread = std::this_thread::get_id();
    font_probe->owner_thread = std::this_thread::get_id();

    {
        assets::AssetManager manager;
        auto source = std::make_shared<assets::MemoryAssetSource>();
        source->add("shaders/demo.vs.bin", {1, 2, 3, 4});
        source->add("shaders/demo.fs.bin", {5, 6, 7});
        source->add("fonts/regular.ttf", {10, 11, 12, 13, 14});
        source->add("fonts/bold.ttf", {20, 21, 22});
        manager.mount("project", source);

        TestShaderMaterialLoader shader_loader(manager, shader_probe);
        TestFontLoader font_loader(manager, font_probe);
        manager.bind_shader_program_loader(&shader_loader);
        manager.bind_material_loader(&shader_loader);
        manager.bind_font_loader(&font_loader);
        REQUIRE(manager.configure_async_requests(executor, residency));

        assets::ShaderProgramAssetRequest shader_request;
        shader_request.resolution.key.material_id = "demo/material";
        shader_request.resolution.key.variant = "test";
        shader_request.resolution.vertex.path = "project:/shaders/demo.vs.bin";
        shader_request.resolution.fragment.path = "project:/shaders/demo.fs.bin";

        auto shader_result =
            manager.request_shader_program(shader_request, assets::AssetRequestReason::Demand);
        auto material_result =
            manager.request_material({.id = "demo/material"}, assets::AssetRequestReason::Demand);
        auto font_result = manager.request_font({.alias = "body", .style = TextFontBold},
                                                assets::AssetRequestReason::Demand);
        REQUIRE(shader_result);
        REQUIRE(material_result);
        REQUIRE(font_result);
        auto shader = std::move(shader_result).value();
        auto material = std::move(material_result).value();
        auto font = std::move(font_result).value();
        REQUIRE(drive_until(executor, [&] {
            return shader.state() == assets::AssetRequestState::Ready &&
                   material.state() == assets::AssetRequestState::Ready &&
                   font.state() == assets::AssetRequestState::Ready;
        }));

        auto shader_lease = std::move(shader).take_ready();
        auto material_lease = std::move(material).take_ready();
        auto font_lease = std::move(font).take_ready();
        REQUIRE(shader_lease);
        REQUIRE(material_lease);
        REQUIRE(font_lease);
        CHECK((*shader_lease)->handle == 72);
        CHECK((*material_lease)->definition != nullptr);
        CHECK((*font_lease)->resolved_alias == "body");
        CHECK(shader_probe->finalizations.load(std::memory_order_relaxed) == 2);
        CHECK(font_probe->finalizations.load(std::memory_order_relaxed) == 1);
        CHECK(font_probe->prepared_bytes.load(std::memory_order_relaxed) == 8);

        const auto accounting = residency->accounting_on_owner().current;
        CHECK(accounting.gpu_bytes == 7);
        CHECK(accounting.prepared_cpu_bytes > 0);
        CHECK(accounting.source_bytes == 8);

        const auto shader_key = shader_lease->cache_key();
        const auto material_key = material_lease->cache_key();
        const auto font_key = font_lease->cache_key();
        shader_lease->reset();
        material_lease->reset();
        font_lease->reset();
        CHECK(residency->evict_on_owner(shader_key,
                                        assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(residency->evict_on_owner(material_key,
                                        assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(
            residency->evict_on_owner(font_key, assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(residency->accounting_on_owner().current.total_bytes() == 0);
    }
    shutdown(executor);
}

TEST_CASE("Text font-source preparation registers and evicts a private runtime family")
{
    jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());

    {
        assets::AssetManager manager;
        manager.mount_directory("project", NOVELTEA_SOURCE_DIR "/apps/sandbox/assets");
        text::TextEngine engine(manager);
        REQUIRE(engine.valid());
        text::TextFontAssetLoader loader(manager, engine);
        manager.bind_font_loader(&loader);
        REQUIRE(manager.configure_async_requests(executor, residency));

        auto requested = manager.request_font(
            {.alias = std::string(kSystemFontDisplayName), .style = TextFontBold},
            assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Ready; }));

        auto lease = std::move(handle).take_ready();
        REQUIRE(lease);
        CHECK((*lease)->face);
        CHECK((*lease)->family);
        CHECK((*lease)->resolved_alias == std::string(kSystemFontAlias));
        CHECK(((*lease)->synthetic_style & TextFontBold) != 0u);
        CHECK(residency->accounting_on_owner().current.source_bytes > 0);

        const auto family = (*lease)->family;
        const auto key = lease->cache_key();
        lease->reset();
        CHECK(residency->evict_on_owner(key, assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(residency->accounting_on_owner().current.source_bytes == 0);
        CHECK_FALSE(engine.resolve_font(family, TextFontRegular).face);
    }
    shutdown(executor);
}

TEST_CASE("Texture prefetch coalesces with demand and canceled preparation never finalizes")
{
    jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());
    auto probe = std::make_shared<PreparationProbe>();
    probe->owner_thread = std::this_thread::get_id();

    {
        assets::AssetManager manager;
        auto source = std::make_shared<assets::MemoryAssetSource>();
        source->add("textures/one.png", one_pixel_png());
        source->add("textures/canceled.png", assets::AssetBytes(300u * 1024u, 0));
        manager.mount("project", source);
        TestTextureLoader loader(manager, probe);
        manager.bind_texture_loader(&loader);
        REQUIRE(manager.configure_async_requests(executor, residency));

        const auto generation = manager.create_prefetch_generation_on_owner();
        REQUIRE(generation);
        const assets::TextureAssetRequest prefetched{.path = "project:/textures/one.png"};
        auto ticket_result = manager.prefetch_texture(prefetched, generation.value());
        REQUIRE(ticket_result);
        auto ticket = std::move(ticket_result).value();
        auto demand_result =
            manager.request_texture(prefetched, assets::AssetRequestReason::Demand);
        REQUIRE(demand_result);
        auto demand = std::move(demand_result).value();
        REQUIRE(drive_until(executor,
                            [&] { return demand.state() == assets::AssetRequestState::Ready; }));
        CHECK(probe->finalizations.load(std::memory_order_relaxed) == 1);
        ticket.cancel();
        auto lease = std::move(demand).take_ready();
        REQUIRE(lease);
        const auto key = lease->cache_key();
        lease->reset();
        CHECK(residency->evict_on_owner(key, assets::ResidencyEvictionReason::ExplicitRelease));

        auto canceled_result = manager.request_texture({.path = "project:/textures/canceled.png"},
                                                       assets::AssetRequestReason::Demand);
        REQUIRE(canceled_result);
        auto canceled = std::move(canceled_result).value();
        REQUIRE(executor.advance_one_step());
        canceled.cancel();
        REQUIRE(drive_until(
            executor, [&] { return canceled.state() == assets::AssetRequestState::Canceled; }));
        CHECK(probe->finalizations.load(std::memory_order_relaxed) == 1);
    }
    shutdown(executor);
}

TEST_CASE("Visual asset cache-key builders include options and source generations")
{
    const assets::AssetSourceGeneration first{41};
    const assets::AssetSourceGeneration second{42};
    const assets::TextureAssetRequest nearest{.path = "project:/textures/a.png",
                                              .sampler = MaterialTextureSampler::ClampNearest};
    const assets::TextureAssetRequest linear{.path = "project:/textures/a.png",
                                             .sampler = MaterialTextureSampler::ClampLinear};
    CHECK(assets::make_texture_cache_key(nearest, first) !=
          assets::make_texture_cache_key(linear, first));
    CHECK(assets::make_texture_cache_key(nearest, first).source_generation == first);
    CHECK(assets::make_texture_cache_key(nearest, first) !=
          assets::make_texture_cache_key(nearest, second));

    assets::FontAssetRequest regular{.alias = "body", .style = TextFontRegular, .size = 16.0f};
    assets::FontAssetRequest same_source{.alias = "body", .style = TextFontRegular, .size = 32.0f};
    assets::FontAssetRequest bold{.alias = "body", .style = TextFontBold, .size = 16.0f};
    CHECK(assets::make_font_cache_key(regular, first) ==
          assets::make_font_cache_key(same_source, first));
    CHECK(assets::make_font_cache_key(regular, first) != assets::make_font_cache_key(bold, first));

    assets::ShaderProgramAssetRequest shader;
    shader.resolution.key.material_id = "demo/material";
    shader.resolution.key.variant = "glsl-120";
    CHECK(assets::make_shader_program_cache_key(shader, first).source_generation == first);
    CHECK(assets::make_material_cache_key({.id = "demo/material"}, first).valid());
}

} // namespace
