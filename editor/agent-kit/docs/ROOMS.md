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

Use this when the sprite represents an object that can participate in interaction. This is one logical authoring operation involving a reusable Interactable Definition, one exact declared Interactable Instance in `project.json`, and Room presentation entries. The Definition does not own live Location/state.

Create `records/interactables/key.json`:

```json
{
  "id": "key",
  "label": "Key",
  "data": {
    "kind": "interactable",
    "displayName": "Key",
    "stackable": false,
    "stackLimit": null,
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
    "features": [],
    "inventories": []
  }
}
```

Then add one exact declared Instance to the top-level `interactableInstances` object in `project.json`:

```json
"interactableInstances": {
  "key-instance": {
    "id": "key-instance",
    "definition": { "$ref": { "collection": "interactables", "id": "key" } },
    "location": { "kind": "room", "room": { "$ref": { "collection": "rooms", "id": "foyer" } } },
    "enabled": true,
    "visible": true,
    "quantity": 1,
    "traits": { "add": [], "remove": [] },
    "localProperties": [],
    "featureOverrides": []
  }
}
```

That registry entry is the gameplay identity. Its `location` is authoritative; the Room entries below only provide presentation geometry/occurrence identity. Replace `foyer` with the actual owning Room ID.

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

And add a Room-local occurrence to `data.interactables`:

```json
{
  "id": "key-occurrence",
  "interactable": { "$ref": { "registry": "interactableInstances", "id": "key-instance" } },
  "condition": { "kind": "always" },
  "placementId": "key-placement",
  "visible": true,
  "order": 0
}
```

The Definition owns the sprite; the exact Instance owns semantic state; the Room occurrence owns only
Room-local presentation linkage. Do not add a duplicate Prop just to display the same sprite, and do
not copy Instance state into the Room occurrence.

The default sprite-alpha Hotspot targets the owning Interactable. Gameplay behavior is defined by
ordinary Interaction rules/Verbs for that Interactable subject; the Hotspot does not own a Verb.
Interactable Hotspot presentation has three modes: `none`, `sprite-alpha`, and `custom`. Use `none`
for an intentionally non-clickable Interactable; it does not require a sprite. Use `sprite-alpha`
when the sprite alpha should define the hit area; this mode requires an image sprite. Use `custom`
for authored rectangular Hotspots; non-empty custom Hotspots also require an image sprite.

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

## Room navigation rejection and lifecycle

Room navigation uses the shared Condition and Gameplay Command contracts. `lifecycle.canLeave` and `lifecycle.canEnter` are pure Conditions. `beforeLeave`/`beforeEnter` run before the Room switch and therefore admit only immediate commands; `afterLeave`/`afterEnter` run after commit and may use the Flow-capable command set.

Expected Exploration rejection is authored behavior, not a failed Room switch. A false source `canLeave` runs the source Room's `lifecycle.onLeaveRejected`. A false selected Exit `condition` runs that Exit's `onRejected` commands when present, otherwise it falls back to the source `onLeaveRejected`. A false target `canEnter` runs the target Room's `lifecycle.onEnterRejected`. The Current Room remains the source while rejection commands run, and those programs may hand off to a Scene or Dialogue. Directed Scene/Lua Room changes remain authoritative even when an exploration guard would be false.

Use these shared lifecycle fields rather than inventing directional rejection hooks or putting rejection behavior in a Hotspot.

## Validation workflow

For changes that create several related objects, finish the complete edit first and then run:

```sh
noveltea validate
```

Do not interpret successful structural validation as visual confirmation. Run relevant authored tests when they exist and can verify the requested behavior through the CLI.
