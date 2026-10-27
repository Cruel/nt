#include "native_cli_macho.hpp"
#include "native_cli_platform_stage.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <miniz/miniz.h>

#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {
namespace fs = std::filesystem;
using Json = noveltea::cli::PlatformJson;

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

void write(const fs::path& target, std::string_view bytes)
{
    fs::create_directories(target.parent_path());
    std::ofstream output(target, std::ios::binary);
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    require(output.good(), "Cannot write macOS export fixture.");
}

std::string read(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

std::string sha(std::string_view bytes)
{
    return noveltea::core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size())));
}

void little32(std::string& out, std::uint32_t number)
{
    for (unsigned i = 0; i < 4; ++i)
        out += static_cast<char>((number >> (i * 8)) & 255u);
}

void big32(std::string& out, std::uint32_t number)
{
    for (int shift = 24; shift >= 0; shift -= 8)
        out += static_cast<char>((number >> shift) & 255u);
}

std::string dylib_command(std::uint32_t kind, const std::string& path, unsigned prefix)
{
    const auto length = static_cast<std::uint32_t>((prefix + path.size() + 1 + 7) & ~7u);
    std::string bytes;
    little32(bytes, kind);
    little32(bytes, length);
    little32(bytes, prefix);
    if (prefix == 24) {
        little32(bytes, 0);
        little32(bytes, 0);
        little32(bytes, 0);
    }
    bytes += path;
    bytes += '\0';
    bytes.resize(length, '\0');
    return bytes;
}

std::string macho()
{
    std::string uuid;
    little32(uuid, 0x1b);
    little32(uuid, 24);
    for (unsigned i = 0; i < 16; ++i)
        uuid += static_cast<char>(i + 1);
    const auto load = dylib_command(0xc, "/usr/lib/libSystem.B.dylib", 24);
    const auto rpath = dylib_command(0x8000001c, "@executable_path/../Frameworks", 12);
    std::string result;
    little32(result, 0xfeedfacf);
    little32(result, 0x0100000c);
    little32(result, 0);
    little32(result, 2);
    little32(result, 3);
    little32(result, static_cast<std::uint32_t>(uuid.size() + load.size() + rpath.size()));
    little32(result, 0);
    little32(result, 0);
    return result + uuid + load + rpath;
}

void parser_tests()
{
    const auto bytes = macho();
    const auto parsed = noveltea::cli::inspect_macho_arm64(bytes);
    require(parsed.dependencies.contains("/usr/lib/libSystem.B.dylib"),
            "Mach-O dependency not extracted.");
    require(parsed.rpaths.contains("@executable_path/../Frameworks"),
            "Mach-O rpath not extracted.");
    require(parsed.uuid == "01020304-0506-0708-090a-0b0c0d0e0f10",
            "Mach-O UUID does not match binary bytes.");
    std::string universal;
    big32(universal, 0xcafebabe);
    big32(universal, 1);
    big32(universal, 0x0100000c);
    big32(universal, 0);
    big32(universal, 28);
    big32(universal, static_cast<std::uint32_t>(bytes.size()));
    big32(universal, 0);
    require(noveltea::cli::inspect_macho_arm64(universal + bytes).uuid == parsed.uuid,
            "Mach-O universal arm64 slice not inspected.");
    for (auto damaged : {bytes.substr(0, 47), std::string(bytes)}) {
        if (damaged.size() == bytes.size())
            damaged[4] = '\0';
        bool rejected = false;
        try {
            (void)noveltea::cli::inspect_macho_arm64(damaged);
        } catch (const std::runtime_error&) {
            rejected = true;
        }
        require(rejected, "Invalid Mach-O architecture or command bounds accepted.");
    }
}

