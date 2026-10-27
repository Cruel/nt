#include "native_cli_platform_stage.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <miniz/miniz.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
namespace fs = std::filesystem;
using Json = noveltea::cli::PlatformJson;

void require(bool condition, const std::string& description)
{
    if (!condition)
        throw std::runtime_error(description);
}

void write(const fs::path& path, std::string_view bytes)
{
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    require(out.good(), "Android test fixture file write failed.");
}

std::string read(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

std::string sha(std::string_view value)
{
    return noveltea::core::sha256_hex(std::as_bytes(std::span(value.data(), value.size())));
}

void zip(const fs::path& destination, const std::map<std::string, std::string>& members)
{
    fs::create_directories(destination.parent_path());
    mz_zip_archive archive{};
    require(mz_zip_writer_init_file(&archive, destination.string().c_str(), 0) != 0,
            "Could not create Android test archive.");
    for (const auto& [name, value] : members)
        require(mz_zip_writer_add_mem(&archive, name.c_str(), value.data(), value.size(),
                                      MZ_DEFAULT_LEVEL) != 0,
                "Could not add Android ZIP member.");
    require(mz_zip_writer_finalize_archive(&archive) != 0, "Could not finalize Android test ZIP.");
    mz_zip_writer_end(&archive);
}

void certify_android_export(const fs::path& root)
{
    const auto template_root = root / "template";
    const auto sdk = root / "sdk";
    const auto jdk = root / "jdk";
    for (const auto& path :
         {jdk / "bin/java", jdk / "bin/jarsigner", sdk / "platforms/android-35/android.jar",
          sdk / "build-tools/35.0.0/aapt2", sdk / "build-tools/35.0.0/zipalign",
          sdk / "build-tools/35.0.0/apksigner"})
        write(path, "mock-tool");
#if defined(_WIN32)
    for (const auto& path :
         {jdk / "bin/java.exe", jdk / "bin/jarsigner.exe", sdk / "build-tools/35.0.0/aapt2.exe",
          sdk / "build-tools/35.0.0/zipalign.exe", sdk / "build-tools/35.0.0/lib/apksigner.jar"})
        write(path, "mock-tool");
#endif
    write(jdk / "release", "JAVA_VERSION=\"17.0.9\"\n");

    Json descriptor{
        {"templateId", "android-arm64-test"},
        {"buildId", "android-test-build"},
        {"files", Json::array()},
        {"android",
         {{"gradleProjectRoot", "source/android"},
          {"gradleWrapperPath", "source/android/gradlew"},
          {"bundletoolPath", "source/android/tools/bundletool-1.18.1.jar"},
          {"applicationModule", "app"},
          {"activityClass", "org.noveltea.player.MainActivity"},
          {"nativeLibraryName", "noveltea-player"},
          {"targetSdk", 35},
          {"compileSdk", 35},
          {"toolchain", {{"java", "17"}, {"gradle", "8.9"}, {"buildTools", "35.0.0"}}}}}};
    const auto add_template = [&](std::string relative, std::string bytes, int mode = 0644) {
        write(template_root / relative, bytes);
        descriptor["files"].push_back(
            {{"path", relative}, {"sha256", sha(bytes)}, {"size", bytes.size()}, {"mode", mode}});
    };
    add_template("source/android/gradlew", "mock-wrapper", 0755);
    add_template("source/android/gradle/wrapper/gradle-wrapper.properties",
                 "distributionUrl=https://services.gradle.org/distributions/gradle-8.9-bin.zip\n");
    add_template("source/android/gradle/wrapper/gradle-wrapper.jar", "mock-gradle-wrapper");
    add_template("source/android/tools/bundletool-1.18.1.jar", "mock-bundletool");
    add_template("source/android/prebuilt-native/arm64-v8a/libnoveltea-player.so", "native-player");
    add_template("source/android/prebuilt-system/fonts/LiberationSans.ttf", "certified-font");
    add_template("licenses/index.json", "license-index");
    add_template("licenses/NOVELTEA.txt", "copyright");
    write(template_root / "template.json", descriptor.dump());
    write(template_root / ".noveltea-template.json", "{}");
    write(root / "icon.png", "source-icon");

    const Json admission{{"profile", Json::object()},
                         {"project",
                          {{"settings",
                            {{"app",
                              {{"applicationId", "com.example.tea"},
                               {"displayName", "Tea & Tales"},
                               {"versionName", "2.4.1"},
                               {"saveNamespace", "tea-save"},
                               {"buildNumber", 10},
                               {"android",
                                {{"applicationId", "org.noveltea.test"},
                                 {"versionCode", 41},
                                 {"allowBackup", false},
                                 {"isGame", true}}}}}}}}}};
    const Json profile{{"target", "android"},
                       {"architecture", "arm64"},
                       {"buildFlavor", "release"},
                       {"packageAccess", "android-private-copy"},
                       {"android", {{"abi", "arm64-v8a"}, {"artifact", "both"}, {"minSdk", 24}}},
                       {"localization", Json::object()},
                       {"assetMemory", {{"kind", "builtin"}, {"preset", "balanced"}}}};
    const Json package_options{{"kind", "runtime"},
                               {"display",
                                {{"reference_resolution", {{"width", 800}, {"height", 600}}},
                                 {"world_raster_policy", "pixel-perfect"},
                                 {"bar_color", "#000000"}}},
                               {"accessibility", {{"ui_scale", 1.0}, {"text_scale", 1.0}}}};
    const noveltea::cli::PlatformResolvedExportSettings settings{
        {{"javaHome", jdk.string()}, {"androidSdk", sdk.string()}}, Json::object(), false};
    noveltea::cli::PlatformExportTools tools;
    bool shader_ok = false;
    bool fail_gradle = false;
    bool fail_after_build = false;
    bool corrupt_system = false;
    bool sign_release = false;
    fs::path last_generated;
    tools.prepare_package = [&](const Json&, const Json& native_profile, const fs::path& target) {
        shader_ok = native_profile.at("shaderVariants") == Json::array({"essl-300"});
        write(target, "runtime-game-payload");
        return Json{{"ok", true},
                    {"artifact",
                     {{"compiledProject", Json::object()}, {"packageOptions", package_options}}}};
    };
    tools.resize_image = [&](const Json& request) {
        write(request.at("outputPath").get<std::string>(), "icon-bytes");
        return Json{{"ok", true}};
    };
    tools.physical_sources_current = [](const Json&) { return true; };
    tools.inspect_command = [&](const std::string& command,
                                const std::vector<std::string>& arguments,
                                const fs::path&) -> std::optional<std::string> {
#if defined(_WIN32)
        require(command != "env" && !command.empty(),
                "Windows Android inspection must use argv tools.");
#else
        require(command == "env", "Android inspection must use the isolated host-tool runner.");
#endif
        const auto file = arguments.empty() ? std::string{} : arguments.back();
        if (std::any_of(arguments.begin(), arguments.end(),
                        [](const auto& arg) { return arg == "badging"; }))
            return "package: name='org.noveltea.test' versionCode='41' "
                   "versionName='2.4.1'\nminSdkVersion:'24'\ntargetSdkVersion:'35'\nuses-"
                   "permission: name='android.permission.VIBRATE'\n";
        if (std::any_of(arguments.begin(), arguments.end(),
                        [](const auto& arg) { return arg == "xmltree"; }))
            return "E: activity (line=1)\nA: android:screenOrientation(0x0101001e)=6\n"
                   "A: android:allowBackup(0x01010280)=false\n"
                   "A: android:dataExtractionRules(0x0101063c)=@0x7f000001\n"
                   "A: android:fullBackupContent(0x010104eb)=@0x7f000002\n"
                   "A: android:appCategory(0x0101054c)=0\n"
                   "org.noveltea.player.MainActivity\nnoveltea-player\n";
        if (file.ends_with(".aab"))
            return sign_release ? "jar verified.\n" : "jar is unsigned.\n";
        return std::nullopt;
    };
    tools.run_signing_command = [&](const std::string& command,
                                    const std::vector<std::string>& arguments,
                                    const fs::path& cwd) {
#if defined(_WIN32)
        require(command != "env" && !command.empty(), "Windows Android tools must use argv tools.");
#else
        require(command == "env", "Android tools must run with an isolated SDK/JDK environment.");
#endif
        const auto find = [&](std::string_view name) {
            return std::any_of(arguments.begin(), arguments.end(), [&](const auto& arg) {
                return arg.find(name) != std::string::npos;
            });
        };
        if (find(":app:assembleRelease") || find(":app:bundleRelease")) {
            if (fail_gradle)
                return false;
            std::string generated;
            for (const auto& arg : arguments)
                if (arg.starts_with("-PnovelteaGeneratedRoot="))
                    generated = arg.substr(std::string("-PnovelteaGeneratedRoot=").size());
            require(!generated.empty(), "Gradle was not passed generated Android sources.");
            const auto properties = read(fs::u8path(generated) / "noveltea.properties");
            require(properties.find("novelteaVersionCode=41") != std::string::npos &&
                        properties.find("novelteaApplicationId=org.noveltea.test") !=
                            std::string::npos &&
                        properties.find("novelteaAbi=arm64-v8a") != std::string::npos &&
                        properties.find("novelteaMinSdk=24") != std::string::npos,
                    "Android version code, package identity or ABI were not passed to Gradle.");
            const auto generated_root = fs::u8path(generated);
            last_generated = generated_root;
            require(read(generated_root / "AndroidManifest.xml").find("sensorLandscape") !=
                        std::string::npos,
                    "Android orientation metadata was not staged.");
            require(fs::exists(generated_root / "res/mipmap-anydpi-v26/ic_launcher.xml"),
                    "Android adaptive icon resources were not generated.");
            std::map<std::string, std::string> members{
                {"assets/noveltea/bootstrap/game.ntpkg",
                 read(generated_root / "assets/noveltea/bootstrap/game.ntpkg")},
                {"assets/noveltea/bootstrap/player.json",
                 read(generated_root / "assets/noveltea/bootstrap/player.json")},
                {"lib/arm64-v8a/libnoveltea-player.so", "native-player"},
                {"assets/system/licenses/index.json", "license-index"},
                {"assets/system/fonts/LiberationSans.ttf",
                 corrupt_system ? "corrupt-font" : "certified-font"},
                {"assets/system/licenses/NOVELTEA.txt", "copyright"}};
            const bool is_bundle = find(":app:bundleRelease");
            if (sign_release) {
                std::string signing_properties;
                for (const auto& arg : arguments)
                    if (arg.starts_with("-PnovelteaSigningProperties="))
                        signing_properties =
                            arg.substr(std::string("-PnovelteaSigningProperties=").size());
                require(!signing_properties.empty(),
                        "Signed Android release omitted keystore arguments.");
                const auto signed_values = read(signing_properties);
                require(
                    signed_values.find("storePassword=store-example-secret") != std::string::npos &&
                        signed_values.find("keyPassword=key-example-secret") != std::string::npos,
                    "Release signing credentials were not resolved from env references.");
            }
            if (is_bundle) {
                std::map<std::string, std::string> bundle;
                for (const auto& [name, value] : members)
                    bundle.emplace("base/" + name, value);
                zip(cwd / "app/build/outputs/bundle/release/app-release.aab", bundle);
            } else {
                zip(cwd / "app/build/outputs/apk/release" /
                        (sign_release ? "app-release.apk" : "app-release-unsigned.apk"),
                    members);
            }
        }
        if (find("build-apks")) {
            std::string output;
            for (const auto& arg : arguments)
                if (arg.starts_with("--output="))
                    output = arg.substr(9);
            require(!output.empty(), "bundletool output path is missing.");
            const auto derived = root / "derived-universal.apk";
            zip(derived, {{"assets/noveltea/bootstrap/game.ntpkg", "runtime-game-payload"},
                          {"assets/noveltea/bootstrap/player.json",
                           read(last_generated / "assets/noveltea/bootstrap/player.json")}});
            zip(output, {{"universal.apk", read(derived)}});
        }
        if (fail_after_build && find("zipalign"))
            return false;
        return true;
    };
    const auto output = root / "distribution";
    auto export_one = [&](bool force, auto freshness) {
        noveltea::cli::PlatformPublicationLock lock(output);
        return noveltea::cli::stage_native_platform_export(
            admission, profile, descriptor, template_root, root / "icon.png", output, force, false,
            false, false, settings, lock, tools, freshness);
    };
    const auto first = export_one(false, [] { return true; });
    require(first.envelope.value("success", false), first.envelope.dump());
    require(shader_ok, "Android runtime preparation omitted essl-300 shaders.");
    require(first.envelope.at("artifacts").size() == 3, "Expected APK, AAB and report.");
    const auto report =
        Json::parse(read(output / "Tea-Tales-2.4.1-android-arm64-v8a-export-report.json"));
    require(report.at("deployment").at("applicationId") == "org.noveltea.test" &&
                report.at("deployment").at("versionCode") == 41,
            "Export report identity/version metadata is wrong.");

    const auto original_apk = read(output / "Tea-Tales-2.4.1-android-arm64-v8a.apk");
    fail_gradle = true;
    const auto failed = export_one(true, [] { return true; });
    require(!failed.envelope.value("success", true) &&
                failed.envelope.at("diagnostics")[0].at("code") == "android-gradle-failed",
            "Gradle failure must block publication with an actionable diagnostic.");
    require(read(output / "Tea-Tales-2.4.1-android-arm64-v8a.apk") == original_apk,
            "Gradle failure replaced the previously published artifact.");
    fail_gradle = false;
    fail_after_build = true;
    const auto inspection_failed = export_one(true, [] { return true; });
    require(!inspection_failed.envelope.value("success", true),
            "Artifact readback failure must block publication.");
    require(read(output / "Tea-Tales-2.4.1-android-arm64-v8a.apk") == original_apk,
            "Readback failure replaced the previously published artifact.");
    fail_after_build = false;
    corrupt_system = true;
    const auto invalid_system = export_one(true, [] { return true; });
    require(!invalid_system.envelope.value("success", true) &&
                read(output / "Tea-Tales-2.4.1-android-arm64-v8a.apk") == original_apk,
            "Corrupt staged Android system assets must not replace the prior distribution.");
    corrupt_system = false;
    const auto stale = export_one(true, [] { return false; });
    require(!stale.envelope.value("success", true) &&
                read(output / "Tea-Tales-2.4.1-android-arm64-v8a.apk") == original_apk,
            "Stale Project inputs must leave the previous Android export unchanged.");

    const auto invalid_signing = noveltea::cli::validate_native_platform_export_settings(
        {{{"javaHome", jdk.string()}},
         {{"android",
           {{"keystorePath", "/missing"},
            {"keyAlias", "key"},
            {"storePasswordReference", "literal-secret"},
            {"keyPasswordReference", "env:KEY_PASSWORD"}}}},
         true},
        profile);
    require(invalid_signing && invalid_signing->envelope.at("diagnostics")[0].at("code") ==
                                   "platform.signing_configuration_invalid",
            "Plaintext signing password must be rejected before staging.");

#if !defined(_WIN32)
    write(root / "release-keystore.jks", "mock-keystore");
    require(setenv("NOVELTEA_TEST_STORE_SECRET", "store-example-secret", 1) == 0 &&
                setenv("NOVELTEA_TEST_KEY_SECRET", "key-example-secret", 1) == 0,
            "Could not set mock Android signing credentials.");
    const noveltea::cli::PlatformResolvedExportSettings signed_settings{
        settings.toolchains,
        {{"android",
          {{"keystorePath", (root / "release-keystore.jks").string()},
           {"keyAlias", "noveltea"},
           {"storePasswordReference", "env:NOVELTEA_TEST_STORE_SECRET"},
           {"keyPasswordReference", "env:NOVELTEA_TEST_KEY_SECRET"}}}},
        true};
    sign_release = true;
    {
        noveltea::cli::PlatformPublicationLock lock(output);
        const auto signed_result = noveltea::cli::stage_native_platform_export(
            admission, profile, descriptor, template_root, root / "icon.png", output, true, false,
            false, false, signed_settings, lock, tools, [] { return true; });
        require(signed_result.envelope.value("success", false) &&
                    signed_result.envelope.value("signingApplied", false),
                "Explicit Android keystore signing must be applied and verified.");
    }
    const auto signed_report =
        read(output / "Tea-Tales-2.4.1-android-arm64-v8a-export-report.json");
    require(signed_report.find("release-keystore") != std::string::npos &&
                signed_report.find("store-example-secret") == std::string::npos &&
                signed_report.find("key-example-secret") == std::string::npos,
            "Android signed release report exposed secret values.");
    unsetenv("NOVELTEA_TEST_STORE_SECRET");
    unsetenv("NOVELTEA_TEST_KEY_SECRET");
#endif
}
} // namespace

int main()
{
    try {
        const auto root =
            fs::temp_directory_path() /
            ("nt-native-android-" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(root);
        struct Cleanup {
            fs::path path;
            ~Cleanup()
            {
                std::error_code error;
                fs::remove_all(path, error);
            }
        } cleanup{root};
        certify_android_export(root);
        std::cout << "Native Android APK/AAB staging, readback and rollback passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
