#pragma once

#include <array>
#include <cmath>

namespace noveltea {

struct Vec2 {
    float x = 0.0f;
    float y = 0.0f;
};

struct Vec3 {
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

struct Size {
    float width = 0.0f;
    float height = 0.0f;
};

struct Rect {
    float x = 0.0f;
    float y = 0.0f;
    float width = 0.0f;
    float height = 0.0f;

    [[nodiscard]] bool contains(Vec2 point) const
    {
        return point.x >= x && point.y >= y
            && point.x <= x + width && point.y <= y + height;
    }
};

struct Color {
    float r = 1.0f;
    float g = 1.0f;
    float b = 1.0f;
    float a = 1.0f;

    static constexpr Color from_rgba8(unsigned r8, unsigned g8, unsigned b8, unsigned a8 = 255)
    {
        return {
            static_cast<float>(r8) / 255.0f,
            static_cast<float>(g8) / 255.0f,
            static_cast<float>(b8) / 255.0f,
            static_cast<float>(a8) / 255.0f,
        };
    }
};

struct Transform2D {
    Vec2 position{};
    Vec2 scale{1.0f, 1.0f};
    float rotation_radians = 0.0f;

    [[nodiscard]] std::array<float, 16> to_column_major_matrix() const
    {
        const float c = std::cos(rotation_radians);
        const float s = std::sin(rotation_radians);
        return {
            c * scale.x, s * scale.x, 0.0f, 0.0f,
            -s * scale.y, c * scale.y, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f,
            position.x, position.y, 0.0f, 1.0f,
        };
    }
};

struct Viewport {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

} // namespace noveltea
