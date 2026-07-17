# Runtime Execution and Capability Specification

Status: Proposed normative architecture. This document defines the target runtime execution,
transaction, command, capability, scripting, publication, and dependency contracts that future
implementation plans must follow. Existing code is evidence of current behavior, not proof that the
target contract is already implemented.

## Purpose and authority

NovelTea already has a typed immutable `CompiledProject`, one mutable `SessionState`, explicit Flow
frames and blockers, a safe retained-checkpoint service, a Lua-only scripting runtime, typed runtime
messages, and backend-neutral presentation coordination. The remaining work must preserve those
strengths while correcting several organizational problems:

- general gameplay runtime types currently appear to belong to the scripting subsystem;
- one broad runtime-session class combines execution, scripting, host brokerage, checkpointing,
  presentation correlation, playback, and publication;
- internal runtime-owned commands are mixed with genuine external host requests;
- Lua binds through one broad target object rather than explicit semantic capability groups;
- runtime UI, presentation, preview, and debugger projections are not yet defined as one settled
  publication boundary;
- transaction and checkpoint settlement currently depend on orchestration spread across runtime and
  UI-facing code.

This specification freezes the corrected runtime architecture required by
[`RUNTIME_AND_PRESENTATION_ARCHITECTURE_CONSOLIDATION_OVERVIEW.md`](plans/RUNTIME_AND_PRESENTATION_ARCHITECTURE_CONSOLIDATION_OVERVIEW.md).
It is authoritative for:

- runtime object ownership and lifetime;
- `SessionState` organization and mutation rules;
- Flow execution responsibility;
- runtime dispatch transactions and settlement;
- immediate mutations, deferred runtime commands, and external host requests;
- semantic capability groups and restricted capability profiles;
- Lua adaptation and script invocation boundaries;
- coherent runtime publication;
- presentation/checkpoint integration seams;
- target names and namespace ownership for current `Typed*` and `script::*` runtime classes.

The later world/Room and presentation specifications own the exact Character, Interactable, Room
composition, scoped presentation, transition, and renderer-facing payloads. They must use the
execution and capability seams defined here rather than creating parallel transaction or scripting
systems.

## Scope

This document covers the runtime from an already validated immutable `LoadedCompiledPackage` to
settled gameplay publications and typed requests for external services.

It includes:

- construction and destruction of one running game;
- mutable gameplay state and execution ownership;
- runtime input admission and dispatch;
- Scene, Dialogue, Interaction, and Room-transition execution integration;
- Lua invocation and yielding;
- semantic gameplay query and command APIs;
- transaction mutation tracking;
- deferred internal work;
- host request lifecycle;
- presentation/audio operation acceptance;
- checkpoint readiness and retained checkpoint publication;
- UI, presentation, preview, and debugger projection coherence;
- load, reset, stop, and project-reload cleanup.

It does not define:

- authoring record schemas or editor UI;
- detailed Room composition payloads;
- final Character world-state fields;
- final scoped presentation record variants;
- transition rendering algorithms;
- bgfx, RmlUi, miniaudio, SDL, or platform objects;
- shell/menu workflow details;
- a new package or save format by itself;
- an entity-component system, service locator, or dependency-injection framework;
- compatibility with deleted legacy runtime, controller, dispatcher, or JSON state models.

## Terminology

### Running game

A **running game** is the lifetime owner joining one immutable loaded package with one mutable runtime
session. It is not a second gameplay model and does not execute instructions itself.

### Runtime session

The **runtime session** is the sole authoritative owner of mutable gameplay execution for one running
game. It owns session state, Flow execution, transaction settlement, checkpoint generations, command
queues, external request tracking, operation correlation, and settled publication.

### Runtime executor

The **runtime executor** interprets immutable compiled programs against the session's mutable state.
It owns no second state graph and does not publish directly to UI, presentation, or host adapters.

### Capability

A **capability** is a typed semantic query or command exposed to an approved frontend such as Lua,
a gameplay Layout event, preview tooling, or tests. Capabilities express author intent and never
expose backend handles or concrete engine subsystem objects.

### Dispatch transaction

A **dispatch transaction** is one atomic runtime processing boundary beginning with one admitted
external input or one explicit runtime lifecycle command and ending after internal commands,
execution, operation acceptance, checkpoint evaluation, and publication have settled.

### Immediate mutation

An **immediate mutation** is a validated state change that is safe to apply within the currently
executing unit without invalidating the active instruction visitor, Flow stack traversal, or script
invocation.

### Deferred runtime command

A **deferred runtime command** is typed work owned entirely by the runtime but postponed until the
current execution unit reaches a safe mutation boundary.

### External host request

An **external host request** is typed work that cannot be completed by the runtime alone and requires
an operating-system, storage, platform, editor, network, or other explicitly external service.

### Runtime event

A **runtime event** is an ordered one-time output such as a presentation operation, user
communication, save outcome, or external request. It is distinct from an idempotent runtime
publication.

### Runtime publication

A **runtime publication** is an immutable coherent set of projections derived from one settled
logical state revision.

## Foundational rules

The following rules are mandatory.

1. There is one authoritative mutable runtime session per running game.
2. `CompiledProject` and all compiled programs remain immutable.
3. `SessionState` remains the sole mutable gameplay-state aggregate.
4. Flow owns Flow stack, frame, continuation, blocker, and runtime-mode transitions; it does not need
   to mediate every unrelated state mutation.
5. Lua and other frontends call semantic capabilities, not `Engine`, `SessionState`, renderer,
   RmlUi, audio backend, or platform objects.
6. Internal runtime commands never leave the runtime merely to return through a host acknowledgement.
7. External requests are explicit, typed, and tracked only when an external service is genuinely
   required.
