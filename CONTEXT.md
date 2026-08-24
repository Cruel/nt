# NovelTea

NovelTea is a visual-novel engine and editor. This glossary fixes cross-cutting project language; detailed architecture and behavior remain in the current documentation hierarchy rooted at `docs/OVERVIEW.md`.

## Project artifacts

**Project**:
A NovelTea game in its editable source form. Use **editor project** only when it must be distinguished from a runtime artifact.
_Avoid_: Authoring project in product-facing language
_See_: `docs/engine/PROJECT.md`

**Project Workspace**:
The directory-backed on-disk representation of a Project: its editable filesystem source tree rather than a runtime artifact.
_See_: `docs/editor/project/PROJECT_WORKSPACE_FORMAT.md`

**Compiled Project**:
The generated gameplay representation produced from a Project for consumption by the native runtime. It is neither editable project source nor the distributable package around that runtime data.
_See_: `docs/architecture/COMPILED_PROJECT_WIRE.md`

**Runtime Package**:
The distributable `.ntpkg` artifact containing a Compiled Project and the runtime resources needed to run it.
_See_: `docs/runtime/PACKAGE_EXPORT.md`

**Prepared Runtime Artifact**:
An immutable, detached export result containing a Compiled Project plus the package metadata, diagnostics, and source identity needed to produce or verify a Runtime Package. It is not itself a Runtime Package.
_See_: `docs/editor/export/EXPORT_AND_PACKAGING.md`

## Gameplay

**Archetype**:
A Project-defined immutable reusable gameplay blueprint that may seed a declared or runtime-created Room, Character, or Interactable. It has no semantic identity or mutable state of its own, and runtime code may instead create an instance entirely from explicit compiled vocabulary or another instance's effective configuration.

**Gameplay Instance**:
A Room, Character, or Interactable with its own stable semantic identity and authoritative state, whether declared in the Project or created during a Runtime Session. Runtime-created Gameplay Instances participate in checkpoints until explicitly destroyed.

**Room**:
A gameplay location that owns its local semantic structure, lifecycle behavior, navigation, and presentation defaults. Character and Interactable presence derives from Location rather than Room-owned membership lists.
_See_: `docs/engine/ROOM.md`

**Current Room**:
The optional Room serving as the Runtime Session's active world and exploration context. It is independent of Flow control and may remain current while a Scene or Dialogue is active.

**Active Room Context**:
Engine-owned context for the current continuous stay in a Room, including its source Room, selected entry Exit when applicable, Entry Cause, and Entry Sequence. It is runtime lifecycle state rather than an authored entity or custom Property.

**Room Transition Context**:
Immutable context describing one attempted Current Room transition, including its origin Room, target Room, selected Exit when applicable, Entry Cause, and source Active Room Context. Room lifecycle guards and hooks receive the same context so they can distinguish direction and transition intent without specialized directional hooks.

**Entry Sequence**:
The session-wide ordinal identifying one continuous stay in a Room. It advances on each committed Room entry, including self-loop Exit traversal, but not on recomposition, idempotent assignment, or save restoration. Per-Room visit counts remain authored gameplay state rather than intrinsic Room state.

**Entry Cause**:
The typed intent under which a Current Room transition occurs, such as Exploration navigation or Flow-directed relocation. Room guards, composition, and lifecycle effects may inspect it so player arrival can differ from Scene-directed movement without bypassing Room lifecycle. Restoring a saved Active Room Context is not a new entry.

**Navigation Attempt**:
A player-facing request to traverse an Exit or otherwise navigate through Exploration. Room lifecycle guards and Exit eligibility may reject it and invoke the matching rejection hook.

**Directed Room Change**:
An authoritative Scene- or Lua-directed change of Current Room. Lifecycle guards are evaluated only for diagnostics and cannot veto it; the ordinary successful-transition lifecycle still runs.

**Room Lifecycle**:
The serialized, non-reentrant effect sequence surrounding a Current Room transition. Pure `canLeave` and `canEnter` guards govern player/Exploration navigation; `onLeaveReject` and `onEnterReject` hooks react when they deny it, while an unmatched rejection is a no-op. Scene- or Lua-directed Room changes cannot be vetoed by these guards, though a false guard produces an internal diagnostic. Before/after hooks perform effects along a transition that proceeds. Transitions to or from no Current Room run only the applicable half, while save restoration does not run lifecycle.

