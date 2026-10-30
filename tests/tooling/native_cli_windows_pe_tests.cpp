#include "native_cli_windows_pe.hpp"
#include "native_cli_paths.hpp"

#include <LIEF/PE/Binary.hpp>
#include <LIEF/PE/Factory.hpp>
#include <LIEF/PE/OptionalHeader.hpp>
#include <LIEF/PE/Parser.hpp>
#include <LIEF/PE/ResourceData.hpp>
#include <LIEF/PE/ResourceDirectory.hpp>
#include <LIEF/PE/ResourcesManager.hpp>
#include <LIEF/PE/Section.hpp>

#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
namespace fs = std::filesystem;

void require(bool accepted, const std::string& failure)
{
    if (!accepted)
        throw std::runtime_error(failure);
}

void write(const fs::path& path, const std::vector<std::uint8_t>& content)
{
    std::ofstream stream(path, std::ios::binary);
    require(static_cast<bool>(stream), "Cannot create synthetic input.");
    stream.write(reinterpret_cast<const char*>(content.data()),
                 static_cast<std::streamsize>(content.size()));
    require(static_cast<bool>(stream), "Cannot write synthetic input.");
}

void make_synthetic_gui_player(const fs::path& path)
{
    auto factory = LIEF::PE::Factory::create(LIEF::PE::PE_TYPE::PE32_PLUS);
    require(static_cast<bool>(factory), "Cannot create synthetic PE factory.");
    LIEF::PE::Section text{".text"};
    text.content(std::vector<std::uint8_t>(512, 0xc3));
    auto binary = factory->add_section(text).get();
    require(static_cast<bool>(binary), "Cannot create synthetic PE.");
    binary->optional_header().subsystem(LIEF::PE::OptionalHeader::SUBSYSTEM::WINDOWS_GUI);

    LIEF::PE::ResourceDirectory resources;
    auto manifests = std::make_unique<LIEF::PE::ResourceDirectory>(24);
    auto manifest_id = std::make_unique<LIEF::PE::ResourceDirectory>(1);
    auto manifest = std::make_unique<LIEF::PE::ResourceData>(
        "<assembly xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'/>");
    manifest->id(1033);
    manifest_id->add_child(std::move(manifest));
    manifests->add_child(std::move(manifest_id));
    resources.add_child(std::move(manifests));
    binary->set_resources(resources);
    binary->write(path.string());
}

void make_icon(const fs::path& path)
{
    // Self-contained, generated fixture. No real player/template files are
    // included or referenced by this permanent regression test.
    constexpr std::array<std::uint8_t, 70> png{
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
        0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
    // ICONDIR + 1 ICONDIRENTRY (the payload is the PNG above).
    constexpr std::array<std::uint8_t, 22> header{0, 0,  1, 0,  1, 0, 1, 1,  0, 0, 1,
                                                  0, 32, 0, 70, 0, 0, 0, 22, 0, 0, 0};
    std::vector<std::uint8_t> ico(header.begin(), header.end());
    ico.insert(ico.end(), png.begin(), png.end());
    write(path, ico);
}

bool has_resource(const LIEF::PE::ResourceNode& root, std::uint32_t type)
{
    for (const auto& node : root.childs())
        if (node.id() == type)
            return true;
    return false;
}

void check_export(const fs::path& input, const fs::path& output, const fs::path& icon)
{
    const noveltea::cli::WindowsPeIdentity identity{"Tea Game 茶", "Tea Game 茶", "2.3.4",
                                                    "com.example.noveltea"};
    noveltea::cli::customize_windows_player(input, output, icon, identity);
    auto binary = LIEF::PE::Parser::parse(output.string());
    require(static_cast<bool>(binary) && binary->resources(), "Modified PE is unreadable.");
    for (const auto type : {3u, 14u, 16u, 24u})
        require(has_resource(*binary->resources(), type), "Expected PE resource is missing.");
    const auto manager = binary->resources_manager();
    require(static_cast<bool>(manager), "Modified PE resources are invalid.");
    require(manager->has_icons() && manager->icons().size() == 1, "PE icon resources are invalid.");
    const auto versions = manager->version();
    require(versions.size() == 1, "Windows version resource is missing.");
    require(versions[0].file_info().file_version_ms == 0x00020003 &&
                versions[0].file_info().file_version_ls == 0x00040000,
            "Windows numeric version does not match.");
    const auto* strings = versions[0].string_file_info();
    require(strings != nullptr, "Windows string table is missing.");
    bool correct_name = false;
    for (const auto& table : strings->children())
        for (const auto& entry : table.entries())
            correct_name |= entry.key_u8() == "ProductName" && entry.value_u8() == "Tea Game 茶";
    require(correct_name, "Windows Unicode ProductName is missing.");
    require(manager->manifest().find("longPathAware") != std::string::npos,
            "Windows manifest is missing long-path support.");
}
} // namespace

int main(int argc, char** argv)
{
    if (argc == 3 && std::string_view(argv[1]) == "--emit-fixture") {
        try {
            // Native platform black-box tests generate this binary on demand.
            // No synthetic PE binaries or large real players enter Git.
            make_synthetic_gui_player(noveltea::cli::native_path_from_utf8(argv[2]));
            return 0;
        } catch (const std::exception& error) {
            std::cerr << error.what() << '\n';
            return 1;
        }
    }
    if (argc != 1)
        return 2;
    const auto root = fs::temp_directory_path() /
                      ("noveltea-pe-test-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        fs::create_directories(root);
        const auto input = root / "player.exe";
        const auto output = root / "custom.exe";
        const auto icon = root / "icon.ico";
        make_synthetic_gui_player(input);
        make_icon(icon);
        check_export(input, output, icon);
        write(icon, {0, 0, 0});
        bool rejected = false;
        try {
            noveltea::cli::customize_windows_player(input, output, icon,
                                                    {"Game", "Game", "1.0", "com.example.game"});
        } catch (const std::exception&) {
            rejected = true;
        }
        require(rejected, "Malformed ICO must be rejected.");
        fs::remove_all(root);
        std::cout << "Native Windows PE resource certification passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::error_code ignored;
        fs::remove_all(root, ignored);
        std::cerr << error.what() << '\n';
        return 1;
    }
}
