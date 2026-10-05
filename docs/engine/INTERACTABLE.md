# Interactable Component

## Contract

`InteractableDefinition` is immutable reusable configuration. It does not identify a live object.
Every live world/inventory object is an exact Interactable Instance with its own stable
`InteractableInstanceId` and a reference to one `InteractableDefinition` identified by
`InteractableDefinitionId`.

Interactable is Property-bearing and may attach compatible Traits. Trait members remain ordinary
Properties; identity, presentation, Feature ownership, interaction structure, and location do not
merge through Traits.

A declared Interactable Definition authoring record may attach one same-kind Archetype. The
Archetype contributes immutable presentation/configuration, Trait attachments, and Property
schemas/Defaults. Mutable Location/enabled/visible state does not belong to the Definition. Editor edits
operate on the resolved effective configuration and become explicit overrides; compilation emits a
flattened `InteractableDefinition` plus separate declared Instance records.

Interactable Definitions are reusable Property schema sources rather than live Property owners. They
may declare ordered typed Property contracts with optional Defaults and may intentionally leave a
required contract without a Default for concrete Instances to satisfy. A Definition Default is more
specific than an inherited Archetype Default, which is more specific than a Trait Default.

Definitions also declare intrinsic quantity behavior. `stackable=false` fixes every live Instance at
quantity `1`. `stackable=true` permits a positive safe-integer quantity and may declare an optional
positive `stackLimit`; omitting the limit means the portable safe-integer ceiling. Stackable
Definitions may still own presentation, Hotspots, Traits, and Properties, but they may not own
identity-bearing Features or Inventories. Changing stackability or reducing a Stack limit never
silently rewrites authored Instances: incompatible quantities or identity-bearing children are kept
in the Project and reported as blocking authoring diagnostics until explicitly repaired.

An Interactable may own stable nested Features. Each Feature has an ID unique within the owning
Interactable, a label, compatible Trait attachments, and compatible Property assignments. An exact
Feature subject is always referenced as `(InteractableInstanceId, FeatureId)`; a bare Feature ID is not a
runtime identity.

Definition presentation may select an Engine2D Material through a shared Material Application. The application contains the Material selection plus sparse typed parameter sources and sparse author-owned texture sources. Parameters may use literals, compatible Interactable Property bindings, or supported scalar standard facets; renderer-owned inputs remain read-only. Changing the selected Material does not delete incompatible saved entries: they remain dormant until a compatible Material is selected again. Every concrete Instance inherits this application and may author a more-specific sparse specialization: an optional Material-selection replacement plus parameter and author-owned texture deltas. Instance names override matching Definition names; absent Instance entries continue to inherit the Definition application, and Reset removes only the Instance delta. Dormant incompatible Instance entries are retained across Material switching and can reactivate when their compatible Material is selected again.

Presentation selects a canonical image or raster Animation `visual`, or explicit null. Animation
selection may name a motion or use its resource default; occurrences loop on the gameplay clock.
Hotspot modes are `none`, `visual-alpha`, or `custom`; the replaced `sprite` field and `sprite-alpha`
discriminator are rejected, not aliased. `none` performs no pointer hit testing and needs no Visual.
`visual-alpha` provides one Hotspot whose hit area follows the currently realized frame's retained
CPU alpha coverage. Every selected frame must support coverage; missing coverage fails publication
explicitly, without GPU readback or rectangle fallback. `custom` contains analytic normalized
rectangles relative to the complete Visual canvas and requires a Visual when non-empty. Hit geometry
and highlight-source capabilities are independent: analytic geometry does not depend on alpha
coverage or on overlay support. Interactable presentation may define one Definition-level cursor
fallback; its implicit `visual-alpha` Hotspot uses that cursor, while custom Hotspots may override it. Cursor
targets accept system semantic cursors, Project named cursors, or `none`, but not direct cursor images.
If neither the custom Hotspot nor presentation supplies a cursor, resolution falls through the Project
Hotspot default and then its Pointer/native fallback. Each Hotspot has stable owner-local identity,
condition, target, input priority, and highlight policy. It may select the owning
Interactable, an owner-local Feature, another exact admitted semantic subject, or explicit `none`.
`none` keeps the Hotspot geometry authored and editor-visible while excluding it from runtime hit
testing and semantic dispatch; validation reports the inert state informationally. Newly created
Interactable Hotspots continue to default to the owning Interactable. Hotspots own no Verb
or Interaction program. Cursor presentation remains Definition-level and is inherited by every
placement/Instance; there is no cursor-specific Instance override. An empty custom list remains
structurally valid while authoring, but `none` is the canonical way to declare an intentionally
non-clickable Interactable.