**Character**:
A semantic person identity whose Traits, Properties, dialogue metadata, and presentation definitions are shared across every representation of that person. A Character may be declared in the Project or created during a Runtime Session.
_See_: `docs/engine/CHARACTER.md`

**Character Presentation**:
One visual occurrence of a Character with independent profile, pose, expression, gesture, speaking, transform, and visibility state. Multiple Character Presentations may represent the same Character simultaneously.

**Character Presentation Profile**:
A named visual realization of a Character, such as full-body stage art or dialogue portrait art, with its own layered poses, expressions, and animations.

**Interactable**:
A non-Character gameplay object with one semantic identity and state that may be present in a Room, Inventory, or other presentation context and participate in interactions. An Interactable may be declared in the Project or created during a Runtime Session.
_Avoid_: Object, Item
_See_: `docs/engine/INTERACTABLE.md`

**Item Definition**:
An immutable Project-defined description of one fungible gameplay kind whose interchangeable units may exist in Item Stacks. It supplies shared configuration, presentation defaults, Traits, and initial Property assignments without itself becoming a Gameplay Instance or mutable runtime state.

**Item Stack**:
An independently identified semantic quantity of interchangeable units from one Item Definition, with one authoritative Room, Inventory, or Unplaced Location, a strictly positive integer quantity, and shared Stack-level Traits and Property state. An Item Stack may be declared in the Project or created during a Runtime Session; it is an interaction subject but neither a Gameplay Instance nor a per-unit identity, and its identity ends when the Stack is fully consumed or explicitly merged away.

**Location**:
The single authoritative semantic destination of a Character, Interactable, or Item Stack. Room and Inventory presence derive from Location; visual presentation occurrences do not change it.

**Unplaced**:
A Location state in which a Character, Interactable, or Item Stack still exists but belongs to no Room or Inventory.
_Avoid_: Nowhere

**Inventory**:
An owner-local semantic container with stable qualified identity whose members are uniquely identified Interactables or Item Stacks located in it. Membership does not imply current accessibility or presentation, and an Inventory is not a separate item identity or interaction system.

**Containment**:
The ancestry formed when an Interactable or Item Stack is located in an owner-local Inventory. Its direct Location remains that Inventory while its ultimate world context follows the Inventory owner chain.

**Hotspot**:
A hit-testable region that maps pointer input to a semantic interaction subject or Exit navigation target. A Hotspot is not itself a gameplay object or behavior.

**Feature**:
A stable owner-local semantic part of a Room or Interactable that can be targeted independently for interaction without being a top-level Project entity. A Feature has no independent Location and follows the semantic context of its owner.

**Anchor**:
A stable occupant-free Room-local presentation target used to position or arrange visual occurrences. An Anchor is not a Location and does not own its occupants.

**Room Visual**:
A lightweight Room-owned presentation occurrence with a stable Room-local presentation key but no independent gameplay identity. Conventional roles such as background remain Room Visual roles rather than separate semantic entities. A Room Visual may realize a Feature, but it has no Location, Properties, Traits, Inventory, or interaction behavior of its own.

**Room Presentation**:
The derived description of how a Room is presented in a particular presentation context, assembled from Room declarations, semantic state, and desired presentation intent. Current-Room and Scene-staged presentations are distinct contexts; a Scene may stage a Room Presentation without changing the Current Room or running Room lifecycle. A Room Presentation is not an independently authoritative or saved copy of the Room.

**Room Composition**:
The deterministic derivation of Room Presentation from Room declarations, semantic state, and scoped presentation intent. An optional composition hook may modify only a temporary presentation draft and cannot perform gameplay side effects.

**Exit**:
A stable Room-owned directed navigation edge naming a target Room. Exits define authoritative Room topology; traversing one uses canonical Room lifecycle and creates a new Active Room Context even when it targets the Current Room.

**Exploration**:
Player interaction with the Current Room and its available semantic subjects. Current Room supplies the world context, while Flow and UI input policy determine whether Exploration is admitted.

