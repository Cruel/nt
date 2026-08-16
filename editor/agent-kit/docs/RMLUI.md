# RmlUi Authoring Differences

Use this guide when writing or modifying NovelTea RML or RCSS. Assume normal HTML, CSS, and XML knowledge, but do not assume a browser feature exists just because its spelling is familiar. NovelTea uses a pinned RmlUi 6.3-dev-derived build; the supported RML/RCSS surface is that build, not current browser CSS and not whatever the latest RmlUi website happens to document.

## RML is XML, not browser HTML

RML uses strict XML syntax. Close elements correctly, quote attributes, escape XML characters, and keep a single well-formed tree. Browser error recovery for malformed HTML is not part of the contract.

A full Layout document uses document structure such as:

```xml
<rml>
  <head>
    <link type="text/rcss" href="project|/ui/common.rcss" />
  </head>
  <body>
    <div class="panel">...</div>
  </body>
</rml>
```

A NovelTea Layout whose `layoutKind` is `fragment` is only the mountable body fragment: do not add `<rml>`, `<head>`, or `<body>` around it. A `document` should contain the full RML document structure.

RmlUi supplies familiar basic elements and controls, but it is not a browser DOM. Do not depend on browser-only HTML semantics, JavaScript, web components, accessibility APIs, navigation, fetch behavior, or implicit browser resources. Generic element names can participate in RmlUi layout and styling, but an unfamiliar tag does not gain HTML behavior merely because a browser recognizes that name. Do not invent undocumented NovelTea `nt-*` elements.

Templates are an RmlUi facility, not HTML `<template>` semantics. A linked `text/template` resource defines an RmlUi template that can be applied through RmlUi's template rules. Treat template files as explicit Layout resources and dependencies rather than browser-imported markup.

## RCSS is a deliberate CSS subset

RCSS preserves CSS-like cascade, inheritance, box layout, selectors, flexbox, transforms, animations, and media queries, but only registered RmlUi properties and values are valid. When uncertain, do not guess from MDN or modern CSS. In particular:

- There is no CSS Grid contract. Use supported block, inline, table, positioned, float, or flex layouts.
- `background` is the `background-color` shorthand; it does not accept browser background images. Use RmlUi decorators or an `<img>` for images.
- Border shorthands cover width and color, not browser border styles such as `solid` or `dashed`.
- Pseudo-elements such as `::before`, `::after`, and `::first-letter` are not supported.
- Browser vendor prefixes, browser-specific functions, and unlisted modern CSS properties should be treated as unsupported.

RmlUi-specific facilities are normal RCSS and are preferable to browser workarounds when they express the intended UI: decorators, `@decorator`, `@spritesheet`, `image-color`, `font-effect`, `fill-image`, navigation properties, and RmlUi drag/focus properties. Image decorators are the usual RCSS mechanism for rendered image backgrounds and support image fitting/alignment behavior directly.

RCSS custom properties and `var()` are supported in NovelTea's pinned build. They cascade and inherit, but custom properties themselves are not animation targets. Use them for tokens; do not assume every newer CSS custom-property feature exists.

## Selector and pseudo-class traps

RCSS supports the familiar universal, type, class, ID, attribute, descendant, child, adjacent-sibling, and general-sibling selectors, plus `:not(...)` and the common structural `:nth-*`, first/last/only/empty selectors.

The important behavioral difference is state propagation: RmlUi's `:hover`, `:active`, `:focus`, and `:focus-visible` state propagates backward through ancestor elements. A rule such as `.panel:hover` can therefore match because a descendant is hovered. Do not reason about those selectors with browser-only target-element semantics.

`:checked` applies to RmlUi form state, including open/select state where documented. `:placeholder-shown` is available for input placeholder state. Pseudo-elements are not available.

For large documents, keep the right-most part of complex selectors anchored by an ID, class, or element name where practical; pseudo/attribute-only right-most selectors require broader matching work.

## Flexbox is close, not identical

Use `display: flex` and `display: inline-flex` for one-dimensional layout, but account for RmlUi differences:

- `inline-flex` requires a definite, non-`auto` width.
- Anonymous flex items are not synthesized from otherwise unwrapped text.
- `order` is not supported.
- `flex-basis: content` is not supported.
- `visibility: collapse` is not supported.
- Baseline alignment is approximate, and stretched items are not reformatted the same way a browser may reflow them.

