#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>

#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/typed_save_slot_store.hpp>
#include <noveltea/engine.hpp>
#include <noveltea/platform.hpp>

#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <string_view>

#if defined(__EMSCRIPTEN__)
extern "C" void noveltea_web_sync_persistent_fs();
#endif

namespace {

#if !defined(SDL_PLATFORM_ANDROID)
std::filesystem::path executable_base()
{
#if defined(__EMSCRIPTEN__)
    return "/";
#elif defined(SDL_PLATFORM_ANDROID)
    return "";
#else
    const char* base = SDL_GetBasePath();
    return base ? std::filesystem::path(base) : std::filesystem::path();
#endif
}

std::filesystem::path config_path(int argc, char** argv)
{
#if !defined(NDEBUG)
    for (int i = 1; i + 1 < argc; ++i)
        if (std::string_view(argv[i]) == "--player-config")
            return argv[i + 1];
#else
    (void)argc;
    (void)argv;
#endif
#if defined(__APPLE__)
    auto base = executable_base();
    auto resources = base.parent_path().parent_path() / "Resources" / "player.json";
    std::error_code error;
    if (std::filesystem::exists(resources, error) && !error)
        return resources;
#endif
    return executable_base() / "player.json";
}
#endif

std::filesystem::path writable_base(const std::string& save_namespace)
{
#if defined(__EMSCRIPTEN__)
    std::string safe = save_namespace;
    for (auto& character : safe)
        if (!(std::isalnum(static_cast<unsigned char>(character)) || character == '.' ||
              character == '_' || character == '-'))
            character = '_';
    return std::filesystem::path("/persist") / safe;
#else
    char* path = SDL_GetPrefPath("NovelTea", save_namespace.c_str());
    if (!path)
        return {};
    std::filesystem::path result(path);
    SDL_free(path);
    return result;
#endif
}

#if defined(SDL_PLATFORM_ANDROID)
std::vector<std::byte> read_packaged_asset(std::string_view asset_path)
{
    std::size_t size = 0;
    void* data = SDL_LoadFile(std::string(asset_path).c_str(), &size);
    if (!data)
        return {};
    const auto* begin = static_cast<const std::byte*>(data);
    std::vector<std::byte> bytes(begin, begin + size);
    SDL_free(data);
    return bytes;
}
#endif

std::filesystem::path packaged_system_asset_root(const std::filesystem::path& player_config)
{
#if defined(__EMSCRIPTEN__) || defined(SDL_PLATFORM_ANDROID)
    (void)player_config;
    return {};
#else
    const auto config_directory = player_config.parent_path();
    for (const auto& candidate : {
             config_directory / "assets" / "system",
             config_directory.parent_path() / "assets" / "system",
         }) {
        std::error_code error;
        if (std::filesystem::is_directory(candidate, error) && !error)
            return candidate;
    }
    return {};
#endif
}

int fail_startup(const noveltea::core::PlayerBootstrapResult& result)
{
    std::string message = "The game could not start.\n\n";
    for (const auto& diagnostic : result.diagnostics) {
        const auto* category = noveltea::core::player_bootstrap_error_name(diagnostic.category);
        std::fprintf(stderr, "[player:%s] %s: %s\n", category, diagnostic.path.c_str(),
                     diagnostic.message.c_str());
        message += "[" + std::string(category) + "] " + diagnostic.message + "\n";
    }
    SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, "NovelTea Player", message.c_str(), nullptr);
    return 2;
}

} // namespace

int main(int argc, char** argv)
{
    std::filesystem::path path;
    noveltea::core::PlayerBootstrapResult bootstrap;
#if defined(SDL_PLATFORM_ANDROID)
    (void)argc;
    (void)argv;
    const auto config_bytes = read_packaged_asset("noveltea/bootstrap/player.json");
    const std::string config_text(reinterpret_cast<const char*>(config_bytes.data()),
                                  config_bytes.size());
    auto packaged_config = noveltea::core::parse_player_config(config_text);
    if (!packaged_config.success())
        return fail_startup(packaged_config);
    const auto app_roots = writable_base(packaged_config.config.save_namespace);
    if (app_roots.empty()) {
        packaged_config.diagnostics.push_back(
            {noveltea::core::PlayerBootstrapError::WritableRoot, "",
             "could not resolve the application writable directory"});
        return fail_startup(packaged_config);
    }
    auto materialized = noveltea::core::materialize_packaged_player(
        app_roots / "bootstrap", "noveltea/bootstrap", read_packaged_asset);
    bootstrap = std::move(materialized.bootstrap);
    path = std::move(materialized.config_path);
#else
    path = config_path(argc, argv);
    bootstrap = noveltea::core::load_and_verify_player(path);
#endif
    if (!bootstrap.success())
        return fail_startup(bootstrap);

    const auto roots = writable_base(bootstrap.config.save_namespace);
    if (roots.empty()) {
        bootstrap.diagnostics.push_back({noveltea::core::PlayerBootstrapError::WritableRoot, "",
                                         "could not resolve the application writable directory"});
        return fail_startup(bootstrap);
    }
    std::error_code error;
    for (const auto* child : {"saves", "config", "cache", "logs"})
        std::filesystem::create_directories(roots / child, error);
    if (error) {
        bootstrap.diagnostics.push_back(
            {noveltea::core::PlayerBootstrapError::WritableRoot, roots.string(), error.message()});
        return fail_startup(bootstrap);
    }
    std::ofstream log(roots / "logs" / "player.log", std::ios::app);
    log << "NovelTea player starting " << bootstrap.config.display_name << " "
        << bootstrap.config.version_name << '\n';
    log.flush();

    noveltea::core::TypedFilesystemSaveSlotStore saves(roots / "saves");
    noveltea::PlatformConfig platform;
    platform.title = bootstrap.config.display_name.c_str();
    const bool portrait = bootstrap.config.display.orientation == "portrait";
    platform.width = portrait ? 720 : 1280;
    platform.height = portrait ? 1280 : 720;

    noveltea::EngineRunConfig run;
    run.enable_debug_ui = false;
    run.project_asset_root = path.parent_path();
    run.system_asset_root = packaged_system_asset_root(path);
    run.cache_asset_root = roots / "cache";
    run.compiled_project = "project:/" + bootstrap.config.package_path.generic_string();
    run.save_slot_store = &saves;
#if !defined(NDEBUG)
    if (const char* frames = std::getenv("NOVELTEA_PLAYER_SMOKE_FRAMES"))
        run.frame_limit = static_cast<std::uint32_t>(std::strtoul(frames, nullptr, 10));
#endif

    noveltea::Engine engine;
    if (!engine.initialize(platform, run)) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "NOVELTEA_PLAYER_STARTUP_FAILED application=%s reason=engine-initialize",
                     bootstrap.config.application_id.c_str());
        log << "Engine initialization failed\n";
        log.flush();
        SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, bootstrap.config.display_name.c_str(),
                                 "The game package could not be initialized. See player.log.",
                                 nullptr);
        return 3;
    }
    SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "NOVELTEA_PLAYER_READY application=%s package=%s",
                bootstrap.config.application_id.c_str(), bootstrap.config.package_sha256.c_str());
    const int result = engine.run();
    engine.shutdown();
#if defined(__EMSCRIPTEN__)
    noveltea_web_sync_persistent_fs();
#endif
    return result;
}
