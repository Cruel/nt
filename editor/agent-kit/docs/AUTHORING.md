# Authoring Semantics

Rooms define locations and exits; Scenes define ordered/branching authored flow; Dialogues define dialogue graphs/blocks; Interactions connect subjects, operands, conditions, and authored programs. Keep references typed and stable-ID based. Use `noveltea usages` before destructive structural work and the transactional rename/delete commands when changing identity.

Inline conditions, expressions, predicates, and effect snippets remain in their owning JSON records unless the current workspace contract explicitly externalizes them. Do not create speculative per-entity Lua hook files or infer semantic references from arbitrary Lua text.