8. One outer dispatch transaction produces at most one settled runtime publication.
9. Runtime UI and presentation projections are distinct typed views of the same settled state.
10. Presentation/audio operation acceptance occurs before checkpoint settlement for the transaction
    that created the operation.
11. No new checkpoint is captured while an outer dispatch transaction is active.
12. Backend state, Lua VM state, coroutine internals, callbacks, renderer resources, RmlUi documents,
    audio voices, and platform handles never enter `SessionState` or `SaveState`.
13. All recoverable failures use typed `Result`, `Diagnostics`, or `ScriptError`; no C++ exception or
    compiler RTTI is introduced.
14. No subsystem may create a parallel mutation generation, save truth, or publication revision that
    competes with the runtime session.

## Target composition

The target ownership graph is:

```text
RunningGame
  ├── LoadedCompiledPackage                         immutable
  └── RuntimeSession                               mutable authority
        ├── SessionState
        ├── FlowExecutor
        ├── RuntimeExecutor
        ├── RuntimeCommandGateway
        ├── RuntimeCheckpointService
        ├── DeferredRuntimeCommandQueue
        ├── ExternalHostRequestTracker
        ├── RuntimePublicationProjector
        └── runtime operation/input/output state

ScriptRuntime                                       Lua VM/backend
  └── ScriptInvocationPort implementation
        └── adapts RuntimeCapabilitySet

PresentationRuntimePort                             external semantic port
  └── presentation coordinator/bridge implementation

TypedSaveSlotStore                                  external byte-storage port
```

The host composition root constructs and wires these objects explicitly. No object discovers another
through globals, singletons, service locators, or `Engine::instance()`.

## Final runtime type and namespace ownership

General gameplay runtime types belong under `noveltea::runtime`.

The target names are:

| Current type | Target type | Final responsibility |
| --- | --- | --- |
| `script::CompiledRuntime` | `runtime::RunningGame` | Own loaded package plus one runtime session for the loaded-game lifetime |
| `script::TypedRuntimeSession` | `runtime::RuntimeSession` | Public runtime dispatch facade and sole mutable session authority |
| `script::TypedExecutionKernel` | `runtime::RuntimeExecutor` | Program execution and typed feature behavior against session-owned state |
| `script::RuntimeCheckpointService` | `runtime::RuntimeCheckpointService` | Checkpoint readiness, generations, retained checkpoint, and save commands |
| `core::ScriptHostServices` | `runtime::RuntimeCommandGateway` plus command/request queues | Typed semantic queries and commands for scripts and other frontends |
| `script::RuntimeScriptApi` | retained under `noveltea::script` | Lua-facing adapter over approved runtime capabilities |
| `script::ScriptRuntime` | retained under `noveltea::script` | Sandboxed Lua VM and binding backend |
| `script::ScriptInvoker` | retained under `noveltea::script` or hidden implementation | Invocation/coroutine adapter implementing the runtime script port |

The implementation plan may stage aliases or file moves internally, but no deleted legacy API is a
compatibility requirement. The final public documentation and production code must use the target
names consistently.

`RunningGame` is retained as a meaningful lifetime owner rather than deleting the current wrapper.
It must remain narrow:

```cpp
class RunningGame final {
public:
    [[nodiscard]] const core::LoadedCompiledPackage& package() const noexcept;
    [[nodiscard]] RuntimeSession& session() noexcept;

private:
    core::LoadedCompiledPackage m_package;
    std::unique_ptr<RuntimeSession> m_session;
};
```

It does not duplicate settings, resource registries, state, checkpoint data, or presentation state.

## SessionState organization

`SessionState` remains one value-owned aggregate. It is not replaced by independently authoritative
manager objects.

Its implementation is organized into five cohesive private state families:

```text
FlowState
GameplayState
PresentationState
HistoryState
TimeState
```

### FlowState

`FlowState` contains:

- `RuntimeMode`;
- Flow stack and frame positions;
- active Flow blocker;
- execution fault;
- frame and blocker allocators;
- state required to enforce Flow invariants.

Only Flow/runtime execution services may mutate Flow stack, frames, blockers, or mode.

### GameplayState

`GameplayState` contains authoritative mutable gameplay facts, including:

- variable values;
- property overrides;
- current Room/world location state;
- Interactable state;
- future Character world state;
- gameplay pause intent;
- other nonhistorical logical gameplay facts.

Exact Character and Room records are assigned to the world/Room specification.

### PresentationState

`PresentationState` contains reconstructible desired presentation intent, not backend realization.
It includes current logical text, choices, Map intent, desired audio intent, and the future scoped
Room/Scene/session presentation records defined by the presentation specification.

It excludes:

- interpolation progress;
- render targets;
- RmlUi documents and focus;
- audio voices and decoders;
- tween objects;
- backend operation callbacks.

### HistoryState

`HistoryState` contains accumulated logical history such as:

- Room visits;
- Dialogue line and choice history;
- show-once markers;
- text log;
- other authored-history records.

### TimeState

`TimeState` contains deterministic simulation and temporal state:

- play time;
- saved random generator state;
- logical timers and pending logical completions;
- time-domain values that are part of runtime state rather than backend clocks.

Engine/RmlUi/audio absolute clocks remain host or presentation realization state.

### State-family constraints

The state families are organizational value types, not public services. They must obey:

- no independent lifetime or heap ownership is required;
- no state family publishes directly to consumers;
- no state family writes save slots;
- no state family allocates presentation/audio backend identities;
- no mutable reference to an entire state family is exposed publicly;
- mutations use typed methods validating against `CompiledProject`;
- every successful mutation reports its mutation impact through the session transaction recorder;
- save projection reads the single coherent aggregate.

Source files may be split by state family, but one `SessionState` public contract remains.

## RuntimeSession ownership

`RuntimeSession` owns:

- one `SessionState`;
- one Flow executor operating on that state;
- one runtime executor operating on compiled definitions and that state;
- one checkpoint service;
- one semantic command gateway;
- current deferred command queue;
- pending external request records;
- session-local operation and request allocators owned by runtime contracts;
- active transaction state and mutation journal;
- current settled publication and revision;
- runtime event/output queues;
- playback/debug state only where it is part of the runtime contract.

`RuntimeSession` does not own:

- `CompiledProject` or package bytes;
- the Lua VM;
- renderer, RmlUi, audio backend, platform, assets, or editor objects;
- presentation coordinator lifecycle records;
- byte-storage implementation;
- shell/menu state.

It borrows stable ports whose owners outlive the session:

- immutable `CompiledProject`;
- `ScriptInvocationPort`;
- `PresentationRuntimePort`;
- `TypedSaveSlotStore`;
- any explicitly admitted external host request sink.

The construction API must make those dependencies explicit and reject incomplete wiring before a
session is published.

## RuntimeExecutor responsibility

`RuntimeExecutor` replaces the broad conceptual role of `TypedExecutionKernel` but does not become a
second session facade.

It is responsible for:

- evaluating typed conditions, effects, waits, and text;
- executing Scene, Dialogue, Interaction, and Room-transition program units;
- invoking Lua through `ScriptInvocationPort`;
- validating feature-specific instruction operands;
- applying immediate typed state mutations;
- emitting deferred runtime commands where structural mutation must wait;
- emitting presentation/audio operation requests through the session transaction;
- returning typed execution outcomes and diagnostics.

It is not responsible for:

- external input dispatch;
- public Lua API binding;
- checkpoint slot writes;
- presentation backend realization;
- external host acknowledgement;
- editor preview protocol encoding;
- publication delivery.

The executor may be a concrete session-owned component rather than a virtual service. It borrows the
session's state, command recorder, script port, and immutable project. It retains no duplicate Flow
stack, continuation, or desired presentation cache.

## Flow ownership

The existing single Flow stack and typed frame model remain.

Flow is the sole owner of:

- frame push, pop, and tail replacement;
- frame cursor advancement;
- return destinations;
- Room-transition frame construction;
- active Flow blocker installation, completion, and cancellation;
- transitions among Room, Flow, and Ended runtime modes;
- stale/wrong-owner blocker rejection.

Flow is not the mandatory route for:

- setting a variable;
- changing a property override;
- updating a safe scalar gameplay fact;
- appending a text-log entry;
- changing desired presentation state through its owning typed service.

Those mutations still occur inside the runtime transaction and report mutation impact. This
clarification replaces documentation claiming that Flow is the sole mutation service for all state.

## Dispatch transaction contract

Every public runtime input is processed by one outer dispatch transaction.

The public shape is provisionally:

```cpp
struct RuntimeDispatchResult {
    RuntimeInputDisposition disposition;
    std::optional<RuntimePublication> publication;
    std::vector<RuntimeEvent> events;
    core::Diagnostics diagnostics;
};

class RuntimeSession {
public:
    [[nodiscard]] RuntimeDispatchResult dispatch(const core::RuntimeInputMessage& input);
};
```

The exact container names may be adjusted by the implementation plan, but the semantics below are
fixed.

### Transaction sequence

One outer dispatch transaction performs these steps in order:

1. Reject reentrant public dispatch and begin an internal transaction scope.
2. Validate lifecycle state and input admission.
3. Apply the initiating runtime input or lifecycle command.
4. Execute Flow/runtime units until blocked, ended, faulted, budget-yielded, or otherwise settled.
5. Apply immediate mutations and append their impact to the transaction mutation journal.
6. Drain deferred runtime commands in deterministic FIFO order at safe execution boundaries.
7. Continue execution when a drained command creates or resumes executable Flow.
8. Synchronously submit presentation/audio operation requests to `PresentationRuntimePort`.
9. Record accepted operation lifecycle and the resulting presentation checkpoint status.
10. Publish or update pending external host requests.
11. Evaluate checkpoint readiness and retained-checkpoint replacement from the fully settled runtime
    transaction state.
12. Project at most one coherent runtime publication.
13. Commit ordered runtime events and diagnostics to the dispatch result.
14. End the transaction scope.

Steps may be implemented through internal loops rather than one function per step, but observable
ordering must match this contract.

### Nested work

Internal execution may create nested calls, Lua invocations, commands, and operation requests. It
does not begin another public dispatch transaction.

Nested transaction depth may exist as an implementation guard, but:

- only the outermost transaction settles generations, checkpoints, and publication;
- nested work appends to the same mutation journal and ordered event sequence;
- public `begin_dispatch_transaction()` and `settle_dispatch_transaction()` are not final API;
- UI and host adapters cannot manually control transaction depth.

### Reentrancy

Calling `RuntimeSession::dispatch()` recursively is an error. Lua commands, Layout event commands,
presentation acknowledgements, and host acknowledgements are converted to queued internal work or a
later external input rather than recursively dispatching.

### Instruction and command budgets

The transaction must have bounded execution and command-drain budgets. Exceeding a budget yields a
typed diagnostic and a defined runtime outcome; it must not loop indefinitely or partially publish
an incoherent state.

Budget yielding that preserves a valid executable state may produce a settled publication. Budget
exhaustion caused by a self-generating command cycle must fault or reject the cycle according to the
implementation plan.

## Mutation impact and generation tracking

Mutation generation tracking must be centralized at the transaction boundary rather than manually
scattered among every frontend adapter.

Each successful state mutation contributes typed impact such as:

```text
StructuralStateChanged
TimeStateChanged
GameplayUiInvalidated
PresentationInvalidated
CheckpointReadinessInvalidated
ObservationInvalidated
```

The exact representation may be a bitset, closed struct, or recorder API. The following invariants
are fixed:

- an invalid mutation records no impact and changes no state;
- state methods or owning mutation services report impact exactly once;
- frontends do not call `record_structural_mutation()` manually after invoking another owner;
- the outer transaction coalesces all impacts;
- structural and time checkpoint generations advance according to the existing checkpoint policy;
- presentation recomposition/projection occurs at most once after all relevant mutations settle;
- publication revision advances at most once per transaction;
- no backend acknowledgement itself increments gameplay mutation generations unless it changes
  authoritative logical state through a typed completion path.

## Immediate mutations

Immediate mutations are allowed only when they cannot invalidate the active execution structure.

Typical immediate mutations include:

- setting a validated variable;
- setting or unsetting a validated property override;
- appending or clearing typed text-log state;
- deterministic random draws;
- updating a simple target state already owned by the active instruction;
- setting semantic gameplay pause intent.

An immediate mutation must:

- be validated before mutation;
- be atomic with respect to failure;
- report mutation impact;
- never invoke a host or backend callback;
- never recursively run Flow;
- never publish directly.

The implementation plan may conservatively defer a mutation that could technically be immediate.
It may not apply a structurally unsafe mutation immediately for convenience.

## Deferred runtime commands

Deferred runtime commands are a closed internal variant. They carry strong IDs and typed payloads,
not callbacks or generic maps.

The command vocabulary includes, at minimum, categories for:

- starting a transient Scene or Dialogue;
- calling a child Scene or Dialogue;
- tail-replacing Flow;
- initiating Room navigation;
- applying structurally sensitive world-location changes;
- applying scoped desired-presentation changes;
- runtime reset/load completion work;
- other runtime-owned mutations that cannot safely occur inside the current visitor.

Exact world and presentation payloads are defined by later specifications.

### Command rules

- Commands are validated when requested as far as current state permits.
- A command that fails initial validation is not queued.
- Commands retain stable typed source context for diagnostics.
- Commands are drained FIFO unless a typed command contract explicitly defines replacement or
  coalescing.
- Command sequence identities are session-local and are not serialized.
- A command may enqueue additional commands; the transaction budget still applies.
- Commands do not receive `HostRequestId` values.
- Commands do not appear in external runtime protocol output.
- Commands do not pass through `RuntimeUI`.
- Command completion is represented through runtime/Flow/script handles where needed, not through a
  fake host acknowledgement.

### Structural command safety

A command that changes Flow, Room, world ownership, or presentation ownership executes only after the
current instruction or script callback has returned to a safe boundary. The runtime must never erase
or replace the active frame while native code is still visiting an instruction owned by that frame.

## External host requests

External host requests are reserved for operations requiring authority or data outside the runtime.

Potential examples include:

- an operating-system service;
- a future network or platform entitlement operation;
- an editor-only external tool action;
- an asynchronous storage operation if the selected slot-store implementation cannot satisfy the
  synchronous typed port;
- other explicitly admitted host integrations.

Navigation, Flow calls, Interactable moves, scoped presentation changes, and normal notifications are
not external host requests merely because a script initiated them.

### Request contract

Each request has:

- a strong session-local request ID;
- a closed typed payload;
- source diagnostic context;
- an explicit completion policy;
- an explicit checkpoint/barrier policy;
- a terminal success, failure, or cancellation input.

Requests default to checkpoint barriers when unresolved completion could affect authoritative
execution or event ordering. A request may be nonblocking only through a typed contract proving that
discarding or delaying its result cannot change gameplay state.

Generic string commands, arbitrary JSON payloads, and untyped callbacks are forbidden.

### Host request acknowledgement

The host acknowledges a request through a later `RuntimeInputMessage`. Acknowledgement validation
must reject:

- unknown request IDs;
- already-terminal requests;
- wrong request kinds;
- stale requests from a previous loaded game or reset generation;
- malformed result payloads.

No state changes on a rejected acknowledgement.

## Runtime semantic capability model

The runtime exposes typed semantic capability groups. These are the stable conceptual boundary for
Lua, gameplay Layout events, tests, preview controls, and debug tools.

The initial capability groups are:

| Capability group | Representative responsibility |
| --- | --- |
| Variables | typed reads and writes of declared global variables |
| Properties | typed property lookup, set, and unset on admitted owner kinds |
| Flow | start/call/replace/return/end operations permitted to the context |
| Room | current Room queries, validated navigation, and later composition/recomposition commands |
| Character | Character definition/world-state queries and typed world mutations |
| Interactable | location, enabled, visible, selection, and interaction-related commands |
| Presentation | scoped desired actor/prop/environment/Layout mutations and semantic operations |
| Audio | semantic audio intent and finite playback operations |
| Map | present, hide, focus, selection, and normal navigation activation |
| Save | checkpoint-aware save/load/delete/query commands |
| Game | lifecycle, pause/resume, runtime status, and other project-wide semantic commands |
| Random | deterministic saved random operations |
| TextLog | typed log queries and mutations |

The world and presentation specifications finalize the payloads for their groups.

### Capability implementation

The architecture does not require one heap object or virtual interface per capability group.

One concrete session-owned `RuntimeCommandGateway` may implement all capability methods. Restricted
frontends receive typed non-owning views exposing only admitted groups or methods.

Conceptually:

```cpp
class RuntimeCommandGateway {
public:
    VariablesCapability variables();
    PropertiesCapability properties();
    FlowCapability flow();
    RoomCapability rooms();
    PresentationCapability presentation();
    // ...
};

struct RuntimeCapabilitySet {
    VariablesCapability variables;
    std::optional<FlowCapability> flow;
    std::optional<PresentationCapability> presentation;
    // ...
};
```

The final implementation may use references, lightweight facades, or interfaces. It must not create a
large dependency-injection container or generic name-based service registry.

### Query and command separation

Capabilities distinguish synchronous queries from commands.

Queries:

- read immutable definitions or current logical state;
- do not publish or mutate;
- return typed values or diagnostics immediately;
- are safe only within the context profile that admitted them.

Commands:

- validate author intent;
- apply an immediate mutation or enqueue a deferred runtime command;
- may create a typed wait/completion relationship;
- never return backend objects;
- never call public runtime dispatch recursively.

The C++ API must make the distinction visible through names, return types, or separate capability
facades.

## Capability profiles

Not every script or frontend receives the same capability set.

Capability profiles are selected by the engine/runtime contract that creates the context. They are
not unchecked author-provided strings and cannot be escalated from Lua.

### GameplayScript

Used by explicit authored effect scripts and yielding Scene/Dialogue/Interaction script
instructions.

It may receive the approved gameplay capability surface, including mutation and yielding commands.
Individual invocation sites may still forbid operations that would violate their Flow contract.

### SynchronousExpression

Used for conditions, text expressions, and other pure synchronous evaluation.

It receives:

- deterministic read-only variables/properties;
- approved definition and logical-state queries;
- locale/text helpers where required.

It does not receive:

- mutation capabilities;
- Flow commands;
- save/load;
- presentation/audio commands;
- external host requests;
- yielding;
- nondeterministic wall-clock or host state.

### RoomComposition

Used by the future Room composition callback.

It receives:

- read-only deterministic gameplay/world queries;
- immutable Room and project context;
- one temporary typed Room-presentation draft owned by the resolver.

It does not receive:

- normal `RuntimeCommandGateway` mutation groups;
- variable/property writes;
- Flow or navigation commands;
- persistent scoped-presentation mutation APIs;
- audio, dialogue, notification, save, or host requests;
- yielding;
- random draws;
- wall-clock time;
- a retainable pointer/reference to the draft after return.

The world/Room specification defines the exact query and draft surface.

### GameplayLayoutEvent

Used by authored gameplay Layout event handlers.

It receives a purpose-specific subset of gameplay semantic capabilities. It may issue normal typed
runtime commands but never receives RmlUi internals, document pointers, renderer handles, or mutable
`SessionState`.

Layout event admission is still subject to mounted Layout owner, input policy, runtime lifecycle, and
gameplay pause rules.

### ShellLayoutEvent

Used by title, pause, settings, save/load, and confirmation shell Layouts.

It receives shell/session-control capabilities such as start, resume, save, load, settings, and
dismissal. It does not receive unrestricted gameplay mutation APIs merely because shell UI is written
in RmlUi/Lua.

Shell state is not gameplay checkpoint data.

### Tooling

Preview, debugger, recorder, and tests use explicit tooling capabilities or runtime inputs. Tooling
may expose debug-only variable/property mutation and teleport operations, but those APIs remain typed,
diagnosed, and excluded from packaged author-facing Lua unless explicitly admitted.

## Lua ownership and adaptation

Lua remains NovelTea's sole authored runtime scripting language.

`script::ScriptRuntime` owns:

- the sandboxed Lua VM;
- binding registration;
- Lua/C++ value conversion;
- source loading and certification support;
- invocation/coroutine backend objects;
- traceback and script error translation.

It does not own:

- `SessionState`;
- Flow;
- checkpoint service;
- Room navigation;
- Character or Interactable state;
- desired presentation;
- semantic audio intent;
- Layout mounts;
- renderer, RmlUi, miniaudio, assets, platform, or save-slot implementation.

### ScriptInvocationPort

The runtime depends on an abstract backend-neutral script invocation seam, provisionally:

```cpp
class ScriptInvocationPort {
public:
    virtual ~ScriptInvocationPort() = default;

    [[nodiscard]] virtual ScriptInvocationOutcome
    invoke(const ScriptInvocationRequest& request,
           const RuntimeCapabilitySet& capabilities) = 0;

    [[nodiscard]] virtual ScriptInvocationOutcome
    resume(const ScriptInvocationHandle& invocation,
           const RuntimeCapabilitySet& capabilities) = 0;

    virtual void cancel(const ScriptInvocationHandle& invocation,
                        ScriptCancellationReason reason) = 0;
};
```

The exact error/result wrappers may follow current `ScriptError` contracts. The dependency direction
is fixed: the runtime defines the semantic invocation contract; the Lua subsystem implements it.

This prevents `noveltea_runtime` from depending on sol2 or Lua headers while allowing compiled
programs to invoke scripts.

### RuntimeScriptApi

`RuntimeScriptApi` remains the sole authored gameplay gateway bound into Lua. It adapts author-facing
Lua modules to one admitted `RuntimeCapabilitySet`.

It must:

- use strong IDs and typed values;
- validate options before mutation or command enqueue;
- return explicit success/failure or typed yield outcomes;
- avoid raw paths where a compiled resource ID exists;
- avoid arbitrary JSON tables as domain payloads;
- avoid capturing `Engine`, renderer, audio backend, RmlUi, platform, or slot-store pointers;
- reject calls not admitted by the invocation's capability profile;
- detach or invalidate bindings before their owning running game is destroyed.

The author-facing Lua module organization may remain convenient and broad. It need not mirror C++
class names one-to-one.

### Binding lifetime

Lua closures may capture a stable non-owning reference to the current script API/gateway generation.
Every call validates that the generation is still active.

On load, reset, project reload, or running-game destruction:

- suspended invocations are cancelled through typed handles;
- stale capability generations are invalidated;
- pending script-owned completions are cancelled;
- no closure may dereference destroyed session state.

## Yielding and completion

Yielding remains explicit and engine-owned.

### Allowed yielding

Only invocation contexts declared yield-capable may suspend. Yielding commands return typed
correlation state owned by runtime contracts, such as:

- input waits;
- duration waits;
- presentation operation completion;
- audio operation completion;
- child Flow completion;
- an explicitly serializable engine wait introduced by a future contract.