## Instance identity, Location, and state

Declared Instances live in the project-level `interactableInstances` registry. Each entry owns its
stable exact ID, Definition reference, optional editor label, authoritative Location, enabled/visible
state, positive quantity, Trait additions/removals, sparse inherited Property overrides, ordered
Instance-local typed Properties, and one sparse Material Application specialization. Multiple Instances
may reference the same Definition and remain independent identities. Effective Property Values resolve
by specificity: Instance-local/override Value, Definition Default, inherited Archetype Default, Trait
Default, then missing. Effective authored Material state resolves Instance selection and named deltas
over Definition selection and named deltas, then Material/preset defaults. Resetting an Instance
override reveals the lower layer instead of copying that lower Value into the Instance.

Room geometry belongs to nested `RoomPlacement`, not the Definition. A mutable `InteractableState`
stores exactly one authoritative Location—owner-qualified Inventory, Room, or Unplaced—plus enabled,
visible, and quantity state. Room Location names only the `RoomId`; visual placement is supplied
separately by Room Interactable occurrences, which reference the exact Instance. A Room may author
zero, one, or multiple exact occurrences for the same Instance without changing its semantic identity.
Runtime state may additionally hold at most one dynamic Room occurrence for an Instance. A Room may
declare one optional fallback Interactable placement for semantically present Instances that do not
have an exact occurrence.

Presentation placement resolves in this order: the Instance's current dynamic occurrence, authored
exact occurrence, Room fallback placement, then no presentation. An ordinary move to a Room resolves
the required presentation before committing either Location or dynamic occurrence, so failure leaves
both unchanged. The explicit advanced `None` presentation policy permits semantic Room presence with
no occurrence. Moving out of a Room clears the dynamic occurrence. Moving an Interactable never
rewrites its Definition or authored Room occurrences.

Quantity mutations preserve exact identity semantics. Create-with-quantity always creates the minimum
number of new limit-respecting identities and never coalesces an existing identity. Split keeps the
source identity and creates one new identity with copied semantic state. Merge requires the same
immutable origin Definition, Location, enabled/visible state, effective Traits, and effective Property
Values and dynamic Room occurrence; the receiver survives and the donor ends. A split in a Room
inherits the source's resolved presentation placement as the new Instance's dynamic occurrence; a
split in an Inventory remains in that same Inventory. Exact transfer preserves identity for a whole-stack
move and performs one split for a partial move. `Add Quantity` fills only compatible Instances that
remain in the Definition's default semantic state, then creates the minimum number of new default
Instances. Consume decrements quantity or ends the identity at zero. Aggregate mutations use stable
Instance-ID ordering, require one semantic compatibility class, and are atomic on ambiguity,
insufficient quantity, invalid Location, overflow, or Stack-limit failure. Pure aggregate observation
may sum across compatibility classes.

Runtime-created Interactable identities use the shared gameplay-instance allocator. Split and
quantity creation therefore consume from the same monotonic allocator as other runtime Interactable
creation; ended identities are never reused, and allocator position plus quantity round-trip through
SaveState without changing the already-selected save/schema versions.

An Interactable may declare owner-local Inventories. Inventory membership is derived solely from Interactable Location, and each Inventory reference includes both its owner and owner-local `InventoryId`. Inventory ownership may also belong to the Project/session convention, Characters, or Features. Containment is acyclic, and moving an Inventory owner changes descendants' derived effective Room without rewriting their direct Inventory Locations.

Inventory presentation is generic and exact-identity based. The Project owns one canonical player Inventory (`inventory` / `Inventory` in authoring); Project Settings authors its starting contents by locating exact Interactable Instances there and may designate one reusable default Inventory Layout. `Present Inventory` accepts Player Inventory or any exact owner-qualified Inventory and resolves its Layout as explicit command Layout, then Project default, then the built-in compact fallback. Inventory membership remains direct and semantically unordered; RuntimeUI publishes direct exact Interactable members in stable Instance-ID order and does not flatten nested container contents. Each row carries the exact Instance and origin Definition identities, quantity/stackability, presentation, and enabled/visible state. Activating a row uses the same exact Interactable Primary Activate/Verb resolution used by Room objects; no aggregate Inventory subject or Item Stack presentation path is created.

The former Item Definition/Item Stack project/runtime model is retired. `docs/engine/ITEM.md` records
that boundary; stackability and quantity are native exact-Interactable-Instance semantics and there
is no parallel Item identity path.

## Authoring, compiled, and state disposition

