#pragma once

#include <array>
#include <cstdint>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::cli {

struct MachOInfo {
    std::set<std::string> dependencies;
    std::set<std::string> rpaths;
    std::string install_name;
    std::string uuid;
};

// Read the arm64 slice without invoking host tooling. A Linux/Windows exporter
// must certify the same bytes as a macOS exporter, including universal binaries.
inline MachOInfo inspect_macho_arm64(std::string_view bytes)
{
    const auto number = [&](std::size_t at, unsigned width, bool big = false) -> std::uint64_t {
        if (at > bytes.size() || width > bytes.size() - at)
            throw std::runtime_error("Truncated Mach-O load command.");
        std::uint64_t value = 0;
        for (unsigned i = 0; i < width; ++i) {
            const unsigned pos = big ? i : width - 1 - i;
            value = (value << 8u) | static_cast<unsigned char>(bytes[at + pos]);
        }
        return value;
    };
    std::size_t base = 0;
    std::size_t size = bytes.size();
    // Universal/fat headers are big-endian by convention; support both
    // 32- and 64-bit arch tables, but reject ambiguous arm64 slices.
    if (bytes.size() >= 8 &&
        (number(0, 4, true) == 0xcafebabe || number(0, 4, true) == 0xcafebabf)) {
        const bool fat64 = number(0, 4, true) == 0xcafebabf;
        const auto count = number(4, 4, true);
        const std::size_t step = fat64 ? 32 : 20;
        if (count == 0 || count > 64 || 8 + count * step > bytes.size())
            throw std::runtime_error("Invalid Mach-O universal header.");
        bool found = false;
        for (std::size_t i = 0; i < count; ++i) {
            const auto offset = 8 + i * step;
            if (number(offset, 4, true) != 0x0100000c)
                continue;
            if (found)
                throw std::runtime_error("Duplicate arm64 Mach-O slices.");
            found = true;
            base = static_cast<std::size_t>(number(offset + 8, fat64 ? 8 : 4, true));
            size =
                static_cast<std::size_t>(number(offset + (fat64 ? 16 : 12), fat64 ? 8 : 4, true));
        }
        if (!found)
            throw std::runtime_error("Mach-O has no arm64 slice.");
        if (base > bytes.size() || size > bytes.size() - base)
            throw std::runtime_error("Mach-O arm64 slice lies outside file.");
    }
    if (size < 32 || number(base, 4) != 0xfeedfacf || number(base + 4, 4) != 0x0100000c)
        throw std::runtime_error("Expected a 64-bit arm64 Mach-O binary.");
    const auto commands = number(base + 16, 4);
    const auto command_size = number(base + 20, 4);
    if (commands > 16384 || command_size > size - 32)
        throw std::runtime_error("Invalid Mach-O load command table.");
    std::size_t cursor = base + 32;
    const auto end = cursor + static_cast<std::size_t>(command_size);
    MachOInfo info;
    const auto string_at = [&](std::size_t start, std::size_t limit) {
        if (start >= limit)
            throw std::runtime_error("Invalid Mach-O load command string offset.");
        const auto zero = bytes.find('\0', start);
        if (zero == std::string_view::npos || zero >= limit || zero == start)
            throw std::runtime_error("Unterminated Mach-O load command string.");
        return std::string(bytes.substr(start, zero - start));
    };
    for (std::uint64_t i = 0; i < commands; ++i) {
        if (cursor + 8 > end)
            throw std::runtime_error("Truncated Mach-O load command table.");
        const auto kind = number(cursor, 4);
        const auto length = number(cursor + 4, 4);
        if (length < 8 || length > end - cursor || length % 4)
            throw std::runtime_error("Malformed Mach-O load command.");
        const auto next = cursor + static_cast<std::size_t>(length);
        switch (kind) {
        case 0xc:                // LC_LOAD_DYLIB
        case 0x18 | 0x80000000u: // LC_LOAD_WEAK_DYLIB
        case 0x1f | 0x80000000u: // LC_REEXPORT_DYLIB
        case 0x23 | 0x80000000u: // LC_LOAD_UPWARD_DYLIB
        case 0x20:               // LC_LAZY_LOAD_DYLIB
        case 0xd: {              // LC_ID_DYLIB
            if (length < 24)
                throw std::runtime_error("Truncated Mach-O dylib command.");
            const auto name = string_at(cursor + number(cursor + 8, 4), next);
            if (kind == 0xd)
                info.install_name = name;
            else
                info.dependencies.insert(name);
            break;
        }
        case 0x1c | 0x80000000u: { // LC_RPATH
            if (length < 12)
                throw std::runtime_error("Truncated Mach-O rpath command.");
            info.rpaths.insert(string_at(cursor + number(cursor + 8, 4), next));
            break;
        }
        case 0x1b: { // LC_UUID
            if (length != 24 || !info.uuid.empty())
                throw std::runtime_error("Invalid or duplicate Mach-O UUID.");
            constexpr char hex[] = "0123456789abcdef";
            for (unsigned j = 0; j < 16; ++j) {
                const auto byte = static_cast<unsigned char>(bytes[cursor + 8 + j]);
                info.uuid += hex[byte >> 4];
                info.uuid += hex[byte & 15];
                if (j == 3 || j == 5 || j == 7 || j == 9)
                    info.uuid += '-';
            }
            break;
        }
        default:
            break;
        }
        cursor = next;
    }
    if (cursor != end || info.uuid.empty())
        throw std::runtime_error("Mach-O command table or UUID is incomplete.");
    return info;
}

} // namespace noveltea::cli
