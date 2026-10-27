#include "native_cli_platform_stage.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <tuple>

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
              "\"nonce\":\"123-456\",\"accepted\":" + (accepted ? "true" : "false") +
              ",\"rollingBack\":false,\"outputs\":[{\"kind\":\"directory\",\"removeOnly\":false,"
              "\"hadPrevious\":" +
              (prior_directory ? "true" : "false") +
              "},{\"kind\":\"archive\",\"removeOnly\":false,\"hadPrevious\":" +
              (prior_archive ? "true" : "false") + "}]}");
}

void retirement_journal(const fs::path& output, bool accepted = false, bool rolling_back = false,
                        bool had_symbols = true)
{
    write(
        output.string() + ".noveltea-publication-transaction.json",
        std::string{"{\"format\":\"noveltea.native-platform-publication\",\"nonce\":\"123-456\","} +
            "\"accepted\":" + (accepted ? "true" : "false") +
            ",\"rollingBack\":" + (rolling_back ? "true" : "false") +
            ",\"outputs\":["
            "{\"kind\":\"directory\",\"hadPrevious\":true,\"removeOnly\":false},"
            "{\"kind\":\"archive\",\"hadPrevious\":true,\"removeOnly\":false},"
            "{\"kind\":\"symbols\",\"hadPrevious\":" +
            (had_symbols ? "true" : "false") + ",\"removeOnly\":true}]}");
}

