# NovelTea RCSS Compatibility Reference

Use this document as an exact lookup when authoring NovelTea RCSS. It describes the RCSS profile exposed by NovelTea's pinned RmlUi build; it is not a browser-CSS tutorial and it does not track the moving upstream documentation independently of that pinned source.

For the broader RML/RCSS differences that are most likely to break browser-trained assumptions, read `.noveltea/agent/docs/RMLUI.md`. Return here when you need to know whether a property, value, shorthand, unit, function, or RmlUi-only facility is actually accepted.

## Certified profile

This reference is curated against this exact NovelTea profile:

- RmlUi version label: `6.3-dev`
- pinned RmlUi commit: `c6744d15bda5e9df7ad9c1f8eae937157e7ed309`
- NovelTea RmlUi patch revision: `6c-feature-calc-lua-listener-state-1`
- `RMLUI_MATH_EXPRESSIONS`: enabled
- registered built-in properties: 99
- registered built-in shorthands: 20

NovelTea's certification tests compare these profile identifiers with `cmake/NovelTeaRmlUi.cmake`. A RmlUi pin or patch revision change must therefore re-review this document rather than silently retaining the old compatibility claim.

## Value vocabulary

Use the following vocabulary in the property tables.

- `<number>`: unitless number.
- `<length>`: `px`, `dp`, `vw`, `vh`, `em`, `rem`, `in`, `cm`, `mm`, `pt`, or `pc`. Unitless zero is accepted where the numeric parser supplies a zero-length unit. `ex` is not registered by the pinned numeric parser.
- `<length-percentage>`: `<length>` or `%`.
- `<angle>`: `deg` or `rad`.
- `<resolution>`: `x`.
- `<color>`: the pinned color parser accepts hex RGB/RGBA forms, `rgb`/`rgba`, `hsl`/`hsla`, `lab`/`lch`, `oklab`/`oklch`, and the built-in names `black`, `silver`, `gray`/`grey`, `white`, `maroon`, `red`, `orange`, `purple`, `fuchsia`, `green`, `lime`, `olive`, `yellow`, `navy`, `blue`, `teal`, `aqua`, and `transparent`. Do not assume the full browser named-color set.
- `<string>`: RCSS string value accepted by the property's parser.
- `<math>`: `calc()`, `min()`, `max()`, or `clamp()` where the property's numeric parser admits the resulting numeric type. NovelTea enables these functions. `+` and `-` require CSS-style surrounding whitespace. `clamp()` also accepts `none` for its minimum or maximum bound in this pinned profile.

Do not assume CSS-wide keywords such as `initial`, `unset`, `revert`, or `revert-layer` are accepted. Built-in inheritance is determined by each registered property below. Custom properties beginning with `--` are supported and can be substituted with `var()`.

## Complete built-in property surface

The `Inherited` column reports RmlUi's registered inheritance flag. Values shown as closed keyword sets are exhaustive for this profile. Familiar numeric/color forms use the vocabulary above rather than repeating browser explanations.

### Box model, sizing, and positioning

