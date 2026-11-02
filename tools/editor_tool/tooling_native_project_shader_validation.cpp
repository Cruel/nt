#include "tooling_native_project_shader_validation.hpp"

#include "tooling_native.hpp"

#include "../project_authoring/material_semantics.hpp"
#include "../project_authoring/platform_source_monitor.hpp"
#include "../project_authoring/validation_work_instrumentation.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <optional>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#if defined(__linux__)
#include <cerrno>
#include <sys/inotify.h>
#endif

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace noveltea::tooling {
namespace {
using Json = nlohmann::json;
namespace fs = std::filesystem;

// Embedded shaderc prints raw diagnostics to stdout. The daemon, like the
// standalone CLI, must never mix those bytes with its JSON transport.
struct SuppressCompilerStdout {
    int saved = -1;
    SuppressCompilerStdout()
    {
        std::fflush(stdout);
#if defined(_WIN32)
        saved = _dup(_fileno(stdout));
        const auto sink = _open("NUL", _O_WRONLY);
        const auto redirected = saved >= 0 && sink >= 0 ? _dup2(sink, _fileno(stdout)) : -1;
        if (sink >= 0)
            _close(sink);
#else
        saved = dup(fileno(stdout));
        const auto sink = open("/dev/null", O_WRONLY);
        const auto redirected = saved >= 0 && sink >= 0 ? dup2(sink, fileno(stdout)) : -1;
        if (sink >= 0)
            close(sink);
#endif
        if (redirected < 0) {
#if defined(_WIN32)
            if (saved >= 0)
                _close(saved);
#else
            if (saved >= 0)
                close(saved);
#endif
            throw std::runtime_error("Could not isolate resident shader compiler output.");
        }
    }
    ~SuppressCompilerStdout()
    {
        std::fflush(stdout);
#if defined(_WIN32)
        _dup2(saved, _fileno(stdout));
        _close(saved);
#else
        dup2(saved, fileno(stdout));
        close(saved);
#endif
    }
};

[[nodiscard]] bool is_project_shader(std::string_view identity)
{
    return identity.starts_with("project:/shaders/");
}

[[nodiscard]] std::string project_shader_path(std::string_view identity)
{
    return std::string(identity.substr(std::string_view("project:/").size()));
}

[[nodiscard]] std::map<std::string, std::string>
shader_inventory(const std::map<std::string, std::string>& revisions)
{
    std::map<std::string, std::string> result;
    for (const auto& [path, revision] : revisions)
        if (path.starts_with("shaders/"))
            result.emplace(path, revision);
    return result;
}

[[nodiscard]] bool deterministic_failure(const Json& response)
{
    if (!response.value("ok", false) || response.value("success", true) ||
        !response.value("outputs", Json::array()).empty())
        return false;
    const std::set<std::string> deterministic = {
        "invalid_variant",   "invalid_source_path",        "unsafe_include_path",
        "missing_source",    "missing_varying_definition", "compiler_failed",
        "contract_violation"};
    const auto& diagnostics = response.value("diagnostics", Json::array());
    return !diagnostics.empty() &&
           std::all_of(diagnostics.begin(), diagnostics.end(), [&](const Json& diagnostic) {
               return diagnostic.is_object() && diagnostic.value("severity", "") == "error" &&
                      deterministic.contains(diagnostic.value("code", ""));
           });
}

// A cache hit never trusts file metadata alone. This is the same SHA-256
// output-integrity gate used by the native shaderc manifest on disk hits.
[[nodiscard]] bool binary_current(const fs::path& root, const Json& output)
{
    if (!output.is_object() || !output.contains("outputPath") ||
        !output.at("outputPath").is_string() || !output.contains("byteHash") ||
        !output.at("byteHash").is_string() || !output.contains("byteSize") ||
        !output.at("byteSize").is_number_unsigned())
        return false;
    const auto base = root / ".noveltea" / "build";
    const fs::path path(output.at("outputPath").get<std::string>());
    const auto relative = path.lexically_relative(base);
    if (relative.empty() || relative == "." || relative.is_absolute() ||
        *relative.begin() == ".." || relative != relative.lexically_normal())
        return false;
    auto current = root;
    for (const auto& part : fs::path(".noveltea") / "build" / relative) {
        current /= part;
        std::error_code ec;
        if (fs::is_symlink(fs::symlink_status(current, ec)) || ec)
            return false;
    }
    std::error_code ec;
    if (!fs::is_regular_file(path, ec) || ec ||
        fs::file_size(path, ec) != output.at("byteSize").get<std::uint64_t>() || ec)
        return false;
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return false;
    const std::string bytes{std::istreambuf_iterator<char>{input},
                            std::istreambuf_iterator<char>{}};
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderProofReads>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::FileByteReads>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::FileBytesRead>(bytes.size());
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderBytesRead>(bytes.size());
    if (input.bad() || bytes.size() != output.at("byteSize").get<std::uint64_t>())
        return false;
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderProofHashes>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ContentHashes>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ContentBytesHashed>(bytes.size());
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderBytesHashed>(bytes.size());
    return "sha256:" + core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size()))) ==
               output.at("byteHash").get<std::string>();
}

