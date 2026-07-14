#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"

#include <optional>
#include <cstring>

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

class ShortReadReader final : public AssetReader {
public:
    [[nodiscard]] std::optional<std::uint64_t> size() const override { return 4; }

    std::size_t read(void* destination, std::size_t bytes) override
    {
        if (bytes == 0)
            return 0;
        static constexpr char payload[] = "ab";
        const std::size_t count = std::min<std::size_t>(2, bytes);
        std::memcpy(destination, payload, count);
        return count;
    }

    bool seek(std::int64_t, int) override { return false; }
    [[nodiscard]] std::optional<std::uint64_t> tell() const override { return 0; }
};

class ShortReadSource final : public AssetSource {
public:
    [[nodiscard]] bool exists(const AssetPath& path) const override
    {
        return path.logical_path() == "project:/short.bin";
    }

    [[nodiscard]] AssetResult<AssetReaderPtr> open(const AssetPath& path) const override
    {
        if (!exists(path))
            return {{}, "missing"};
        return {std::make_unique<ShortReadReader>(), {}};
    }

    [[nodiscard]] std::string describe() const override { return "short-read-source"; }
    [[nodiscard]] const char* kind() const override { return "test-short-read"; }
};

class FakeFontAssetLoader final : public FontAssetLoader {
public:
    AssetResult<FontAsset> load_font(const FontAssetRequest& request) override
    {
        last_request = request;
        return {FontAsset{.face = noveltea::FontHandle{42},
                          .family = noveltea::FontFamilyHandle{7},
                          .resolved_alias = request.alias.empty() ? "default" : request.alias,
                          .requested_style = request.style,
                          .synthetic_style = request.style},
                {}};
    }

    std::optional<FontAssetRequest> last_request;
};

class FakeTextureAssetLoader final : public TextureAssetLoader {
public:
    AssetResult<TextureAsset> load_texture(const TextureAssetRequest& request) override
    {
        last_request = request;
        return {TextureAsset{.handle = 11, .path = request.path, .width = 4, .height = 5}, {}};
    }

    std::optional<TextureAssetRequest> last_request;
};

class FakeShaderProgramAssetLoader final : public ShaderProgramAssetLoader {
public:
    AssetResult<ShaderProgramAsset>
    load_shader_program(const ShaderProgramAssetRequest& request) override
    {
        last_request = request;
        return {ShaderProgramAsset{.handle = 12, .key = request.resolution.key}, {}};
    }

    std::optional<ShaderProgramAssetRequest> last_request;
};

class FakeMaterialAssetLoader final : public MaterialAssetLoader {
public:
    AssetResult<MaterialAsset> load_material(const MaterialAssetRequest& request) override
    {
        last_request = request;
        return {MaterialAsset{.definition = &material, .id = request.id}, {}};
    }

    noveltea::MaterialDefinition material;
    std::optional<MaterialAssetRequest> last_request;
};

class FakeAudioAssetLoader final : public AudioAssetLoader {
public:
    AssetResult<AudioAsset> load_audio(const AudioAssetRequest& request) override
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
    CHECK(missing.error.find("searched:") != std::string::npos);
}

TEST_CASE("AssetManager reports sized-reader short reads without returning partial data")
{
    AssetManager manager;
    manager.mount("project", std::make_shared<ShortReadSource>());

    const auto result = manager.read_binary("project:/short.bin");
    REQUIRE_FALSE(result);
    CHECK(result.error.find("short read") != std::string::npos);
    CHECK(result.error.find("project:/short.bin") != std::string::npos);
    CHECK(result.error.find("short-read-source") != std::string::npos);
}