For large or expensive flex layouts, definite sizing and simple `flex: <number>` distribution are safer than relying heavily on repeated content measurement.

## Media queries use the RmlUi context, not browser environment APIs

RCSS `@media` supports the RmlUi media features `width`, `height`, `aspect-ratio`, `resolution`, `orientation`, and the RmlUi-specific `theme`. Range features support `min-`/`max-`. Logical composition supports `and` and `not`.

Do not use unsupported browser media-query syntax: nested media rules, nested condition parentheses, `or`, general CSS Level 4 comparison syntax such as `width >= ...`, or arbitrary browser/device features.

NovelTea supplies the logical dimensions and scale environment used by RmlUi. The pinned numeric parser accepts `px`, `dp`, `em`, `rem`, `vw`, `vh`, `in`, `cm`, `mm`, `pt`, and `pc` length units; `ex` is not accepted. RCSS resolution uses the `x` unit (for example `2x`). Do not infer browser `devicePixelRatio`, physical monitor size, or CSS viewport behavior from the native window. Author responsive UI against the RmlUi logical context presented by NovelTea.

## Animations and transitions

RCSS supports `@keyframes`, `animation`, transforms, and transitions for supported property types. Do not assume browser animation coverage for every property; for example box shadows are not animation targets in the pinned profile.

A particularly important difference: RCSS transitions run when the affected property change comes from adding or removing a class or pseudo-class. Do not expect a transition merely because some other mechanism changed a computed property.

Use CSS animation for visual behavior owned by the Layout. NovelTea's semantic presentation transitions, such as mounting or replacing gameplay Layouts, are engine operations and should not be reimplemented as CSS state machines.

## NovelTea enables CSS math expressions

NovelTea builds RmlUi with math expressions enabled. Supported numeric properties can use `calc()`, `min()`, `max()`, and `clamp()` with compatible numeric types, including nested expressions. Binary `+` and `-` follow CSS-style whitespace requirements. `clamp()` accepts its three arguments and the pinned implementation also accepts `none` for an unbounded minimum or maximum.

Example:

```rcss
.dialogue-panel {
  width: min(92vw, 1100dp);
  padding-left: clamp(24dp, 4vw, 72dp);
  font-size: calc(18dp + 0.3vw);
}
```

Do not infer additional modern CSS math functions. A function or unit not supported by the pinned RmlUi parser is invalid even if browsers accept it.

## Images, decorators, and sprite sheets

Use `<img>` when an image is content. Use `decorator` when an image or generated effect decorates an element. RmlUi decorators include image/tiled/nine-patch forms, gradients, shader-backed decorators where the runtime supports them, and text decorators. Filters and font effects are separate RCSS facilities.

`@spritesheet` defines named rectangles from one image; sprite names are document-global across the included style sheets, and later definitions can replace earlier ones. Sprites can be used by decorators and `<img sprite="..." />`.

For NovelTea project resources, source URLs use mounted namespace spelling:

- `project|/path` for project resources;
- `system|/path` for engine-bundled resources when a documented system resource is intentionally referenced;
- relative URLs resolve relative to the RML/RCSS resource.

A path in RML or RCSS is not enough to make a resource available. Project images, fonts, stylesheets, scripts, templates, and other Layout resources must also be represented by the appropriate Layout dependency so preview and exported packages contain the complete resource graph. Dependency declarations do not rewrite Asset IDs into URLs; write the actual mounted/relative source URL in RML or RCSS.

## Before treating browser intuition as authoritative

When a familiar CSS or HTML technique is not covered here, prefer the focused generated references over guessing. Use `.noveltea/agent/docs/RCSS_REFERENCE.md` before introducing a new RCSS property/value/function, `.noveltea/agent/docs/RMLUI_DATA_BINDING.md` for `data-*` or `noveltea` model behavior, `.noveltea/agent/docs/RMLUI_LUA.md` for RML event Lua/`<script>`/imperative RmlUi APIs, and `.noveltea/agent/docs/RMLUI_CUSTOM_COMPONENTS.md` before using any `nt-*` tag.

The separate engine-wide base-RCSS/default-style behavior is outside this guide. Do not compensate for that issue by baking assumptions about implicit base styles into authored Layouts.
