#include "yaml_transaction.hpp"

#include "source_authority.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#else
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {
namespace fs = std::filesystem;
using namespace noveltea::authoring;

void require(bool okay, std::string_view why)
{
    if (!okay)
        throw std::runtime_error(std::string(why));
}

void write(const fs::path& path, std::string_view contents)
{
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    require(static_cast<bool>(out), "Cannot prepare physical transaction fixture");
}

std::string read(const fs::path& path)
{
    std::ifstream in(path, std::ios::binary);
    require(static_cast<bool>(in), "Cannot read physical transaction fixture");
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

struct TemporaryProject {
    fs::path root;
    TemporaryProject()
    {
        root = fs::temp_directory_path() /
               ("noveltea-native-yaml-transaction-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(root / "records/rooms");
    }
    ~TemporaryProject()
    {
        std::error_code ignored;
        fs::remove_all(root, ignored);
    }
};

YamlTransactionTarget change(std::string path, std::string baseline, std::string pointer,
                             std::string replacement)
{
    YamlTransactionTarget target;
    target.path = std::move(path);
    target.expected_revision = exact_source_revision(baseline);
    target.baseline_source = std::move(baseline);
    target.edits = {{std::move(pointer), std::move(replacement)}};
    return target;
}

void certify()
{
    TemporaryProject temp;
    YamlTransactionService writer(temp.root);
    const auto first = temp.root / "records/rooms/one.yaml";
    const auto second = temp.root / "records/rooms/two.yaml";
    const std::string source_a =
        "id: one\nlabel: First # owned prose\nmode: changed # intentional default\n";
    const std::string source_b = "id: two\nlabel: Second\n";
    write(first, source_a);
    write(second, source_b);
    write(temp.root / "unrelated.bin", std::string_view("\0binary", 7));

    // CRLF and LF must preserve identical comment text during formatting.
    // Exact revision/CAS still works on original bytes, and a changed comment
    // must never be accepted as a formatting-only transaction.
    const auto crlf_path = temp.root / "records/rooms/crlf.yaml";
    const std::string crlf_source =
        "# header comment\r\nid: crlf\r\nlabel: Value # inline comment\r\n";
    write(crlf_path, crlf_source);
    const auto formatted_crlf = format_yaml_source(crlf_source);
    require(formatted_crlf.accepted && formatted_crlf.source.find('\r') == std::string::npos,
            "Native YAML formatter emits normalized LF from CRLF input");
    YamlTransactionTarget crlf_format;
    crlf_format.path = "records/rooms/crlf.yaml";
    crlf_format.expected_revision = exact_source_revision(crlf_source);
    crlf_format.baseline_source = crlf_source;
    crlf_format.replacement_source = formatted_crlf.source;
    const auto crlf_prepared = writer.prepare({crlf_format}, TransactionDecision::KeepComments);
    require(crlf_prepared.accepted && crlf_prepared.targets.size() == 1,
            "CRLF source comments survive a formatting-only LF conversion");
    require(writer.commit(crlf_prepared, TransactionDecision::KeepComments).accepted &&
                read(crlf_path) == formatted_crlf.source,
            "CRLF formatting commits without changing comment text");
    const auto second_format = format_yaml_source(read(crlf_path));
    require(second_format.accepted && second_format.source == read(crlf_path),
            "Normalized YAML formatting is idempotent");
    write(crlf_path, crlf_source);
    const auto altered_comment = formatted_crlf.source.find("# inline comment");
    require(altered_comment != std::string::npos,
            "Formatted CRLF fixture retains the inline comment");
    auto tampered = formatted_crlf.source;
    tampered.replace(altered_comment, std::string("# inline comment").size(), "# altered comment");
    crlf_format.replacement_source = tampered;
    const auto rejected_comments = writer.prepare({crlf_format}, TransactionDecision::KeepComments);
    require(!rejected_comments.accepted &&
                rejected_comments.error == "YAML formatting must preserve all comment text." &&
                read(crlf_path) == crlf_source,
            "Formatting still rejects real comment text changes without writing");

    // Native staged text sources are not YAML. They still need the identical
    // exact-revision lock/journal/recovery guarantees as Project authoring.
    const auto script = temp.root / "scripts/game.lua";
    write(script, "return 1\n");
    YamlTransactionTarget text_change;
    text_change.path = "scripts/game.lua";
    text_change.baseline_source = "return 1\n";
    text_change.expected_revision = exact_source_revision(text_change.baseline_source);
    text_change.raw_text_source = "return 2 -- full-source edit\n";
    const auto text_prepared = writer.prepare({text_change}, TransactionDecision::KeepComments);
    require(text_prepared.accepted && text_prepared.targets.size() == 1,
            "Native raw text preflight accepts tracked script content without a YAML parse");
    require(writer.commit(text_prepared, TransactionDecision::KeepComments).accepted &&
                read(script) == *text_change.raw_text_source,
            "Raw Lua Save is durable and retains exact edited bytes");
    require(!writer.commit(text_prepared, TransactionDecision::KeepComments).accepted,
            "A raw text Save approval cannot replay over its newly published source");
    text_change.baseline_source = read(script);
    text_change.expected_revision = exact_source_revision(text_change.baseline_source);
    text_change.raw_text_source = "return 3\n";
    const auto text_stale = writer.prepare({text_change}, TransactionDecision::KeepComments);
    require(text_stale.accepted, "Raw text stale-revision fixture is prepared");
    write(script, "return external\n");
    require(!writer.commit(text_stale, TransactionDecision::KeepComments).accepted &&
                read(script) == "return external\n",
            "Raw text Save refuses an intervening physical source change");
    text_change.path = "scripts/../../outside.lua";
    require(!writer.prepare({text_change}, TransactionDecision::KeepComments).accepted,
            "Raw text Save refuses a path traversal");

    auto edit_a = change("records/rooms/one.yaml", source_a, "/label", "\"Updated\"");
    const auto reviewed = writer.prepare({edit_a}, TransactionDecision::KeepComments);
    require(reviewed.accepted && reviewed.targets.size() == 1 &&
                std::find(reviewed.targets.front().affected_comments.begin(),
                          reviewed.targets.front().affected_comments.end(),
                          "/label") != reviewed.targets.front().affected_comments.end(),
            "Comment preflight reports the exact changed annotated field");
    require(!writer.commit(reviewed, TransactionDecision::Cancel).accepted &&
                read(first) == source_a,
            "Cancel does not perform a physical write");
    require(!writer.commit(reviewed, TransactionDecision::RemoveComments).accepted &&
                read(first) == source_a,
            "Keep/Remove decision change invalidates the reviewed approval");
    require(writer.commit(reviewed, TransactionDecision::KeepComments).accepted &&
                read(first).find("# owned prose") != std::string::npos && read(second) == source_b,
            "Keep preserves comments and leaves unrelated tracked YAML untouched");

    auto current = read(first);
    auto default_edit = change("records/rooms/one.yaml", current, "/mode", "\"default\"");
    default_edit.edits.front().omission_default_json = "\"default\"";
    auto kept_default = writer.prepare({default_edit}, TransactionDecision::KeepComments);
    require(kept_default.accepted &&
                writer.commit(kept_default, TransactionDecision::KeepComments).accepted &&
                read(first).find("mode: default") != std::string::npos &&
                read(first).find("# intentional default") != std::string::npos,
            "Keep preserves intentional explicitly commented sparse defaults");

    current = read(first);
    auto removed_comment =
        writer.prepare({change("records/rooms/one.yaml", current, "/label", "\"Plain\"")},
                       TransactionDecision::RemoveComments);
    require(removed_comment.accepted &&
                writer.commit(removed_comment, TransactionDecision::RemoveComments).accepted &&
                read(first).find("# owned prose") == std::string::npos,
            "Remove erases only comments owned by changed YAML fields");

    current = read(first);
    auto stale_review =
        writer.prepare({change("records/rooms/one.yaml", current, "/label", "\"Reviewed\"")},
                       TransactionDecision::KeepComments);
    require(stale_review.accepted, "Preflight before external revision edit succeeds");
    write(first, current + "agent: external\n");
    require(!writer.commit(stale_review, TransactionDecision::KeepComments).accepted &&
                read(first).find("agent: external") != std::string::npos,
            "External edit after approval fails revision-CAS without overwriting the change");
    auto rebased =
        writer.prepare({change("records/rooms/one.yaml", current, "/label", "\"Rebased\"")},
                       TransactionDecision::KeepComments);
    require(rebased.accepted &&
                writer.commit(rebased, TransactionDecision::KeepComments).accepted &&
                read(first).find("agent: external") != std::string::npos &&
                read(first).find("label: Rebased") != std::string::npos,
            "Disjoint external same-file edit survives source-aware rebase");
    require(!writer
                 .prepare({change("records/rooms/one.yaml", current, "/label", "\"Clobber\"")},
                          TransactionDecision::KeepComments)
                 .accepted,
            "Same-path external edit fails closed without overwriting agent changes");

    const auto before_group_a = read(first);
    const auto before_group_b = read(second);
    auto group =
        writer.prepare({change("records/rooms/one.yaml", before_group_a, "/label", "\"Group A\""),
                        change("records/rooms/two.yaml", before_group_b, "/label", "\"Group B\"")},
                       TransactionDecision::KeepComments);
    require(group.accepted && group.targets.size() == 2,
            "Independent changed tracked YAML files form one grouped transaction");
    writer.set_after_target_hook_for_certification([](std::size_t index) {
        if (index == 0)
            throw std::runtime_error("Simulated write failure");
    });
    require(!writer.commit(group, TransactionDecision::KeepComments).accepted &&
                read(first) == before_group_a && read(second) == before_group_b,
            "Failed grouped write restores every target through journal rollback");
    writer.set_after_target_hook_for_certification({});
    require(writer.commit(group, TransactionDecision::KeepComments).accepted &&
                read(first).find("Group A") != std::string::npos &&
                read(second).find("Group B") != std::string::npos &&
                read(temp.root / "unrelated.bin") == std::string_view("\0binary", 7),
            "Successful grouped commit atomically coordinates only selected physical paths");
    require(writer.recover().accepted, "Clean recovery performs no unnecessary transaction work");

    const auto blank = temp.root / "records/rooms/new.yaml";
    YamlTransactionTarget created;
    created.path = "records/rooms/new.yaml";
    created.expected_revision = "absent";
    created.create_source = "id: new\nlabel: Created\n";
    auto create_plan = writer.prepare({created}, TransactionDecision::KeepComments);
    require(create_plan.accepted &&
                writer.commit(create_plan, TransactionDecision::KeepComments).accepted &&
                read(blank) == *created.create_source,
            "Tracked source creation participates in journal and absent CAS");
    YamlTransactionTarget erased;
    erased.path = created.path;
    erased.baseline_source = read(blank);
    erased.expected_revision = exact_source_revision(erased.baseline_source);
    erased.erase = true;
    const auto erase_plan = writer.prepare({erased}, TransactionDecision::KeepComments);
    require(erase_plan.accepted &&
                writer.commit(erase_plan, TransactionDecision::KeepComments).accepted &&
                !fs::exists(blank),
            "Explicit deletion participates in grouped atomic source transactions");

    // Binary Asset trash is a typed native transaction, not a YAML edit or a
    // second best-effort filesystem operation after the metadata is saved.
    const auto binary = temp.root / "assets/imports/certified.bin";
    const auto trashed =
        temp.root / ".noveltea/trash/assets/certified/assets/imports/certified.bin";
    const std::string binary_bytes("\0asset\xff", 7);
    write(binary, binary_bytes);
    YamlTransactionTarget asset_delete;
    asset_delete.path = "assets/imports/certified.bin";
    asset_delete.expected_revision = exact_source_revision(binary_bytes);
    asset_delete.baseline_source = binary_bytes;
    asset_delete.erase = true;
    asset_delete.raw_asset_file = true;
    YamlTransactionTarget asset_create;
    asset_create.path = ".noveltea/trash/assets/certified/assets/imports/certified.bin";
    asset_create.expected_revision = "absent";
    asset_create.create_source = binary_bytes;
    asset_create.raw_asset_file = true;
    require(!writer.prepare({asset_create}, TransactionDecision::KeepComments).targets.empty(),
            "Admitted binary Asset may be written into Project trash");
    auto binary_plan =
        writer.prepare({asset_delete, asset_create}, TransactionDecision::KeepComments);
    require(binary_plan.accepted && binary_plan.targets.size() == 2,
            "Binary trash source and destination share one exact-CAS approval");
    writer.set_after_target_hook_for_certification([](std::size_t index) {
        if (index == 0)
            throw std::runtime_error("Simulated binary trash publication failure");
    });
    require(!writer.commit(binary_plan, TransactionDecision::KeepComments).accepted &&
                read(binary) == binary_bytes && !fs::exists(trashed),
            "Partial binary trash publication rolls back both source and destination");
    writer.set_after_target_hook_for_certification({});
    write(binary, "external edit");
    require(!writer.commit(binary_plan, TransactionDecision::KeepComments).accepted &&
                read(binary) == "external edit" && !fs::exists(trashed),
            "Binary Asset trash commit rejects an external edit after preflight");
    write(binary, binary_bytes);
    require(writer.commit(binary_plan, TransactionDecision::KeepComments).accepted &&
                !fs::exists(binary) && read(trashed) == binary_bytes,
            "Binary Asset trash persists exactly through native journal");
    require(!writer
                 .prepare({YamlTransactionTarget{.path = ".noveltea/trash/other.bin",
                                                 .expected_revision = "absent",
                                                 .create_source = binary_bytes,
                                                 .raw_asset_file = true}},
                          TransactionDecision::KeepComments)
                 .accepted,
            "Binary journal rejects paths outside admitted Asset and Asset-trash roots");
    YamlTransactionTarget asset_restore;
    asset_restore.path = asset_create.path;
    asset_restore.expected_revision = exact_source_revision(binary_bytes);
    asset_restore.baseline_source = binary_bytes;
    asset_restore.erase = true;
    asset_restore.raw_asset_file = true;
    asset_delete.erase = false;
    asset_delete.expected_revision = "absent";
    asset_delete.create_source = binary_bytes;
    asset_delete.baseline_source.clear();
    auto restore_plan =
        writer.prepare({asset_restore, asset_delete}, TransactionDecision::KeepComments);
    require(restore_plan.accepted &&
                writer.commit(restore_plan, TransactionDecision::KeepComments).accepted &&
                read(binary) == binary_bytes && !fs::exists(trashed),
            "Binary Asset restoration uses the same journal with absent destination CAS");

    const auto invalid = temp.root / "records/rooms/invalid.yaml";
    write(invalid, "broken: [\n");
    writer.set_invalid_sources({"records/rooms/invalid.yaml"}, false);
    const auto unaffected = read(first);
    auto independent_save = writer.prepare(
        {change("records/rooms/one.yaml", unaffected, "/label", "\"Still allowed\"")},
        TransactionDecision::KeepComments);
    require(independent_save.accepted &&
                writer.commit(independent_save, TransactionDecision::KeepComments).accepted,
            "Attributable invalid source does not block unrelated tracked YAML Save");
    require(!writer
                 .prepare({change("records/rooms/invalid.yaml", read(invalid), "/broken", "true")},
                          TransactionDecision::KeepComments)
                 .accepted,
            "Directly affected invalid physical source cannot be written");
    writer.set_invalid_sources({}, true);
    require(!writer
                 .prepare({change("records/rooms/one.yaml", read(first), "/label", "\"Blocked\"")},
                          TransactionDecision::KeepComments)
                 .accepted,
            "Unattributed structural uncertainty conservatively blocks all writes");
    writer.set_invalid_sources({}, false);

    const auto busy = temp.root / ".noveltea/transactions/.writer-lock";
    fs::create_directories(busy);
    write(busy / "owner.json", "{\"ownerToken\":\"other\",\"pid\":" +
                                   std::to_string(
#ifdef _WIN32
                                       GetCurrentProcessId()
#else
                                       getpid()
#endif
                                           ) +
                                   ",\"operationLabel\":\"busy\",\"transactionId\":null}\n");
    const auto busy_source = read(first);
    const auto busy_plan =
        writer.prepare({change("records/rooms/one.yaml", busy_source, "/label", "\"Busy\"")},
                       TransactionDecision::KeepComments);
    require(busy_plan.accepted &&
                !writer.commit(busy_plan, TransactionDecision::KeepComments).accepted &&
                read(first) == busy_source,
            "Concurrent live writer lock blocks mutation, without unsafe lock reclamation");
    fs::remove_all(busy);

#ifndef _WIN32
    // A real process death exercises a crash between target rename and the
    // completion marker, not just a catchable exception and graceful rollback.
    const auto crash_before_a = read(first);
    const auto crash_before_b = read(second);
    const auto crash_plan = writer.prepare(
        {change("records/rooms/one.yaml", crash_before_a, "/label", "\"After Crash A\""),
         change("records/rooms/two.yaml", crash_before_b, "/label", "\"After Crash B\"")},
        TransactionDecision::KeepComments);
    require(crash_plan.accepted, "Crash group prepared against two exact revisions");
    const auto child = fork();
    require(child >= 0, "Cannot fork native crash-certification process");
    if (child == 0) {
        YamlTransactionService child_writer(temp.root);
        child_writer.set_after_target_hook_for_certification([](std::size_t index) {
            if (index == 0)
                _exit(91);
        });
        (void)child_writer.commit(crash_plan, TransactionDecision::KeepComments);
        _exit(92);
    }
    int status = 0;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 91,
            "Crash fault occurs after first physical rename while lock/journal remain");
    require(read(first) != crash_before_a && read(second) == crash_before_b,
            "Crash left a physically partial group for journal recovery");
    require(writer.recover().accepted && read(first) == crash_before_a &&
                read(second) == crash_before_b,
            "Dead writer lock is reclaimed and incomplete journal rolled back exactly");

    const auto other_child = fork();
    require(other_child >= 0, "Cannot fork unknown-edit recovery test");
    if (other_child == 0) {
        YamlTransactionService child_writer(temp.root);
        child_writer.set_after_target_hook_for_certification([](std::size_t index) {
            if (index == 0)
                _exit(91);
        });
        (void)child_writer.commit(crash_plan, TransactionDecision::KeepComments);
        _exit(92);
    }
    require(waitpid(other_child, &status, 0) == other_child && WIFEXITED(status) &&
                WEXITSTATUS(status) == 91,
            "Second crash produces orphan journal for conflict qualification");
    write(first, "id: one\nlabel: Independent agent write\n");
    require(!writer.recover().accepted &&
                read(first) == "id: one\nlabel: Independent agent write\n" &&
                read(second) == crash_before_b,
            "Unknown post-crash external edit retains journal and never overwrites source");
    // Recovery remains possible after manually restoring a journal-known target revision.
    write(first, crash_before_a);
    require(writer.recover().accepted && read(first) == crash_before_a,
            "Repeated recovery resumes from an exact known physical source state");
#endif

    const auto malformed = temp.root / ".noveltea/transactions/invalid-journal";
    const auto preparation = temp.root / ".noveltea/transactions/.preparing-crashed-stage";
    write(preparation / "after/0", "staged but unpublished source");
    require(writer.recover().accepted && !fs::exists(preparation),
            "Unpublished interrupted staging cannot block recovery or alter tracked sources");
    write(malformed / "manifest.json", "{\"bad\":true}");
    require(!writer.recover().accepted && fs::exists(malformed),
            "Unknown or malformed crash journal fails closed without erasing recovery evidence");
    fs::remove_all(malformed);
}
} // namespace

int main()
{
    try {
        certify();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Native YAML transaction certification failed: " << e.what() << '\n';
        return 1;
    }
}