[[nodiscard]] bool source_matches(const std::map<std::string, std::string>& dependencies,
                                  const std::map<std::string, std::string>& current)
{
    for (const auto& [path, revision] : dependencies) {
        const auto found = current.find(path);
        if (found == current.end() || found->second != revision)
            return false;
    }
    return true;
}

[[nodiscard]] bool file_hash_matches(const fs::path& path, const std::string& expected)
{
    std::error_code ec;
    auto cursor = path.root_path();
    for (const auto& component : path.relative_path()) {
        cursor /= component;
        if (fs::is_symlink(fs::symlink_status(cursor, ec)) || ec)
            return false;
    }
    if (!fs::is_regular_file(path, ec) || ec)
        return false;
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return false;
    const std::string contents{std::istreambuf_iterator<char>{input},
                               std::istreambuf_iterator<char>{}};
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderProofReads>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::FileByteReads>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::FileBytesRead>(contents.size());
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderBytesRead>(contents.size());
    if (input.bad())
        return false;
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderProofHashes>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ContentHashes>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ContentBytesHashed>(contents.size());
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ShaderBytesHashed>(contents.size());
    return "sha256:" +
                   core::sha256_hex(std::as_bytes(std::span(contents.data(), contents.size()))) ==
               expected;
}

// The compiler materializes immutable engine source blobs into a project-local
// toolchain directory. Do not assume these physical copies are immutable:
// establish their exact location once on a miss, then reprove only the
// individual files on hits (never walk the engine/include tree again).
[[nodiscard]] std::optional<fs::path> locate_engine_dependency(const fs::path& root,
                                                               std::string_view identity,
                                                               const std::string& expected)
{
    constexpr std::string_view prefix = "engine:/";
    if (!identity.starts_with(prefix))
        return std::nullopt;
    const fs::path relative{std::string(identity.substr(prefix.size()))};
    if (relative.empty() || relative.is_absolute() || relative != relative.lexically_normal() ||
        *relative.begin() == "..")
        return std::nullopt;
    const auto toolchains = root / ".noveltea" / "cache" / "toolchain" / "noveltea-shaders";
    std::error_code ec;
    if (!fs::is_directory(toolchains, ec) || ec)
        return std::nullopt;
    for (const auto& directory : fs::directory_iterator(toolchains, ec)) {
        if (ec)
            break;
        std::error_code entry_error;
        if (directory.is_symlink(entry_error) || entry_error ||
            !directory.is_directory(entry_error) || entry_error)
            continue;
        const auto candidate = directory.path() / relative;
        if (file_hash_matches(candidate, expected))
            return candidate;
    }
    return std::nullopt;
}

} // namespace

