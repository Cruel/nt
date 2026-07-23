#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"

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

    explicit TestLoaderPreparationTask(Loader loader) : m_loader(std::move(loader)) {}

    [[nodiscard]] ResidencyCost estimated_cost_on_owner() const noexcept override { return {}; }

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
            {.asset = std::move(*loaded.value), .cost = {}, .destroy_on_owner = {}});
    }

private:
    Loader m_loader;
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
        return {TextureAsset{.handle = 11, .path = request.path, .width = 4, .height = 5}, {}};
    }

    std::unique_ptr<AssetPreparationTask<TextureAsset>>
    create_texture_preparation_task(const TextureAssetRequest& request) override
    {
        return std::make_unique<TestLoaderPreparationTask<TextureAsset>>(
            [this, request]() { return load_texture(request); });
    }

    std::optional<TextureAssetRequest> last_request;
    std::uint64_t call_count = 0;
    std::thread::id call_thread{};
};

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
