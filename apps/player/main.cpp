#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>

#include <noveltea/assets/asset_source.hpp>
#include <noveltea/core/loading_progress.hpp>
#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/typed_save_slot_store.hpp>
#include <noveltea/engine.hpp>
#include <noveltea/engine_tooling.hpp>
#include <noveltea/platform.hpp>

#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
extern "C" void noveltea_web_sync_persistent_fs();
extern "C" void noveltea_web_report_loading_progress(std::uint32_t operation, std::uint32_t phase,
                                                     std::uint32_t state, std::uint32_t completed,
                                                     std::int32_t total, std::int32_t retryable,
                                                     const char* diagnostic_code,
                                                     const char* diagnostic_message);
#endif

namespace {

noveltea::assets::AssetMemoryTarget runtime_asset_memory_target() noexcept
{
#if defined(__EMSCRIPTEN__)
    return noveltea::assets::AssetMemoryTarget::Web;
#elif defined(NOVELTEA_PLATFORM_ANDROID) || defined(__ANDROID__)
    return noveltea::assets::AssetMemoryTarget::Android;
#else
    return noveltea::assets::AssetMemoryTarget::Desktop;
#endif
}

noveltea::assets::AssetMemoryPreset asset_memory_preset(std::string_view value) noexcept
{
    if (value == "low")
        return noveltea::assets::AssetMemoryPreset::Low;
    if (value == "high")
        return noveltea::assets::AssetMemoryPreset::High;
    if (value == "custom")
        return noveltea::assets::AssetMemoryPreset::Custom;
    return noveltea::assets::AssetMemoryPreset::Balanced;
}

std::optional<noveltea::assets::ResolvedAssetMemoryPolicy>
resolved_asset_memory_policy(const noveltea::core::PlayerBootstrapConfig& config)
{
    const auto target = runtime_asset_memory_target();
    if (!config.asset_memory) {
        auto resolved = noveltea::assets::resolve_asset_memory_policy(
            target, noveltea::assets::AssetMemoryPreset::Balanced);
        if (!resolved)
            return std::nullopt;
        return std::move(*resolved.value_if());
    }
    const auto& memory = *config.asset_memory;
    return noveltea::assets::ResolvedAssetMemoryPolicy{
        .target = target,
        .preset = asset_memory_preset(memory.preset),
        .budget = {.source_bytes = memory.prepared_cpu_bytes,
                   .prepared_cpu_bytes = memory.prepared_cpu_bytes,
                   .gpu_bytes = memory.gpu_bytes,
                   .audio_bytes = memory.audio_bytes,
                   .temporary_bytes = memory.temporary_bytes,
                   .prefetch_allowance_percent = memory.prefetch_allowance_percent},
    };
}

#if defined(__EMSCRIPTEN__)
std::shared_ptr<noveltea::assets::AssetBytes> g_web_package_staging;
std::shared_ptr<const noveltea::assets::AssetBytes> g_web_package_bytes;
noveltea::core::LoadingOperationId g_web_loading_operation;

void report_web_loading(noveltea::core::LoadingPhase phase, noveltea::core::LoadingState state,
                        std::uint32_t completed = 0, std::optional<std::uint32_t> total = {},
                        bool retryable = false, const char* diagnostic_code = nullptr,
                        const char* diagnostic_message = nullptr)
{
    if (!g_web_loading_operation.valid())
        return;
    noveltea_web_report_loading_progress(static_cast<std::uint32_t>(g_web_loading_operation.value),
                                         static_cast<std::uint32_t>(phase),
                                         static_cast<std::uint32_t>(state), completed,
                                         total ? static_cast<std::int32_t>(*total) : -1,
                                         retryable ? 1 : 0, diagnostic_code, diagnostic_message);
}

extern "C" EMSCRIPTEN_KEEPALIVE std::uintptr_t noveltea_player_prepare_package(std::uint32_t size)
{
    g_web_package_bytes.reset();
    g_web_package_staging.reset();
    if (size == 0)
        return 0;
    g_web_package_staging = std::make_shared<noveltea::assets::AssetBytes>(size, std::uint8_t{0});
    return reinterpret_cast<std::uintptr_t>(g_web_package_staging->data());
}

extern "C" EMSCRIPTEN_KEEPALIVE std::int32_t noveltea_player_commit_package(std::uint32_t operation)
{
    if (!g_web_package_staging || g_web_package_staging->empty() || operation == 0)
        return 0;
    g_web_loading_operation = {operation};
    g_web_package_bytes = std::move(g_web_package_staging);
    g_web_package_staging.reset();
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE std::uint32_t noveltea_player_retained_package_bytes()
{
    return g_web_package_bytes ? static_cast<std::uint32_t>(g_web_package_bytes->size()) : 0;
}

struct WebPlayerState {
    std::unique_ptr<noveltea::Engine> engine;
    std::unique_ptr<noveltea::core::TypedFilesystemSaveSlotStore> saves;
};

WebPlayerState* g_web_player_state = nullptr;

extern "C" EMSCRIPTEN_KEEPALIVE void
noveltea_player_resize(int logical_width, int logical_height, int framebuffer_width,
                       int framebuffer_height, float host_logical_to_framebuffer_scale_x,
                       float host_logical_to_framebuffer_scale_y)
{
    if (!g_web_player_state || !g_web_player_state->engine)
        return;
    auto host = noveltea::make_host_surface_metrics(logical_width, logical_height,
                                                    framebuffer_width, framebuffer_height);
    host.logical_to_framebuffer_scale = {host_logical_to_framebuffer_scale_x,
                                         host_logical_to_framebuffer_scale_y};
    g_web_player_state->engine->resize(noveltea::sanitize_host_surface_metrics(host));
}

void web_main_loop(void* opaque)
{
    auto* state = static_cast<WebPlayerState*>(opaque);
    if (state->engine->tick())
        return;

    emscripten_cancel_main_loop();
    state->engine->shutdown();
    noveltea_web_sync_persistent_fs();
    g_web_player_state = nullptr;
    delete state;
}
#endif

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

noveltea::EngineToolingConfig tooling_config(int argc, char** argv)
{
    noveltea::EngineToolingConfig config;
    for (int i = 1; i < argc; ++i) {
        const std::string_view argument = argv[i];
        if (argument == "--show-fps") {
            config.show_fps_counter = true;
        } else if (argument == "--fps-cap" && i + 1 < argc) {
            config.fps_cap = static_cast<std::uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        }
    }
    return config;
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
#if defined(__EMSCRIPTEN__)
    if (!result.diagnostics.empty()) {
        const auto& diagnostic = result.diagnostics.front();
        auto phase = noveltea::core::LoadingPhase::VerifyingPackage;
        if (diagnostic.category == noveltea::core::PlayerBootstrapError::PackageContent)
            phase = noveltea::core::LoadingPhase::OpeningPackageIndex;
        else if (diagnostic.category == noveltea::core::PlayerBootstrapError::WritableRoot ||
                 diagnostic.category == noveltea::core::PlayerBootstrapError::Materialization)
            phase = noveltea::core::LoadingPhase::LoadingStartupContent;
        report_web_loading(phase, noveltea::core::LoadingState::Failed, 0, {}, false,
                           noveltea::core::player_bootstrap_error_name(diagnostic.category),
                           diagnostic.message.c_str());
    }
#endif
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
#if defined(__EMSCRIPTEN__)
    report_web_loading(noveltea::core::LoadingPhase::VerifyingPackage,
                       noveltea::core::LoadingState::Active);
    std::ifstream config_file(path, std::ios::binary);
    if (!config_file) {
        bootstrap.diagnostics.push_back({noveltea::core::PlayerBootstrapError::ConfigDiscovery,
                                         path.string(), "player config was not found"});
    } else if (!g_web_package_bytes || g_web_package_bytes->empty()) {
        bootstrap.diagnostics.push_back({noveltea::core::PlayerBootstrapError::PackageDiscovery,
                                         "/package", "browser package handoff was not completed"});
    } else {
        report_web_loading(noveltea::core::LoadingPhase::VerifyingPackage,
                           noveltea::core::LoadingState::Active,
                           static_cast<std::uint32_t>(g_web_package_bytes->size()),
                           static_cast<std::uint32_t>(g_web_package_bytes->size()));
        const std::string config_text{std::istreambuf_iterator<char>(config_file),
                                      std::istreambuf_iterator<char>()};
        const auto package_span = std::span<const std::byte>(
            reinterpret_cast<const std::byte*>(g_web_package_bytes->data()),
            g_web_package_bytes->size());
        bootstrap =
            noveltea::core::verify_player_config_and_package_view(config_text, package_span);
    }
#else
    bootstrap = noveltea::core::load_and_verify_player(path);
#endif
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

    auto saves = std::make_unique<noveltea::core::TypedFilesystemSaveSlotStore>(roots / "saves");
    noveltea::PlatformConfig platform;
    platform.title = bootstrap.config.display_name.c_str();
    const bool portrait =
        bootstrap.config.display.reference_width < bootstrap.config.display.reference_height;
    platform.width = portrait ? 720 : 1280;
    platform.height = portrait ? 1280 : 720;

    noveltea::EngineConfig engine_config;
    engine_config.project_asset_root = path.parent_path();
    engine_config.system_asset_root = packaged_system_asset_root(path);
    engine_config.cache_asset_root = roots / "cache";
    engine_config.compiled_project = "project:/" + bootstrap.config.package_path.generic_string();
    engine_config.asset_memory_policy = resolved_asset_memory_policy(bootstrap.config);
    if (!engine_config.asset_memory_policy) {
        bootstrap.diagnostics.push_back({noveltea::core::PlayerBootstrapError::ConfigParse,
                                         "/assetMemory",
                                         "asset memory policy could not be resolved"});
        return fail_startup(bootstrap);
    }
    const auto& memory_policy = *engine_config.asset_memory_policy;
    const auto& memory_budget = memory_policy.budget;
    log << "Asset memory policy target="
        << noveltea::assets::asset_memory_target_name(memory_policy.target)
        << " preset=" << noveltea::assets::asset_memory_preset_name(memory_policy.preset)
        << " source=" << memory_budget.source_bytes
        << " prepared_cpu=" << memory_budget.prepared_cpu_bytes
        << " gpu=" << memory_budget.gpu_bytes << " audio=" << memory_budget.audio_bytes
        << " temporary=" << memory_budget.temporary_bytes
        << " prefetch=" << memory_budget.prefetch_allowance_percent << "%\n";
    log.flush();
#if defined(__EMSCRIPTEN__)
    report_web_loading(noveltea::core::LoadingPhase::OpeningPackageIndex,
                       noveltea::core::LoadingState::Active);
    engine_config.runtime_package_source =
        std::make_shared<noveltea::assets::ZipAssetSource>(std::move(g_web_package_bytes));
    report_web_loading(noveltea::core::LoadingPhase::OpeningPackageIndex,
                       noveltea::core::LoadingState::Active, 1, 1);
    report_web_loading(noveltea::core::LoadingPhase::LoadingStartupContent,
                       noveltea::core::LoadingState::Active);
#endif
    engine_config.save_slot_store = saves.get();

    auto engine = std::make_unique<noveltea::Engine>();
    auto player_tooling = tooling_config(argc, argv);
#if !defined(NDEBUG)
    if (const char* frames = std::getenv("NOVELTEA_PLAYER_SMOKE_FRAMES")) {
        player_tooling.frame_limit = static_cast<std::uint32_t>(std::strtoul(frames, nullptr, 10));
    }
#endif
    const bool initialized =
        noveltea::EngineTooling::initialize(*engine, platform, engine_config, player_tooling);
    if (!initialized) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "NOVELTEA_PLAYER_STARTUP_FAILED application=%s reason=engine-initialize",
                     bootstrap.config.application_id.c_str());
        log << "Engine initialization failed\n";
        log.flush();
        SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, bootstrap.config.display_name.c_str(),
                                 "The game package could not be initialized. See player.log.",
                                 nullptr);
#if defined(__EMSCRIPTEN__)
        report_web_loading(noveltea::core::LoadingPhase::LoadingStartupContent,
                           noveltea::core::LoadingState::Failed, 0, {}, false,
                           "player.engine_initialize_failed",
                           "The game package could not be initialized.");
#endif
        return 3;
    }
    SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "NOVELTEA_PLAYER_READY application=%s package=%s",
                bootstrap.config.application_id.c_str(), bootstrap.config.package_sha256.c_str());
#if defined(__EMSCRIPTEN__)
    report_web_loading(noveltea::core::LoadingPhase::LoadingStartupContent,
                       noveltea::core::LoadingState::Completed, 1, 1);
    auto* state = new WebPlayerState{std::move(engine), std::move(saves)};
    g_web_player_state = state;
    emscripten_set_main_loop_arg(web_main_loop, state, 0, true);
    return 0;
#else
    const int result = engine->run();
    engine->shutdown();
    return result;
#endif
}
