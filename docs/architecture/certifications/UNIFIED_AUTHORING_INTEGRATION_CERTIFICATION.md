# Unified Authoring Integration Certification

Certified: 2026-08-30

Scope: issue #128, the final integration/documentation ticket under #115. The prerequisite #127
implementation is present at commit `efda27ba`; this certification evaluates the resulting unified
authoring, compiled-project, Running Game, and RuntimeUI contract.

## Contract certified

NovelTea has one gameplay-object model for authored and runtime interactive objects:

- an Interactable Definition is immutable reusable configuration;
- a declared Interactable Instance is an exact gameplay identity in the Project-level
  `interactableInstances` registry;
- its Location, enabled/visible state, quantity, Traits, Properties, and Feature overrides belong to
  that exact Instance;
- Room Interactable records are presentation occurrences referring to exact Instance identities;
- Inventory membership is derived from exact Instance Location and Inventory rows preserve those
  identities rather than introducing Item Stack identities;
- stackability belongs to the Definition while positive quantity belongs to each live Instance;
- Conditions and Gameplay Commands are shared typed vocabularies across their admitted hosts;
- Exploration rejection remains in the source Room and uses source `onLeaveRejected`, Exit
  `onRejected`, or target `onEnterRejected` Gameplay Command programs as appropriate;
- Verb Menu, Present Inventory, Trigger Context, occurrence-safe self-dismissal, and parent/child
  Layout presentation use the same exact gameplay identities through RuntimeUI.

The retired Item Definition/Item Stack project/runtime architecture is not a compatibility path.
Current authoring, generated Agent Kit guidance, compiled fixtures, native runtime, and Lua guidance
describe only the unified model; retirement references remain only where they explicitly document an
invalid former shape.

## Documentation and Agent Kit audit

The final audit reconciled `CONTEXT.md`, Project and Gameplay Command engine docs, RuntimeUI docs, and
the Agent Kit authoring, Room, Interaction, Inventory, Layout, and provenance documents. It corrected
a stale Room authoring recipe that still treated an Interactable Definition as the mutable live object
and documented the Definition / declared Instance / Room occurrence split in prose.

The existing runtime and Lua documentation was audited rather than rewritten unnecessarily:

- `docs/runtime/STATE_AND_PLAYBACK.md` already documents exact Interactable Instance state,
  quantity/Location, and Room rejection settlement;
- `docs/runtime/LUA_RUNTIME.md` already documents exact Interactable identity, Location/Inventory,
  quantity mutation, and capability-bound runtime references;
- `editor/agent-kit/docs/LUA.md` already documents owner-qualified Inventory locations, quantity APIs,
  normal Room navigation/rejection, exact subject activation, Verb Menu semantics, `Game.mount_context`,
  Trigger Context anchoring, self-dismissal, and contextual child Inventory/Layout presentation;
- current editor workspace, preview, and save-unit documentation already identifies the
  `interactableInstances` registry and exact Instance ownership.

The Agent Kit generation/provenance tests certify that these curated documents remain part of the
deterministic generated kit.

## Project to Compiled Project seam

The authoring/compiler seam is certified by the strict schema, compiler, wire, golden-corpus, and
Agent Kit tests. In addition, `roomInteractableRef()` was corrected to emit the exact
`interactableInstances` registry reference required by its own Room schema; a direct regression test
now locks that helper to the schema type.

The canonical exploration golden now contains a stackable `credits` Definition, a declared `wallet`
Instance with quantity four in an Inventory, and a shared `consume-quantity` Gameplay Command. The
regenerated compiled golden therefore proves that exact Definition/Instance separation, Location,
quantity, and command lowering survive the real TypeScript compiler boundary. Existing strictness
tests continue to reject retired same-version authoring/compiled shapes rather than normalize them.

Focused seam verification:

```text
authoring-rooms.test.ts
authoring-schema-strictness.test.ts
authoring-compiler.test.ts
compiled-project-wire.test.ts
compiled-project-golden-corpus.test.ts
noveltea-cli.test.ts
```

Result: 6 files, 97/97 tests passed.

## Compiled Project to Running Game seam

The canonical `RunningGame` exploration integration test now exercises the unified model through the
final native runtime boundary. It verifies:

- declared exact Instance lookup and Inventory containment;
- stackable quantity four at startup;
- Interaction/Primary Activate entering the authored exploration Scene;
- shared Gameplay Command quantity consumption from four to three;
- existing runtime-created Room and Interactable Instance publication;
- ordinary gameplay mutation and Room movement;
- save creation, load-candidate construction, commit, and preservation of quantity/containment;
- an Exploration navigation rejection that leaves Current Room and Room visit counts unchanged.

Supporting native tests independently cover split/merge/transfer/add/consume quantity arithmetic,
declared/runtime Instance allocation, recursive Conditions including Inventory quantity, declarative
Room rejection programs and Scene/Dialogue handoff, exact selectors, and save-state reconstruction.

The strengthened canonical test was developed red-to-green: before the canonical fixture gained the
quantity scenario, the new startup/mutation/restore assertions observed quantity one instead of the
required four/three/three; after the authoring fixture and compiled golden were updated, the same
test passed without runtime-specific fixture patching.

## RuntimeUI and Layout seam

The RuntimeUI/Layout integration matrix passed the focused cases for:

- exact configured Player Inventory opening;
- Present Inventory Project-default and built-in/explicit Layout precedence;
- exact Inventory row/gameplay collection projection in ordinary RmlUi Layouts;
- semantic Verb Menu publication without implicit primary selection;
- built-in Verb Menu to multi-slot Command Builder flow;
- contextual Verb Menu invalidation/dismissal;
- immutable Trigger Context preservation through Command Builder submission;
- Trigger Context anchoring in receiver logical coordinates;
- occurrence-safe contextual child Layout presentation;
- parent lifetime/replacement grouping bound to the exact Mount occurrence;
- Escape/self-dismiss ordering; and
- Present Inventory Mount save/strict restore behavior.

The focused RuntimeUI/Layout runs passed 14/14 selected integration tests. These tests are also part
of the complete native suite below.

## Version preservation

No authoring schema, compiled-project schema, save format, runtime protocol, preview protocol, or
other selected version number was changed. Both editor and native/Web schema-version policy gates
passed, including the checker self-tests.

## Verification evidence

The final #128 tree was verified on 2026-08-30:

| Verification | Result |
| --- | --- |
| Focused Project -> Compiled Project suite | PASS: 6 files, 97/97 tests. |
| Focused canonical Running Game seam | PASS. |
| Focused RuntimeUI/Layout seam | PASS: 14/14 selected integration tests. |
| `pnpm -C editor run check` | PASS: format, lint with zero warnings/errors, TypeScript, and schema-version policy. |
| `pnpm -C editor run test` | PASS: 231 files passed, 2 skipped; 1,699 tests passed, 5 skipped. Existing non-failing React `act(...)` warnings remain. |
| `pnpm -C editor run build` + bundle policy | PASS: Electron/main/preload/tools and renderer production build; bundle policy passed. |
| Linux Debug build | PASS with four-way parallelism requested for this development host. |
| Linux format/C++/JSON/module/schema policy gates | PASS. |
| `DISPLAY=:0 ctest --test-dir build/linux-debug --output-on-failure` | PASS: 988/988 tests, including all GPU/readback tests, Player package smoke, and repeated sandbox compiled-package smoke. |
| Web Debug threaded configure/build | PASS: player and sandbox built. |
| Web C++/dependency/JSON/module/schema policy gates | PASS. |
| `pnpm run web:smoke` | PASS, including compiled-world readback and renderer performance publication. |
| `git diff --check` | PASS. |

Two diagnostic reruns preceded the clean native result. A first CTest invocation omitted `DISPLAY`
and failed only X11-dependent captures/downstream verifiers. With `DISPLAY=:0`, all GPU cases passed;
a parallel run then exposed one transient threaded mandatory-asset test (`finalized` observed as three
instead of four), which passed immediately alone. The final serial display-backed matrix passed all
988 tests, so neither diagnostic failure is classified as a #128 regression.

`pnpm run web:screenshot:smoke` was additionally attempted. The engine reached ready state and
created the requested PPM path, but the existing Web renderer exhausted its RmlUi bgfx view range
(`65..156`), failed the final composite, and timed out before completing the PPM payload. #128 does
not modify renderer view allocation or screenshot capture; the normal Web browser smoke, Web build,
Web policy gates, and all native GPU/readback tests are green. This is recorded as an existing
renderer/screenshot-smoke limitation rather than silently treating the optional check as passed.