// .noveltea/build and the materialized engine toolchain are not part of the
// Project source observer. Proof reuse requires a separate physical fence;
// checking the saved size/mtime of a binary would miss restored-timestamp edits.
struct MaterialShaderValidationCache::ArtifactProof {
    explicit ArtifactProof(fs::path project_root) : root(std::move(project_root))
    {
#if defined(__linux__)
        fd = ::inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
#elif defined(_WIN32)
        monitor = std::make_unique<authoring::PlatformSourceMonitor>(root / ".noveltea");
#endif
    }
    ~ArtifactProof()
    {
#if defined(__linux__)
        if (fd >= 0)
            ::close(fd);
#endif
    }
    fs::path root;
    bool lost = false;
    // An output or materialized include is trusted only after a successful
    // exact SHA-256 proof under its own live filesystem watch. These proofs
    // outlive a changed shader program, unlike the whole-stage result.
    std::map<fs::path, std::string> verified;
#if defined(__linux__)
    int fd = -1;
    std::set<fs::path> watched;
    std::map<int, std::set<fs::path>> watch_paths;
#elif defined(_WIN32)
    std::unique_ptr<authoring::PlatformSourceMonitor> monitor;
#endif

    bool watch(const fs::path& file)
    {
        if (lost)
            return false;
        const auto relative = file.lexically_relative(root);
        if (relative.empty() || relative.is_absolute() || *relative.begin() != ".noveltea" ||
            relative != relative.lexically_normal())
            return false;
#if defined(__linux__)
        if (fd < 0)
            return false;
        auto cursor = root;
        const auto arm = [&](const fs::path& path) {
            if (watched.contains(path))
                return true;
            constexpr auto mask = IN_ATTRIB | IN_MODIFY | IN_CLOSE_WRITE | IN_CREATE | IN_DELETE |
                                  IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE_SELF | IN_MOVE_SELF |
                                  IN_UNMOUNT;
            const auto wd = ::inotify_add_watch(fd, path.c_str(), mask);
            if (wd < 0)
                return false;
            watched.insert(path);
            watch_paths[wd].insert(path);
            return true;
        };
        if (!arm(cursor))
            return false;
        for (const auto& part : relative) {
            cursor /= part;
            if (!arm(cursor))
                return false;
        }
        return true;
#elif defined(_WIN32)
        monitor->protect_source(relative.lexically_relative(".noveltea").generic_string());
        return true;
#else
        (void)file;
        return false; // No verified inode/hard-link fence for external macOS writes.
#endif
    }

    bool drain(bool& changed)
    {
        if (lost)
            return false;
#if defined(__linux__)
        if (fd < 0)
            return false;
        alignas(inotify_event) char buffer[32768];
        for (;;) {
            const auto count = ::read(fd, buffer, sizeof(buffer));
            if (count < 0) {
                if (errno == EINTR)
                    continue;
                if (errno == EAGAIN)
                    return true;
                verified.clear();
                lost = true;
                return false;
            }
            if (count == 0) {
                verified.clear();
                lost = true;
                return false;
            }
            for (std::size_t pos = 0; pos < static_cast<std::size_t>(count);) {
                const auto* event = reinterpret_cast<const inotify_event*>(buffer + pos);
                if (event->mask &
                    (IN_Q_OVERFLOW | IN_IGNORED | IN_UNMOUNT | IN_DELETE_SELF | IN_MOVE_SELF)) {
                    verified.clear();
                    lost = true;
                    return false;
                }
                const auto paths = watch_paths.find(event->wd);
                if (paths == watch_paths.end()) {
                    verified.clear();
                    lost = true;
                    return false;
                }
                for (const auto& watched_path : paths->second) {
                    const auto affected =
                        event->len == 0 ? watched_path : watched_path / event->name;
                    for (auto it = verified.begin(); it != verified.end();) {
                        const auto relative = it->first.lexically_relative(affected);
                        if (it->first == affected ||
                            (!relative.empty() && !relative.is_absolute() &&
                             *relative.begin() != "..")) {
                            changed = true;
                            it = verified.erase(it);
                        } else {
                            ++it;
                        }
                    }
                    // A formerly certified whole-stage proof must also be
                    // invalidated if one of its watched files was changed.
                    if (watched.contains(affected))
                        changed = true;
                }
                pos += sizeof(inotify_event) + event->len;
            }
        }
#elif defined(_WIN32)
        const auto changes = monitor->fence();
        if (!changes.reliable) {
            verified.clear();
            lost = true;
            return false;
        }
        for (const auto& path : changes.paths) {
            const auto absolute = root / ".noveltea" / path;
            changed = true;
            verified.erase(absolute);
        }
        if (!changes.directories.empty()) {
            changed = true;
            verified.clear();
        }
        return true;
#else
        verified.clear();
        return false;
#endif
    }

