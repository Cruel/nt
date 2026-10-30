#include "native_cli_windows_pe.hpp"

#include <LIEF/PE/Binary.hpp>
#include <LIEF/PE/Builder.hpp>
#include <LIEF/PE/OptionalHeader.hpp>
#include <LIEF/PE/Parser.hpp>
#include <LIEF/PE/ResourceData.hpp>
#include <LIEF/PE/ResourceDirectory.hpp>
#include <LIEF/PE/ResourceNode.hpp>
#include <LIEF/PE/ResourcesManager.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::cli {
namespace {
using Bytes = std::vector<std::uint8_t>;

std::string path_text(const std::filesystem::path& path)
{
    const auto encoded = path.u8string();
    return {encoded.begin(), encoded.end()};
}

Bytes read_bytes(const std::filesystem::path& path, std::uintmax_t limit)
{
    std::error_code error;
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > limit)
        throw std::runtime_error("Invalid Windows resource input: " + path_text(path));
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Cannot read Windows resource input: " + path_text(path));
    Bytes bytes(static_cast<std::size_t>(size));
    if (!bytes.empty() && !stream.read(reinterpret_cast<char*>(bytes.data()),
                                       static_cast<std::streamsize>(bytes.size())))
        throw std::runtime_error("Short Windows resource input: " + path_text(path));
    return bytes;
}

std::uint16_t u16_at(const Bytes& data, std::size_t offset)
{
    if (offset > data.size() || data.size() - offset < 2)
        throw std::runtime_error("Truncated ICO directory.");
    return static_cast<std::uint16_t>(data[offset] | (data[offset + 1] << 8));
}

std::uint32_t u32_at(const Bytes& data, std::size_t offset)
{
    return static_cast<std::uint32_t>(u16_at(data, offset)) |
           (static_cast<std::uint32_t>(u16_at(data, offset + 2)) << 16);
}

void u16(Bytes& data, std::uint16_t value)
{
    data.push_back(static_cast<std::uint8_t>(value));
    data.push_back(static_cast<std::uint8_t>(value >> 8));
}

void u32(Bytes& data, std::uint32_t value)
{
    u16(data, static_cast<std::uint16_t>(value));
    u16(data, static_cast<std::uint16_t>(value >> 16));
}

void align_four(Bytes& data)
{
    while ((data.size() & 3u) != 0)
        data.push_back(0);
}

// Resource strings are UTF-16LE. Reject malformed UTF-8 instead of silently
// publishing a mismatched Windows display name.
void utf16(Bytes& data, std::string_view source)
{
    for (std::size_t i = 0; i < source.size();) {
        const auto lead = static_cast<std::uint8_t>(source[i]);
        std::uint32_t codepoint = 0;
        std::size_t count = 0;
        if (lead < 0x80) {
            codepoint = lead;
            count = 1;
        } else if ((lead & 0xe0u) == 0xc0u) {
            codepoint = lead & 0x1fu;
            count = 2;
        } else if ((lead & 0xf0u) == 0xe0u) {
            codepoint = lead & 0x0fu;
            count = 3;
        } else if ((lead & 0xf8u) == 0xf0u) {
            codepoint = lead & 0x07u;
            count = 4;
        } else {
            throw std::runtime_error("Invalid UTF-8 Windows resource string.");
        }
        if (i + count > source.size())
            throw std::runtime_error("Truncated UTF-8 Windows resource string.");
        for (std::size_t c = 1; c < count; ++c) {
            const auto byte = static_cast<std::uint8_t>(source[i + c]);
            if ((byte & 0xc0u) != 0x80u)
                throw std::runtime_error("Invalid UTF-8 Windows resource string.");
            codepoint = (codepoint << 6) | (byte & 0x3fu);
        }
        if ((count == 2 && codepoint < 0x80) || (count == 3 && codepoint < 0x800) ||
            (count == 4 && codepoint < 0x10000) || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff) || codepoint < 0x20 || codepoint == 0x7f)
            throw std::runtime_error("Noncanonical UTF-8 Windows resource string.");
        if (codepoint < 0x10000) {
            u16(data, static_cast<std::uint16_t>(codepoint));
        } else {
            codepoint -= 0x10000;
            u16(data, static_cast<std::uint16_t>(0xd800 + (codepoint >> 10)));
            u16(data, static_cast<std::uint16_t>(0xdc00 + (codepoint & 0x3ffu)));
        }
        i += count;
    }
    u16(data, 0);
}

Bytes resource_block(std::string_view key, Bytes value, const Bytes& children,
                     std::uint16_t value_length, std::uint16_t type)
{
    Bytes data;
    u16(data, 0); // size, backfilled once children are appended
    u16(data, value_length);
    u16(data, type);
    utf16(data, key);
    align_four(data);
    data.insert(data.end(), value.begin(), value.end());
    align_four(data);
    data.insert(data.end(), children.begin(), children.end());
    if (data.size() > std::numeric_limits<std::uint16_t>::max())
        throw std::runtime_error("Windows version resource exceeds 64 KiB.");
    data[0] = static_cast<std::uint8_t>(data.size());
    data[1] = static_cast<std::uint8_t>(data.size() >> 8);
    return data;
}