**Verb**:
A named interaction intent whose localizable sentence template declares stable named subject slots that are progressively bound in one locale-independent selection order. Localized placeholder order affects presentation, not command construction.
_See_: `docs/engine/VERB.md`

**Verb Offer**:
A subject-first discovery affordance that associates a Verb's starting slot with a Subject Selector and determines whether that Verb appears for a selected subject. An offered Verb is plausible rather than guaranteed to succeed, and its absence does not prohibit an otherwise valid command submitted through another authorized path.

**Offer Condition**:
A pure runtime condition that determines whether a matching Verb Offer is currently presented. It controls discovery in the interaction UI rather than which behavior handles a completed command.

**Primary Activate**:
A semantic request to use a subject's unique resolved primary Verb Offer, falling back to opening its Verb menu when no unambiguous primary exists. Physical mouse, touch, keyboard, and controller mappings belong to input policy.

**Open Verb Menu**:
A semantic request to open the Command Builder for a subject and present its resolved Verb Offers without automatically selecting the primary offer.

**Property**:
A declared typed custom value in global gameplay state or attached to a supported gameplay identity, read and written through the explicit Property API. Every runtime Property override is saved; transient authored state belongs in Lua rather than a second Property persistence class.

**Global Property**:
A Property declared in the Project-wide gameplay-state scope rather than on a gameplay identity. It is accessed through the Game facade without making Project, Running Game, or Runtime Session into a property-bearing semantic entity.

**Variable**:
The editor-facing term and management surface for a Global Property. The compiled/runtime model has only Properties and does not create an independent Variable state system.

**Trait**:
A named, discoverable gameplay capability schema that requires or configures ordinary declared Properties on entities carrying that capability. Traits are composition, not inheritance, and do not create a separate value namespace.

**Typed Selector**:
A selector over one addressable semantic kind and a stable qualified-identity pattern, used by systems such as hook registration. Exact identities and trailing namespace wildcards support deterministic specificity without creating entity inheritance, ownership, or a cross-kind untyped namespace.

**Subject Selector**:
A reusable typed selector over gameplay subjects using subject family, exact or qualified-wildcard identity, Traits, and Item Definition where applicable. Verb slots, Verb Offers, Interaction Rules, and future gameplay features may share this vocabulary without making it Interaction-owned.

**Command Draft**:
Transient Command Builder state containing a selected Verb and zero or more bound subject slots while a complete command is constructed. It is never saved; subject changes are reported for Layout-controlled reconciliation, while runtime may terminate the Builder when interaction control itself ends.

**Command Builder**:
The replaceable System Layout Role that owns subject-first Verb presentation and optional Command Draft state while holding exclusive gameplay-subject selection capture. Runtime owns offer resolution, final command validation, capture lifecycle, and forced termination when interaction control ends.

**Interaction**:
A single-winner rule that structurally matches a complete Verb command and whose Interaction Guard determines whether its behavior may execute.
_Avoid_: Action
_See_: `docs/engine/INTERACTION.md`

**Interaction Guard**:
A pure runtime condition that determines whether a structurally matching Interaction Rule is eligible to handle a complete command. It does not implicitly control whether the Verb is offered during subject-first construction.

**Interaction Behavior**:
The compact handled result of one selected Interaction Rule: an optional atomic typed effect batch followed by at most one terminal response or Flow handoff. Guard-based decline drives fallback before execution; a started behavior either handles the command or fails.

**Interaction Response**:
A localized terminal message emitted by an Interaction Behavior with an explicit immediate or acknowledgement-awaited completion policy. The active interaction System Layout owns its presentation, while runtime retains its semantic content, causal identity, and Flow completion contract.

**Scene**:
A Project-defined immutable visual-novel orchestration program for authored presentation and gameplay steps. It has no semantic gameplay identity or mutable gameplay state of its own.
_Avoid_: Cutscene
_See_: `docs/engine/SCENE.md`

**Scene Invocation**:
One runtime occurrence of a Scene with its own execution position, waits, presentation scope, and causal ancestry. Multiple invocations of the same Scene remain distinct.