## Final review

The final diff was reviewed against repository standards using `HEAD` (`efda27ba`) as the fixed
point and against issue #128 as the specification source.

**Standards:** no findings. The changes preserve the single-current-version rule, update the
narrowest current documentation/Agent Kit surfaces for behavior that changed, keep exact IDs typed,
add focused regression coverage for the corrected schema helper, keep C++/TypeScript formatting and
policy gates clean, and introduce no new dependency or compatibility path. No material Fowler smell
was introduced by the implementation diff.

**Spec:** no findings. Every #128 acceptance area is either directly changed here or certified through
the already-current implementation/docs from #123-#127: unified authoring guidance, Agent Kit prose,
canonical fixtures, strict Project -> Compiled lowering, Running Game identity/quantity/containment/
Interaction/navigation/save behavior, RuntimeUI contextual presentation, Linux/Web/editor
verification, and version preservation.

## Result

Issue #128's unified product-contract boundary is implemented and certified. Authoring guidance,
generated agent guidance, canonical compilation, native Running Game behavior, and RuntimeUI/Layout
presentation now describe and exercise the same exact Interactable Instance model from source Project
through runtime UI without a second Item Stack architecture.

## Post-certification #115 alignment follow-up

A subsequent parent-spec audit of issue #115 found several gaps that were not exercised strongly
enough by the original #128 certification. They were corrected without changing any selected schema,
protocol, compiled-project, or save version:

- ordinary runtime Interactable creation now always names an Interactable Definition. The shared
  Gameplay Command, Scene runtime-world operation, Runtime World/Lua capability surface, compiler,
  decoder, and canonical goldens no longer use compiled/effective Instance cloning as the ordinary
  creation path. Effective configuration cloning remains available only through the explicit
  structural replacement capability;
- Room authoring `count` expansion creates the minimum number of exact stackable Instances permitted
  by `stackLimit`, while non-stackable counts remain repeated exact identities;
- editor commands distinguish presentation-occurrence removal, semantic `Remove from Room`, and
  exact Instance destruction. Semantic Room removal also clears that Instance's Room presentation
  occurrences, while pure occurrence removal does not change Location;
- exact Interactable Instance rename rewrites typed registry references, including Room occurrences
  and owner-qualified nested Inventory references, without changing the origin Definition;
- `Present Inventory` command policy now carries trigger anchoring, optional exact triggering-Layout
  parent lifetime, and explicit coexistence through authoring, compiled wire, runtime execution, and
  RuntimeUI transport;
- shared `Navigate Exit` and `Change Room` are both executable from the common command path.
  Navigation remains guard-vetoable, while directed Room change remains authoritative. The audit
  exposed and fixed a root-flow continuation defect where a successful nested directed change could
  be overwritten by the source Room captured when the root Interaction/Scene began; root return now
  resumes the currently committed Room visit;
- Scene gameplay-effect batches remain an immediate-only atomic host as designed. Authoring
  validation now rejects boundary commands such as `Present Inventory`, `Navigate Exit`, and
  `Change Room` there, matching the Scene editor and compiled-project validator; Scene-directed Room
  control continues to use its specialized timeline Event;
- authoring dependency-graph metadata and fingerprints explicitly classify the added command fields
  instead of bypassing the fail-closed field audit.

Follow-up verification on 2026-08-30:

| Verification | Result |
| --- | --- |
| `pnpm -C editor run check` | PASS: formatting, lint with zero warnings/errors, TypeScript, and schema-version policy. |
| `pnpm -C editor run test` | PASS: 232 files passed, 2 skipped; 1,706 tests passed, 5 skipped. Existing non-failing React `act(...)` warnings remain. |
| Linux Debug build | PASS. |
| `DISPLAY=:0 ctest --test-dir build/linux-debug --output-on-failure` | PASS: 991/991 tests, including all GPU/readback and package smoke tests. |
| Web Debug threaded build | PASS: player and sandbox built. |
| `pnpm run web:smoke` | PASS, including compiled-world readback and renderer performance publication. |
| `git diff --check` | PASS. |

The remaining `Item Definition` / `Item Stack` references outside historical certification text are
retirement documentation or deliberate negative tests. No live compatibility path was found during
the follow-up audit.
