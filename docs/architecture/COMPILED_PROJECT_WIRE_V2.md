# CompiledProject Wire V2

`editor/src/shared/project-schema/compiled-project.ts` is the sole executable contract for
`noveltea.compiled.project` version 2. The native decoder consumes this contract and may add
defensive validation, but must not invent a second wire shape.

The document contains immutable gameplay definitions (Characters, Rooms, Interactables, Verbs,
Interactions, Scenes, Dialogues, and Maps), typed properties and variables, typed runtime resources
(assets, layouts, and scripts), localization, runtime settings, startup hook, and one Room/Scene/
Dialogue entrypoint. Cross-references, including references into separately versioned material data,
are typed discriminated references; generic collection/id
references, authoring collection maps, legacy Object/Action names, comments, categories, tags, and
editor state are not legal fields.

The wire contains closed `SceneProgram`, `DialogueProgram`, `InteractionProgram`, and Room hook
representations. Program and nested IDs remain stable. Definition arrays are compiler-sorted by ID;
the compiler preserves the authored order of all semantically ordered arrays inside a definition.

`serializeCompiledProjectWireV2` is the only serializer. It validates the strict wire shape,
serializes compact UTF-8 JSON without a BOM or insignificant whitespace, orders object keys by Unicode
code point recursively, normalizes negative zero to zero, rejects non-finite values through schema
validation, and never reorders arrays. Package manifests and shader/material metadata remain separate
versioned documents.

Runtime settings publish the canonical reference resolution, project-wide world raster policy, and
independent UI/text accessibility policies. Aspect ratio and orientation are not compiled fields;
platform and bootstrap boundaries derive them from reference resolution only when required. Each
reference-resolution dimension is an integer from 1 through 10,000 across authoring, compiled wire,
package manifest, preview display, and player bootstrap validation.

Newly compiled image resources publish `sampling: "linear"` or `sampling: "nearest"`; omission in
older compiled documents resolves to the closed default `linear`. The field is authored for image
assets and ignored for non-image resource kinds. Native decode resolves both forms to the closed
`ImageSampling` enum before the immutable asset catalog is published.

Every compiled Layout publishes a fully resolved UI/text scale policy. Scene `set-layout`
instructions and transition-group Layout mutations may additionally publish per-mount
`scaleOverrides`; omitted members mean no override. Native decode and execution retain those typed
overrides through mounted presentation policy.

This is a TypeScript-owned contract. The native decoder consumes it defensively, and preview,
playback, package, and CLI consumers receive its canonical publication; no alternate runtime wire
shape or provisional-version decoder is retained.

The compiler uses a separate `CompiledProjectSharedDraft` implementation type while specialized
programs are still incomplete. That draft contains all shared declarations, resources, definitions,
inheritance edges, and authored assignments, but omits program-owned fields entirely. It is never
accepted by `compiledProjectWireV2Schema`, serialized as gameplay JSON, or exposed to consumers.

## Scene TransitionGroup wire contract

The targetless Scene instruction `{ "kind": "transition", ... }` is not a V2 variant and has no
compatibility interpretation. The only grouped transition instruction is
`{ "kind": "transition-group", ... }` with a non-empty `children` array, stable unique child IDs,
`transitionKind`, `durationMs`, `color`, `waitForCompletion`, and `skippable`.

The initial child union is closed to:

- `set-background` with typed asset/material references, color, and fit;
- `clear-background`;
- `actor-cue` with a typed Character reference and complete target placement;
- `set-layout` with `overlay` or `custom` slot and the literal resolved participation marker
  `plane: "world-overlay"`.

No child may contain waits, Flow changes, Lua execution, external requests, or another presentation
family. `cut` requires zero duration, no wait, and no color. `fade` and `dissolve` require positive
duration, and `dissolve` accepts no color. Native decode additionally links actor nested references and
requires a Layout child to resolve to `scene-overlay`, `room-overlay`, or `custom-overlay`.

This wire contract describes immutable compiled intent only. It contains no backend object, callback,
operation progress, or JSON-preserving runtime payload. Live runtime execution lowers the decoded
intent into committed desired targets, coherent presentation snapshots, and exact typed finite
operations without retaining the wire JSON.

Standalone `set-background`, `actor-cue`, and `set-layout` Scene instructions also carry required
`durationMs`, `waitForCompletion`, and `skippable` fields. `set-layout` additionally carries a closed
`transition` value of `none` or `fade`. Immediate forms require zero duration and no wait; animated
forms require positive duration. Actor `slide` is restricted to show, hide, and move. These fields are
compiled intent consumed by the live typed operation path; they never become backend-owned state.

## Cross-language decoder corpus

The exact cross-language decoder inputs live under
`editor/src/renderer/test/fixtures/compiled-project-golden/`:

- `minimal.json`;
- `comprehensive.json`;
- `inheritance-properties-localization.json`;
- `resources.json`;
- `scene-program.json`;
- `dialogue-program.json`;
- `interaction-program.json`.

They are generated only through `compileAuthoringProject` by running
`pnpm goldens:compiled-project` in `editor/`. Tests require byte-identical regeneration and verify that
the corpus collectively covers the closed Scene, Dialogue, Interaction, text, condition, effect,
flow-target, resource-source, location, matching, variable, property, and persistence vocabulary.

`decode_compiled_project` is the public native gameplay boundary. It consumes all seven
canonical documents through strict internal DTOs, reuses the native strong-ID and closed primitive
vocabulary, and returns `core::Diagnostics` for structural or semantic failures. Scene instructions,
Dialogue blocks/segments/edges, Interaction rules/instructions/contexts/operands, Verb default
programs, and Room hooks decode losslessly with owner-scoped nested IDs. A separate linker validates
all gameplay references, declarations, inheritance, nested targets, resource closure, and topology,
then publishes one immutable indexed `CompiledProject` only after every check passes. Source JSON is
never retained. Material references remain typed IDs until the separately versioned material manifest
is validated and assembled with the compiled package.

`noveltea_fuzz_compiled_project_decoder` is the dedicated decoder fuzz target. Its
non-libFuzzer smoke run feeds malformed JSON and all seven canonical documents through the same
nonthrowing parser and `decode_compiled_project` boundary under the Linux sanitizer preset. A
failed parse is passed to the decoder as its discarded JSON value, so the same Result/diagnostic path
is exercised without an assertion or exception.