void cross_host_export(const fs::path& root)
{
    const auto template_root = root / "template";
    const auto player_bytes = macho();
    const auto symbol_bytes = std::string("matching-symbol");
    write(template_root / "bin/player", player_bytes);
    write(template_root / "symbols/player.dSYM/Contents/Resources/DWARF/player", symbol_bytes);
    write(root / "icon.png", "fixture-icon");
    Json descriptor{
        {"templateId", "macos-fixture"},
        {"buildId", "build-123"},
        {"capabilities", Json::array({"external-url"})},
        {"macosDependencies", Json::array({"/usr/lib/libSystem.B.dylib"})},
        {"macosRpaths", Json::array({"@executable_path/../Frameworks"})},
        {"macosMachO", Json::array({{{"path", "bin/player"},
                                     {"dependencies", Json::array({"/usr/lib/libSystem.B.dylib"})},
                                     {"rpaths", Json::array({"@executable_path/../Frameworks"})},
                                     {"uuid", "01020304-0506-0708-090a-0b0c0d0e0f10"}}})},
        {"files", Json::array({{{"path", "bin/player"},
                                {"role", "player"},
                                {"size", player_bytes.size()},
                                {"sha256", sha(player_bytes)},
                                {"mode", 0755}},
                               {{"path", "symbols/player.dSYM/Contents/Resources/DWARF/player"},
                                {"role", "symbol"},
                                {"size", symbol_bytes.size()},
                                {"sha256", sha(symbol_bytes)},
                                {"mode", 0644}}})}};
    write(template_root / "template.json", descriptor.dump());
    write(template_root / ".noveltea-template.json", "{}");
    Json admission{{"profile", Json::object()},
                   {"project",
                    {{"settings",
                      {{"app",
                        {{"applicationId", "com.example.fixture"},
                         {"displayName", "Tea Fixture"},
                         {"saveNamespace", "tea-fixture"},
                         {"versionName", "1.0.0"},
                         {"defaultLocale", "en"}}}}}}}};
    Json profile{{"target", "macos"},
                 {"architecture", "arm64"},
                 {"buildFlavor", "release"},
                 {"desktop", {{"artifact", "app-bundle"}, {"executableName", "Tea"}}},
                 {"packageAccess", "bundle-resource"},
                 {"localization", Json::object()},
                 {"assetMemory", {{"kind", "builtin"}, {"preset", "balanced"}}},
                 {"includeDebugSymbols", true}};
    const Json package_options{{"kind", "runtime"},
                               {"display",
                                {{"reference_resolution", {{"width", 1280}, {"height", 720}}},
                                 {"world_raster_policy", "pixel-perfect"},
                                 {"bar_color", "#000000"}}},
                               {"accessibility", {{"ui_scale", 1.0}, {"text_scale", 1.0}}}};
    noveltea::cli::PlatformExportTools tools;
    tools.cancelled = [] { return false; };
    tools.prepare_package = [&](const Json&, const Json&, const fs::path& path) {
        write(path, "package-contents");
        return Json{{"ok", true},
                    {"artifact",
                     {{"compiledProject", Json::object()}, {"packageOptions", package_options}}}};
    };
    tools.resize_image = [&](const Json& request) {
        write(request.at("outputPath").get<std::string>(), "\x89PNG\r\n\x1a\nfixture");
        return Json{{"ok", true}};
    };
    tools.create_archive = [&](const Json& request) {
        mz_zip_archive zip{};
        const auto filename = request.at("outputPath").get<std::string>();
        require(mz_zip_writer_init_file(&zip, filename.c_str(), 0) != 0,
                "Cannot create fixture ZIP.");
        for (const auto& entry : request.at("entries")) {
            const auto src = entry.at("sourcePath").get<std::string>();
            const auto dst = entry.at("archivePath").get<std::string>();
            require(mz_zip_writer_add_file(&zip, dst.c_str(), src.c_str(), nullptr, 0,
                                           MZ_DEFAULT_LEVEL) != 0,
                    "Cannot add fixture ZIP entry.");
        }
        require(mz_zip_writer_finalize_archive(&zip) != 0, "Cannot finalize fixture ZIP.");
        mz_zip_writer_end(&zip);
        return Json{{"ok", true}};
    };
    tools.physical_sources_current = [](const Json&) { return true; };
    const noveltea::cli::PlatformResolvedExportSettings settings{};
    const auto destination = root / "Tea Fixture.app";
    {
        noveltea::cli::PlatformPublicationLock lock(destination);
        const auto result = noveltea::cli::stage_native_platform_export(
            admission, profile, descriptor, template_root, root / "icon.png", destination, false,
            false, false, false, settings, lock, tools, [] { return true; });
        require(result.envelope.value("success", false), result.envelope.dump());
    }
    require(fs::exists(destination / "Contents/MacOS/Tea"), "macOS player missing.");
    require(fs::exists(destination / "Contents/Resources/game.ntpkg"), "macOS package missing.");
    require(fs::exists(destination / "Contents/Resources/AppIcon.icns"), "macOS icon missing.");
    require(fs::exists(root / "Tea Fixture.zip"), "macOS distribution ZIP missing.");
    require(fs::exists(root / "Tea Fixture-symbols.zip"), "macOS symbols ZIP missing.");
    require(fs::exists(root / "Tea Fixture-export-manifest.json"), "macOS manifest missing.");
    const auto manifest = Json::parse(read(root / "Tea Fixture-export-manifest.json"));
    require(manifest.at("deployment").at("target") == "macos", "Incorrect macOS deployment.");
    require(manifest.at("files").is_array(), "Missing macOS bundle integrity inventory.");

    auto bad = descriptor;
    bad["macosMachO"][0]["uuid"] = "deadbeef-0000-0000-0000-000000000000";
    write(template_root / "template.json", bad.dump());
    const auto bad_destination = root / "Tampered.app";
    {
        noveltea::cli::PlatformPublicationLock lock(bad_destination);
        const auto result = noveltea::cli::stage_native_platform_export(
            admission, profile, bad, template_root, root / "icon.png", bad_destination, false,
            false, false, false, settings, lock, tools, [] { return true; });
        require(!result.envelope.value("success", true), "Tampered Mach-O was accepted.");
        require(result.envelope.at("diagnostics")[0]["code"] == "platform-template-macho",
                "Tampered Mach-O failed at the wrong boundary.");
    }
    require(!fs::exists(bad_destination), "Rejected macOS output was published.");
}
} // namespace

int main()
{
    try {
        parser_tests();
        const auto root =
            fs::temp_directory_path() /
            ("nt-native-macos-" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directory(root);
        struct Cleanup {
            fs::path root;
            ~Cleanup()
            {
                std::error_code ignored;
                fs::remove_all(root, ignored);
            }
        } cleanup{root};
        cross_host_export(root);
        std::cout << "Mach-O and cross-host native macOS export passed.\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