**Scene Stage**:
The single world-presentation context local to one Scene Invocation, based explicitly on inherited presentation, a staged Room Presentation, or a blank stage. Its presentation ends with that invocation unless an Event explicitly targets a longer-lived owner; staging a Room does not change Current Room or run Room Lifecycle.

**Scene Event**:
A stable authored item in a Scene's ordered semantic timeline. A control-changing Event forms a runtime suspension or continuation boundary without requiring authors to arrange Scene content as a graph of labeled groups.

**Scene Outcome**:
An optional declared named result returned by a completed Scene Invocation for its awaiting caller to handle. It is call-control data rather than durable gameplay state.

**Complete Game**:
The explicit terminal Flow action that ends the current Runtime Session as a completed playthrough and returns control to the Project's title/start screen. Credits or other ending presentation occur before it through ordinary Flow.

**Scene Text**:
ActiveText-compatible text authored directly in a Scene for narration, captions, inner monologue, and other presentation that does not require Dialogue's conversation model. The dedicated Scene Text System Layout Role owns its presentation and acknowledgement surface.

**Scene Choice**:
A generic player decision authored by a Scene and presented through the dedicated Scene Choice System Layout Role. Dialogue choices remain part of the Dialogue Layout contract rather than using this role.

**Dialogue**:
A specialized conversation graph with its own authored flow, conversation presentation state, and mutable execution position.
_See_: `docs/engine/DIALOGUE.md`

**Dialogue Cue**:
A typed conversation-timed presentation action embedded between Dialogue text segments, such as a Character presentation change, sound effect, or common camera emphasis. ActiveText-style semantic markup is authoring shorthand for these cues rather than a separate runtime behavior system.

**Dialogue Handoff**:
An engine-owned pause that returns control from an active Dialogue to the next sequential Event of its direct awaiting Scene caller without ending the Dialogue Invocation. A later Scene Event may resume that exact Dialogue from its retained conversation position.

**Voice Cue**:
A Dialogue Cue that associates voice audio with a stable Dialogue line or segment position. Checkpoints retain the Dialogue cursor and cue-execution position rather than decoder or sample state.

**Map**:
An optional, typically image-backed authored presentation and selection projection over Rooms and authoritative Room exits. It does not define a second navigation topology; generated graph layout is only an authoring convenience.
_See_: `docs/engine/MAP.md`

**Map Location**:
The single Map-local presentation entry and semantic UI target for one Room on one Map. It may use multiple disjoint normalized image-space regions with arbitrary polygon boundaries without duplicating the Room or creating another gameplay place; simpler editor shapes are authoring conveniences.

**Map Connection**:
A Map-local presentation record and semantic UI target over one directed Exit or an explicitly grouped reciprocal Exit pair. Its endpoints derive from the referenced Exits and Map Locations, while optional path or hit-test geometry remains purely presentational.

## Resources and UI

**Layout**:
An authored runtime UI document or fragment.
_Avoid_: UI Layout
_See_: `docs/engine/LAYOUT.md`

**Layout Mount**:
One engine-owned runtime occurrence of a reusable Layout, with its own identity, owner scope, presentation placement, and lifecycle policy. A Layout Mount ends automatically with its owner rather than being owned by Lua state or RmlUi elements.

**Layout Mount Context**:
The per-occurrence Layout-facing context containing one Mount's identity, contract inputs, Layout Signal emitter, and local UI state. Layout Mount Contexts are distinct even though their scripts share the Project's Lua VM, global `Game` API, and imported modules; local state persists only through an explicit Layout persistence contract.

**Layout State Slot**:
An engine-owned persistable state value addressed independently from a Layout Mount by a stable scope, semantic owner, and key. A Slot may outlive an unmounted Layout and hydrate a later Mount, while transient Lua and DOM state remain occurrence-local.

**Layout Contract**:
The declared typed boundary of a Layout's mount inputs, optional Layout Signals, and optional local-state persistence participation. System Layout Roles provide engine-defined contracts, while custom Layouts may define project-specific contracts and reuse admitted standard data facets.

**Layout Signal**:
An optional named, typed semantic message emitted by a Layout Mount to its owner. Layout Signals cross the reusable Layout boundary; internal pointer, focus, and other DOM events remain private UI behavior.