    bool quiet()
    {
        bool changed = false;
        return drain(changed) && !changed;
    }

    template<class Check> bool prove(const fs::path& path, const std::string& digest,
                                     Check&& check, bool& physically_checked)
    {
        physically_checked = false;
        bool changed = false;
        // The watch precedes any hash. A changed sibling invalidates only its
        // own proof; an overflow or lost watcher invalidates all proofs.
        if (!watch(path) || !drain(changed)) {
            physically_checked = true;
            verified.erase(path);
            return check(); // Unwatched fallback is an independent exact check.
        }
        if (const auto found = verified.find(path);
            found != verified.end() && found->second == digest)
            return true;
        physically_checked = true;
        if (!check()) {
            verified.erase(path);
            return false;
        }
        changed = false;
        if (!drain(changed))
            return false;
        // A concurrent mutation during the read is never eligible for reuse.
        if (changed)
            return false;
        verified.insert_or_assign(path, digest);
        return true;
    }
};

MaterialShaderValidationCache::MaterialShaderValidationCache() = default;
MaterialShaderValidationCache::~MaterialShaderValidationCache() = default;
MaterialShaderValidationCache::MaterialShaderValidationCache(
    MaterialShaderValidationCache&&) noexcept = default;
MaterialShaderValidationCache&
MaterialShaderValidationCache::operator=(MaterialShaderValidationCache&&) noexcept = default;

void MaterialShaderValidationCache::clear()
{
    entries_.clear();
    reflection_entries_.clear();
    discard_certified_stage();
    artifact_proof_.reset();
}

void MaterialShaderValidationCache::discard_certified_stage() { certified_stage_.reset(); }

std::optional<MaterialShaderValidationCache::Stage>
MaterialShaderValidationCache::reuse_certified_stage(
    const fs::path& root, const Json& material_programs, const Json& effective_materials,
    const std::map<std::string, std::string>& source_revisions)
{
    if (!certified_stage_ || !artifact_proof_ || artifact_proof_->root != root ||
        certified_stage_->programs != material_programs ||
        certified_stage_->effective != effective_materials ||
        !source_matches(certified_stage_->dependencies, source_revisions) ||
        !artifact_proof_->quiet()) {
        certified_stage_.reset();
        return std::nullopt;
    }
    Stage stage = certified_stage_->result;
    for (auto& output : stage.compiled["outputs"])
        output["cacheHit"] = true;
    if (!artifact_proof_->quiet()) {
        certified_stage_.reset();
        return std::nullopt;
    }
    return stage;
}

void MaterialShaderValidationCache::certify_stage(
    const fs::path& root, const Json& material_programs, const Json& effective_materials,
    const std::map<std::string, std::string>& source_revisions, const Stage& stage, Work& work)
{
    certified_stage_.reset();
    if (!stage.compiled.value("ok", false) || !stage.compiled.value("success", false))
        return;

    if (!artifact_proof_ || artifact_proof_->root != root || artifact_proof_->lost)
        artifact_proof_ = std::make_unique<ArtifactProof>(root);
    auto& proof = *artifact_proof_;
    std::map<std::string, std::string> dependencies;
    std::map<fs::path, std::string> engine;
    std::set<std::string> canonical_programs;
    for (const auto& [material, collection] : material_programs.items()) {
        (void)material;
        for (const auto& [id, program] : collection.items()) {
            // Alias programs share the same canonical compiler request. Only
            // the first program ID is used by the shaderc cache authority.
            if (!canonical_programs.insert(program.dump()).second)
                continue;
            const auto entry = entries_.find(id + "\n" + program.dump());
            // A compiler response not admitted to the normal dependency cache
            // (e.g. partial outputs or uncertain dependency revisions) cannot
            // become a broader whole-stage authority either.
            if (entry == entries_.end() || entry->second.failed)
                return;
            for (const auto& [path, revision] : entry->second.source_revisions) {
                const auto [existing, added] = dependencies.emplace(path, revision);
                if (!added && existing->second != revision)
                    return;
            }
            for (const auto& [path, revision] : entry->second.engine_revisions) {
                const auto [existing, added] = engine.emplace(path, revision);
                if (!added && existing->second != revision)
                    return;
            }
        }
    }
    if (!source_matches(dependencies, source_revisions))
        return;
    // Establish notification coverage before hashing; a concurrent write
    // cannot turn a digest checked before watch registration into authority.
    std::map<fs::path, Json> binaries;
    for (const auto& output : stage.compiled.at("outputs")) {
        if (!output.is_object() || !output.contains("outputPath") ||
            !output.at("outputPath").is_string())
            return;
        const auto [existing, added] =
            binaries.emplace(fs::path(output.at("outputPath").get<std::string>()), output);
        if (!added &&
            (existing->second.value("byteHash", Json{}) != output.value("byteHash", Json{}) ||
             existing->second.value("byteSize", Json{}) != output.value("byteSize", Json{})))
            return;
    }
    if (binaries.empty())
        return;
    for (const auto& [path, _] : binaries)
        if (!proof.watch(path))
            return;
    for (const auto& [path, _] : engine)
        if (!proof.watch(path))
            return;
    bool changed_before_proof = false;
    // The compiler may have replaced one of the previously watched outputs.
    // Drain those notifications to revoke its old proof; only mutations
    // during or after the new exact proof are publication conflicts.
    if (!proof.drain(changed_before_proof))
        return;
    for (const auto& [path, output] : binaries) {
        bool checked = false;
        if (!proof.prove(
                path, output.at("byteHash").get<std::string>(),
                [&] { return binary_current(root, output); }, checked))
            return;
        work.output_proofs += checked;
    }
    for (const auto& [path, digest] : engine) {
        bool checked = false;
        if (!proof.prove(path, digest, [&] { return file_hash_matches(path, digest); }, checked))
            return;
    }
    if (!proof.quiet())
        return;
    // The primary compiler cache remains the source of truth for a miss.
    // This resident shortcut is never serialized into the offline ledger.
    certified_stage_ =
        CertifiedStage{material_programs, effective_materials, std::move(dependencies), stage};
}

Json MaterialShaderValidationCache::validate(
    const fs::path& root, const Json& material_programs,
    const std::map<std::string, std::string>& source_revisions, Work& work)
{
    // Preserve the standalone CLI's canonical-program deduplication and
    // output alias ordering. Compilation itself is owned by the same native
    // shaderc service, not another validator.
    std::map<std::string, std::string> canonical;
    std::map<std::string, std::string> aliases;
    std::map<std::string, Json> programs;
    for (const auto& [material, collection] : material_programs.items())
        for (const auto& [id, program] : collection.items()) {
            const auto serialized = program.dump();
            // Public validate historically passes no custom-Material ID
            // overrides to native_material_compile(). Preserve those exact
            // output identities; explicit shader commands keep their naming.
            const auto [found, unique] = canonical.emplace(serialized, id);
            if (unique)
                programs[id] = program;
            aliases[material] = found->second;
        }

    const auto all_shader_revisions = shader_inventory(source_revisions);
    if (!artifact_proof_ || artifact_proof_->root != root || artifact_proof_->lost)
        artifact_proof_ = std::make_unique<ArtifactProof>(root);
    Json result{{"ok", true},
                {"success", true},
                {"outputs", Json::array()},
                {"diagnostics", Json::array()}};
    for (const auto& [id, program] : programs) {
        const auto key = id + "\n" + program.dump();
        auto cached = entries_.find(key);
        bool reusable = cached != entries_.end() &&
                        source_matches(cached->second.source_revisions, source_revisions);
        if (reusable && cached->second.failed)
            reusable = cached->second.source_revisions == all_shader_revisions;
        if (reusable)
            for (const auto& [path, revision] : cached->second.engine_revisions) {
                bool checked = false;
                if (!artifact_proof_->prove(
                        path, revision, [&] { return file_hash_matches(path, revision); },
                        checked)) {
                    reusable = false;
                    break;
                }
            }
        if (reusable && !cached->second.failed)
            for (const auto& output : cached->second.response.at("outputs")) {
                bool checked = false;
                const auto path = fs::path(output.at("outputPath").get<std::string>());
                if (!artifact_proof_->prove(
                        path, output.at("byteHash").get<std::string>(),
                        [&] { return binary_current(root, output); }, checked)) {
                    reusable = false;
                    break;
                }
                work.output_proofs += checked;
            }

        Json compiled;
        if (reusable) {
            compiled = cached->second.response;
            for (auto& output : compiled["outputs"])
                output["cacheHit"] = true;
            ++work.reused_programs;
        } else {
            // A failed proof must force compiler staging and manifest checks;
            // never return a cached result for tampered or missing binaries.
            entries_.erase(key);
            const Json request = {
                {"shaderProject",
                 {{"schema", "noveltea.shader-source-programs"}, {"programs", {{id, program}}}}},
                {"options",
                 {{"projectRoot", root.string()},
                  {"outputRoot", (root / ".noveltea" / "build").string()},
                  {"cacheRoot", (root / ".noveltea" / "cache").string()},
                  {"shaderVariants", Json::array({"glsl-330", "essl-300", "metal"})},
                  {"forceRebuild", false},
                  {"sourceOverlays", Json::object()}}}};
            ++work.compiler_runs;
            {
                SuppressCompilerStdout silence;
                compiled = Json::parse(compile_shaders(request.dump()).response_json);
            }
            Entry entry;
            entry.response = compiled;
            entry.failed = deterministic_failure(compiled);
            bool admissible = entry.failed;
            if (entry.failed) {
                // A missing include can become available without changing the
                // program request. Any shader source addition/removal/edit
                // revokes negative findings; unknown I/O failures are not cached.
                entry.source_revisions = all_shader_revisions;
            } else if (compiled.value("ok", false) && compiled.value("success", false) &&
                       compiled.value("diagnostics", Json::array()).empty() &&
                       !compiled.value("outputs", Json::array()).empty()) {
                admissible = true;
                for (const auto& output : compiled.at("outputs")) {
                    if (!output.contains("dependencyRevisions") ||
                        !output.at("dependencyRevisions").is_array()) {
                        admissible = false;
                        break;
                    }
                    for (const auto& dependency : output.at("dependencyRevisions")) {
                        const auto identity = dependency.value("identity", std::string{});
                        if (identity.starts_with("engine:/")) {
                            const auto hash = dependency.value("contentHash", std::string{});
                            const auto path = locate_engine_dependency(root, identity, hash);
                            if (!path) {
                                admissible = false;
                                break;
                            }
                            entry.engine_revisions.emplace(*path, hash);
                        }
                        if (!is_project_shader(identity))
                            continue;
                        const auto path = project_shader_path(identity);
                        const auto revision = source_revisions.find(path);
                        if (revision == source_revisions.end()) {
                            admissible = false;
                            break;
                        }
                        entry.source_revisions.emplace(path, revision->second);
                    }
                    if (!admissible)
                        break;
                }
            }
            if (admissible) {
                if (entries_.size() >= 256)
                    entries_.erase(entries_.begin());
                entries_.emplace(key, std::move(entry));
            }
        }
        if (!compiled.value("ok", false))
            return compiled;
        result["success"] = result.at("success").get<bool>() && compiled.value("success", false);
        for (const auto& output : compiled.value("outputs", Json::array()))
            result["outputs"].push_back(output);
        for (const auto& diagnostic : compiled.value("diagnostics", Json::array()))
            result["diagnostics"].push_back(diagnostic);
    }
    Json additional = Json::array();
    for (const auto& output : result.at("outputs"))
        for (const auto& [material, id] : aliases) {
            if (output.value("program", "") != id || material == id)
                continue;
            auto alias = output;
            alias["program"] = material;
            additional.push_back(std::move(alias));
        }
    for (auto& alias : additional)
        result["outputs"].push_back(std::move(alias));
    return result;
}

