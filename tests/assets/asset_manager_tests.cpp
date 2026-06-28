#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/project_document.hpp"

#include <optional>

using namespace noveltea::assets;
using noveltea::core::ProjectDocument;
using noveltea::core::legacy::ProjectPackage;

static std::shared_ptr<MemoryAssetSource> memory_source(std::string_view path, AssetBytes bytes)
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add(path, std::move(bytes));
    return source;
}

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

static std::vector<std::byte> package_bytes(std::string_view value)
{
    std::vector<std::byte> bytes;
    bytes.reserve(value.size());
    for (const char ch : value) {
        bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(ch)));
    }
    return bytes;
}

TEST_CASE("AssetManager mounts legacy package entries as project assets")
{
    ProjectPackage package;
    package.imported_project.document = ProjectDocument::new_project();
    package.game_json = package.imported_project.document.root().dump();
    package.image = package_bytes("cover");
    package.fonts.emplace("caption.ttf", package_bytes("font"));
    package.textures.emplace("room.png", package_bytes("texture"));
    package.assets.emplace("scripts/bootstrap.lua", package_bytes("script"));
    package.assets.emplace("text/intro.txt", package_bytes("intro"));
    package.assets.emplace("shaders/bgfx/glsl-120/custom.fs.bin", package_bytes("shader"));

    AssetManager manager;
    manager.mount_legacy_package("project", package);

    auto game = manager.read_text("project:/game");
    REQUIRE(game);
    CHECK(*game.value == package.game_json);

    auto image = manager.read_binary("project:/image");
    REQUIRE(image);
    CHECK(image.value->bytes == AssetBytes{'c', 'o', 'v', 'e', 'r'});

    auto font = manager.read_text("project:/fonts/caption.ttf");
    REQUIRE(font);
    CHECK(*font.value == "font");

    auto texture = manager.read_text("project:/textures/room.png");
    REQUIRE(texture);
    CHECK(*texture.value == "texture");

    auto script = manager.read_text("project:/scripts/bootstrap.lua");
    REQUIRE(script);
    CHECK(*script.value == "script");

    auto text = manager.read_text("project:/text/intro.txt");
    REQUIRE(text);
    CHECK(*text.value == "intro");

    auto shader = manager.read_text("project:/shaders/bgfx/glsl-120/custom.fs.bin");
    REQUIRE(shader);
    CHECK(*shader.value == "shader");
}