TEST_CASE("AssetManager typed font API reports missing loader and forwards requests")
{
    AssetManager manager;
    auto missing = manager.load_font(FontAssetRequest{.alias = "body"});
    CHECK_FALSE(missing);
    CHECK(missing.error.find("font loader") != std::string::npos);

    manager.set_default_font_alias("body");
    CHECK(manager.default_font_alias() == "body");

    FakeFontAssetLoader loader;
    manager.bind_font_loader(&loader);
    auto font = manager.load_font(FontAssetRequest{.style = noveltea::TextFontBold});
    REQUIRE(font);
    REQUIRE(loader.last_request);
    CHECK(loader.last_request->alias == "body");
    CHECK(loader.last_request->style == noveltea::TextFontBold);
    CHECK(font.value->face == noveltea::FontHandle{42});
    CHECK(font.value->family == noveltea::FontFamilyHandle{7});
    CHECK(font.value->resolved_alias == "body");
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

TEST_CASE("AssetManager typed texture shader and material APIs forward to bound loaders")
{
    AssetManager manager;
    CHECK_FALSE(manager.load_texture(TextureAssetRequest{.path = "project:/textures/checker.png"}));
    CHECK_FALSE(manager.load_shader_program(ShaderProgramAssetRequest{}));
    CHECK_FALSE(manager.load_material(MaterialAssetRequest{.id = "demo/material"}));

    FakeTextureAssetLoader texture_loader;
    manager.bind_texture_loader(&texture_loader);
    auto texture = manager.load_texture(
        TextureAssetRequest{.path = "project:/textures/checker.png",
                            .sampler = noveltea::MaterialTextureSampler::RepeatNearest});
    REQUIRE(texture);
    REQUIRE(texture_loader.last_request);
    CHECK(texture_loader.last_request->path == "project:/textures/checker.png");
    CHECK(texture_loader.last_request->sampler == noveltea::MaterialTextureSampler::RepeatNearest);
    CHECK(texture.value->handle == 11);
    CHECK(texture.value->width == 4);
    CHECK(texture.value->height == 5);

    FakeShaderProgramAssetLoader shader_loader;
    manager.bind_shader_program_loader(&shader_loader);
    ShaderProgramAssetRequest shader_request;
    shader_request.resolution.key.material_id = "demo/material";
    shader_request.resolution.key.variant = "glsl-120";
    auto program = manager.load_shader_program(shader_request);
    REQUIRE(program);
    REQUIRE(shader_loader.last_request);
    CHECK(program.value->handle == 12);
    CHECK(program.value->key.material_id == "demo/material");

    FakeMaterialAssetLoader material_loader;
    manager.bind_material_loader(&material_loader);
    auto material = manager.load_material(MaterialAssetRequest{.id = "demo/material"});
    REQUIRE(material);
    REQUIRE(material_loader.last_request);
    CHECK(material_loader.last_request->id == "demo/material");
    CHECK(material.value->definition == &material_loader.material);
}

TEST_CASE("AssetManager typed audio API reports missing loader and forwards requests")
{
    AssetManager manager;
    auto missing = manager.load_audio(AudioAssetRequest{.path = "project:/audio/notification.mp3"});
    CHECK_FALSE(missing);
    CHECK(missing.error.find("audio loader") != std::string::npos);

    FakeAudioAssetLoader loader;
    manager.bind_audio_loader(&loader);
    auto audio = manager.load_audio(AudioAssetRequest{.path = "project:/audio/notification.mp3",
                                                      .mode = noveltea::AudioLoadMode::Stream,
                                                      .kind = noveltea::AudioClipKind::Sfx});
    REQUIRE(audio);
    REQUIRE(loader.last_request);
    CHECK(loader.last_request->path == "project:/audio/notification.mp3");
    CHECK(loader.last_request->mode == noveltea::AudioLoadMode::Stream);
    CHECK(loader.last_request->kind == noveltea::AudioClipKind::Sfx);
    CHECK(audio.value->clip == noveltea::AudioClipHandle{99});
    CHECK(audio.value->path == "project:/audio/notification.mp3");
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

    FakeAudioAssetLoader audio_loader;
    manager.bind_audio_loader(&audio_loader);
    auto audio = manager.load_audio_alias("ui.notification");
    REQUIRE(audio);
    REQUIRE(audio_loader.last_request);
    CHECK(audio_loader.last_request->path == "project:/audio/notification.mp3");

    FakeTextureAssetLoader texture_loader;
    manager.bind_texture_loader(&texture_loader);
    auto texture = manager.load_texture_alias("bg.school");
    REQUIRE(texture);
    REQUIRE(texture_loader.last_request);
    CHECK(texture_loader.last_request->path == "project:/images/bg/school.png");
    CHECK(texture_loader.last_request->sampler == noveltea::MaterialTextureSampler::RepeatLinear);

    FakeMaterialAssetLoader material_loader;
    manager.bind_material_loader(&material_loader);
    auto material = manager.load_material_alias("ui.glow");
    REQUIRE(material);
    REQUIRE(material_loader.last_request);
    CHECK(material_loader.last_request->id == "materials/ui_glow");
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

TEST_CASE("AssetManager reads binary, text, and streams without native paths")
{
    AssetManager manager;
    manager.mount("project", memory_source("project:/hello.txt", {'h', 'i'}));
    auto text = manager.read_text("hello.txt");
    REQUIRE(text);
    CHECK(*text.value == "hi");
    auto opened = manager.open("hello.txt");
    REQUIRE(opened);
    CHECK((*opened.value)->size().value() == 2);
}
