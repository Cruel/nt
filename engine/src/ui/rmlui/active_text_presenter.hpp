#pragma once

#include "noveltea/active_text_layout.hpp"
#include "noveltea/active_text_playback.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/presentation/presentation_coordinator.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <memory>
#include <optional>
#include <string>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::text {
class TextEngine;
class TextFontAssetLoader;
} // namespace noveltea::text

namespace noveltea::ui::rmlui {

struct ActiveTextPresenterSurface {
    Rect bounds{};
    Color text_color = Color::from_rgba8(247, 244, 237);
    std::string language = "und";
};

struct ActiveTextPresenterActivation {
    bool consumed = false;
    bool local_state_changed = false;
    std::optional<core::RuntimeInputMessage> input;
};

class ActiveTextPresenter {
public:
    explicit ActiveTextPresenter(core::Diagnostics& diagnostics);
    ~ActiveTextPresenter();

    ActiveTextPresenter(const ActiveTextPresenter&) = delete;
    ActiveTextPresenter& operator=(const ActiveTextPresenter&) = delete;

    void initialize(const assets::AssetManager& assets);
    void advance(const core::TypedRuntimeUIViewState* view, float delta_seconds);
    void refresh_layout(const core::TypedRuntimeUIViewState* view,
                        const std::optional<ActiveTextPresenterSurface>& surface);

    [[nodiscard]] ActiveTextPresenterActivation activate(const core::TypedRuntimeUIViewState* view,
                                                         float x, float y);

    [[nodiscard]] const ActiveTextLayout& render_snapshot() const noexcept { return m_layout; }
    [[nodiscard]] bool direct_render_enabled() const noexcept { return m_direct_render_enabled; }
    [[nodiscard]] core::ActiveTextPresentationPhase presentation_phase() const noexcept;

private:
    core::Diagnostics& m_diagnostics;
    ActiveTextPlaybackState m_playback;
    ActiveTextPlaybackConfig m_playback_config{};
    std::size_t m_page_index = 0;
    std::size_t m_page_count = 1;
    std::unique_ptr<text::TextEngine> m_text_engine;
    std::unique_ptr<text::TextFontAssetLoader> m_font_loader;
    FontHandle m_font;
    ActiveTextLayout m_layout;
    std::string m_content_key;
    double m_time_seconds = 0.0;
    bool m_direct_render_enabled = true;
};

} // namespace noveltea::ui::rmlui