std::array<std::uint16_t, 4> version_parts(std::string_view version)
{
    std::array<std::uint16_t, 4> parts{};
    std::size_t index = 0;
    for (std::size_t i = 0; i < version.size() && index < parts.size();) {
        if (version[i] < '0' || version[i] > '9') {
            ++i;
            continue;
        }
        unsigned value = 0;
        while (i < version.size() && version[i] >= '0' && version[i] <= '9') {
            value = std::min(65535u, value * 10u + static_cast<unsigned>(version[i] - '0'));
            ++i;
        }
        parts[index++] = static_cast<std::uint16_t>(value);
    }
    return parts;
}

Bytes version_resource(const WindowsPeIdentity& identity)
{
    const auto version = version_parts(identity.version_name);
    const auto major_minor = (static_cast<std::uint32_t>(version[0]) << 16) | version[1];
    const auto build_revision = (static_cast<std::uint32_t>(version[2]) << 16) | version[3];
    Bytes fixed;
    for (const auto value : {0xfeef04bdu, 0x00010000u, major_minor, build_revision, major_minor,
                             build_revision, 0x3fu, 0u, 0x00040004u, 1u, 0u, 0u, 0u})
        u32(fixed, value);

    Bytes strings;
    for (const auto& [key, value] : std::array<std::pair<std::string_view, std::string>, 6>{{
             {"FileDescription", identity.display_name},
             {"FileVersion", identity.version_name},
             {"InternalName", identity.executable_name},
             {"OriginalFilename", identity.executable_name + ".exe"},
             {"ProductName", identity.display_name},
             {"ProductVersion", identity.version_name},
         }}) {
        Bytes encoded;
        utf16(encoded, value);
        if (encoded.size() / 2 > std::numeric_limits<std::uint16_t>::max())
            throw std::runtime_error("Windows version string exceeds resource limits.");
        const auto length = static_cast<std::uint16_t>(encoded.size() / 2);
        const auto entry = resource_block(key, std::move(encoded), {}, length, 1);
        strings.insert(strings.end(), entry.begin(), entry.end());
    }
    const auto table = resource_block("040904B0", {}, strings, 0, 1);
    const auto string_info = resource_block("StringFileInfo", {}, table, 0, 1);
    Bytes translation;
    u16(translation, 1033);
    u16(translation, 1200);
    const auto translation_block = resource_block("Translation", translation, {}, 4, 0);
    const auto var_info = resource_block("VarFileInfo", {}, translation_block, 0, 1);
    Bytes children = string_info;
    children.insert(children.end(), var_info.begin(), var_info.end());
    return resource_block("VS_VERSION_INFO", fixed, children, 52, 0);
}

std::string escape_xml(std::string_view value)
{
    std::string out;
    for (const auto character : value) {
        switch (character) {
        case '&':
            out += "&amp;";
            break;
        case '<':
            out += "&lt;";
            break;
        case '>':
            out += "&gt;";
            break;
        case '"':
            out += "&quot;";
            break;
        case '\'':
            out += "&apos;";
            break;
        default:
            if (static_cast<unsigned char>(character) < 0x20 && character != '\n' &&
                character != '\r' && character != '\t')
                throw std::runtime_error("Invalid Windows application ID.");
            out += character;
        }
    }
    return out;
}

std::string windows_manifest(std::string_view application_id)
{
    return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
           "<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\">\n"
           "  <assemblyIdentity version=\"1.0.0.0\" processorArchitecture=\"*\" name=\"" +
           escape_xml(application_id) +
           "\" type=\"win32\"/>\n"
           "  <trustInfo xmlns=\"urn:schemas-microsoft-com:asm.v3\"><security>"
           "<requestedPrivileges><requestedExecutionLevel level=\"asInvoker\" uiAccess=\"false\"/>"
           "</requestedPrivileges></security></trustInfo>\n"
           "  <compatibility xmlns=\"urn:schemas-microsoft-com:compatibility.v1\">"
           "<application><supportedOS Id=\"{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}\"/>"
           "</application></compatibility>\n"
           "  <application xmlns=\"urn:schemas-microsoft-com:asm.v3\"><windowsSettings>\n"
           "    <dpiAware xmlns=\"http://schemas.microsoft.com/SMI/2005/WindowsSettings\">"
           "true/pm</dpiAware>\n"
           "    <dpiAwareness xmlns=\"http://schemas.microsoft.com/SMI/2016/WindowsSettings\">"
           "PerMonitorV2,PerMonitor</dpiAwareness>\n"
           "    <longPathAware xmlns=\"http://schemas.microsoft.com/SMI/2016/WindowsSettings\">"
           "true</longPathAware>\n"
           "  </windowsSettings></application>\n</assembly>";
}

