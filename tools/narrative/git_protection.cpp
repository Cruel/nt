#include "catalog_internal.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <cstdlib>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#else
#include <cerrno>
#include <csignal>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace noveltea::narrative {
namespace {
namespace fs = std::filesystem;

std::string utf8_path(const fs::path& path)
{
    const auto bytes = path.generic_u8string();
    return {bytes.begin(), bytes.end()};
}

std::string trim_newline(std::string value)
{
    while (!value.empty() && (value.back() == '\n' || value.back() == '\r'))
        value.pop_back();
    return value;
}

#if defined(_WIN32)
std::wstring quote_arg(const std::wstring& arg)
{
    std::wstring quoted = L"\"";
    std::size_t slashes = 0;
    for (wchar_t ch : arg) {
        if (ch == L'\\') {
            ++slashes;
        } else {
            quoted.append(slashes * (ch == L'"' ? 2 : 1), L'\\');
            if (ch == L'"')
                quoted.push_back(L'\\');
            quoted.push_back(ch);
            slashes = 0;
        }
    }
    quoted.append(slashes * 2, L'\\');
    return quoted + L'"';
}
#endif

// Argument-vector execution; never interpolate refs or source paths into a shell command.
// Git objects are read from stdout only, without touching the index or worktree.
std::string run_git(const fs::path& cwd, const std::vector<std::string>& args)
{
    std::vector<std::string> argv{"git", "-C", utf8_path(cwd)};
    argv.insert(argv.end(), args.begin(), args.end());
    std::string output;
    constexpr std::size_t output_limit = 128 * 1024 * 1024;
#if defined(_WIN32)
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE reader = nullptr, writer = nullptr;
    if (!CreatePipe(&reader, &writer, &attributes, 0))
        throw std::runtime_error("Cannot create Git output pipe.");
    (void)SetHandleInformation(reader, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = writer;
    startup.hStdError = writer;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    std::wstring command;
    for (const auto& arg : argv) {
        if (!command.empty())
            command += L" ";
        command += quote_arg(fs::path(std::u8string(arg.begin(), arg.end())).wstring());
    }
    // A promisor clone could otherwise fetch absent baseline objects, writing
    // to Git and contacting the network during an ostensibly read-only check.
    LPWCH inherited = GetEnvironmentStringsW();
    if (!inherited) {
        CloseHandle(reader);
        CloseHandle(writer);
        throw std::runtime_error("Cannot inspect environment for Git baseline read.");
    }
    std::vector<std::wstring> entries;
    const auto override_name = [](std::wstring_view item, std::wstring_view name) {
        const auto separator = item.find(L'=');
        return separator == name.size() &&
               CompareStringOrdinal(item.data(), static_cast<int>(separator), name.data(),
                                    static_cast<int>(name.size()), TRUE) == CSTR_EQUAL;
    };
    for (const wchar_t* item = inherited; *item; item += lstrlenW(item) + 1) {
        const std::wstring_view value(item);
        if (!override_name(value, L"GIT_NO_LAZY_FETCH") &&
            !override_name(value, L"GIT_NO_REPLACE_OBJECTS") &&
            !override_name(value, L"GIT_OPTIONAL_LOCKS"))
            entries.emplace_back(value);
    }
    FreeEnvironmentStringsW(inherited);
    entries.emplace_back(L"GIT_NO_LAZY_FETCH=1");
    entries.emplace_back(L"GIT_NO_REPLACE_OBJECTS=1");
    entries.emplace_back(L"GIT_OPTIONAL_LOCKS=0");
    std::sort(entries.begin(), entries.end());
    std::wstring environment;
    for (const auto& entry : entries) {
        environment += entry;
        environment.push_back(L'\0');
    }
    environment.push_back(L'\0');
    PROCESS_INFORMATION process{};
    const bool launched = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                         CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                                         environment.data(), nullptr, &startup, &process) != 0;
    CloseHandle(writer);
    if (!launched) {
        CloseHandle(reader);
        throw std::runtime_error("Cannot launch Git for Story baseline inspection.");
    }
    std::array<char, 8192> buffer{};
    DWORD count = 0;
    bool oversized = false;
    while (ReadFile(reader, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr) &&
           count) {
        if (output.size() + count > output_limit) {
            oversized = true;
            (void)TerminateProcess(process.hProcess, 1);
            break;
        }
        output.append(buffer.data(), count);
    }
    CloseHandle(reader);
    (void)WaitForSingleObject(process.hProcess, INFINITE);
    DWORD status = 0;
    const bool finished = GetExitCodeProcess(process.hProcess, &status) != 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    if (oversized)
        throw std::runtime_error("Git baseline object exceeds the output safety limit.");
    if (!finished || status != 0)
        throw std::runtime_error("Cannot inspect the requested Git baseline.");
#else
    int fds[2]{};
    if (pipe(fds) != 0)
        throw std::runtime_error("Cannot create Git output pipe.");
    const pid_t pid = fork();
    if (pid < 0) {
        close(fds[0]);
        close(fds[1]);
        throw std::runtime_error("Cannot launch Git for Story baseline inspection.");
    }
    if (pid == 0) {
        (void)close(fds[0]);
        (void)dup2(fds[1], STDOUT_FILENO);
        (void)dup2(fds[1], STDERR_FILENO);
        (void)close(fds[1]);
        std::vector<char*> cargs;
        for (auto& arg : argv)
            cargs.push_back(arg.data());
        cargs.push_back(nullptr);
        if (setenv("GIT_NO_LAZY_FETCH", "1", 1) != 0 ||
            setenv("GIT_NO_REPLACE_OBJECTS", "1", 1) != 0 ||
            setenv("GIT_OPTIONAL_LOCKS", "0", 1) != 0)
            _exit(127);
        execvp(cargs.front(), cargs.data());
        _exit(127);
    }
    (void)close(fds[1]);
    std::array<char, 8192> buffer{};
    ssize_t count = 0;
    bool oversized = false;
    while ((count = read(fds[0], buffer.data(), buffer.size())) > 0) {
        if (output.size() + static_cast<std::size_t>(count) > output_limit) {
            oversized = true;
            (void)kill(pid, SIGKILL);
            break;
        }
        output.append(buffer.data(), static_cast<std::size_t>(count));
    }
    (void)close(fds[0]);
    int status = 0;
    pid_t waited = 0;
    do {
        waited = waitpid(pid, &status, 0);
    } while (waited < 0 && errno == EINTR);
    if (oversized)
        throw std::runtime_error("Git baseline object exceeds the output safety limit.");
    if (waited != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        throw std::runtime_error("Cannot inspect the requested Git baseline.");
#endif
    return output;
}

struct Snapshot {
    std::string sha;
    Catalog catalog;
};

// Only tracked regular Markdown blobs under the canonical Story directory are admitted.
// Historical metadata must match the *current* pinned schema, or the comparison fails closed.
Snapshot baseline(const fs::path& root, const std::string& revision)
{
    const auto story = fs::canonical(root);
    const auto repo_path = trim_newline(run_git(story, {"rev-parse", "--show-toplevel"}));
    const auto repo = fs::canonical(fs::path(std::u8string(repo_path.begin(), repo_path.end())));
    const auto relative = story.lexically_relative(repo);
    if (relative.empty() || relative == ".." || relative.is_absolute() ||
        (!relative.empty() && *relative.begin() == ".."))
        throw std::runtime_error("Story root must be contained in the Git worktree.");
    const auto prefix = relative == "." ? std::string{} : utf8_path(relative);
    const auto sha = trim_newline(
        run_git(story, {"rev-parse", "--verify", "--end-of-options", revision + "^{commit}"}));
    if (sha.size() != 40 && sha.size() != 64)
        throw std::runtime_error("Git baseline did not resolve to a full commit ID.");
    std::vector<std::string> tree_args{"ls-tree", "-r", "-z", "--full-tree", sha, "--"};
    if (!prefix.empty())
        tree_args.push_back(prefix);
    const auto tree = run_git(story, tree_args);
    std::map<std::string, std::string> sources;
    std::size_t start = 0;
    while (start < tree.size()) {
        const auto end = tree.find('\0', start);
        if (end == std::string::npos)
            throw std::runtime_error("Git baseline tree contains an incomplete entry.");
        const auto entry = std::string_view(tree).substr(start, end - start);
        start = end + 1;
        const auto tab = entry.find('\t');
        if (tab == std::string_view::npos)
            throw std::runtime_error("Git baseline tree entry is malformed.");
        const auto header = entry.substr(0, tab);
        const auto path = entry.substr(tab + 1);
        if (!path.ends_with(".md") || (!prefix.empty() && !path.starts_with(prefix + "/")))
            continue;
        const auto path_in_story = std::string(path.substr(prefix.empty() ? 0 : prefix.size() + 1));
        const auto relative_path =
            fs::path(std::u8string(path_in_story.begin(), path_in_story.end()));
        if (is_private_inbox_path(relative_path))
            continue;
        const bool regular_blob =
            header.size() >= 14 &&
            (header.substr(0, 7) == "100644 " || header.substr(0, 7) == "100755 ") &&
            header.substr(7, 5) == "blob ";
        if (!regular_blob)
            throw std::runtime_error("Git baseline contains an unsupported Story file mode.");
        const auto object_id = std::string(header.substr(12));
        if (object_id.size() != 40 && object_id.size() != 64)
            throw std::runtime_error("Git baseline tree has an invalid object ID.");
        sources.emplace(path_in_story, run_git(story, {"cat-file", "blob", object_id}));
    }
    // A verified commit may predate this Story root. With no historical
    // Markdown there are no records or decisions to check; applying today's
    // required Creative Direction rule to that empty snapshot would incorrectly
    // reject a valid Git baseline. Nonempty snapshots still fail closed through
    // the canonical reader and structural analysis.
    Catalog catalog;
    if (!sources.empty()) {
        catalog = read_catalog(".", &sources);
        if (!catalog.diagnostics.empty())
            throw std::runtime_error(
                "Baseline Story has invalid or unsupported historical metadata.");
        (void)analyze(catalog);
        if (!catalog.diagnostics.empty())
            throw std::runtime_error(
                "Baseline Story does not satisfy the current narrative contract.");
    }
    return {sha, std::move(catalog)};
}

using Records = std::map<std::string, const Record*>;

Records by_id(const Catalog& catalog)
{
    Records records;
    for (const auto& record : catalog.records)
        records.emplace(record.metadata.at("id").get<std::string>(), &record);
    return records;
}

Json decision_location(const Catalog& catalog, const Record& record, std::size_t index)
{
    return catalog.located(record, "/decisions/" + std::to_string(index) + "/statement");
}

Json impact_report(const Catalog& previous, const Catalog& current)
{
    const auto old_records = by_id(previous);
    const auto new_records = by_id(current);
    std::set<std::string> changed;
    Json moved = Json::array();
    for (const auto& [id, old_record] : old_records) {
        const auto found = new_records.find(id);
        if (found == new_records.end() || old_record->metadata != found->second->metadata ||
            old_record->body != found->second->body)
            changed.insert(id);
        if (found != new_records.end() && old_record->path != found->second->path)
            moved.push_back(
                {{"id", id}, {"previousPath", old_record->path}, {"path", found->second->path}});
    }
    for (const auto& [id, record] : new_records) {
        static_cast<void>(record);
        if (!old_records.contains(id))
            changed.insert(id);
    }

    // Both versions' graph edges remain useful: deleting an old dependency must
    // still flag its former consumers. Source-located witnesses are deterministic.
    std::map<std::string, Json> edges;
    for (const auto& [graph, revision] :
         {std::pair<const Catalog*, std::string>{&previous, "baseline"}, {&current, "working"}}) {
        for (const auto& ref : graph->references) {
            Json edge = {{"sourceId", ref.at("source")}, {"targetId", ref.at("target")},
                         {"path", ref.at("path")},       {"pointer", ref.at("pointer")},
                         {"line", ref.at("line")},       {"column", ref.at("column")},
                         {"revision", revision}};
            edges.emplace(edge.dump(), std::move(edge));
        }
    }
    std::set<std::string> impacted = changed;
    std::map<std::string, Json> witness;
    constexpr std::size_t record_limit = 2048;
    bool truncated = impacted.size() > record_limit;
    if (!truncated) {
        bool grew = true;
        while (grew && !truncated) {
            grew = false;
            for (const auto& [key, edge] : edges) {
                static_cast<void>(key);
                const auto from = edge.at("sourceId").get<std::string>();
                const auto to = edge.at("targetId").get<std::string>();
                if (!impacted.contains(from) && !impacted.contains(to))
                    continue;
                for (const auto& id : {from, to}) {
                    if (!old_records.contains(id) && !new_records.contains(id))
                        continue;
                    if (impacted.insert(id).second) {
                        witness[id] = Json::array({edge});
                        grew = true;
                        if (impacted.size() > record_limit) {
                            truncated = true;
                            break;
                        }
                    }
                }
                if (truncated)
                    break;
            }
        }
    }
    Json affected = Json::array();
    for (const auto& id : impacted) {
        const auto found = new_records.find(id);
        const Record* record = found != new_records.end() ? found->second : old_records.at(id);
        affected.push_back(
            {{"id", id},
             {"path", record->path},
             {"type", record->metadata.at("type")},
             {"status", record->metadata.at("status")},
             {"reason", changed.contains(id) ? "changed" : "linked-dependency-review"},
             {"witnesses", witness.contains(id) ? witness.at(id) : Json::array()}});
    }
    Json changes = Json::array();
    for (const auto& id : changed)
        changes.push_back(id);
    return {{"changed", changes},
            {"moved", moved},
            {"affected", affected},
            {"bounded", {{"maxRecords", record_limit}, {"truncated", truncated}}},
            {"unverified",
             {"creative-dependency-semantics", "prose-continuity", "human-authorization"}}};
}
} // namespace

Json inspect_git_baseline(const fs::path& root, const std::string& revision, const Catalog& current)
{
    const auto previous = baseline(root, revision);
    const auto old_records = by_id(previous.catalog);
    const auto new_records = by_id(current);
    Json findings = Json::array();
    std::size_t checked = 0;
    for (const auto& [id, record] : old_records) {
        const auto target = new_records.find(id);
        const Record* now = target == new_records.end() ? nullptr : target->second;
        const auto& decisions = record->metadata.at("decisions");
        for (std::size_t i = 0; i < decisions.size(); ++i) {
            const auto& before = decisions[i];
            if (before.at("authority") != "user-protected")
                continue;
            ++checked;
            const Json* after = nullptr;
            std::size_t after_index = 0;
            if (now) {
                const auto& candidates = now->metadata.at("decisions");
                for (std::size_t j = 0; j < candidates.size(); ++j)
                    if (candidates[j].at("id") == before.at("id")) {
                        after = &candidates[j];
                        after_index = j;
                        break;
                    }
            }
            const bool retired = now && record->metadata.at("status") != "superseded" &&
                                 now->metadata.at("status") == "superseded";
            if (after && before == *after && !retired)
                continue;
            std::string category;
            if (!now)
                category = "record-deleted";
            else if (!after)
                category = "removed";
            else if (retired)
                category = "record-retired";
            else if (after->at("authority") == "delegated")
                category = "demoted";
            else
                category = "changed";
            const auto decision_id = id + "#" + before.at("id").get<std::string>();
            findings.push_back(
                {{"code", "protected-decision-change"},
                 {"severity", "approval-required"},
                 {"decisionId", decision_id},
                 {"recordId", id},
                 {"category", category},
                 {"baselineSha", previous.sha},
                 {"beforeLocation", decision_location(previous.catalog, *record, i)},
                 {"afterLocation",
                  after ? decision_location(current, *now, after_index) : Json(nullptr)},
                 {"before", before},
                 {"after", after ? *after : Json(nullptr)},
                 {"message", "Protected decision changed relative to committed Git baseline; "
                             "obtain author approval or restore the baseline decision. "
                             "This tool cannot verify human authorization."}});
        }
    }
    return {{"status", "checked"},
            {"base", previous.sha},
            {"checkedDecisions", checked},
            {"findings", findings},
            {"impact", impact_report(previous.catalog, current)},
            {"authorizationVerified", false}};
}
} // namespace noveltea::narrative
