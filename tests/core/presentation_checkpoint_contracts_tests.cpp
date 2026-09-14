#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>
#include <fstream>
#include <string>
#include <type_traits>

using namespace noveltea::core;

namespace {
std::string read_source_file(const std::filesystem::path& path)
{
    std::ifstream input(path);
    REQUIRE(input.good());
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

std::size_t occurrence_count(const std::string& source, const std::string& needle)
{
    std::size_t count = 0;
    std::size_t position = 0;
    while ((position = source.find(needle, position)) != std::string::npos) {
        ++count;
        position += needle.size();
    }
    return count;
}
} // namespace

TEST_CASE("presentation and checkpoint identities cannot authorize unrelated operations")
{
    STATIC_REQUIRE(!std::is_convertible_v<PresentationOperationId, AudioOperationId>);
    STATIC_REQUIRE(!std::is_convertible_v<CheckpointBarrierId, SaveCheckpointRevision>);
    STATIC_REQUIRE(!std::is_constructible_v<MountedLayoutInstanceId, PresentationOperationId>);
    STATIC_REQUIRE(!std::is_constructible_v<CheckpointSaveRequest, CheckpointBarrier>);
    STATIC_REQUIRE(!std::is_constructible_v<CheckpointBarrierSource, ManualSaveRequest>);
}

TEST_CASE("checkpoint readiness requires all capture issues to be cleared")
{
    CheckpointReadinessStatus status{.revision = CheckpointReadinessRevision::from_number(1),
                                     .issues = {}};
    CHECK(status.can_capture());
    status.issues.push_back({.reason = CheckpointReadinessReason::RuntimeTransactionActive,
                             .barrier = std::nullopt,
                             .diagnostic = {"test.transaction", "Transaction active"}});
    status.issues.push_back({.reason = CheckpointReadinessReason::RuntimeQueueUnsettled,
                             .barrier = std::nullopt,
                             .diagnostic = {"test.queue", "Queue unsettled"}});
    CHECK_FALSE(status.can_capture());
    status.issues.pop_back();
    CHECK_FALSE(status.can_capture());
    status.issues.clear();
    CHECK(status.can_capture());
}

TEST_CASE("shared contract headers enforce canonical definitions and dependency boundaries")
{
    const auto source_root = std::filesystem::path{NOVELTEA_SOURCE_DIR};
    const auto include_root = source_root / "engine/include";
    const std::array canonical_headers{include_root / "noveltea/core/session_operation_id.hpp",
                                       include_root / "noveltea/core/presentation_contracts.hpp",
                                       include_root / "noveltea/core/checkpoint_contracts.hpp"};

    std::string contracts;
    for (const auto& header : canonical_headers) {
        contracts += read_source_file(header);
    }

    const std::array forbidden_tokens{
        "nlohmann",  "json.hpp",     "RmlUi",        "Rml::",         "bgfx",
        "Renderer",  "AudioBackend", "miniaudio",    "std::function", "std::exception",
        "type_info", "typeid(",      "dynamic_cast", "std::any",      "unordered_map"};
    for (const auto& token : forbidden_tokens) {
        CAPTURE(token);
        CHECK(contracts.find(token) == std::string::npos);
    }

    std::string public_headers;
    for (const auto& entry :
         std::filesystem::recursive_directory_iterator(include_root / "noveltea")) {
        if (entry.is_regular_file() && entry.path().extension() == ".hpp") {
            public_headers += read_source_file(entry.path());
        }
    }
    CHECK(occurrence_count(public_headers, "using PresentationOperationId =") == 1);
    CHECK(occurrence_count(public_headers, "using AudioOperationId =") == 1);
    CHECK(occurrence_count(public_headers, "using HostRequestId =") == 0);
    CHECK(occurrence_count(public_headers, "using MountedLayoutInstanceId =") == 1);
    CHECK(occurrence_count(public_headers, "struct PresentationOperationTag;") == 1);
    CHECK(occurrence_count(public_headers, "struct MountedLayoutInstanceTag;") == 1);

    const auto runtime_messages =
        read_source_file(include_root / "noveltea/core/runtime_messages.hpp");
    CHECK(runtime_messages.find("noveltea/core/session_operation_id.hpp") != std::string::npos);
    CHECK(runtime_messages.find("using PresentationOperationId =") == std::string::npos);
    CHECK(runtime_messages.find("using AudioCompletionHandle =") == std::string::npos);
    CHECK(runtime_messages.find("TransitionPresentationOperation") == std::string::npos);
    CHECK(runtime_messages.find("LayoutPresentationOperation") == std::string::npos);
}
