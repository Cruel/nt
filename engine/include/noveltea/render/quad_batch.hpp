#pragma once

#include "noveltea/math/geometry.hpp"

#include <cstdint>
#include <vector>

namespace noveltea {

enum class GameLayer : uint8_t {
    Background = 0,
    Main = 1,
    Foreground = 2,
    UIOverlay = 3,
    Count
};

struct Texture {
    uint16_t handle = UINT16_MAX;

    [[nodiscard]] bool valid() const { return handle != UINT16_MAX; }
};

struct QuadCommand {
    Rect rect{};
    Rect uv{0.0f, 0.0f, 1.0f, 1.0f};
    Color color{};
    Texture texture{};
    float depth = 0.0f;
    GameLayer layer = GameLayer::Main;
};

class QuadBatch {
public:
    void clear() { m_commands.clear(); }

    void draw_colored_quad(Rect rect, Color color, float depth = 0.0f,
                           GameLayer layer = GameLayer::Main)
    {
        m_commands.push_back(QuadCommand{rect, {0.0f, 0.0f, 1.0f, 1.0f}, color, {}, depth, layer});
    }

    void draw_textured_quad(Rect rect, Texture texture, Rect uv, Color color, float depth = 0.0f,
                            GameLayer layer = GameLayer::Main)
    {
        m_commands.push_back(QuadCommand{rect, uv, color, texture, depth, layer});
    }

    [[nodiscard]] const std::vector<QuadCommand>& commands() const { return m_commands; }
    [[nodiscard]] bool empty() const { return m_commands.empty(); }

private:
    std::vector<QuadCommand> m_commands;
};

} // namespace noveltea