| Property                                                                                                       | Accepted value                                                                                                                                                                             | Initial       | Inherited |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------- |
| `margin-top`, `margin-right`, `margin-bottom`, `margin-left`                                                   | `auto` or `<length-percentage>`                                                                                                                                                            | `0px`         | no        |
| `padding-top`, `padding-right`, `padding-bottom`, `padding-left`                                               | `<length-percentage>`                                                                                                                                                                      | `0px`         | no        |
| `border-top-width`, `border-right-width`, `border-bottom-width`, `border-left-width`                           | `<length>`                                                                                                                                                                                 | `0px`         | no        |
| `border-top-color`, `border-right-color`, `border-bottom-color`, `border-left-color`                           | `<color>`                                                                                                                                                                                  | `black`       | no        |
| `border-top-left-radius`, `border-top-right-radius`, `border-bottom-right-radius`, `border-bottom-left-radius` | `<length>`                                                                                                                                                                                 | `0px`         | no        |
| `display`                                                                                                      | `none`, `block`, `inline`, `inline-block`, `flow-root`, `flex`, `inline-flex`, `table`, `inline-table`, `table-row`, `table-row-group`, `table-column`, `table-column-group`, `table-cell` | `inline`      | no        |
| `position`                                                                                                     | `static`, `relative`, `absolute`, `fixed`                                                                                                                                                  | `static`      | no        |
| `top`, `right`, `bottom`, `left`                                                                               | `auto` or `<length-percentage>`                                                                                                                                                            | `auto`        | no        |
| `float`                                                                                                        | `none`, `left`, `right`                                                                                                                                                                    | `none`        | no        |
| `clear`                                                                                                        | `none`, `left`, `right`, `both`                                                                                                                                                            | `none`        | no        |
| `box-sizing`                                                                                                   | `content-box`, `border-box`                                                                                                                                                                | `content-box` | no        |
| `z-index`                                                                                                      | `auto` or `<number>`                                                                                                                                                                       | `auto`        | no        |
| `width`, `height`                                                                                              | `auto` or `<length-percentage>`                                                                                                                                                            | `auto`        | no        |
| `min-width`, `min-height`                                                                                      | `<length-percentage>`                                                                                                                                                                      | `0px`         | no        |
| `max-width`, `max-height`                                                                                      | `none` or `<length-percentage>`                                                                                                                                                            | `none`        | no        |
| `vertical-align`                                                                                               | `baseline`, `middle`, `sub`, `super`, `text-top`, `text-bottom`, `top`, `center`, `bottom`, or `<length-percentage>`                                                                       | `baseline`    | no        |
| `overflow-x`, `overflow-y`                                                                                     | `visible`, `hidden`, `auto`, `scroll`                                                                                                                                                      | `visible`     | no        |
| `clip`                                                                                                         | `auto`, `none`, `always`, or `<number>`                                                                                                                                                    | `auto`        | no        |
| `visibility`                                                                                                   | `visible`, `hidden`                                                                                                                                                                        | `visible`     | no        |
| `row-gap`, `column-gap`                                                                                        | `<length-percentage>`                                                                                                                                                                      | `0px`         | no        |

Important differences from browser CSS:

- There is no `border-style` property. Border shorthands contain width and color only.
- `background` only expands to `background-color`; browser background-image/position/repeat syntax is not part of this shorthand.
- There is no Grid property surface.
- `visibility: collapse` is not registered.
- `order` is not registered.

### Color, text, and fonts

| Property           | Accepted value                                            | Initial       | Inherited |
| ------------------ | --------------------------------------------------------- | ------------- | --------- |
| `background-color` | `<color>`                                                 | `transparent` | no        |
| `color`            | `<color>`                                                 | `white`       | yes       |
| `caret-color`      | `auto` or `<color>`                                       | `auto`        | yes       |
| `image-color`      | `<color>`                                                 | `white`       | no        |
| `opacity`          | `<number>`                                                | `1`           | yes       |
| `line-height`      | `<number>`, `<length-percentage>`, or compatible `<math>` | `1.2`         | yes       |
| `font-family`      | `<string>`                                                | empty         | yes       |
| `font-style`       | `normal`, `italic`                                        | `normal`      | yes       |
| `font-weight`      | `normal` (=400), `bold` (=700), or `<number>`             | `normal`      | yes       |
| `font-size`        | `<length-percentage>` or compatible `<math>`              | `12px`        | yes       |
| `font-kerning`     | `auto`, `normal`, `none`                                  | `auto`        | yes       |
| `letter-spacing`   | `normal` or `<length>`                                    | `normal`      | yes       |
| `text-align`       | `left`, `right`, `center`, `justify`                      | `left`        | yes       |
| `text-decoration`  | `none`, `underline`, `overline`, `line-through`           | `none`        | yes       |
| `text-transform`   | `none`, `capitalize`, `uppercase`, `lowercase`            | `none`        | yes       |
| `white-space`      | `normal`, `pre`, `nowrap`, `pre-wrap`, `pre-line`         | `normal`      | yes       |
| `word-break`       | `normal`, `break-all`, `break-word`                       | `normal`      | yes       |
| `text-overflow`    | `clip`, `ellipsis`, or `<string>`                         | `clip`        | no        |