### Forbidden yielding

The following cannot yield:

- conditions;
- text expressions;
- Room composition;
- compiler/load certification;
- immediate definition/property queries;
- callbacks whose contract is synchronous.

### Coroutine persistence

Lua coroutine/VM state is never serialized. A suspended invocation is checkpoint-safe only when an
engine-defined wait contract explicitly represents all required logical state. Otherwise it remains a
checkpoint barrier and the older retained checkpoint remains current.

### Completion correlation

Every completion validates:

- invocation or Flow owner;
- exact typed operation/wait handle;
- active session generation;
- nonterminal lifecycle;
- expected completion kind.

Stale or wrong-owner completion fails without state mutation.

## Presentation and audio runtime port

Runtime execution requests semantic presentation and audio operations through one synchronous
backend-neutral port implemented by the presentation service.

Provisionally:

```cpp
class PresentationRuntimePort {
public:
    virtual ~PresentationRuntimePort() = default;

    [[nodiscard]] virtual core::Result<PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation& operation) = 0;

    [[nodiscard]] virtual core::Result<PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation& operation) = 0;

    [[nodiscard]] virtual const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept = 0;

    virtual void terminate(core::PresentationCancellationReason reason) = 0;
};
```

The presentation specification may refine operation variants and acceptance values. These rules are
fixed:

- acceptance is synchronous with the creating runtime transaction;
- backend realization may continue asynchronously;
- accepted causal barriers are visible to checkpoint settlement in the same transaction;
- completion returns through a later typed runtime input;
- runtime UI is not the broker or owner of operation lifecycle;
- runtime does not call renderer, RmlUi, audio backend, or tween services directly;
- presentation operation IDs remain session-local typed identities allocated by their named owner;
- exact operation allocation ownership must remain singular and documented.

`RuntimeUI` consumes publications and emits runtime inputs. It does not own the presentation port and
does not manually begin or settle runtime transactions.

## Runtime input contract

External consumers interact with the session through closed typed runtime inputs.

Input families include:

- lifecycle: start, stop, reset, load;
- time advancement;
- gameplay input: continue, choice, navigation, selection, interaction;
- tooling/debug input;
- save commands;
- presentation/audio completion or cancellation;
- external host request success/failure/cancellation;
- playback/test controls where retained as runtime behavior.

Inputs never contain:

- arbitrary JSON state;
- renderer/RmlUi/audio/platform handles;
- generic callback functions;
- raw pointers into compiled collections;
- untyped entity tags.

### Admission

Input admission considers:

- session lifecycle;
- current runtime mode and blocker;
- effective gameplay pause;
- mounted Layout/gameplay input policy supplied through the host's typed admission seam;
- active playback/test mode;
- exact owner/handle correlation for completion inputs.

Input admission is deterministic and produces `Handled`, `Unhandled`, or `Failed` plus diagnostics.
An unhandled input does not mutate state.

## Runtime events and external outputs

One-time outputs remain separate from idempotent publication.

The final closed `RuntimeEvent` vocabulary may include:

- accepted presentation/audio operation observations needed by host tooling;
- external host requests;
- user communication such as notifications;
- save/load outcomes;
- playback/test observations not represented in the publication snapshot;
- diagnostics.

The presentation service receives semantic operation requests through its direct typed port, not by
depending on a UI consumer to discover an output variant.

External protocol adapters may encode runtime events as JSON only at their boundary.

Events have deterministic order within one transaction. Diagnostics preserve stable source context
and are not reordered according to frontend timing.

## Coherent runtime publication

The runtime publishes one immutable envelope derived from one settled session state.

The target shape is:

```cpp
struct RuntimePublication {
    RuntimePublicationRevision revision;
    core::TypedRuntimeUIViewState gameplay_ui;
    core::RuntimePresentationSnapshot presentation;
    RuntimeObservationSnapshot observations;
};
```

The implementation plan may rename `TypedRuntimeUIViewState` after migration, but its feature-specific
role remains.

### Publication rules

- Revision zero is invalid.
- The initial valid publication starts at revision one.
- A session-local revision increases monotonically and never wraps.
- At most one publication is produced by one outer dispatch transaction.
- All subviews are projected from the same final `SessionState` and immutable `CompiledProject`.
- No subview is projected while deferred commands remain drainable.
- No backend realization state is read to create the publication.
- A transaction that produces no observable projection change may omit a new publication.
- Start, reset, successful load, and project session construction produce a complete publication.
- Faulted execution publishes the stable fault/runtime observation state when it changed.

### Subview revisions

Presentation and other specialized projections may retain their own domain revision for efficient
backend reconciliation. If retained, every specialized revision must identify or be associated with
the source `RuntimePublicationRevision` that produced it.

No consumer may combine subviews from different runtime publication revisions and treat them as one
state.

### Publication delivery

The runtime session returns the immutable publication in its dispatch result or exposes an equivalent
borrowed immutable current publication after dispatch. The host may route subviews to different
consumers, but publication assembly remains runtime-owned.

The host applies one dispatch result in a deterministic order:

1. receive the settled publication and events;
2. route the presentation snapshot to the presentation service/backend reconciliation seam;
3. bind gameplay UI and observations from the same revision;
4. deliver external events in their recorded order;
5. schedule later completion inputs without recursively dispatching inside the same call stack.

The revised presentation specification may define an atomic batch seam combining snapshot
reconciliation with finite-operation requests. It must preserve the single runtime publication
revision defined here.

## Checkpoint integration

`RuntimeCheckpointService` remains runtime-owned.

It owns:

- structural and time generations;
- checkpoint readiness evaluation;
- immutable latest retained checkpoint bytes, matching metadata, and optional thumbnail;
- manual save requests;
- deferred autosave requests;
- typed save outcomes;
- slot-store invocation.

