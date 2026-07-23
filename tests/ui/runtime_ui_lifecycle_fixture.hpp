#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "ui/rmlui/runtime_ui.hpp"

#include <filesystem>
#include <limits>
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
        if (!m_async_assets_configured) {
            m_residency = std::make_shared<assets::AssetResidencyManager>(
                assets::ResidencyBudget{.source_bytes = 64 * 1024 * 1024,
                                        .prepared_cpu_bytes = 64 * 1024 * 1024,
                                        .gpu_bytes = 64 * 1024 * 1024,
                                        .audio_bytes = 64 * 1024 * 1024,
                                        .temporary_bytes = 64 * 1024 * 1024});
            if (!m_assets.configure_async_requests(m_executor, m_residency))
                return false;
            m_async_assets_configured = true;
        }
        if (!m_scripts.is_initialized() && !m_scripts.initialize({&m_assets}))
            return false;
        if (!m_runtime_ui.initialize(&m_assets, nullptr, &m_scripts, nullptr, true))
            return false;
        return m_executor.run_until_idle(64);
    }

    void shutdown()
    {
        m_runtime_ui.shutdown();
        m_scripts.shutdown();
        if (!m_executor_shutdown) {
            m_executor.begin_shutdown();
            (void)m_executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
            m_executor_shutdown = true;
        }
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
    jobs::InlineJobExecutor m_executor;
    std::shared_ptr<assets::AssetResidencyManager> m_residency;
    assets::AssetManager m_assets;
    script::ScriptRuntime m_scripts;
    RuntimeUI m_runtime_ui;
    bool m_system_assets_mounted = false;
    bool m_async_assets_configured = false;
    bool m_executor_shutdown = false;
};

} // namespace noveltea::test
