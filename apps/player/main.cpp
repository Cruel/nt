#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>

#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/save_document.hpp>
#include <noveltea/engine.hpp>

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
    if (std::filesystem::exists(resources))
        return resources;
#endif
    return executable_base() / "player.json";
}

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
    const auto path = config_path(argc, argv);
    auto bootstrap = noveltea::core::load_and_verify_player(path);
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

    noveltea::core::FilesystemSaveSlotStore saves(roots / "saves");
    noveltea::PlatformConfig platform;
    platform.title = bootstrap.config.display_name.c_str();
    const bool portrait = bootstrap.config.display.orientation == "portrait";
    platform.width = portrait ? 720 : 1280;
    platform.height = portrait ? 1280 : 720;

    noveltea::EngineRunConfig run;
    run.enable_debug_ui = false;
    run.demo_mode = noveltea::DemoMode::None;
    run.project_asset_root = path.parent_path();
    run.cache_asset_root = roots / "cache";
    run.runtime_project = "project:/" + bootstrap.config.package_path.generic_string();
    run.save_slot_store = &saves;
#if !defined(NDEBUG)
    if (const char* frames = std::getenv("NOVELTEA_PLAYER_SMOKE_FRAMES"))
        run.frame_limit = static_cast<std::uint32_t>(std::strtoul(frames, nullptr, 10));
#endif

    noveltea::Engine engine;
    if (!engine.initialize(platform, run)) {
        SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, bootstrap.config.display_name.c_str(),
                                 "The game package could not be initialized. See player.log.",
                                 nullptr);
        log << "Engine initialization failed\n";
        return 3;
    }
    const int result = engine.run();
    engine.shutdown();
#if defined(__EMSCRIPTEN__)
    noveltea_web_sync_persistent_fs();
#endif
    return result;
}