It consumes:

- the settled `SessionState`;
- transaction mutation impact;
- runtime queue/invocation/request status;
- current presentation checkpoint status;
- the displayed presentation revision used to bind thumbnail capture to the retained checkpoint;
- save codec/validation results.

### Checkpoint settlement order

Checkpoint readiness is evaluated only after:

- runtime execution has stopped at a valid boundary;
- deferred internal commands have drained or are proven intentionally pending;
- immediate script invocation has returned or suspended through a typed handle;
- presentation/audio operations created by the transaction have been accepted and classified;
- external host requests have been recorded;
- all mutation impact is finalized.

A checkpoint candidate is never captured from the middle of an outer transaction.

### Retained checkpoint behavior

Manual saves and deferred autosaves continue to use the latest valid retained checkpoint according to
the existing policy. The introduction of capability ports or command queues must not restore direct
live-state save writes.

The checkpoint service publishes typed observations containing readiness, causal and reconstructible
presentation status, retained metadata, replay distance, and thumbnail availability. These are
read-only menu/tooling facts and do not expose an eligibility override. Save-slot persistence keeps
the exact encoded save, metadata, and optional PNG in one atomic checkpoint record; load validates
that stored metadata describes the decoded save before committing replacement state.

### Load behavior

Successful load is an atomic session-state replacement:

1. decode and validate the selected retained save;
2. construct a fresh valid `SessionState` and runtime execution state;
3. cancel old script invocations, presentation/audio operations, internal commands, and external
   requests with typed reasons;
4. replace the session state only after construction succeeds;
5. reset checkpoint generations and retained checkpoint ownership according to the checkpoint spec;
6. publish one complete new runtime publication;
7. reconcile presentation from logical desired state without restoring backend progress.

A failed load leaves the current running session unchanged except for the typed failure outcome.

## Lifecycle

### Construction

`RunningGame::create` succeeds only after:

- package/gameplay validation is complete;
- immutable `CompiledProject` is published;
- Lua certification has succeeded;
- required ports are present;
- `SessionState` construction and indexes are valid;
- initial capability bindings can be created safely.

Failed construction publishes no partial running game.

### Start

Starting the session runs the non-yielding startup hook, then starts the typed project entrypoint. A
start transaction settles and publishes a complete initial state or faults with diagnostics.

### Stop

Stop cancels active runtime execution and transient operations according to typed cancellation rules.
It does not destroy immutable package state until the running game is destroyed.

### Reset

Reset constructs fresh initial session state for the same loaded package, cancels current transient
work, resets checkpoint/session-local allocators as specified, rebinds script capability generation,
and publishes a complete initial state.

### Project reload

Project reload destroys the old `RunningGame` after all borrowed frontend bindings and backend
operations are terminated. A new package and running game are constructed independently. IDs and
handles from the old game are invalid in the new game even when textual project IDs match.

## Threading and concurrency

The initial runtime is single-thread confined.

- `RuntimeSession::dispatch()` runs on the owning runtime/host thread.
- Lua invocation and `SessionState` mutation run on that same thread.
- backend or platform threads do not mutate session state directly.
- asynchronous external services post typed completion inputs to the owning thread.
- capability objects are not thread-safe service handles.
- publication values may be copied or moved to adapters only according to explicit lifetime rules.

Future worker-thread decoding or asset preparation does not change runtime mutation ownership.

## Error and diagnostic contract

Every runtime boundary uses explicit typed failure.

- Invalid capability arguments fail before mutation or enqueue.
- Invalid commands are not partially applied.
- Failed deferred commands produce source-aware diagnostics and a defined Flow/script outcome.
- External request failures return through typed terminal inputs.
- Script failures retain chunk/source identity and traceback where available.
- Stale operation, request, frame, blocker, invocation, or capability-generation IDs fail without
  mutation.
- Runtime execution faults are fail-stop until reset/load/project reload according to existing
  policy.
- User-authored invalid data never reaches assertion, termination, unchecked lookup, or throwing
  access paths.

Diagnostics retain stable codes suitable for tests and external protocol adaptation.

## Dependency direction

The logical dependency direction is:

```text
domain/core contracts
        ↑
runtime session/execution/capability contracts
        ↑
script Lua adapter        presentation service        content/storage adapters
        ↑                         ↑                              ↑
host/engine composition and platform frontends
```

More precisely:

- domain code does not include runtime, Lua, SDL, bgfx, RmlUi, miniaudio, Electron, or platform
  headers;
- runtime code may depend on domain contracts and abstract script/presentation/storage ports;
- Lua adapter code depends on runtime capability and invocation contracts;
- presentation code depends on shared runtime/presentation contracts, not Lua or RuntimeUI;
- host code wires concrete implementations;
- external JSON protocol code remains an adapter and is not imported into runtime state.

This direction must be enforceable by source and, in the later host/module plan, by a bounded CMake
target structure.

## Current implementation disposition

The current implementation is migrated according to this table.