Json MaterialShaderValidationCache::ledger() const
{
    Json entries = Json::object(), reflections = Json::object();
    for (const auto& [key, entry] : entries_) {
        Json engine = Json::object();
        for (const auto& [path, revision] : entry.engine_revisions)
            engine[path.generic_string()] = revision;
        entries[key] = {{"response", entry.response}, {"sources", entry.source_revisions},
                        {"engine", engine}, {"failed", entry.failed}};
    }
    for (const auto& [key, entry] : reflection_entries_)
        reflections[key] = {{"identity", entry.identity}, {"diagnostics", entry.diagnostics}};
    return {{"programs", entries}, {"reflections", reflections}};
}

bool MaterialShaderValidationCache::restore_ledger(const fs::path& root, const Json& snapshot)
{
    try {
        if (!snapshot.is_object() || snapshot.size() != 2 ||
            !snapshot.at("programs").is_object() || !snapshot.at("reflections").is_object() ||
            snapshot.at("programs").size() > 256 || snapshot.at("reflections").size() > 256)
            return false;
        std::map<std::string, Entry> entries;
        std::map<std::string, ReflectionEntry> reflections;
        for (const auto& [key, item] : snapshot.at("programs").items()) {
            if (!item.is_object() || item.size() != 4 || !item.at("response").is_object() ||
                !item.at("sources").is_object() || !item.at("engine").is_object() ||
                !item.at("failed").is_boolean())
                return false;
            Entry entry;
            entry.response = item.at("response");
            entry.failed = item.at("failed").get<bool>();
            if (!entry.response.at("outputs").is_array() ||
                !entry.response.at("diagnostics").is_array() ||
                (entry.failed && !deterministic_failure(entry.response)))
                return false;
            entry.source_revisions = item.at("sources").get<std::map<std::string, std::string>>();
            for (const auto& [path, revision] : item.at("engine").items()) {
                const auto relative = fs::path(path).lexically_relative(
                    root / ".noveltea/cache/toolchain/noveltea-shaders");
                if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
                    relative != relative.lexically_normal() || !revision.is_string())
                    return false;
                entry.engine_revisions.emplace(path, revision.get<std::string>());
            }
            entries.emplace(key, std::move(entry));
        }
        for (const auto& [key, item] : snapshot.at("reflections").items()) {
            if (!item.is_object() || item.size() != 2 || !item.at("identity").is_string() ||
                !item.at("diagnostics").is_array())
                return false;
            for (const auto& diagnostic : item.at("diagnostics"))
                if (!diagnostic.is_object() || diagnostic.size() != 4 ||
                    !diagnostic.at("code").is_string() || !diagnostic.at("severity").is_string() ||
                    !diagnostic.at("path").is_string() || !diagnostic.at("message").is_string())
                    return false;
            reflections.emplace(key, ReflectionEntry{item.at("identity").get<std::string>(),
                                                     item.at("diagnostics")});
        }
        entries_ = std::move(entries);
        reflection_entries_ = std::move(reflections);
        discard_certified_stage();
        artifact_proof_.reset(); // Persisted ledger does not carry watched authority.
        return true;
    } catch (...) {
        return false;
    }
}

