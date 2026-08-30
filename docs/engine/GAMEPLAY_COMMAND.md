# Gameplay Commands

Gameplay Commands are the shared typed vocabulary for ordinary gameplay mutation, flow handoff,
feedback, and the explicit Lua escape hatch. Interactions, Dialogue effect programs, Scene
gameplay-mutation surfaces, and Room lifecycle/rejection programs use the same authoring definitions,
compiled command records, editor component, validation rules, and runtime execution semantics. Hosts
provide only their available reference context and admissibility policy; they do not define private
copies of the command language.

## Vocabulary

The current command set covers Global Property and identity Property mutation, Add/Remove Trait, Set
Enabled/Visible, Move Instance, Room/Character/Interactable creation, Instance destruction,
Split/Merge/Transfer/Add/Consume quantity operations, Call Scene, Call Dialogue, Notify, Run Lua, and
recursive `If/Else`. `Present Inventory` presents an exact owner-qualified Inventory using an explicit
Layout when supplied, otherwise the Project default Inventory Layout and then the built-in fallback.

These commands are generic mechanics rather than adventure-game Verbs. Pick Up, Give, Open, Use,
Inspect, and similar authored actions remain Verbs/Interactions composed from Gameplay Commands.

## Typed operands and results

Commands and Conditions share the typed operand vocabulary documented in `CONDITION.md`. Exact
identities, Interaction slots, earlier command results, Current Room, exact/owner-local/Player
Inventories, and Room/Inventory/Unplaced Locations are available only where the host supplies the
required context.

Commands that create an identity may bind a program-local result. Result bindings carry their
semantic type: Room, Character, or Interactable. Compiled-project validation rejects use before
definite binding and rejects incompatible uses such as supplying a Room result to an
Interactable-only operand. An `If/Else` result is available after the branch only when both branches
definitely bind that result with the same type. Result bindings do not escape their command program.

## Execution and transaction boundaries

Consecutive immediate commands form one automatic atomic mutation group. Runtime first applies that
group to staged state; if any command fails, none of the group's mutations commit. Pure `If/Else`
participates in that group when every command in both branches is immediate.

Observable or yielding commands form natural transaction boundaries. Notify, Call Scene, Call
Dialogue, and a suspending Run Lua therefore do not retroactively roll back already committed
immediate mutations. `If/Else` may contain those commands: the Flow frame records the exact nested
command cursor so execution resumes after the observable child rather than restarting the branch.
Dialogue persists that nested effect cursor in the existing current save shape so a valid checkpoint
can resume deterministically.

Scene `gameplay-effect-batch` Events admit immediate Gameplay Commands only and therefore remain one
atomic mutation boundary. The legacy `set-variable` Scene authoring Event lowers to a one-command
batch instead of producing a private compiled mutation instruction. Scene Choice effects also store
Gameplay Commands; their admitted set preserves the former immediate-mutation plus Run Lua behavior.
Audiovisual/timeline Events, waits, transitions, Scene terminals, and advanced structural Runtime
World transactions remain Scene-owned orchestration rather than being generalized into commands.

Aggregate Transfer is atomic across compatible exact Interactable Instances. It preserves whole
source identities where possible, splits only the boundary quantity, and never implicitly merges
with destination stacks. Because several identities may participate, aggregate Transfer cannot bind a
singular result.

## Editor and implementation

`GameplayCommandListEditor` is the reusable editor for Interaction programs, Dialogue effects, Room
lifecycle/rejection programs, and Scene gameplay-mutation surfaces. Host policy supplies available
Interaction slots, command results, Current Room/Player Inventory, and an optional admitted-command
set; nested `If/Else` uses the same component recursively.

The primary implementation surfaces are:

- `editor/src/shared/project-schema/authoring-flow.ts`
- `editor/src/renderer/components/gameplay-commands/GameplayCommandEditor.tsx`
- `engine/include/noveltea/core/execution_primitives.hpp`
- `engine/src/core/compiled_project_validation.cpp`
- `engine/src/runtime/runtime_executor.cpp`
- `engine/src/runtime/runtime_executor_interaction.cpp`
- `engine/src/runtime/runtime_executor_dialogue.cpp`
- `engine/src/runtime/runtime_world.cpp`

The current schema, compiled-project, protocol, and save version numbers are intentionally preserved;
the repository still supports one canonical shape at each already-selected version.