- **Authoring Definition:** collection-specific Interactable record, Trait attachments, ordered typed
  Property schemas with optional Defaults, intrinsic stackability/optional Stack limit, owner-local
  Features for non-stackable definitions, immutable presentation including its Definition Material
  Application, and semantic Hotspot targets.
- **Authoring Instance:** infrastructure-level `interactableInstances` registry entry with exact ID,
  Definition reference, optional editor label, Location/state/quantity, Trait deltas, sparse inherited
  Value overrides, and ordered Instance-local typed Properties. The editor labels these entries
  `Initial Stacks` for stackable Definitions.
- **Compiled:** immutable `InteractableDefinition` records plus separate
  `InteractableInstanceDeclaration` records. Room occurrences refer to exact Instance IDs.
- **Mutable:** exact-Instance `InteractableState` and Property overrides in `SessionState`; Save-policy
  values, logical state, and any dynamic Room occurrence enter `SaveState` under the same Instance
  identity.
- **Tooling only:** categories, tags, colors, sort keys, notes, selection, and preview state.

Interactions use a closed Character/Interactable/Feature subject union. Operands are an exact typed
subject, `AnyCharacter`, `AnyInteractable`, or `AnySubject`; Feature subjects retain their owner-qualified
identity. Lua can access declared Interactable Properties through the ordinary typed Property API and
Feature Properties through the owner-qualified Feature helpers; neither API mutates arbitrary JSON.

## Implementation

The editor authoring schema uses the current `interactables` collection for Definitions and the
project-level `interactableInstances` registry for exact Instances. The editor supports Definition
creation, nested Feature editing, semantic Hotspot target editing, an Instance list in the
Interactable editor, and Room workflows that either create-and-place a new Instance or place an
existing Instance atomically. The Interactable editor and Room composition surface expose the same
compact exact-Instance Property editor; both mutate the registry entry rather than a Room occurrence
or placement. The creation wizard accepts Definition identity, an optional
same-kind Archetype, and an optional image Visual. Without an Archetype, creation uses `none` when no
image is selected and `visual-alpha` when an image is selected. With an Archetype, the image choice
can inherit its Visual or author an explicit replacement/null while Hotspot behavior remains inherited.
The Definition editor's Visual picker admits images and Animations, with a default/named motion selector.
Custom Interactable Hotspot geometry is edited through the same full-tab Hotspot Focus workflow used
by Rooms. The normal Interactable editor retains semantic fields, while Focus owns only source-image
geometry, local undo/redo, Fit/native zoom, and transactional Done/Cancel behavior. Rectangle mode
stays active for batch creation and new custom rectangles default to the owning Interactable.
`visual-alpha` mode can open the same focused source-image surface for inspection but does not expose
rectangle drawing. Animation geometry inspection uses the selected motion's first source frame; the
focused Room preview stages and plays the full Animation through production resource realization.
Alpha or non-empty custom Hotspots without a Visual are authoring errors. A visible Room occurrence
whose Interactable has no Visual is allowed but produces an authoring warning because it will not render. `CompiledProject` decodes immutable Definitions and separate declared
Instances; `SessionState` initializes one live state per Instance, and typed mutations reject missing
Rooms/Inventories and containment cycles atomically. Authored concrete Instances with unresolved
required Property contracts are compile errors, and runtime Instance creation validates the same
effective contracts before publishing a new identity.
Placements have no occupant back-reference or Interactable owner. Lua, player, Map, and Interaction
operations all use these same typed Location and semantic-subject APIs.

Lua quantity operations live on `noveltea.interactables`, alongside exact Location operations. The
surface queries exact quantity and exposes create-with-quantity, split, merge, exact transfer,
Add Quantity, consume, and aggregate Definition quantity/consume helpers. These APIs return and accept
`InteractableInstanceId` identities. The retired `noveltea.item_stacks` surface is absent rather than
aliased or normalized onto Interactable quantity semantics.

At runtime, occurrences share immutable source textures and alpha coverage, but retain independent
Room-qualified authored/dynamic/fallback occurrence identities and playback epochs. Reconciliation
preserves compatible occurrences rather than collapsing all placements of an Instance into one draw.
Capture, highlight routing, and Trigger source bounds retain the selected occurrence while semantic
dispatch still carries only the exact Instance/Feature subject. Snapshots keep Visual selection and
logical canvas metadata unchanged as frames advance; hit testing and overlays consume the same
selected texture lease. Custom mode derives an owner-union binary `R8` mask through the ordinary
prefetch/jobs/residency pipeline; Animation masks use logical canvas dimensions. Masks are neither
authoring Assets nor package entries. Inventory rows currently expose image Visuals as static icons;
animated Inventory icon realization is not part of this world-presentation cutover.
