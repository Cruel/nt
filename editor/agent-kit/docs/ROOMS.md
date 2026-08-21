# Rooms, Placements, Props, Interactables, and Hotspots

Read `.noveltea/agent/docs/AUTHORING.md` first. This document covers the common Room authoring shapes that are easy to confuse when working from schema alone.

## Placements and normalized coordinates

Room Placements and rectangular hotspots both store normalized rectangles, but they use different coordinate spaces:

- **Room Placement bounds** are normalized to the project's Room reference frame. They are independent of the Room background image's `cover`, `contain`, `stretch`, or `center` fit.
- **Room hotspot bounds** are normalized to the complete Room background source image in image/UV space.
- **Interactable custom hotspot bounds** are normalized to the complete Interactable sprite image.

For any chosen coordinate basis:

- `x = left / totalWidth`
- `y = top / totalHeight`
- `width = rectangleWidth / totalWidth`
- `height = rectangleHeight / totalHeight`

Example: a 200x100 hotspot whose top-left corner is at pixel 400,250 in a 1000x500 source image becomes `{ "x": 0.4, "y": 0.5, "width": 0.2, "height": 0.2 }`. Rectangular hotspots must satisfy `x + width <= 1` and `y + height <= 1`.

Coordinate selection is an authoring estimate. `noveltea validate` checks structural and semantic validity, not whether the placement looks visually correct. Final visual judgment belongs to the user.

## Template 1: static Room prop

Use this when an image should appear in a Room but is not an interactive object.

Add a Placement to the Room's `data.placements`:

```json
{
  "id": "lamp-placement",
  "bounds": { "x": 0.7, "y": 0.3, "width": 0.15, "height": 0.25 },
  "presentation": {
    "label": null,
    "layout": null
  }
}
```

Then add a Prop to the same Room's `data.props`:

```json
{
  "id": "lamp",
  "condition": { "kind": "always" },
  "placementId": "lamp-placement",
  "asset": { "$ref": { "collection": "assets", "id": "lamp-image" } },
  "material": null,
  "visible": true,
  "order": 0
}
```

The Prop points at the Placement by `placementId`. The image Asset itself is not a Prop.

## Template 2: sprite-backed Interactable placed in a Room

Use this when the sprite represents an object that can participate in interaction. This is one logical authoring operation involving a global Interactable record plus two Room entries.

Create `records/interactables/key.json`:

```json
{
  "id": "key",
  "label": "Key",
  "data": {
    "kind": "interactable",
    "displayName": "Key",
    "presentation": {
      "sprite": { "$ref": { "collection": "assets", "id": "key-image" } },
      "material": null,
      "hotspots": {
        "kind": "sprite-alpha",
        "hotspot": {
          "id": "primary",
          "label": "Key",
          "condition": { "kind": "always" },
          "inputOrder": 0,
          "highlight": { "kind": "default" },
          "target": { "kind": "owner" }
        }
      }
    },
    "initialState": {
      "enabled": true,
      "visible": true
    }
  }
}
```

Then add a Placement to the Room:

```json
{
  "id": "key-placement",
  "bounds": { "x": 0.42, "y": 0.62, "width": 0.08, "height": 0.08 },
  "presentation": {
    "label": null,
    "layout": null
  }
}
```

And add a Room-interactable instance to `data.interactables`:

```json
{
  "id": "key-instance",
  "interactable": { "$ref": { "collection": "interactables", "id": "key" } },
  "condition": { "kind": "always" },
  "placementId": "key-placement",
  "enabled": true,
  "visible": true,
  "order": 0
}
```

The Interactable owns the sprite. Do not add a duplicate Prop just to display the same sprite.

The default sprite-alpha Hotspot targets the owning Interactable. Gameplay behavior is defined by
ordinary Interaction rules/Verbs for that Interactable subject; the Hotspot does not own a Verb.

## Template 3: Room Feature with background Hotspot geometry

Use a Room Feature when a meaningful semantic part is visually baked into the Room background image.
The Feature owns semantic identity/state; one or more Hotspots may select it.

First add to the Room's `data.features`:

```json
{
  "id": "picture-frame",
  "label": "Picture frame",
  "traits": [],
  "properties": {}
}
```

Then add pointer geometry to `data.hotspots`:

```json
{
  "id": "picture-frame-region",
  "label": "Picture frame",
  "condition": { "kind": "always" },
  "inputOrder": 0,
  "highlight": { "kind": "default" },
  "shape": {
    "kind": "rect",
    "bounds": { "x": 0.62, "y": 0.18, "width": 0.16, "height": 0.24 }
  },
  "target": {
    "kind": "owner-feature",
    "featureId": "picture-frame"
  }
}
```

A Room Hotspot requires a background image source when it is clickable. It owns no Verb or
Interaction context. Define gameplay behavior through Interaction rules using the owner-qualified
Room Feature as the semantic subject. Multiple Hotspots may target the same Feature when one semantic
part has multiple clickable regions.

Room Hotspots can instead select an owner-local Room Exit with
`{ "kind": "exit", "exitId": "..." }`; the referenced Exit must belong to the same Room.

## Validation workflow

For changes that create several related objects, finish the complete edit first and then run:

```sh
noveltea validate
```

Do not interpret successful structural validation as visual confirmation. Run relevant authored tests when they exist and can verify the requested behavior through the CLI.