void replace_resource_type(LIEF::PE::ResourceNode& root, std::uint32_t type,
                           const std::vector<std::pair<std::uint32_t, Bytes>>& resources)
{
    bool present = false;
    for (const auto& node : root.childs())
        if (node.id() == type)
            present = true;
    if (present)
        root.delete_child(type);
    auto directory = std::make_unique<LIEF::PE::ResourceDirectory>(type);
    for (const auto& [id, bytes] : resources) {
        auto entry = std::make_unique<LIEF::PE::ResourceDirectory>(id);
        auto language = std::make_unique<LIEF::PE::ResourceData>(bytes);
        language->id(1033);
        entry->add_child(std::move(language));
        directory->add_child(std::move(entry));
    }
    root.add_child(std::move(directory));
}

std::pair<std::vector<std::pair<std::uint32_t, Bytes>>, Bytes> decode_ico(const Bytes& ico)
{
    if (ico.size() < 6 || u16_at(ico, 0) != 0 || u16_at(ico, 2) != 1)
        throw std::runtime_error("Invalid Windows ICO header.");
    const auto count = u16_at(ico, 4);
    if (count == 0 || count > 255 || ico.size() < 6u + 16u * count)
        throw std::runtime_error("Invalid Windows ICO image count.");
    Bytes group;
    u16(group, 0);
    u16(group, 1);
    u16(group, count);
    std::vector<std::pair<std::uint32_t, Bytes>> images;
    for (std::uint32_t index = 0; index < count; ++index) {
        const auto entry = 6u + 16u * index;
        const auto length = u32_at(ico, entry + 8);
        const auto offset = u32_at(ico, entry + 12);
        if (length == 0 || offset < 6u + 16u * count || offset > ico.size() ||
            length > ico.size() - offset)
            throw std::runtime_error("ICO image extent is invalid.");
        group.insert(group.end(), ico.begin() + entry, ico.begin() + entry + 12);
        u16(group, static_cast<std::uint16_t>(index + 1));
        images.emplace_back(index + 1, Bytes(ico.begin() + offset, ico.begin() + offset + length));
    }
    return {std::move(images), std::move(group)};
}
} // namespace

void customize_windows_player(const std::filesystem::path& input_executable,
                              const std::filesystem::path& output_executable,
                              const std::filesystem::path& icon_file,
                              const WindowsPeIdentity& identity)
{
    if (identity.executable_name.empty() || identity.executable_name.starts_with('.') ||
        identity.display_name.empty() || identity.application_id.empty())
        throw std::runtime_error("Windows executable identity is incomplete.");
    for (const auto character : identity.executable_name)
        if (static_cast<unsigned char>(character) < 0x20 ||
            std::string_view("<>:\"/\\|?*").find(character) != std::string_view::npos)
            throw std::runtime_error("Windows executable filename is invalid.");
    const auto source = read_bytes(input_executable, 1024ull * 1024 * 1024);
    auto binary = LIEF::PE::Parser::parse(source);
    if (!binary ||
        binary->optional_header().subsystem() != LIEF::PE::OptionalHeader::SUBSYSTEM::WINDOWS_GUI ||
        !binary->resources())
        throw std::runtime_error("Windows player must be a GUI PE executable with resources.");
    auto [images, group] = decode_ico(read_bytes(icon_file, 64ull * 1024 * 1024));
    auto* resources = binary->resources();
    replace_resource_type(*resources, 3, images);
    replace_resource_type(*resources, 14, {{101, std::move(group)}});
    replace_resource_type(*resources, 16, {{1, version_resource(identity)}});
    auto manager = binary->resources_manager();
    if (!manager)
        throw std::runtime_error("Cannot open Windows PE resource manager.");
    manager->manifest(windows_manifest(identity.application_id));

    // Preserve imported DLLs, TLS, relocations, code sections and overlay.
    // LIEF reconstructs just the changed resource tree.
    LIEF::PE::Builder::config_t config;
    config.resources = true;
    config.relocations = false;
    config.load_configuration = false;
    config.tls = false;
    config.debug = false;
    // The original player may have a very small .rsrc. LIEF relocates the
    // enlarged tree; give the new section a distinct name.
    config.rsrc_section = ".ntres";
    LIEF::PE::Builder builder(*binary, config);
    if (!builder.build())
        throw std::runtime_error("Failed to rebuild Windows PE resource tree.");
    std::ofstream output(output_executable, std::ios::binary | std::ios::trunc);
    if (!output)
        throw std::runtime_error("Cannot write customized Windows executable.");
    builder.write(output);
    output.flush();
    if (!output)
        throw std::runtime_error("Cannot finish customized Windows executable.");
}

} // namespace noveltea::cli
