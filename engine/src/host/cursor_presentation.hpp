#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace noveltea::host {

enum class CursorShape : std::uint8_t {
    Default,
    Pointer,
    Text,
    Wait,
    Progress,
    Crosshair,
    Move,
    NotAllowed,
    NsResize,
    EwResize,
    NeswResize,
    NwseResize,
    Hidden,
};

[[nodiscard]] std::string_view cursor_shape_name(CursorShape shape) noexcept;

enum class CursorRequestSource : std::uint8_t {
    LayoutLua,
    GameplayLua,
    RmlUi,
    WorldHotspot,
    ProjectDefault,
    Count,
};

[[nodiscard]] std::string_view cursor_request_source_name(CursorRequestSource source) noexcept;

enum class CursorImageSampling : std::uint8_t {
    Linear,
    Nearest,
};

struct CursorImageSize {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    bool operator==(const CursorImageSize&) const = default;
};

[[nodiscard]] CursorImageSize fit_cursor_image_size(std::uint32_t width,
                                                     std::uint32_t height) noexcept;

struct CustomCursorPresentation {
    std::string id;
    std::string logical_path;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t hotspot_x = 0;
    std::uint32_t hotspot_y = 0;
    CursorImageSampling sampling = CursorImageSampling::Linear;
    bool fit_to_portable_bound = false;
    bool operator==(const CustomCursorPresentation&) const = default;
};

struct CursorPresentation {
    CursorShape shape = CursorShape::Default;
    std::optional<CustomCursorPresentation> custom;
    bool operator==(const CursorPresentation&) const = default;
};

struct CursorInspection {
    CursorShape effective = CursorShape::Default;
    std::string effective_name = "default";
    std::string source = "native-default";
    std::string owner;
    std::optional<CustomCursorPresentation> custom;
};

class CursorRealizer {
public:
    virtual ~CursorRealizer() = default;
    virtual void realize(const CursorPresentation& presentation) noexcept = 0;
    [[nodiscard]] virtual bool prepare(const CustomCursorPresentation&) noexcept { return true; }
    virtual void clear_custom() noexcept {}

protected:
    CursorRealizer() = default;
};

class CursorAuthority final {
public:
    using OwnerToken = std::uint64_t;

    explicit CursorAuthority(CursorRealizer* realizer = nullptr) noexcept;

    void bind_realizer(CursorRealizer* realizer) noexcept;
    void invalidate_realization() noexcept;
    void publish(CursorRequestSource source, OwnerToken owner, CursorShape shape,
                 std::string owner_label);
    void publish(CursorRequestSource source, OwnerToken owner, CursorPresentation presentation,
                 std::string owner_label);
    void clear(CursorRequestSource source, OwnerToken owner);
    void clear_source(CursorRequestSource source);
    void set_eligible_order(CursorRequestSource source, std::vector<OwnerToken> front_to_back);
    void resolve() noexcept;
    void reset() noexcept;

    [[nodiscard]] const CursorInspection& inspection() const noexcept;

private:
    struct Request {
        CursorPresentation presentation{};
        std::string owner_label;
    };

    struct RequestKey {
        CursorRequestSource source = CursorRequestSource::RmlUi;
        OwnerToken owner = 0;
        bool operator==(const RequestKey&) const = default;
    };

    struct RequestKeyHash {
        [[nodiscard]] std::size_t operator()(const RequestKey& key) const noexcept;
    };

    static constexpr std::size_t kSourceCount =
        static_cast<std::size_t>(CursorRequestSource::Count);
    static constexpr std::size_t source_index(CursorRequestSource source) noexcept
    {
        return static_cast<std::size_t>(source);
    }

    CursorRealizer* m_realizer = nullptr;
    std::unordered_map<RequestKey, Request, RequestKeyHash> m_requests;
    std::array<std::vector<OwnerToken>, kSourceCount> m_eligible;
    CursorInspection m_inspection{};
    std::optional<CursorPresentation> m_realized;
};

} // namespace noveltea::host