`text-overflow` is not registered as inherited even though RmlUi propagates its effect into descendants where needed for text layout. Conversely, `opacity` is registered as inherited in this RmlUi profile, unlike browser CSS; do not assume browser opacity inheritance semantics.

### Interaction and RmlUi navigation

| Property                                      | Accepted value                                                        | Initial | Inherited |
| --------------------------------------------- | --------------------------------------------------------------------- | ------- | --------- |
| `cursor`                                      | `<string>`                                                            | empty   | yes       |
| `drag`                                        | `none`, `drag`, `drag-drop`, `block`, `clone`                         | `none`  | no        |
| `tab-index`                                   | `none`, `auto`                                                        | `none`  | no        |
| `focus`                                       | `none`, `auto`                                                        | `auto`  | yes       |
| `nav-up`, `nav-right`, `nav-down`, `nav-left` | `none`, `auto`, `horizontal`, `vertical`, `tree-order`, or `<string>` | `none`  | no        |
| `scrollbar-margin`                            | `<length>`                                                            | `0`     | no        |
| `overscroll-behavior`                         | `auto`, `contain`                                                     | `auto`  | no        |
| `pointer-events`                              | `none`, `auto`                                                        | `auto`  | yes       |

The `drag`, `focus`, `tab-index`, and `nav-*` properties are RmlUi facilities. Do not replace them with unrelated browser APIs.

### Flexbox

| Property          | Accepted value                                                                                 | Initial      | Inherited |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------ | --------- |
| `align-content`   | `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`, `stretch` | `stretch`    | no        |
| `align-items`     | `flex-start`, `flex-end`, `center`, `baseline`, `stretch`                                      | `stretch`    | no        |
| `align-self`      | `auto`, `flex-start`, `flex-end`, `center`, `baseline`, `stretch`                              | `auto`       | no        |
| `flex-basis`      | `auto` or `<length-percentage>`                                                                | `auto`       | no        |
| `flex-direction`  | `row`, `row-reverse`, `column`, `column-reverse`                                               | `row`        | no        |
| `flex-grow`       | `<number>`                                                                                     | `0`          | no        |
| `flex-shrink`     | `<number>`                                                                                     | `1`          | no        |
| `flex-wrap`       | `nowrap`, `wrap`, `wrap-reverse`                                                               | `nowrap`     | no        |
| `justify-content` | `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`            | `flex-start` | no        |

Do not use `order`, `flex-basis: content`, or `visibility: collapse`; they are not part of this profile. `inline-flex` is supported but RmlUi requires a definite non-`auto` width for it to participate correctly.

Pinned source overrides the moving upstream property index. For example, the current online RmlUi property index lists `space-around` for `align-items` and `align-self`, but NovelTea's pinned `StyleSheetSpecification.cpp` does not register that value for either property. The closed vocabularies in the table above are authoritative for NovelTea.

### Transforms, animation, and visual effects

| Property               | Accepted value                                      | Initial | Inherited |
| ---------------------- | --------------------------------------------------- | ------- | --------- |
| `perspective`          | `none` or `<length>`                                | `none`  | no        |
| `perspective-origin-x` | `left`, `center`, `right`, or `<length-percentage>` | `50%`   | no        |
| `perspective-origin-y` | `top`, `center`, `bottom`, or `<length-percentage>` | `50%`   | no        |
| `transform`            | `none` or supported transform functions             | `none`  | no        |
| `transform-origin-x`   | `left`, `center`, `right`, or `<length-percentage>` | `50%`   | no        |
| `transform-origin-y`   | `top`, `center`, `bottom`, or `<length-percentage>` | `50%`   | no        |
| `transform-origin-z`   | `<length>`                                          | `0`     | no        |
| `transition`           | RmlUi transition grammar or `none`                  | `none`  | no        |
| `animation`            | RmlUi animation grammar or `none`                   | `none`  | no        |
| `decorator`            | decorator list/declaration                          | empty   | no        |
| `mask-image`           | decorator grammar                                   | empty   | no        |
| `font-effect`          | font-effect list/declaration                        | empty   | yes       |
| `filter`               | filter-function list                                | empty   | no        |
| `backdrop-filter`      | filter-function list                                | empty   | no        |
| `box-shadow`           | RmlUi box-shadow grammar or `none`                  | `none`  | no        |
| `fill-image`           | `<string>`                                          | empty   | no        |

Supported transform functions in the pinned parser are exactly:

`matrix`, `matrix3d`, `translateX`, `translateY`, `translateZ`, `translate`, `translate3d`, `scaleX`, `scaleY`, `scaleZ`, `scale`, `scale3d`, `rotateX`, `rotateY`, `rotateZ`, `rotate`, `rotate3d`, `skewX`, `skewY`, and `skew`.

Built-in filter names are:

`hue-rotate`, `brightness`, `contrast`, `grayscale`, `invert`, `opacity`, `saturate`, `sepia`, `blur`, and `drop-shadow`.

Built-in font-effect names are:

`blur`, `glow`, `outline`, and `shadow`.

Built-in decorator names/types are:

`text`, `tiled-horizontal`, `tiled-vertical`, `tiled-box`, `image`, `ninepatch`, `shader`, `gradient`, `horizontal-gradient`, `vertical-gradient`, `linear-gradient`, `repeating-linear-gradient`, `radial-gradient`, `repeating-radial-gradient`, `conic-gradient`, and `repeating-conic-gradient`.

Some effects depend on renderer features. NovelTea's authored-source contract is still the RCSS grammar above; if an existing NovelTea Layout does not demonstrate a renderer-dependent effect, validate it in the target preview/runtime rather than assuming browser rendering behavior.

### Registered internal internationalization properties

These are registered by RmlUi but are internal-facing. Do not author them unless a NovelTea/RmlUi contract specifically requires them.

| Property           | Accepted value       | Initial | Inherited |
| ------------------ | -------------------- | ------- | --------- |
| `-rmlui-language`  | `<string>`           | empty   | yes       |
| `-rmlui-direction` | `auto`, `ltr`, `rtl` | `auto`  | yes       |

## Complete shorthand surface

NovelTea's pinned RmlUi build registers these 20 built-in shorthands:

| Shorthand                                                    | Expands to / special behavior                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `margin`                                                     | `margin-top`, `margin-right`, `margin-bottom`, `margin-left`; 1-4 value box replication                                        |
| `padding`                                                    | `padding-top`, `padding-right`, `padding-bottom`, `padding-left`; 1-4 value box replication                                    |
| `border-width`                                               | four border width sides; 1-4 value box replication                                                                             |
| `border-color`                                               | four border color sides; 1-4 value box replication                                                                             |
| `border-top`, `border-right`, `border-bottom`, `border-left` | edge width + edge color; no border-style slot                                                                                  |
| `border`                                                     | recursive edge shorthand over width + color only                                                                               |
| `border-radius`                                              | four corner radii; 1-4 value box replication                                                                                   |
| `inset`                                                      | `top`, `right`, `bottom`, `left`; 1-4 value box replication                                                                    |
| `overflow`                                                   | `overflow-x`, `overflow-y`                                                                                                     |
| `background`                                                 | `background-color` only                                                                                                        |
| `font`                                                       | `font-style`, `font-weight`, `font-size`, `font-family`                                                                        |
| `gap`                                                        | `row-gap`, `column-gap`                                                                                                        |
| `nav`                                                        | `nav-up`, `nav-right`, `nav-down`, `nav-left`; 1-4 value box replication                                                       |
| `perspective-origin`                                         | x + y origin                                                                                                                   |
| `transform-origin`                                           | x + y + z origin                                                                                                               |
| `flex`                                                       | `flex-grow`, `flex-shrink`, `flex-basis`; `none` becomes `0 0 auto`; omitted slots use the shorthand-specific defaults `1 1 0` |
| `flex-flow`                                                  | `flex-direction`, `flex-wrap`                                                                                                  |

The four edge border shorthands are counted separately, producing 20 registered shorthand IDs total.

Custom/extension parsers may also define local shorthands inside decorator or font-effect grammars. Those do not add general element properties.

## Math-expression support

NovelTea enables RmlUi's math-expression extension. The parser recognizes only:

- `calc(expression)`
- `min(arg, ...)`
- `max(arg, ...)`
- `clamp(min, preferred, max)`; `none` is accepted for the minimum or maximum bound

Expressions support `+`, `-`, `*`, `/`, parentheses, nesting, and compatible numeric units. `+` and `-` require whitespace on both sides. Type checking is strict: incompatible result types are rejected rather than coerced like arbitrary JavaScript arithmetic.

The parser's public numeric units are: unitless number, `%`, `px`, `dp`, `x`, `vw`, `vh`, `em`, `rem`, `in`, `cm`, `mm`, `pt`, `pc`, `deg`, and `rad`. A property still accepts only the subset appropriate to that property's parser; for example `width` accepts length/percentage results, while transforms may accept angles or numbers depending on the function argument.

Do not use newer browser math functions such as `round()`, `mod()`, `rem()`, `sin()`, `cos()`, `tan()`, `pow()`, or `sqrt()`.

## Custom properties and `var()`

Property names beginning with `--` are accepted as custom properties. Their source text is preserved and can be substituted through `var()`. They participate in the RmlUi cascade/inheritance model.

Treat them as substitution tokens, not as a browser Houdini/property-registration system. There is no authored `@property` contract here, and custom properties themselves are not animation targets.

## At-rules and RCSS-only facilities

The pinned RCSS authoring surface includes the ordinary style-rule syntax plus these important at-rules/facilities:

- `@media`: features `width`, `height`, `aspect-ratio`, `resolution`, `orientation`, and RmlUi-specific `theme`; range features support `min-`/`max-`; logical operators are `and` and `not`. Do not use nested `@media`, nested condition groups, `or`, or CSS Level 4 comparison syntax.
- `@keyframes`: used by the `animation` property.
- `@decorator`: names reusable RmlUi decorators.
- `@spritesheet`: defines sprite rectangles and optional resolution metadata for image reuse.

RmlUi decorators replace many browser `background-image` use cases. Sprite names are available across the document's loaded style sheets; later definitions can replace earlier ones.

## Selectors: exact high-risk constraints

The normal RmlUi selector surface includes universal, type, class, ID, attribute, descendant, child, adjacent-sibling, general-sibling, `:not(...)`, structural `:nth-*`, first/last/only/empty selectors, and supported state pseudo-classes. Pseudo-elements such as `::before` and `::after` are not part of the profile.

Do not apply browser target-only reasoning to `:hover`, `:active`, `:focus`, or `:focus-visible`: RmlUi propagates these states backward through ancestors. See `.noveltea/agent/docs/RMLUI.md` for the behavioral implications.

## NovelTea resource rules still apply

RCSS syntax support does not imply resource availability. An image, font, stylesheet, template, or script referenced by an authored Layout must also be present in the appropriate NovelTea Layout dependency set so focused preview and package export can close the resource graph. Use the mounted/relative source URL in RML/RCSS; dependency declarations do not rewrite Asset IDs into source URLs.

The engine-wide base-RCSS/default-style bug is separate from this compatibility profile. Do not encode workarounds for that issue into this reference.
