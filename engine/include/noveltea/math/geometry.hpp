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
        return point.x >= x && point.y >= y && point.x <= x + width && point.y <= y + height;
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
            c * scale.x, s * scale.x, 0.0f, 0.0f, -s * scale.y, c * scale.y, 0.0f, 0.0f,
            0.0f,        0.0f,        1.0f, 0.0f, position.x,   position.y,  0.0f, 1.0f,
        };
    }
};

struct Viewport {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

[[nodiscard]] inline float clamp01(float value)
{
    if (value < 0.0f)
        return 0.0f;
    if (value > 1.0f)
        return 1.0f;
    return value;
}

[[nodiscard]] inline bool point_in_triangle(Vec2 point, Vec2 a, Vec2 b, Vec2 c)
{
    const auto sign = [](Vec2 p1, Vec2 p2, Vec2 p3) {
        return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    };

    const float d1 = sign(point, a, b);
    const float d2 = sign(point, b, c);
    const float d3 = sign(point, c, a);
    const bool has_neg = d1 < 0.0f || d2 < 0.0f || d3 < 0.0f;
    const bool has_pos = d1 > 0.0f || d2 > 0.0f || d3 > 0.0f;
    return !(has_neg && has_pos);
}

} // namespace noveltea
