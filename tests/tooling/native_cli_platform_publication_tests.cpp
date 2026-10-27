#include "native_cli_platform_stage.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
namespace fs = std::filesystem;

void require(bool condition, const std::string& message)
{
    if (!condition)
        throw std::runtime_error(message);
}

void write(const fs::path& path, const std::string& bytes)
{
    std::ofstream output(path, std::ios::binary);
    if (!(output << bytes))
        throw std::runtime_error("Unable to create publication fixture.");
}

std::string read(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void journal(const fs::path& output, bool accepted, bool prior_directory, bool prior_archive)
{
    write(output.string() + ".noveltea-publication-transaction.json",
          std::string{"{\"format\":\"noveltea.native-platform-publication\","} +
              "\"formatVersion\":1,\"nonce\":\"123-456\",\"accepted\":" +
              (accepted ? "true" : "false") +
              ",\"outputs\":[{\"kind\":\"directory\",\"hadPrevious\":" +
              (prior_directory ? "true" : "false") + "},{\"kind\":\"archive\",\"hadPrevious\":" +
              (prior_archive ? "true" : "false") + "}]}");
}

void expect_conflict(const fs::path& output)
{
    std::string error;
    require(!noveltea::cli::recover_native_platform_publication(output, error),
            "Ambiguous/incomplete publication must not recover as complete.");
    require(!error.empty(), "Recovery conflict must provide an explanation.");
    require(fs::exists(output.string() + ".noveltea-publication-transaction.json"),
            "Recovery conflict must retain its journal.");
}
} // namespace

int main()
{
    try {
        const auto temp =
            fs::temp_directory_path() /
            ("nt-platform-publication-" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directory(temp);
        struct Cleanup {
            fs::path root;
            ~Cleanup()
            {
                std::error_code ignored;
                fs::remove_all(root, ignored);
            }
        } cleanup{temp};

        // A lost prior backup and vanished stage make the final artifact's
        // provenance unknowable. It might be the newly activated artifact.
        const auto uncertain = temp / "uncertain";
        fs::create_directory(uncertain);
        write(uncertain / "marker", "new-build");
        write(uncertain.string() + ".zip", "original-archive");
        write(uncertain.string() + ".zip.stage-123-456", "new-archive");
        journal(uncertain, false, true, true);
        expect_conflict(uncertain);
        require(read(uncertain / "marker") == "new-build", "Recovery must preserve ambiguity.");
        require(read(uncertain.string() + ".zip.stage-123-456") == "new-archive",
                "Recovery must preserve evidence on conflict.");

        // Transaction validation must not restore the first incumbent before
        // discovering that another member has lost its own backup.
        const auto mixed = temp / "mixed";
        fs::create_directory(mixed);
        write(mixed / "marker", "new-directory");
        fs::create_directory(mixed.string() + ".previous-123-456");
        write(mixed.string() + ".previous-123-456/marker", "old-directory");
        write(mixed.string() + ".zip", "unknown-archive");
        journal(mixed, false, true, true);
        expect_conflict(mixed);
        require(read(mixed / "marker") == "new-directory",
                "Recovery must not partially mutate the distribution on conflict.");
        require(read(mixed.string() + ".previous-123-456/marker") == "old-directory",
                "Recovery must preserve all incumbent backups on conflict.");

        // Accepted journals must not silently certify missing distribution members.
        const auto missing = temp / "accepted-missing";
        fs::create_directory(missing);
        journal(missing, true, false, false);
        expect_conflict(missing);

        // A valid interrupted multi-output replacement restores both incumbents.
        const auto rollback = temp / "rollback";
        fs::create_directory(rollback);
        write(rollback / "marker", "new-directory");
        fs::create_directory(rollback.string() + ".previous-123-456");
        write(rollback.string() + ".previous-123-456/marker", "old-directory");
        write(rollback.string() + ".zip", "new-archive");
        write(rollback.string() + ".zip.previous-123-456", "old-archive");
        journal(rollback, false, true, true);
        std::string error;
        require(noveltea::cli::recover_native_platform_publication(rollback, error), error);
        require(read(rollback / "marker") == "old-directory", "Directory rollback failed.");
        require(read(rollback.string() + ".zip") == "old-archive", "Archive rollback failed.");
        require(!fs::exists(rollback.string() + ".noveltea-publication-transaction.json"),
                "Recovered journal must be removed.");

        noveltea::cli::PlatformExportTools tools;
        tools.cancelled = [] { return true; };
        tools.prepare_package = [](const auto&, const auto&, const auto&) {
            return noveltea::cli::PlatformJson::object();
        };
        tools.create_archive = [](const auto&) { return noveltea::cli::PlatformJson::object(); };
        tools.resize_image = [](const auto&) { return noveltea::cli::PlatformJson::object(); };
        tools.physical_sources_current = [](const auto&) { return true; };
        const auto cancelled = noveltea::cli::stage_native_platform_export(
            {{}}, {{"target", "windows"}}, {{}}, temp, temp / "icon.png", temp / "not-published",
            false, false, false, false, tools, [] { return true; });
        require(cancelled.envelope.value("exitCode", 0) == 130 &&
                    cancelled.envelope.value("cancelled", false) &&
                    cancelled.envelope.at("diagnostics").front().at("code") == "export-cancelled",
                "Native platform cancellation must preserve CLI exit and JSON contracts.");
        require(!fs::exists(temp / "not-published"),
                "Cancelled export must not publish a distribution.");
        std::cout << "Native platform publication recovery passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
