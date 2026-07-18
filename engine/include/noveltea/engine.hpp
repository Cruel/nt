#pragma once

#include "noveltea/surface.hpp"

#include <filesystem>
#include <memory>
#include <string>

namespace noveltea {

struct PlatformConfig;
class EngineTooling;

namespace core {
class TypedSaveSlotStore;
}

struct EngineConfig {
    std::filesystem::path system_asset_root;
    std::filesystem::path project_asset_root;
    std::filesystem::path cache_asset_root;
    std::string compiled_project;
    bool load_title_screen = true;
    bool enable_audio = true;
    core::TypedSaveSlotStore* save_slot_store = nullptr;
};

class Engine final {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    bool initialize(const PlatformConfig& config, const EngineConfig& engine_config = {});
    int run();
    bool tick();
    void resize(const SurfaceMetrics& surface);
    const PresentationMetrics& presentation() const;
    void shutdown();
    void request_stop();
    bool is_running() const;

private:
    friend class EngineTooling;
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea
