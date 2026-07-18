# Module Boundary Policy

## Purpose

The module boundary policy makes the six production-library dependency directions executable. It
first requires every C/C++ file under `engine/include` and `engine/src` to have exactly one owner in
the six-target classification, then checks that production set and source-owned CMake files without
traversing generated or build trees.

Run the checker through the normal build target:

```sh
cmake --build --preset linux-debug --target module-boundary-policy
cmake --build --preset web-debug --target module-boundary-policy
```

The aggregate `cxx-policy` target also depends on `module-boundary-policy`, so the Linux and Web
policy jobs execute it automatically.

## Allowed Production Graph

The checker uses `cmake/NovelTeaModuleFileClassification.cmake` as the exact production file set and
enforces these direct dependency directions:

- `noveltea_domain` depends only on itself;
- `noveltea_content` may depend on domain;
- `noveltea_runtime` may depend on domain and content;
- `noveltea_presentation` may depend on domain and runtime;
- `noveltea_script_lua` may depend on domain and runtime;
- `noveltea_engine` may depend on every lower production module.

The same direction applies to resolved NovelTea include directives and explicit CMake target edges.
Lower modules may not acquire host/backend dependencies indirectly through a source include. Content
may include nlohmann-json and miniz headers and link their approved private compile targets.
`script_lua` may include and link Lua/sol2. Domain, runtime, and presentation do not admit those or
SDL, bgfx/bimg/bx, RmlUi, ImGui, miniaudio, Twink, or text-backend includes. Engine owns those backend
families.

The scanner parses exact include directives and `target_link_libraries` command arguments. It does
not use unrestricted source-substring searches, and it only visits classified production files plus
source CMake files under the root, `engine`, `apps`, `tools`, and `tests` trees. `build/`, generated
trees, dependency checkouts, and reference trees are outside its scan set. Lower-module link commands
must name dependencies explicitly; variable or generator-expression edges are rejected because they
would hide the graph from source policy validation.

## Exceptions

The authoritative allowlist is `cmake/module-boundary-allowlist.txt`. No exceptions are currently
approved. Each future entry must have exactly seven pipe-separated fields:

```text
kind|source|dependency|owner|rationale|removal_condition|documentation
```

`kind` is `include` or `target-edge`. Include sources are exact classified repository paths and the
dependency is the exact include token. Target-edge sources and dependencies are exact target names.
Wildcards, absolute paths, and parent traversal are forbidden. The documentation field must be an
exact path under `docs/`, and that document must contain the exact
`kind|source|dependency` key. The checker rejects duplicate entries, entries that no longer suppress
a live violation, missing documentation, and entries whose source is not part of the production
classification.

`cmake/VerifyModuleBoundaryPolicyChecker.cmake` supplies positive fixtures for the approved graph,
build-tree exclusion, and exact documented exceptions. Its negative fixtures cover forbidden module
and backend includes, forbidden target edges, hidden dynamic edges, unclassified production files,
malformed/wildcard/duplicate/stale allowlist entries, and undocumented exceptions.
