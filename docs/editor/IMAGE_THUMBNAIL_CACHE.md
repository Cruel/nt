# Image Thumbnail Cache

## Purpose and scope

The editor's image-thumbnail service produces bounded, immutable WebP derivatives for direct image
assets used in compact editor UI. It owns Assets-page cards, Command Palette image results, and
search-selector image results and selected-image summaries. It does not own engine-rendered entity
previews such as material, layout, room, scene, or character snapshots; those remain a separate
future rendered-preview pipeline.

Generated thumbnails are editor cache data only. They never enter project JSON, recovery state,
compiled projects, or runtime packages, and thumbnail bytes or Base64 data URLs never cross the
thumbnail IPC boundary.

## Cache root and identity

The central cache-path helper resolves the platform cache directory, appends `noveltea-editor`, and
stores image derivatives under `thumbnails/image-v1`. On Linux this follows `XDG_CACHE_HOME` when
set, otherwise `~/.cache`; corresponding platform cache conventions are used elsewhere. The cache is
outside Electron `userData` and outside every project directory.

Each derivative is addressed by a SHA-256 key derived from source content, audited intrinsic
metadata, the selected tier, and generator policy/version identity. Paths, asset IDs, and labels are
not cache identity. Rename or move of unchanged content therefore reuses a derivative. A same-path
file replacement remains the previously published project revision until explicit reimport updates
the asset content hash; generation with a supplied hash fails with `source_revision_mismatch` when
the source bytes do not match it.

Published files are immutable and written atomically. Concurrent identical requests within one main
process share a generation task, and separate editor processes safely converge on the same immutable
path. Cache clearing cannot prevent another already-running editor instance from repopulating the
shared cache afterward.

## Profiles and request semantics

The centrally defined physical long-edge profiles are:

| Profile | Long edge |
| --- | ---: |
| `compact` | 192 px |
| `card` | 384 px |
| `large` | 1024 px |

Callers may request a named profile or a minimum physical slot with `cover` or `contain` fit. Slot
requests account for source aspect ratio, EXIF orientation, and device-pixel ratio (clamped to 1–4)
before selecting the smallest sufficient profile. Requests larger than `large` use `large` and report
that the tier limited the result. Raster sources are never enlarged beyond their intrinsic
resolution; SVG sources may be rasterized at any selected tier.

A successful IPC response contains only metadata and a `noveltea-thumbnail://` URL. Protocol URLs
include the current cache epoch and are constrained to the image cache namespace. Successful
responses use `image/webp`, immutable one-year caching, cross-origin resource permission, and MIME
sniffing protection. Missing or invalid protocol paths are non-cacheable and cannot traverse outside
the cache root.

## Generation behavior

PNG, JPEG, WebP, GIF, and SVG are supported V1 inputs. Animated GIF, animated PNG content under a
`.png` name, and animated WebP are decoded with animation disabled and produce a static first-frame
thumbnail. BMP is deliberately unsupported in V1 and falls back symbolically.

Output is lossless WebP converted to sRGB. Alpha is preserved; thumbnail UI renders transparent
images over its checkerboard rather than flattening them. EXIF orientation is applied before output
dimensions are finalized.

SVGs with explicit dimensions or only a `viewBox` receive bounded transparent raster output. SVG
input fails closed when it contains scripts, entities/DOCTYPE declarations, stylesheets, base URLs,
or external resources. Raster decoding is bounded to 268,402,689 input pixels. Generation has a
30-second deadline, and the bounded scheduler admits at most two Sharp generation jobs at once.
Interactive work has priority over queued prewarm work.

## Lifecycle and prewarming

Project open publishes the editor document without waiting for thumbnail work. The renderer submits
compact prewarm batches for admitted image revisions, replaces ownership when the active project
generation changes, and incrementally schedules imported, generated, and explicitly reimported
revisions. Prewarming generates cache files only; it does not create browser `Image` objects or hold
decoded thumbnails in renderer memory.

Assets-page cards request `card` derivatives only after the shared visibility service admits them.
Command Palette and selector surfaces request eagerly when their result rows are rendered. The
renderer suppresses stale asynchronous results and re-requests mounted visible thumbnails after a
cache-epoch change. Offscreen cards wait until they become visible.

External changes to an already tracked source file do not silently revise the project record.
Explicit reimport owns content-hash publication and therefore thumbnail invalidation.

## Errors and fallback

The request contract reports stable error codes:

`invalid_request`, `unsafe_source_path`, `source_missing`, `source_revision_mismatch`,
`source_metadata_invalid`, `unsupported_image`, `svg_external_resource`, `decode_failed`,
`encode_failed`, `generation_timeout`, `cache_write_failed`, and `cache_cleared`.

Cache-clear, timeout, and cache-write failures are retryable. Missing, corrupt, unsafe, unsupported,
or otherwise failed images use stable symbolic fallback UI and do not break the containing surface.

## Clear Editor Cache

Workspace Settings exposes **Clear Editor Cache** with confirmation, busy state, and completion or
failure feedback. The operation removes only the recreatable central editor cache root, increments
the cache epoch, cancels or invalidates work owned by the clearing main process, and notifies
renderers. It is independent from Reset All Settings. V1 intentionally has no age/size eviction:
cache use is append-only across source revisions until this explicit clear action.

## Retained original-image consumers

The following production consumers intentionally continue through `resolveProjectAssetUrl` because
they require full source pixels rather than a reduced editor thumbnail:

| Consumer | Full-source purpose |
| --- | --- |
| `editors/assets/AssetPreview.tsx` | Noncompact asset detail. |
| `editors/comfyui/ImageGenerationEditor.tsx` | Image editing and source-image workflow. |
| `components/hotspots/HotspotAuthoringPanel.tsx` | Hotspot authoring and hit-region alignment. |
| `editors/rooms/RoomEditor.tsx` | Room composition and engine-preview input. |

New compact image surfaces should use `AssetImageThumbnail`; additions to the full-source list must
be deliberate and covered by the consumer-classification test.
