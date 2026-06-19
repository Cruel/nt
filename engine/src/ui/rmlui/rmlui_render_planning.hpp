#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace noveltea::ui::rmlui {

struct FullscreenVertex {
    float x;
    float y;
    float u;
    float v;
};

[[nodiscard]] std::array<FullscreenVertex, 3> fullscreen_triangle(bool origin_bottom_left);

class LayerPoolPlan {
public:
    static constexpr uint32_t BaseLayer = 0;
    static constexpr uint32_t InvalidLayer = UINT32_MAX;

    void begin_frame();
    [[nodiscard]] uint32_t push();
    void note_allocated(uint32_t slot);
    void reset_resources();
    [[nodiscard]] uint32_t allocation_count() const { return m_allocation_count; }
    [[nodiscard]] uint32_t slot_count() const { return m_slot_count; }
    [[nodiscard]] uint32_t next_temporary() const { return m_next_temporary; }

private:
    uint32_t m_next_temporary = 1;
    uint32_t m_slot_count = 1;
    uint32_t m_allocation_count = 1;
};

enum class PostprocessTargetKind {
    Primary,
    Secondary,
    Tertiary,
    BlendMask,
    Scratch,
};

class PostprocessPoolPlan {
public:
    static constexpr uint32_t TargetCount = 5;

    void mark_allocated(PostprocessTargetKind target);
    void reset_resources();
    [[nodiscard]] bool allocated(PostprocessTargetKind target) const;
    [[nodiscard]] uint32_t allocation_count() const { return m_allocation_count; }

private:
    std::array<bool, TargetCount> m_allocated{};
    uint32_t m_allocation_count = 0;
};

enum class TextureOwnership {
    External,
    SavedLayer,
    InternalLayerAttachment,
    Postprocess,
};

enum class StencilPlan {
    D24S8,
    D0S8,
    StencilAttachment,
    Unsupported,
};

[[nodiscard]] StencilPlan choose_stencil_plan(bool d24s8_supported, bool d0s8_supported);

enum class ClipOperationPlan {
    Set,
    SetInverse,
    Intersect,
};

struct StencilClipPlan {
    uint8_t previous_ref = 1;
    uint8_t next_ref = 1;
    bool normalize_before_render = false;
};

[[nodiscard]] StencilClipPlan plan_stencil_clip_operation(uint8_t current_ref,
                                                          ClipOperationPlan operation);

struct GaussianKernel {
    std::vector<float> weights;
};

[[nodiscard]] GaussianKernel gaussian_kernel(float sigma);

enum class FilterKind {
    Invalid,
    Opacity,
    Blur,
    DropShadow,
    ColorMatrix,
    MaskImage,
};

struct FilterRecord {
    FilterKind kind = FilterKind::Invalid;
    float scalar = 1.0f;
    float sigma = 0.0f;
    std::array<float, 2> offset{};
    std::array<float, 4> color{};
    std::array<float, 16> matrix{};
    uint64_t resource = 0;
};

[[nodiscard]] FilterRecord make_opacity_filter(float value);
[[nodiscard]] FilterRecord make_brightness_filter(float value);
[[nodiscard]] FilterRecord make_contrast_filter(float value);
[[nodiscard]] FilterRecord make_invert_filter(float value);
[[nodiscard]] FilterRecord make_grayscale_filter(float value);
[[nodiscard]] FilterRecord make_sepia_filter(float value);
[[nodiscard]] FilterRecord make_hue_rotate_filter(float radians);
[[nodiscard]] FilterRecord make_saturate_filter(float value);
// Matrix storage is row-major. Vectors are treated as columns. The fourth
// column stores RGB constants and is multiplied by source alpha for
// premultiplied-alpha parity with RmlUi's GL3 renderer. Alpha is preserved.
[[nodiscard]] std::array<float, 4> apply_color_matrix(const std::array<float, 16>& row_major_matrix,
                                                      std::array<float, 4> rgba);

enum class GradientKind {
    Invalid,
    Linear,
    RepeatingLinear,
    Radial,
    RepeatingRadial,
    Conic,
    RepeatingConic,
};

struct GradientStop {
    float position = 0.0f;
    std::array<float, 4> color{};
};

struct GradientRecord {
    GradientKind kind = GradientKind::Invalid;
    std::array<float, 4> p_v{};
    std::array<GradientStop, 16> stops{};
    uint32_t stop_count = 0;
};

[[nodiscard]] GradientRecord make_invalid_gradient();

} // namespace noveltea::ui::rmlui
