#include "tooling_native_project_sync.hpp"

#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"

#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>

using noveltea::authoring::ProjectSession;
using noveltea::authoring::exact_source_revision;

// Keep the exact disk-generation proof available to the production CLI and to
// the lightweight runtime-cache test seam without linking all editor tooling.
std::string native_project_source_generation(const ProjectSession& session,
                                             const std::filesystem::path& root)
{
    std::string identity = "native-project-source-generation-v1";
    identity.push_back('\0');
    // Scoped authoritative membership is what defines the source generation;
    // unrelated unregistered Asset neighbors cannot advance it.
    const auto revisions = session.verified_source_revisions();
    if (!revisions)
        throw std::runtime_error("Cannot verify an uncertain native source generation.");
    for (const auto& [relative, revision] : *revisions) {
        const auto path = root / std::filesystem::path(relative);
        identity.append(relative).push_back('\0');
        if (revision == "absent") {
            identity.append("absent").push_back('\0');
        } else {
            if (!std::filesystem::is_regular_file(path) || std::filesystem::is_symlink(path))
                throw std::runtime_error("Cannot verify native source generation: " + relative);
            std::ifstream input(path, std::ios::binary);
            if (!input)
                throw std::runtime_error("Cannot read tracked localization source.");
            const std::string bytes{std::istreambuf_iterator<char>(input),
                                    std::istreambuf_iterator<char>()};
            if (input.bad())
                throw std::runtime_error("Cannot finish localization source read.");
            identity.append(exact_source_revision(bytes)).push_back('\0');
        }
    }
    return exact_source_revision(identity);
}

bool native_project_source_generation_is_current(const std::filesystem::path& root,
                                                 std::string_view expected)
{
    std::string error;
    auto fresh = ProjectSession::open(root, error);
    return fresh && native_project_source_generation(*fresh, root) == expected;
}
