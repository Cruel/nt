#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
struct NativeMessageProjection;

// The staged draft is nonpublishable until compiler finalization (#557).
[[nodiscard]] nlohmann::json lower_room_scene_programs(const nlohmann::json& project,
                                                       const NativeMessageProjection& messages,
                                                       nlohmann::json shared);

// Shared with the subsequent Dialogue/Interaction native lowering stage.
[[nodiscard]] nlohmann::json lower_gameplay_command(const nlohmann::json& project,
                                                    const NativeMessageProjection& messages,
                                                    const nlohmann::json& command,
                                                    const std::string& semantic_path);
[[nodiscard]] nlohmann::json lower_gameplay_condition(const nlohmann::json& condition);

// Completes the native gameplay families without constructing a publishable
// Compiled Project wire. Consumes the same shared definitions and Message IDs.
[[nodiscard]] nlohmann::json
lower_dialogue_interaction_programs(const nlohmann::json& project,
                                    const NativeMessageProjection& messages,
                                    nlohmann::json room_scene_draft);
} // namespace noveltea::cli
