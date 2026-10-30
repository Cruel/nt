#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <string_view>

#define XXH_STATIC_LINKING_ONLY
#define XXH_INLINE_ALL
#include <xxhash.h>

namespace noveltea::core {

// Noncryptographic fingerprint for local content identity, not trusted downloads.
// XXH3 canonical high64/low64 order, independent of host endianness.
inline std::string xxh3_128_hex(std::span<const std::byte> bytes)
{
    const auto hash = XXH3_128bits(bytes.data(), bytes.size());
    char result[33]{};
    constexpr char hex[] = "0123456789abcdef";
    for (std::size_t i = 0; i < 16; ++i) {
        const auto word = i < 8 ? hash.high64 : hash.low64;
        const auto shift = static_cast<unsigned>((7 - i % 8) * 8);
        const auto byte = (word >> shift) & 255;
        result[i * 2] = hex[byte >> 4];
        result[i * 2 + 1] = hex[byte & 15];
    }
    return std::string(result, 32);
}

inline std::string xxh3_128_revision(std::span<const std::byte> bytes)
{
    return "xxh3-128:" + xxh3_128_hex(bytes);
}

inline std::string xxh3_128_revision(std::string_view bytes)
{
    return xxh3_128_revision(std::as_bytes(std::span(bytes.data(), bytes.size())));
}

class Xxh3Hasher {
public:
    Xxh3Hasher() { XXH3_128bits_reset(&state_); }

    void update(std::string_view bytes)
    {
        XXH3_128bits_update(&state_, bytes.data(), bytes.size());
    }

    [[nodiscard]] std::string finish() const
    {
        const auto hash = XXH3_128bits_digest(&state_);
        XXH128_canonical_t canonical{};
        XXH128_canonicalFromHash(&canonical, hash);
        constexpr char hex[] = "0123456789abcdef";
        std::string result = "xxh3-128:";
        result.reserve(41);
        for (unsigned char byte : canonical.digest) {
            result.push_back(hex[byte >> 4]);
            result.push_back(hex[byte & 15]);
        }
        return result;
    }

private:
    XXH3_state_t state_{};
};

} // namespace noveltea::core
