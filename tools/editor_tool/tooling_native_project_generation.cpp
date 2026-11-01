#include "tooling_native_project_sync.hpp"

#include "../project_authoring/room_session.hpp"
#include <noveltea/core/fingerprint.hpp>
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/validation_work_instrumentation.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

using noveltea::authoring::exact_source_revision;
using noveltea::authoring::ProjectSession;

// Keep the exact disk-generation proof available to the production CLI and to
// the lightweight runtime-cache test seam without linking all editor tooling.
std::string
native_project_source_generation(const ProjectSession& session, const std::filesystem::path& root,
                                 bool observed_at_entry, std::string_view proof_phase,
                                 std::map<std::string, std::string>* exact_revisions,
                                 const std::map<std::string, std::string>* pinned_revisions)
{
    // The binary member digests changed to XXH3; invalidate durable generations.
    std::string identity = "native-project-source-generation-v2";
    identity.push_back('\0');
    std::size_t text_reuse_hits = 0;
    // Scoped authoritative membership is what defines the source generation;
    // unrelated unregistered Asset neighbors cannot advance it.
    const auto* revisions = session.verified_source_revisions_view();
    if (!revisions)
        throw std::runtime_error("Cannot verify an uncertain native source generation.");
    const auto canonical_root = std::filesystem::canonical(root);
    if (exact_revisions)
        exact_revisions->clear();
    for (const auto& [relative, revision] : *revisions) {
        const auto path = root / std::filesystem::path(relative);
        identity.append(relative).push_back('\0');
        if (revision == "absent") {
            identity.append("absent").push_back('\0');
            if (exact_revisions)
                exact_revisions->emplace(relative, "absent");
        } else {
            // The watched generation already pins text existence, type,
            // containment and exact bytes. The publication fence checks that
            // no relevant event has invalidated that evidence; do not stat
            // every text leaf again on each outer CLI stage.
            if (observed_at_entry && !revision.starts_with("physical:")) {
                identity.append(revision).push_back('\0');
                if (exact_revisions)
                    exact_revisions->emplace(relative, revision);
                ++text_reuse_hits;
                continue;
            }
            if (std::filesystem::symlink_status(path).type() != std::filesystem::file_type::regular)
                throw std::runtime_error("Cannot verify native source generation: " + relative);
            if (revision.starts_with("physical:")) {
                const auto contained =
                    std::filesystem::weakly_canonical(path).lexically_relative(canonical_root);
                if (contained.empty() || contained == ".." || *contained.begin() == "..")
                    throw std::runtime_error("Native Asset source escapes Project: " + relative);
            }
            // The public owner pins exact Asset digests at cache admission.
            // A healthy watcher fence lets preparation reuse that same
            // generation. Final publication separately re-proves binary bytes.
            if (observed_at_entry && revision.starts_with("physical:") && pinned_revisions) {
                const auto pinned = pinned_revisions->find(relative);
                if (pinned == pinned_revisions->end() || !pinned->second.starts_with("xxh3-128:"))
                    throw std::runtime_error("Missing pinned Asset generation evidence: " +
                                             relative);
                identity.append(pinned->second).push_back('\0');
                if (exact_revisions)
                    exact_revisions->emplace(relative, pinned->second);
                continue;
            }
            noveltea::authoring::count_validation_work<
                noveltea::authoring::WorkCounter::StatReadlinkCalls>();
            std::ifstream input(path, std::ios::binary);
            if (!input)
                throw std::runtime_error("Cannot read tracked localization source.");
            const auto size = std::filesystem::file_size(path);
            if (size > static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
                throw std::runtime_error("Tracked source exceeds native digest capacity.");
            std::string digest;
            if (revision.starts_with("physical:")) {
                noveltea::core::Xxh3Hasher hasher;
                std::array<char, 64 * 1024> buffer{};
                auto remaining = size;
                while (remaining != 0) {
                    const auto chunk = static_cast<std::streamsize>(
                        std::min<std::uintmax_t>(remaining, buffer.size()));
                    if (!input.read(buffer.data(), chunk))
                        throw std::runtime_error("Cannot finish localization source read.");
                    hasher.update(std::string_view(buffer.data(), static_cast<std::size_t>(chunk)));
                    remaining -= static_cast<std::uintmax_t>(chunk);
                }
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::GenerationAssetProofReads>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::FileByteReads>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::FileBytesRead>(size);
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::GenerationAssetBytesRead>(size);
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::GenerationAssetProofHashes>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::ContentHashes>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::ContentBytesHashed>(size);
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::GenerationAssetBytesHashed>(size);
                digest = hasher.finish();
            } else {
                // Fresh non-admission text proofs retain the native XXH3-128
                // authoring revision contract.
                std::string bytes(static_cast<std::size_t>(size), '\0');
                if (!bytes.empty() &&
                    !input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
                    throw std::runtime_error("Cannot finish localization source read.");
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::GenerationTextProofReads>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::FileByteReads>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::FileBytesRead>(bytes.size());
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::ContentHashes>();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::ContentBytesHashed>(bytes.size());
                digest = exact_source_revision(bytes);
            }
            if (input.peek() != std::char_traits<char>::eof() ||
                std::filesystem::file_size(path) != size)
                throw std::runtime_error("Cannot finish localization source read.");
            identity.append(digest).push_back('\0');
            if (exact_revisions)
                exact_revisions->emplace(relative, std::move(digest));
            if (revision.starts_with("physical:"))
                noveltea::authoring::trace_exact_asset_proof(proof_phase, relative,
                                                             static_cast<std::size_t>(size));
        }
    }
    if (text_reuse_hits)
        noveltea::authoring::trace_source_proof_event(proof_phase, "text-reuse", text_reuse_hits);
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ContentHashes>();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ContentBytesHashed>(identity.size());
    return exact_source_revision(identity);
}

bool native_project_source_generation_is_current(const std::filesystem::path& root,
                                                 std::string_view expected)
{
    std::string error;
    auto fresh = ProjectSession::open(root, error);
    return fresh && native_project_source_generation(*fresh, root) == expected;
}
