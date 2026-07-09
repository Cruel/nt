# Editor Translation Status

## Purpose

This document tracks editor UI translation coverage and review status. It is the
source of truth for whether a checked-in locale is source copy, reviewed human
translation, unreviewed machine translation, or a development-only pseudo-locale.

Do not treat machine-translated strings as final UI copy. They are acceptable for
implementation, layout testing, and early dogfooding, but they must be reviewed
before being considered production-quality translations.

## Status Values

- `source`: Source-language strings written directly for the editor.
- `machine-unreviewed`: Machine-generated translation that has not been reviewed
  by a fluent human reviewer.
- `human-reviewed`: Translation reviewed by a fluent human reviewer and accepted
  for release.
- `pseudo`: Development-only pseudo-localization for layout and missing-string
  checks. This is not a real language translation.

## Locale Inventory

| Locale | Display name | Role | Status | Current namespaces | Notes |
| --- | --- | --- | --- | --- | --- |
| `en-US` | English (United States) | Source language | `source` | `common`, `menu`, `settings`, `workspace` | Canonical source copy for translated resources. |
| `pt-BR` | Portuguese (Brazil) | Real translation | `machine-unreviewed` | `common`, `menu`, `settings`, `workspace` | Added as the only Portuguese variant for now. Must be reviewed before release-quality claims. |
| `pseudo` | Pseudo-localized | Development/test locale | `pseudo` | `common`, `menu`, `settings`, `workspace` | Bracketed pseudo strings used to verify live language switching and layout tolerance. |

## Namespace Coverage

| Namespace | Scope | `en-US` | `pt-BR` | `pseudo` |
| --- | --- | --- | --- | --- |
| `common` | Shared actions, booleans, generic field labels, loading text, unsaved project label | Source | Machine-unreviewed | Pseudo |
| `menu` | Custom renderer application menu, window controls, About dialog labels | Source | Machine-unreviewed | Pseudo |
| `settings` | Editor settings page, theme/language/window/workspace cards, code editor theme dialog | Source | Machine-unreviewed | Pseudo |
| `workspace` | Sidebar utility labels, command palette strings, bottom panel labels, basic empty states, Project Settings ComfyUI workflow management | Source | Machine-unreviewed | Pseudo |

## Review Checklist

Before changing a locale status from `machine-unreviewed` to `human-reviewed`, a
reviewer should check:

1. Terminology consistency for editor concepts such as project, entity, asset,
   layout, shader, package export, preview, and workspace.
2. Tone consistency with the English source: concise editor UI language, not
   marketing copy.
3. Accelerator/shortcut-adjacent labels still make sense with preserved keyboard
   shortcuts.
4. String interpolation preserves variables exactly, including `{{count}}`,
   `{{language}}`, `{{current}}`, and `{{total}}`.
5. Plural forms are correct where i18next plural keys are used.
6. Buttons, menus, dialogs, and bottom panel tabs fit at normal editor widths.
7. Command palette search terms include localized search aliases and any useful
   English aliases intentionally kept for discoverability.

## Implementation Conventions

- Stable user-facing editor text belongs in `editor/src/renderer/i18n/locales/`,
  with `en-US` as the source copy.
- Dynamic values should use whole-message interpolation such as
  `{{projectName}}`, `{{path}}`, and `{{count}}`; do not build translated
  messages by concatenating fragments in component code.
- Count-based text should use i18next plural suffixes such as `_one` and
  `_other` instead of ad hoc ternaries.
- Locale-sensitive dates, times, relative time, numbers, percentages, and file
  sizes should use `editor/src/renderer/i18n/formatting.ts` helpers.
- `editor/src/renderer/test/i18n-resource-parity.test.ts` guards missing keys,
  dangling keys, interpolation placeholder drift, and incomplete plural pairs.

## Change Log

| Date | Change | Status impact |
| --- | --- | --- |
| 2026-07-04 | Added `en-US` source resources and `pseudo` development resources for the first editor localization slice. | `en-US`: source; `pseudo`: pseudo. |
| 2026-07-04 | Added `pt-BR` resources for the same initial namespaces using machine translation. | `pt-BR`: machine-unreviewed. |
| 2026-07-08 | Added Project Settings ComfyUI workflow management and import/repair dialog copy to the `workspace` namespace. | `pt-BR` remains machine-unreviewed. |
