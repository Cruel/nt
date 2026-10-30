#include "tooling_native_project_sync.hpp"

#include "../project_authoring/room_session.hpp"
#include <noveltea/core/fingerprint.hpp>
#include "../project_authoring/source_authority.hpp"

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
std::string native_project_source_generation(const ProjectSession& session,
                                             const std::filesystem::path& root,
                                             bool observed_at_entry, std::string_view proof_phase,
                                             std::map<std::string, std::string>* exact_revisions)
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
            if (std::filesystem::symlink_status(path).type() !=
                std::filesystem::file_type::regular)
                throw std::runtime_error("Cannot verify native source generation: " + relative);
            // An authoritative observation already read and hashed all text
            // sources. Only binary Assets have physical (size/time) hints and
            // still require a fresh byte-exact digest for generation proof.
            if (observed_at_entry && !revision.starts_with("physical:")) {
                identity.append(revision).push_back('\0');
                if (exact_revisions)
                    exact_revisions->emplace(relative, revision);
                ++text_reuse_hits;
                continue;
            }
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
                digest = hasher.finish();
            } else {
                // Text revisions remain SHA-256, including fresh non-admission
                // proofs where their observed digest cannot be reused.
                std::string bytes(static_cast<std::size_t>(size), '\0');
                if (!bytes.empty() &&
                    !input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
                    throw std::runtime_error("Cannot finish localization source read.");
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
    return exact_source_revision(identity);
}

bool native_project_source_generation_is_current(const std::filesystem::path& root,
                                                 std::string_view expected)
{
    std::string error;
    auto fresh = ProjectSession::open(root, error);
    return fresh && native_project_source_generation(*fresh, root) == expected;
}