**System Layout Role**:
An engine-defined runtime UI responsibility, such as the game HUD or pause menu, whose lifecycle, authority, and fallback behavior remain fixed when a Project supplies a replacement Layout.

**Presentation Plane**:
An engine-defined composition stratum that governs how presentation occurrences are ordered and coordinated across runtime UI and other presentation backends. Layout authors choose among admitted planes rather than defining new global planes.

**Persistable Value**:
A backend-neutral data tree containing null, boolean, integer, finite number, string, arrays, and string-keyed objects. It mirrors JSON's value domain without making a JSON document or Lua table authoritative runtime state.

**State Shape**:
A Project-authored recursive contract for a Persistable Value, composed from scalars, Objects, Lists, Maps, Tuples, and One Of variants. An explicit Any Persistable Value node permits unstructured data while intentionally reducing field-level validation and tooling.

**Desired Presentation State**:
Typed reconstructible intent describing what should currently exist in a presentation context. It remains authoritative independently of finite operations and disposable backend realization.

**Presentation Operation**:
Ordered finite or one-shot presentation or audio work with an explicit semantic lifecycle, skip behavior, replacement target, and checkpoint policy. Operation progress is not Desired Presentation State.

**Camera View**:
The engine-owned logical two-dimensional framing of one world presentation context, expressed by logical center or offset, zoom, and rotation over an identity default. It is normally a static authored View over presentation content that may be wider than the viewport, not a camera that implicitly follows a Character.

**Camera Focus**:
A temporary Presentation Operation that frames a captured presentation occurrence or Room Anchor, optionally holds, and returns to the unchanged desired Camera View. It does not continuously follow its target.

**Camera Bounds**:
The optional authored limits within World Presentation Space against which Camera Views and pan endpoints are validated. Temporary emphasis may use an explicit overscan or edge-fill policy rather than silently changing the desired View.

**World Presentation Space**:
The logical project-reference coordinate domain containing a Room Presentation's backgrounds, Room Visuals, Anchors, and presentation occurrences. Camera View selects its visible rectangle; the space is presentation geometry rather than semantic Location.

**Material Parameter**:
A typed shader-uniform value exposed through a Material for one presentation occurrence. Lua may change it through validated Desired Presentation State, or it may read from an explicit Property or standard engine binding; it is not a mutable global Material resource or backend uniform handle.

**Material Clock Policy**:
The declared gameplay or unscaled-presentation clock that drives an occurrence's continuous Material time input. Elapsed phase is disposable realization; semantically meaningful phase must be an explicit Material Parameter.

**Postprocess Effect**:
An owner-scoped Desired Presentation State instance that applies a postprocess Material and Material Parameters at a closed world or full-game-viewport scope. Ordered instances form a bounded linear stack rather than an arbitrary render graph.

**Audio Purpose**:
The semantic role of an audio intent: Music, Ambience, Voice, Sound Effect, or UI Sound. Purpose informs mixing and default policy but does not by itself decide whether playback is desired, looping, awaited, causal, or disposable.

**Audio Owner**:
The typed runtime owner whose lifetime governs an audio instance, such as the Runtime Session, Active Room Context, Flow invocation, Layout Mount, or Shell. Ownership is independent of Audio Purpose and pause behavior.

**Audio Pause Policy**:
The declared rule for whether an audio instance follows gameplay pause, follows its owner's policy, or continues on unscaled presentation time. It is independent of Audio Purpose and Audio Owner.

**Audio Pan Source**:
An optional presentation occurrence or Room Anchor whose position relative to Camera View derives an audio instance's stereo pan. It is a lightweight VN presentation binding rather than a general three-dimensional spatial-audio model.

**Ambience**:
Environmental audio whose intended semantic purpose is to establish the sound of a place or situation.
_Avoid_: Ambient

**Asset**:
An imported project resource such as an image, font, audio file, script, shader source, data file, or opaque binary, addressed through stable project asset identity and metadata.
_See_: `docs/engine/ASSET.md`

## Runtime

**Flow**:
The engine-owned progression of Scene, Dialogue, Interaction, and Room-transition execution, including their calls, returns, and waits. Flow determines which authored sequence currently has control while remaining independent of the Current Room.

