#include "noveltea/script/compiled_runtime.hpp"

#include "noveltea/script/script_runtime.hpp"

#include <type_traits>
#include <utility>

namespace noveltea::script {
namespace {

template<class> inline constexpr bool always_false = false;

void append_script_error(core::Diagnostics& diagnostics, const ScriptError& error,
                         std::string source_path)
{
    diagnostics.push_back(core::Diagnostic{.code = "runtime.lua_certification_failed",
                                           .message = error.message,
                                           .source_path = std::move(source_path)});
}

void certify_chunk(core::Diagnostics& diagnostics, ScriptRuntime& scripts, std::string_view source,
                   std::string path, bool expression = false)
{
    std::string chunk_source;
    if (expression) {
        chunk_source = "return ";
        chunk_source += source;
        source = chunk_source;
    }
    auto certified = scripts.certify(source, path);
    if (!certified)
        append_script_error(diagnostics, certified.error(), std::move(path));
}

void certify_asset(core::Diagnostics& diagnostics, ScriptRuntime& scripts,
                   std::string_view logical_path, std::string path)
{
    std::string namespaced_path;
    if (logical_path.find(":/") == std::string_view::npos) {
        namespaced_path = "project:/";
        namespaced_path += logical_path;
        logical_path = namespaced_path;
    }
    auto certified = scripts.certify_asset(logical_path);
    if (!certified)
        append_script_error(diagnostics, certified.error(), std::move(path));
}

void certify_condition(core::Diagnostics& diagnostics, ScriptRuntime& scripts,
                       const core::Condition& condition, const std::string& path)
{
    if (const auto* lua = std::get_if<core::LuaPredicate>(&condition))
        certify_chunk(diagnostics, scripts, lua->source, path, true);
}

void certify_effect(core::Diagnostics& diagnostics, ScriptRuntime& scripts,
                    const core::Effect& effect, const std::string& path)
{
    if (const auto* lua = std::get_if<core::RunLuaEffect>(&effect))
        certify_chunk(diagnostics, scripts, lua->source, path);
}

void certify_text(core::Diagnostics& diagnostics, ScriptRuntime& scripts,
                  const core::TextContent& text, const std::string& path)
{
    if (const auto* lua = std::get_if<core::LuaTextExpression>(&text.source))
        certify_chunk(diagnostics, scripts, lua->source, path, true);
}

void certify_interaction_program(core::Diagnostics& diagnostics, ScriptRuntime& scripts,
                                 const core::compiled::InteractionProgram& program,
                                 const std::string& path)
{
    for (std::size_t index = 0; index < program.instructions.size(); ++index) {
        std::visit(
            [&](const auto& instruction) {
                using T = std::decay_t<decltype(instruction)>;
                const auto item_path = path + "/instructions/" + std::to_string(index);
                if constexpr (std::is_same_v<T, core::compiled::ApplyEffectInstruction>)
                    certify_effect(diagnostics, scripts, instruction.effect, item_path + "/effect");
                else if constexpr (std::is_same_v<T, core::compiled::NotifyInstruction>)
                    certify_text(diagnostics, scripts, instruction.message, item_path + "/message");
                else if constexpr (
                    std::is_same_v<T, core::compiled::MoveInteractableInstruction> ||
                    std::is_same_v<T, core::compiled::SetInteractableStateInstruction> ||
                    std::is_same_v<T, core::compiled::CallSceneInteractionInstruction> ||
                    std::is_same_v<T, core::compiled::CallDialogueInteractionInstruction>) {
                } else
                    static_assert(always_false<T>, "Unhandled InteractionInstruction");
            },
            program.instructions[index]);
    }
}

} // namespace

core::Diagnostics certify_compiled_project_lua(const core::CompiledProject& project,
                                               ScriptRuntime& scripts)
{
    core::Diagnostics diagnostics;
    if (project.startup_hook())
        certify_chunk(diagnostics, scripts, project.startup_hook()->source, "/startupHook/source");

    for (std::size_t index = 0; index < project.scripts().size(); ++index) {
        const auto& script = project.scripts()[index];
        if (const auto* inline_source =
                std::get_if<core::compiled::InlineLuaSource>(&script.source))
            certify_chunk(diagnostics, scripts, inline_source->source,
                          "/resources/scripts/" + std::to_string(index) + "/source/inline");
        else if (const auto* asset_source =
                     std::get_if<core::compiled::AssetScriptSource>(&script.source)) {
            const auto* asset = project.find_asset(asset_source->asset);
            if (asset)
                certify_asset(diagnostics, scripts, asset->path,
                              "/resources/scripts/" + std::to_string(index) + "/source/asset");
        }
    }

    for (std::size_t index = 0; index < project.layouts().size(); ++index) {
        const auto& layout = project.layouts()[index];
        if (!layout.script_enabled)
            continue;
        if (const auto* inline_source =
                std::get_if<core::compiled::InlineLayoutSource>(&layout.lua))
            certify_chunk(diagnostics, scripts, inline_source->text,
                          "/resources/layouts/" + std::to_string(index) + "/lua/inline");
        else if (const auto* asset_source =
                     std::get_if<core::compiled::AssetLayoutSource>(&layout.lua)) {
            const auto* asset = project.find_asset(asset_source->asset);
            if (asset)
                certify_asset(diagnostics, scripts, asset->path,
                              "/resources/layouts/" + std::to_string(index) + "/lua/asset");
        }
    }

    for (std::size_t room_index = 0; room_index < project.rooms().size(); ++room_index) {
        const auto& room = project.rooms()[room_index];
        const auto base = "/definitions/rooms/" + std::to_string(room_index);
        certify_text(diagnostics, scripts, room.description, base + "/description");
        certify_condition(diagnostics, scripts, room.lifecycle.can_enter,
                          base + "/lifecycle/canEnter");
        certify_condition(diagnostics, scripts, room.lifecycle.can_leave,
                          base + "/lifecycle/canLeave");
        for (std::size_t hook_index = 0; hook_index < room.lifecycle.hooks.size(); ++hook_index)
            for (std::size_t effect_index = 0;
                 effect_index < room.lifecycle.hooks[hook_index].effects.size(); ++effect_index)
                certify_effect(diagnostics, scripts,
                               room.lifecycle.hooks[hook_index].effects[effect_index],
                               base + "/lifecycle/hooks/" + std::to_string(hook_index) +
                                   "/effects/" + std::to_string(effect_index));
        for (std::size_t placement_index = 0; placement_index < room.placements.size();
             ++placement_index) {
            const auto& placement = room.placements[placement_index];
            if (placement.presentation.label)
                certify_text(diagnostics, scripts, *placement.presentation.label,
                             base + "/placements/" + std::to_string(placement_index) +
                                 "/presentation/label");
        }
        for (std::size_t exit_index = 0; exit_index < room.exits.size(); ++exit_index) {
            certify_condition(diagnostics, scripts, room.exits[exit_index].condition,
                              base + "/exits/" + std::to_string(exit_index) + "/condition");
            certify_text(diagnostics, scripts, room.exits[exit_index].label,
                         base + "/exits/" + std::to_string(exit_index) + "/label");
        }
    }

    for (std::size_t verb_index = 0; verb_index < project.verbs().size(); ++verb_index) {
        const auto& verb = project.verbs()[verb_index];
        const auto base = "/definitions/verbs/" + std::to_string(verb_index);
        certify_text(diagnostics, scripts, verb.action_text, base + "/actionText");
        certify_condition(diagnostics, scripts, verb.availability, base + "/availability");
        certify_interaction_program(diagnostics, scripts, verb.default_program,
                                    base + "/defaultProgram");
    }

    for (std::size_t interaction_index = 0; interaction_index < project.interactions().size();
         ++interaction_index) {
        const auto& interaction = project.interactions()[interaction_index];
        const auto base = "/definitions/interactions/" + std::to_string(interaction_index);
        for (std::size_t rule_index = 0; rule_index < interaction.rules.size(); ++rule_index) {
            const auto& rule = interaction.rules[rule_index];
            if (const auto* predicate =
                    std::get_if<core::compiled::PredicateInteractionContext>(&rule.context))
                certify_condition(diagnostics, scripts, predicate->condition,
                                  base + "/rules/" + std::to_string(rule_index) + "/context");
            certify_interaction_program(diagnostics, scripts, rule.program,
                                        base + "/rules/" + std::to_string(rule_index) + "/program");
        }
    }

    for (std::size_t map_index = 0; map_index < project.maps().size(); ++map_index) {
        const auto& map = project.maps()[map_index];
        const auto base = "/definitions/maps/" + std::to_string(map_index);
        for (std::size_t location_index = 0; location_index < map.locations.size();
             ++location_index) {
            if (map.locations[location_index].label)
                certify_text(diagnostics, scripts, *map.locations[location_index].label,
                             base + "/locations/" + std::to_string(location_index) + "/label");
        }
        if (map.presentation.title)
            certify_text(diagnostics, scripts, *map.presentation.title,
                         base + "/presentation/title");
    }

    for (std::size_t scene_index = 0; scene_index < project.scenes().size(); ++scene_index) {
        const auto& scene = project.scenes()[scene_index];
        const auto base = "/definitions/scenes/" + std::to_string(scene_index) + "/program";
        for (std::size_t instruction_index = 0;
             instruction_index < scene.program.instructions.size(); ++instruction_index) {
            std::visit(
                [&](const auto& instruction) {
                    using T = std::decay_t<decltype(instruction)>;
                    const auto path = base + "/instructions/" + std::to_string(instruction_index);
                    if (instruction.condition)
                        certify_condition(diagnostics, scripts, *instruction.condition,
                                          path + "/condition");
                    if constexpr (std::is_same_v<T, core::compiled::RunLuaSceneInstruction>)
                        certify_chunk(diagnostics, scripts, instruction.source, path + "/source");
                    else if constexpr (std::is_same_v<T, core::compiled::ShowTextInstruction>)
                        certify_text(diagnostics, scripts, instruction.text, path + "/text");
                    else if constexpr (std::is_same_v<T,
                                                      core::compiled::ConditionalBranchInstruction>)
                        for (std::size_t i = 0; i < instruction.branches.size(); ++i)
                            certify_condition(
                                diagnostics, scripts, instruction.branches[i].condition,
                                path + "/branches/" + std::to_string(i) + "/condition");
                    else if constexpr (std::is_same_v<T, core::compiled::ChoiceSceneInstruction>) {
                        if (instruction.prompt)
                            certify_text(diagnostics, scripts, *instruction.prompt,
                                         path + "/prompt");
                        for (std::size_t i = 0; i < instruction.options.size(); ++i) {
                            const auto& option = instruction.options[i];
                            if (option.condition)
                                certify_condition(diagnostics, scripts, *option.condition,
                                                  path + "/options/" + std::to_string(i) +
                                                      "/condition");
                            certify_text(diagnostics, scripts, option.label,
                                         path + "/options/" + std::to_string(i) + "/label");
                            for (std::size_t e = 0; e < option.effects.size(); ++e)
                                certify_effect(diagnostics, scripts, option.effects[e],
                                               path + "/options/" + std::to_string(i) +
                                                   "/effects/" + std::to_string(e));
                        }
                    }
                },
                scene.program.instructions[instruction_index]);
        }
    }

    for (std::size_t dialogue_index = 0; dialogue_index < project.dialogues().size();
         ++dialogue_index) {
        const auto& dialogue = project.dialogues()[dialogue_index];
        const auto base = "/definitions/dialogues/" + std::to_string(dialogue_index) + "/program";
        for (std::size_t block_index = 0; block_index < dialogue.program.blocks.size();
             ++block_index) {
            if (const auto* sequence = std::get_if<core::compiled::DialogueSequenceBlock>(
                    &dialogue.program.blocks[block_index])) {
                for (std::size_t segment_index = 0; segment_index < sequence->segments.size();
                     ++segment_index) {
                    const auto path = base + "/blocks/" + std::to_string(block_index) +
                                      "/segments/" + std::to_string(segment_index);
                    std::visit(
                        [&](const auto& segment) {
                            using T = std::decay_t<decltype(segment)>;
                            if (segment.condition)
                                certify_condition(diagnostics, scripts, *segment.condition,
                                                  path + "/condition");
                            if constexpr (std::is_same_v<T, core::compiled::DialogueRunLuaSegment>)
                                certify_chunk(diagnostics, scripts, segment.source,
                                              path + "/source");
                            else {
                                certify_text(diagnostics, scripts, segment.text, path + "/text");
                                for (std::size_t e = 0; e < segment.effects.size(); ++e)
                                    certify_effect(diagnostics, scripts, segment.effects[e],
                                                   path + "/effects/" + std::to_string(e));
                            }
                        },
                        sequence->segments[segment_index]);
                }
            }
        }
        for (std::size_t edge_index = 0; edge_index < dialogue.program.edges.size(); ++edge_index) {
            if (const auto* choice = std::get_if<core::compiled::DialogueChoiceEdge>(
                    &dialogue.program.edges[edge_index])) {
                const auto path = base + "/edges/" + std::to_string(edge_index);
                if (choice->condition)
                    certify_condition(diagnostics, scripts, *choice->condition,
                                      path + "/condition");
                certify_text(diagnostics, scripts, choice->label, path + "/label");
                for (std::size_t e = 0; e < choice->effects.size(); ++e)
                    certify_effect(diagnostics, scripts, choice->effects[e],
                                   path + "/effects/" + std::to_string(e));
            }
        }
    }
    return diagnostics;
}

CompiledRuntime::CompiledRuntime(core::LoadedCompiledPackage package) noexcept
    : m_package(std::move(package))
{
}

core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
CompiledRuntime::create(core::LoadedCompiledPackage package, ScriptRuntime& scripts,
                        core::TypedSaveSlotStore& saves, std::string runtime_locale)
{
    auto lua_diagnostics = certify_compiled_project_lua(package.project(), scripts);
    if (!lua_diagnostics.empty())
        return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
            std::move(lua_diagnostics));

    auto runtime = std::unique_ptr<CompiledRuntime>(new CompiledRuntime(std::move(package)));
    auto session = TypedRuntimeSession::create(runtime->m_package.project(), scripts, saves,
                                               std::move(runtime_locale));
    if (!session)
        return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
            std::move(session).error());
    runtime->m_session = std::move(*session.value_if());
    return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::success(
        std::move(runtime));
}

} // namespace noveltea::script