void expect_conflict(const fs::path& output)
{
    std::string error;
    noveltea::cli::PlatformPublicationLock lock(output);
    require(!noveltea::cli::recover_native_platform_publication(output, lock, error),
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
        {
            noveltea::cli::PlatformPublicationLock lock(rollback);
            require(noveltea::cli::recover_native_platform_publication(rollback, lock, error),
                    error);
        }
        require(read(rollback / "marker") == "old-directory", "Directory rollback failed.");
        require(read(rollback.string() + ".zip") == "old-archive", "Archive rollback failed.");
        require(!fs::exists(rollback.string() + ".noveltea-publication-transaction.json"),
                "Recovered journal must be removed.");

        // Recovery can be terminated after restoring the archive but before
        // restoring the directory. A durable rollback intent makes the next
        // invocation complete the interrupted pass instead of failing.
        const auto resumed = temp / "resumed";
        fs::create_directory(resumed);
        write(resumed / "marker", "new-directory");
        fs::create_directory(resumed.string() + ".previous-123-456");
        write(resumed.string() + ".previous-123-456/marker", "old-directory");
        write(resumed.string() + ".zip", "old-archive");
        journal(resumed, false, true, true);
        {
            auto file = resumed.string() + ".noveltea-publication-transaction.json";
            auto contents = read(file);
            const auto marker = contents.find("\"rollingBack\":false");
            require(marker != std::string::npos, "Fixture rollback marker absent.");
            contents.replace(marker, std::string{"\"rollingBack\":false"}.size(),
                             "\"rollingBack\":true");
            write(file, contents);
        }
        write(resumed.string() + ".noveltea-publication-transaction.json.new-123-456",
              "incomplete journal rewrite");
        {
            noveltea::cli::PlatformPublicationLock lock(resumed);
            require(noveltea::cli::recover_native_platform_publication(resumed, lock, error),
                    error);
        }
        require(read(resumed / "marker") == "old-directory",
                "Interrupted rollback did not resume.");
        require(read(resumed.string() + ".zip") == "old-archive", "Restored archive was changed.");
        require(
            !fs::exists(resumed.string() + ".noveltea-publication-transaction.json.new-123-456"),
            "Interrupted journal update debris must be cleared when rollback resumes.");

        // The recovery API itself must never traverse a linked parent.
        const auto linked = temp / "linked";
        fs::create_directory(temp / "real");
        fs::create_directory(temp / "real/dist");
        write(temp / "real/dist.zip", "old");
        journal(temp / "real/dist", false, true, true);
        fs::create_directory(temp / "real/dist.previous-123-456");
        std::error_code symlink_error;
        fs::create_directory_symlink(temp / "real", linked, symlink_error);
        if (!symlink_error) {
            try {
                noveltea::cli::PlatformPublicationLock lock(linked / "dist");
                require(false, "Linked-parent recovery unexpectedly acquired a lock.");
            } catch (const std::runtime_error&) {
                require(fs::exists(temp / "real/dist.noveltea-publication-transaction.json"),
                        "Linked-parent recovery mutated the journal.");
            }
        }

        // A second invocation cannot recover a journal while its publisher
        // still holds the destination lease, even in the same process.
        const auto busy = temp / "busy";
        {
            noveltea::cli::PlatformPublicationLock publisher(busy);
            bool rejected = false;
            try {
                noveltea::cli::PlatformPublicationLock second(busy);
            } catch (const std::runtime_error&) {
                rejected = true;
            }
            require(rejected, "Live publisher's destination lock must be exclusive.");
        }

        // Removing an obsolete symbols archive is an accepted, recoverable
        // operation, not an unrelated deletion after publishing the new ZIP.
        const auto retired = temp / "retired";
        fs::create_directory(retired);
        write(retired.string() + ".zip", "new-archive");
        write(retired.string() + "-symbols.zip.previous-123-456", "old-symbols");
        write(retired.string() + ".noveltea-publication-transaction.json",
              "{\"format\":\"noveltea.native-platform-publication\",\"nonce\":\"123-456\","
              "\"accepted\":true,\"rollingBack\":false,\"outputs\":["
              "{\"kind\":\"directory\",\"hadPrevious\":false,\"removeOnly\":false},"
              "{\"kind\":\"archive\",\"hadPrevious\":false,\"removeOnly\":false},"
              "{\"kind\":\"symbols\",\"hadPrevious\":true,\"removeOnly\":true}]}");
        {
            noveltea::cli::PlatformPublicationLock lock(retired);
            require(noveltea::cli::recover_native_platform_publication(retired, lock, error),
                    error);
        }
        require(!fs::exists(retired.string() + "-symbols.zip.previous-123-456"),
                "Accepted symbols retirement must clear the obsolete backup.");

        // The remove-only symbols member NEVER has a stage. A crash between
        // replacing the directory/ZIP and backing up the obsolete symbols
        // leaves the incumbent in its final location; recover the entire set.
        // Also cover interruption after backing up the symbols, and after a
        // restarted rollback restored the symbols but not the other members.
        for (const auto& [suffix, backup_taken, rolling_back] :
             {std::tuple{std::string{"before-symbols-backup"}, false, false},
              std::tuple{std::string{"after-symbols-backup"}, true, false},
              std::tuple{std::string{"resumed-symbols-rollback"}, false, true}}) {
            const auto output = temp / suffix;
            fs::create_directory(output);
            write(output / "marker", "new-directory");
            fs::create_directory(output.string() + ".previous-123-456");
            write(output.string() + ".previous-123-456/marker", "old-directory");
            write(output.string() + ".zip", "new-archive");
            write(output.string() + ".zip.previous-123-456", "old-archive");
            const auto symbols_path = output.string() + "-symbols.zip";
            write(symbols_path + (backup_taken ? ".previous-123-456" : ""), "old-symbols");
            retirement_journal(output, false, rolling_back);
            {
                noveltea::cli::PlatformPublicationLock lock(output);
                error.clear();
                require(noveltea::cli::recover_native_platform_publication(output, lock, error),
                        suffix + ": " + error);
            }
            require(read(output / "marker") == "old-directory",
                    suffix + ": previous directory not restored");
            require(read(output.string() + ".zip") == "old-archive",
                    suffix + ": previous archive not restored");
            require(read(symbols_path) == "old-symbols",
                    suffix + ": previous symbols not restored");
            require(!fs::exists(output.string() + ".noveltea-publication-transaction.json"),
                    suffix + ": rollback journal still exists");
            require(!fs::exists(symbols_path + ".previous-123-456"),
                    suffix + ": symbols backup not consumed");
        }

        // With no prior symbols archive, the journal cannot own a new file
        // that appeared at the retirement path. Recovery must not delete it.
        const auto foreign = temp / "foreign-symbols";
        fs::create_directory(foreign);
        write(foreign.string() + ".zip", "new-archive");
        write(foreign.string() + "-symbols.zip", "other-publisher");
        retirement_journal(foreign, false, false, false);
        expect_conflict(foreign);
        require(read(foreign.string() + "-symbols.zip") == "other-publisher",
                "Recovery must not remove symbols never owned by this transaction.");

        noveltea::cli::PlatformExportTools tools;
        tools.cancelled = [] { return true; };
        tools.prepare_package = [](const auto&, const auto&, const auto&) {
            return noveltea::cli::PlatformJson::object();
        };
        tools.create_archive = [](const auto&) { return noveltea::cli::PlatformJson::object(); };
        tools.resize_image = [](const auto&) { return noveltea::cli::PlatformJson::object(); };
        tools.physical_sources_current = [](const auto&) { return true; };
        noveltea::cli::PlatformPublicationLock cancel_lock(temp / "not-published");
        const noveltea::cli::PlatformResolvedExportSettings unsigned_settings{
            {{"javaHome", "/unused/jdk"}}, noveltea::cli::PlatformJson::object(), false};
        const auto cancelled = noveltea::cli::stage_native_platform_export(
            {{}}, {{"target", "windows"}}, {{}}, temp, temp / "icon.png", temp / "not-published",
            false, false, false, false, unsigned_settings, cancel_lock, tools, [] { return true; });
        require(cancelled.envelope.value("exitCode", 0) == 130 &&
                    cancelled.envelope.value("cancelled", false) &&
                    cancelled.envelope.at("diagnostics").front().at("code") == "export-cancelled",
                "Native platform cancellation must preserve CLI exit and JSON contracts.");
        require(!fs::exists(temp / "not-published"),
                "Cancelled export must not publish a distribution.");
        // Signed requests must reach the common stage with their resolved
        // credentials and still fail closed before preparing or publishing.
        const noveltea::cli::PlatformResolvedExportSettings signed_settings{
            {{"javaHome", "/unused/jdk"}},
            {{"windows",
              {{"command", "signtool"},
               {"args", noveltea::cli::PlatformJson::array()},
               {"verifyCommand", "signtool"},
               {"verifyArgs", noveltea::cli::PlatformJson::array()}}}},
            true};
        const auto not_signed = noveltea::cli::stage_native_platform_export(
            {{}}, {{"target", "windows"}}, {{}}, temp, temp / "icon.png", temp / "not-published",
            false, false, false, false, signed_settings, cancel_lock, tools, [] { return true; });
        require(not_signed.envelope.value("exitCode", 0) == 70 &&
                    not_signed.envelope.at("diagnostics").front().at("code") ==
                        "CLI_NATIVE_CANDIDATE_UNCLAIMED",
                "Resolved signing must not be silently discarded by the common stage.");
        require(!fs::exists(temp / "not-published"),
                "Unsupported signed export must not publish any output.");
        const auto no_signer = noveltea::cli::stage_native_platform_export(
            {{}}, {{"target", "windows"}}, {{}}, temp, temp / "icon.png", temp / "not-published",
            false, false, false, false,
            noveltea::cli::PlatformResolvedExportSettings{
                noveltea::cli::PlatformJson::object(), noveltea::cli::PlatformJson::object(), true},
            cancel_lock, tools, [] { return true; });
        require(no_signer.envelope.at("diagnostics").front().at("code") ==
                    "platform.signing_profile_required",
                "Common stage must reject an unbound signed request.");
        std::cout << "Native platform publication recovery passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
