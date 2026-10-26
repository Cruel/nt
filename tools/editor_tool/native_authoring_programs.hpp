#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
struct NativeMessageProjection;

// Only the Scene/Room programs are attached. The draft is nonpublishable until
// Dialogue/Interaction, localization and compiler finalization are complete.
[[nodiscard]] nlohmann::json lower_room_scene_programs(const nlohmann::json& project,
                                                       const NativeMessageProjection& messages,
                                                       nlohmann::json shared);

// Shared with the subsequent Dialogue/Interaction native lowering stage.
[[nodiscard]] nlohmann::json lower_gameplay_command(const nlohmann::json& project,
                                                    const NativeMessageProjection& messages,
                                                    const nlohmann::json& command,
                                                    const std::string& semantic_path);
} // namespace noveltea::cli