| Current concern | Disposition |
| --- | --- |
| `SessionState` as sole mutable aggregate | Retain; reorganize internally into state families |
| `FlowExecutor` and one Flow stack | Retain; narrow documentation to Flow ownership |
| `TypedExecutionKernel` feature behavior | Retain behavior; move/split into `RuntimeExecutor` and session-owned services |
| `TypedRuntimeSession::apply` | Retain as basis for `RuntimeSession::dispatch`; simplify responsibilities |
| public `begin_dispatch_transaction` / `settle_dispatch_transaction` | Replace with private outer transaction ownership |
| `ScriptHostServices` immediate queries/mutations | Migrate to `RuntimeCommandGateway` capability groups |
| `ScriptHostServices` internal request queue | Split into deferred runtime commands and true external requests |
| internal navigation/Flow requests encoded as `TypedHostRequest` | Delete after internal command cutover |
| `RuntimeScriptApiTarget` broad interface | Replace with capability groups/restricted sets |
| `RuntimeScriptApi` Lua surface | Retain and adapt; preserve approved capability parity |
| `RuntimeUI::dispatch_typed_runtime_input` | Move orchestration to host/runtime facade; RuntimeUI becomes input/view adapter |
| runtime presentation/audio output brokerage through RuntimeUI | Replace with direct synchronous presentation runtime port |
| `TypedRuntimeUIViewState` | Retain as gameplay UI subview; publish coherently with presentation |
| `RuntimeViewPublication` | Replace with complete `RuntimePublication` envelope |
| `RuntimeCheckpointService` retained-checkpoint behavior | Retain; move to runtime namespace and consume final transaction state |
| preview/debug/playback protocol adapters | Retain as external consumers; migrate to final publication/events |

No old path is deleted until focused tests prove equivalent retained behavior through the new owner.

## Required conformance tests

Any implementation claiming this specification must cover at least the following.

### Ownership and construction

- one running game owns exactly one runtime session;
- failed construction publishes no partial session;
- session dependencies outlive borrowed ports;
- project reload invalidates old handles and capability generations.

### Transactions

- one external input creates one outer transaction;
- recursive public dispatch is rejected;
- nested script/Flow work does not settle publication early;
- at most one publication is produced per transaction;
- invalid input leaves state and revisions unchanged;
- command/instruction budgets prevent infinite self-enqueue loops.

### Mutation tracking

- immediate and deferred mutations report exactly one impact;
- structural/time generations advance correctly;
- no manual frontend mutation recording is required;
- multiple mutations coalesce into one publication;
- no-op mutations do not create false structural generations.

### Deferred commands

- FIFO order is deterministic;
- commands never appear as host requests;
- frame-destructive commands wait for a safe boundary;
- stale source owners fail without mutation;
- command failure produces stable diagnostics.

### External requests

- only admitted external operations create request IDs;
- wrong-kind, stale, duplicate, and unknown acknowledgements fail;
- unresolved causal requests block checkpoint replacement;
- reset/load/project reload cancels pending requests.

### Capabilities and Lua

- full gameplay scripts retain approved current capabilities;
- synchronous expressions cannot mutate or yield;
- Room composition cannot mutate, yield, draw random values, or retain its draft;
- gameplay and shell Layout profiles cannot escalate capabilities;
- Lua closures contain no backend pointers;
- stale capability generations fail safely;
- all bindings use typed IDs and results.

### Presentation/checkpoint integration

- operations created during a transaction are accepted before checkpoint settlement;
- a newly accepted causal barrier prevents checkpoint replacement in the same transaction;
- disposable/reconstructible classifications do not create false barriers;
- RuntimeUI is not required to broker acceptance;
- completion correlation uses exact typed owners and handles.

### Publication

- UI and presentation subviews come from the same settled state;
- revision ordering is monotonic;
- backend progress cannot affect publication values;
- start/reset/load publish complete values;
- consumers cannot observe mixed revisions.

### Platform and policy

- Linux and Web remain buildable throughout migration;
- Android/platform checks run where host interfaces change;
- no-exceptions/no-RTTI policy checks pass;
- JSON-boundary checks reject runtime-domain JSON leakage;
- sanitizer and malformed-input coverage remain green.

## Documentation obligations

Implementation of this specification must update:

- `docs/architecture/ENGINE_ARCHITECTURE.md`;
- `docs/architecture/CORE_DOMAIN_MODEL.md` where state/execution ownership wording changes;
- `docs/runtime/LUA_RUNTIME.md`;
- `docs/runtime/STATE_AND_PLAYBACK.md`;
- preview/debugger communication documentation when publication/event shapes change;
- the runtime/presentation ownership audit;
- affected component documentation for new capability APIs.

Stale comments referring to completed migration phases, a transitional typed path, runtime ownership
under `noveltea::script`, or RuntimeUI-owned operation brokerage must be removed when their code is
replaced.

## Decisions deferred to later specifications

This document deliberately leaves these payload decisions to their owning specifications:

- final Character world-state representation;
- Room composition draft and resolved presentation fields;
- current-Room, Room, session, Scene, and shell presentation owner variants;
- scoped actor/prop/environment/Layout identity and conflict rules;
- Scene `TransitionGroup` compiled payload;
- Room navigation target presentation and transition policy;
- presentation snapshot merge order;
- desired versus transient audio record variants;
- save codec fields for reconstructible presentation.

Those specifications may add typed capability methods and deferred command variants. They may not
change the transaction, ownership, capability-profile, or publication principles defined here
without revising this document explicitly.

## Completion criteria

The runtime execution and capability architecture is complete when:

- general gameplay runtime ownership no longer appears under the Lua scripting subsystem;
- `RuntimeSession` is the sole public dispatch and mutable-session facade;
- `SessionState` remains one authority but is organized into cohesive state families;
- Flow ownership is precise and no longer described as the route for every mutation;
- internal runtime commands no longer leave the runtime as host requests;
- true external requests have typed lifecycle and checkpoint rules;
- Lua and Layout events bind only through admitted semantic capability sets;
- Room composition can receive a provably restricted read-only/draft context;
- runtime execution invokes Lua through a backend-neutral port;
- presentation/audio operations are accepted synchronously before transaction checkpoint settlement;
- one settled transaction produces at most one coherent UI/presentation/observation publication;
- checkpoint generations, retained saves, load/reset cleanup, and operation barriers remain correct;
- RuntimeUI is a consumer/input adapter rather than runtime transaction or presentation-broker owner;
- Linux and Web builds, policy checks, focused tests, and full runtime tests pass;
- obsolete broad targets, mixed host requests, duplicate publication paths, and stale documentation
  have been removed.