**Execution Provenance**:
The runtime-maintained causal ancestry of commands, Interactions, Scenes, Dialogues, Lua invocations, navigation, and significant typed operations. Immediate-parent and root-cause relationships support Flow ownership, cancellation, diagnostics, and debugger explanation without being manually passed or fabricated by authored code.

**Script Suspension**:
A yield-capable Lua invocation paused through an awaitable NovelTea operation on an engine-owned typed wait, then resumed or cancelled by its exact invocation identity. It remains part of Flow but is opaque to checkpoint persistence; synchronous script contexts and unregistered raw coroutine yields cannot create one.

**Hook Registry**:
The general runtime mechanism that associates supported hook kinds with Typed Selectors and handlers. Hook families define their valid semantic kinds and context; exact identity, longest matching namespace prefix, and catch-all registrations resolve deterministically across Rooms and other addressable kinds.

**Gameplay Identity Reference**:
A Lua-facing typed reference to one declared or runtime-created Gameplay Instance, represented by its kind and stable ID rather than copied state or ownership of a C++ gameplay object. Archetypes use a distinct reference type; each operation resolves current instance state through the active invocation's capabilities, so a stored reference cannot retain authority, backend access, or a stale runtime object.

**Running Game**:
The lifetime owner that joins one loaded immutable runtime package with one mutable Runtime Session.
_See_: `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`

**Runtime Session**:
The authoritative mutable gameplay execution context for one Running Game.
_See_: `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`

**Runtime Publication**:
An immutable coherent set of runtime projections derived from one settled logical state revision for consumers such as presentation and runtime UI.
_See_: `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md`

**Save Contract**:
The compiler-derived compatibility identity covering persistent declarations and save-addressable checkpoint structure for a Project. Restoration rejects a mismatched Save Contract rather than migrating, dropping, or defaulting saved state.

**Bootstrap Module**:
The one explicit Project script entry that runs synchronously in every fresh Project Lua VM to construct state-independent functions, imports, controllers, and hook registrations. It cannot read or mutate gameplay state. Other Script Modules execute only when imported, referenced by a supported hook mapping, or invoked explicitly.

**Script Module**:
A Project-owned Lua resource imported by stable identity through the Project's VM-local cached loader. Its first-load initialization is synchronous, non-yielding, and independent of gameplay state; exported functions may use the capabilities of their invocation context, while an unused and unreferenced Script Module does not execute.

**Hook Module**:
A Script Module explicitly referenced by a supported hook mapping and therefore loaded automatically during registry construction so its named handlers can be resolved before the Hook Registry freezes. A dedicated file paired with one definition is an editor convenience rather than exclusive module ownership or implicit top-level gameplay execution.

**Pure Script Context**:
A synchronous Lua evaluation context, such as a condition, text expression, or lifecycle guard, that may observe admitted authoritative state but cannot leave mutations in gameplay state, Lua globals, module state, closure state, or the module cache. Room Composition is a specialized Pure Script Context whose only mutable target is its temporary presentation draft.

**Game Ready Hook**:
The synchronous, non-yielding `on_ready` lifecycle handler that rebuilds transient Lua state after authoritative gameplay state has been established in a fresh VM. It runs for new game, reset, and save restoration, may read current gameplay state and mutate only transient Lua state, and is presented to authors as **On Game Ready**.

**Hydration**:
The save-restoration phase that establishes validated authoritative state in a fresh candidate session before the shared Game Ready Hook rebuilds transient Lua state. Hydration never reruns the entrypoint, Room lifecycle, crossed cues, or restored Flow instructions, and failure rejects the candidate restoration atomically.

**Checkpoint Boundary**:
A semantic execution position at which settled runtime state is technically serializable and coherent as a resumable gameplay checkpoint. Boundary policies are extensible by execution family; Property mutations or presentation work do not promote a checkpoint until the owning unit reaches an eligible boundary.

**Retained Save**:
A save operation that immediately writes the latest valid in-memory checkpoint, which may intentionally predate current transient or unfinished work.

**Deferred Save**:
A save operation that waits for and writes the first valid checkpoint promoted after the request.
