# Domain Docs

How engineering and planning skills should consume NovelTea's domain language and current documentation.

## Authority and routing

Use these layers for different jobs:

- **`CONTEXT.md`** — canonical cross-cutting NovelTea vocabulary. It is a glossary, not an architecture document.
- **`docs/adr/`** — rare rationale for architectural decisions that are hard to reverse, surprising without context, and the result of a real trade-off.
- **`docs/OVERVIEW.md` → area overview → subsystem/component document** — authoritative current architecture and behavior.
- **Wayfinder maps, specs, tickets, and implementation plans** — planning/delivery artifacts. They may describe proposed changes but do not become current architecture authority merely by being decided or published.

Before planning, specifying, ticketing, or changing an area, read `CONTEXT.md` and follow `docs/OVERVIEW.md` to the narrowest relevant current documents. Read relevant ADRs when `docs/adr/` exists. Inspect code when a claimed current behavior or boundary needs verification.

If `docs/adr/` does not exist, proceed silently. Create it only when a decision actually meets the ADR threshold.

## `CONTEXT.md` scope

Keep `CONTEXT.md` deliberately small and cheap to load. A term belongs there when its precise NovelTea meaning is useful across planning or subsystem boundaries.

For each term:

- define what it **is** in one or two sentences;
- keep implementation details, schemas, ownership graphs, algorithms, version numbers, and lifecycle rules in the current detailed docs;
- use `_Avoid_:` only for an established terminology decision, not to invent synonym bans;
- optionally use one `_See_:` pointer to the canonical current document when more detail is useful.

A narrow subsystem term should remain in that subsystem's terminology section unless repeated cross-cutting use makes a glossary entry valuable. General engineering vocabulary from skills such as `/codebase-design` does not belong in `CONTEXT.md`, and skill-specific analysis terms do not rename established NovelTea concepts such as Layouts, engine components, or RmlUi custom components. `CONTEXT.md` supplements detailed project definitions rather than replacing them.

When `/domain-modeling` adds or changes a term, first check the relevant current docs through `docs/OVERVIEW.md` and the code when needed. Preserve settled terminology unless the planning discussion is explicitly reopening it. When a genuinely new term crystallizes, update `CONTEXT.md` immediately as the skill requires.

## ADRs

Use the stock `/domain-modeling` ADR threshold. An ADR records **why** a consequential choice was made; it does not replace the current document that describes **what** the implemented system does.

Do not create ADRs retroactively just because an existing architecture document contains rationale. Create new ADRs prospectively when a planning decision meets the threshold. If later implementation changes current architecture or behavior, update the narrowest affected current document under the existing documentation hierarchy.

## Planning versus current truth

During `/grill-with-docs` or `/wayfinder`, glossary terms and qualifying decision rationale may be recorded immediately. Proposed architecture and behavior remain in the planning artifact until implemented.

When a Wayfinder effort concerns a specific subsystem, put the relevant current-doc pointers in the map's `Notes` so fresh ticket sessions can zoom into authoritative NovelTea documentation without duplicating it into the map.