Json material_reflection_diagnostics(const Json& compiled, const Json& effective_materials)
{
    Json diagnostics = Json::array();
    for (const auto& [material_id, effective] : effective_materials.items()) {
        if (!effective.value("custom", false))
            continue;
        Json outputs = Json::array();
        for (const auto& output : compiled.value("outputs", Json::array()))
            if (output.value("program", std::string{}) == material_id)
                outputs.push_back(output);
        const auto reflected = noveltea::authoring::validate_material_shader_compiler_result(
            Json{{"ok", true},
                 {"success", true},
                 {"diagnostics", Json::array()},
                 {"outputs", std::move(outputs)}}
                .dump(),
            material_id, effective.dump());
        for (const auto& finding : reflected.diagnostics) {
            auto message = finding.message;
            if (finding.code == "material.shader.orphan") {
                const auto name = finding.path.substr(finding.path.find_last_of('/') + 1);
                std::string unescaped;
                for (std::size_t i = 0; i < name.size(); ++i) {
                    if (name[i] == '~' && i + 1 < name.size() &&
                        (name[i + 1] == '0' || name[i + 1] == '1'))
                        unescaped += name[++i] == '0' ? '~' : '/';
                    else
                        unescaped += name[i];
                }
                const bool texture = finding.path.find("/textures/") != std::string::npos;
                message = "Material " + std::string(texture ? "texture" : "parameter") + " '" +
                          unescaped +
                          "' is not present in the reflected shader interface and remains "
                          "orphaned.";
            }
            diagnostics.push_back({{"code", "shader.material_project"},
                                   {"severity", finding.severity},
                                   {"path", finding.path},
                                   {"message", message}});
        }
    }
    return diagnostics;
}

Json MaterialShaderValidationCache::reflected_materials(const Json& compiled,
                                                        const Json& effective_materials, Work& work)
{
    Json diagnostics = Json::array();
    for (const auto& [material, effective] : effective_materials.items()) {
        if (!effective.value("custom", false))
            continue;
        Json interface_inputs = Json::array();
        for (const auto& output : compiled.value("outputs", Json::array()))
            if (output.value("program", "") == material)
                interface_inputs.push_back(
                    {{"programIdentity", output.value("programIdentity", std::string{})},
                     {"stage", output.value("stage", std::string{})},
                     {"variant", output.value("variant", std::string{})},
                     {"byteHash", output.value("byteHash", std::string{})},
                     {"reflectedInputs", output.value("reflectedInputs", Json::array())}});
        const auto identity = Json{{"effective", effective}, {"outputs", interface_inputs}}.dump();
        auto cached = reflection_entries_.find(material);
        if (cached == reflection_entries_.end() || cached->second.identity != identity) {
            ++work.interface_validations;
            auto findings = material_reflection_diagnostics(compiled, Json{{material, effective}});
            if (reflection_entries_.size() >= 256 && cached == reflection_entries_.end())
                reflection_entries_.erase(reflection_entries_.begin());
            reflection_entries_.insert_or_assign(material,
                                                 ReflectionEntry{identity, std::move(findings)});
            cached = reflection_entries_.find(material);
        } else {
            ++work.interface_reuses;
        }
        for (const auto& finding : cached->second.diagnostics)
            diagnostics.push_back(finding);
    }
    return diagnostics;
}

} // namespace noveltea::tooling
