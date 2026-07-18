#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "ui/rmlui/runtime_ui.hpp"

#include <filesystem>
#include <memory>

namespace noveltea::test {

class RuntimeUiLifecycleFixture final {
public:
    struct Config {
        bool mount_system_assets = false;
    };

    RuntimeUiLifecycleFixture() : RuntimeUiLifecycleFixture(Config{}) {}

    explicit RuntimeUiLifecycleFixture(Config config)
        : m_project_assets(std::make_shared<assets::MemoryAssetSource>())
    {
        m_assets.mount("project", m_project_assets);
        if (config.mount_system_assets)
            mount_system_assets();
    }

    ~RuntimeUiLifecycleFixture() { shutdown(); }

    RuntimeUiLifecycleFixture(const RuntimeUiLifecycleFixture&) = delete;
    RuntimeUiLifecycleFixture& operator=(const RuntimeUiLifecycleFixture&) = delete;
    RuntimeUiLifecycleFixture(RuntimeUiLifecycleFixture&&) = delete;
    RuntimeUiLifecycleFixture& operator=(RuntimeUiLifecycleFixture&&) = delete;

    [[nodiscard]] bool initialize()
    {
        if (!m_scripts.is_initialized() && !m_scripts.initialize({&m_assets}))
            return false;
        return m_runtime_ui.initialize(&m_assets, nullptr, &m_scripts, nullptr, true);
    }

    void shutdown()
    {
        m_runtime_ui.shutdown();
        m_scripts.shutdown();
    }

    void mount_system_assets()
    {
        if (m_system_assets_mounted)
            return;
        m_assets.mount_directory(
            "system", std::filesystem::path(NOVELTEA_SOURCE_DIR) / "engine/assets/system", false);
        m_system_assets_mounted = true;
    }

    [[nodiscard]] assets::MemoryAssetSource& project_assets() noexcept { return *m_project_assets; }
    [[nodiscard]] assets::AssetManager& assets() noexcept { return m_assets; }
    [[nodiscard]] script::ScriptRuntime& scripts() noexcept { return m_scripts; }
    [[nodiscard]] RuntimeUI& runtime_ui() noexcept { return m_runtime_ui; }

private:
    std::shared_ptr<assets::MemoryAssetSource> m_project_assets;
    assets::AssetManager m_assets;
    script::ScriptRuntime m_scripts;
    RuntimeUI m_runtime_ui;
    bool m_system_assets_mounted = false;
};

} // namespace noveltea::test
