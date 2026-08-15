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
stores image derivatives under `thumbnails/image-v2`. On Linux this follows `XDG_CACHE_HOME` when
set, otherwise `~/.cache`; corresponding platform cache conventions are used elsewhere. The cache is
outside Electron `userData` and outside every project directory.

Startup removes the retired `thumbnails/image-v1` subtree. V2 never probes or reuses V1 files.

Each derivative is addressed by a SHA-256 key derived from source content, audited intrinsic
metadata, the selected presentation profile, image sampling mode, and generator policy/version
identity. Paths, asset IDs, and labels are
not cache identity. Rename or move of unchanged content therefore reuses a derivative. A same-path
file replacement remains the previously published project revision until explicit reimport updates
the asset content hash; generation with a supplied hash fails with `source_revision_mismatch` when
the source bytes do not match it.

Published files are immutable and written atomically. Concurrent identical requests within one main
process share a generation task, and separate editor processes safely converge on the same immutable
path. Cache clearing cannot prevent another already-running editor instance from repopulating the
shared cache afterward.

## Profiles and request semantics

The centrally defined physical output profiles match the editor surfaces that consume them:

| Profile | Output | Current consumers |
| --- | ---: | --- |
| `list` | 96 × 72 px | Command Palette and ordinary image selectors |
| `wide` | 160 × 96 px | Room background selector and selected-background summary |
| `card` | 320 × 320 px | Assets-page image cards |

Every profile uses centered `cover` output, so the cache does not preserve and encode source pixels
that the fixed presentation will crop away in CSS. Consumers request a named profile directly; the
renderer does not create arbitrary per-slot cache dimensions. Raster sources are never enlarged
beyond their intrinsic resolution, so an undersized source can produce a smaller result. SVG sources
are rasterized at the exact selected profile dimensions.

A successful IPC response contains only metadata and a `noveltea-thumbnail://` URL. Protocol URLs
include the current cache epoch and are constrained to the image cache namespace. Successful
responses use `image/webp`, immutable one-year caching, cross-origin resource permission, and MIME
sniffing protection. Missing or invalid protocol paths are non-cacheable and cannot traverse outside
the cache root.

## Generation behavior

PNG, JPEG, WebP, GIF, and SVG are supported V1 inputs. Animated GIF, animated PNG content under a
`.png` name, and animated WebP are decoded with animation disabled and produce a static first-frame
thumbnail. BMP is deliberately unsupported in V1 and falls back symbolically.

Output is WebP converted to sRGB. Ordinary images use quality 85, alpha quality 100, smart
subsampling, and effort 4. Alpha is preserved; thumbnail UI renders transparent images over its
checkerboard rather than flattening them. Assets whose project sampling mode is `nearest` use
lossless WebP and nearest-neighbor resize so pixel art remains exact. EXIF orientation is applied
before crop and resize.

SVGs with explicit dimensions or only a `viewBox` receive bounded transparent raster output. SVG
input fails closed when it contains scripts, entities/DOCTYPE declarations, stylesheets, base URLs,
or external resources. Raster decoding is bounded to 268,402,689 input pixels. Generation has a
30-second deadline, and the bounded scheduler admits at most two Sharp generation jobs at once.
Interactive work has priority over queued prewarm work.

## Lifecycle and prewarming

Project open publishes the editor document without waiting for thumbnail work. Thumbnail and prewarm
requests carry the active `projectSessionId`, Asset id, Project-relative source identity, and bounded
presentation metadata. Main resolves the Asset from the session-owned admitted snapshot rather than
accepting a renderer Project root. It rejects stale sessions, unknown/non-image Assets, and admitted
source or revision mismatches before source bytes are read, then applies canonical-root, realpath,
regular-file, and containment checks. Intrinsic dimensions and orientation are verified against the
decoded source before publication. Authority is re-checked after asynchronous path admission.

The renderer submits `list`-profile prewarm batches for admitted image revisions, replaces ownership
when the active Project session changes, and incrementally schedules imported, generated, and
explicitly reimported revisions. Prewarming generates cache files only; it does not create browser
`Image` objects or hold decoded thumbnails in renderer memory.

Assets-page cards request `card` derivatives only after the shared visibility service admits them.
Command Palette and ordinary selector surfaces request `list`; the larger Room image selector and
selected summary request `wide`. The renderer suppresses stale asynchronous results and re-requests
mounted visible thumbnails after a cache-epoch change. Offscreen cards wait until they become
visible.

External changes to an already tracked source file do not silently revise the project record.
Explicit reimport owns content-hash publication and therefore thumbnail invalidation.

## Errors and fallback

The request contract reports stable error codes:

`invalid_request`, `stale_project_session`, `unauthorized_asset`, `unsafe_source_path`,
`source_missing`, `source_revision_mismatch`, `source_metadata_invalid`, `unsupported_image`,
`svg_external_resource`, `decode_failed`,
`encode_failed`, `generation_timeout`, `cache_write_failed`, and `cache_cleared`.

Cache-clear, timeout, and cache-write failures are retryable. Missing, corrupt, unsafe, unsupported,
or otherwise failed images use stable symbolic fallback UI and do not break the containing surface.

## Clear Editor Cache

Workspace Settings exposes **Clear Editor Cache** with confirmation, busy state, and completion or
failure feedback. The operation removes only the recreatable central editor cache root, increments
the cache epoch, cancels or invalidates work owned by the clearing main process, and notifies
renderers. It is independent from Reset All Settings. V1 intentionally has no age/size eviction:
cache use is append-only across source revisions until this explicit clear action.

## Session-scoped original Asset streaming

Full-size image and audio consumers use `resolveProjectOriginalAssetUrl(projectSessionId, assetId)`. The
renderer cannot provide a Project root, manifest path, or source path. Main resolves the admitted
Asset snapshot owned by the active Project session and returns only a `noveltea-asset://` protocol
URL.

The protocol repeats authorization for every request. It accepts only admitted image/audio Assets
under `assets/`, requires the activated canonical Project root to still resolve to itself, canonicalizes
the source target, permits symlinks only when their real target remains contained, requires a regular
file, and verifies the admitted byte size and `sha256:` revision with a bounded read before streaming.
Files larger than 128 MiB are rejected. Successful responses
stream from the verified open file with authoritative `Content-Type` and `Content-Length`,
`Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`; filesystem paths are never returned
to the renderer. Switching or closing the Project invalidates previously issued URLs.

The following production consumers intentionally use original-source streaming because they require
full source pixels or audio rather than a reduced editor thumbnail. Room composition and focused
Room preview both use the active Project session plus Asset id; focused Room resource staging fetches
the `noveltea-asset://` URL directly and never publishes a Room Asset source path to the preview host.

| Consumer | Full-source purpose |
| --- | --- |
| `editors/assets/AssetPreview.tsx` | Noncompact asset detail. |
| `editors/comfyui/ImageGenerationEditor.tsx` | Image-edit preview uses the session-scoped original URL; edit submission carries only the admitted Asset id and main performs a separate 32 MiB loopback-only upload. |
| `components/hotspots/HotspotAuthoringPanel.tsx` | Hotspot authoring and hit-region alignment; requires an admitted image Asset and uses its original-resolution protocol stream so normalized hotspot geometry is never authored against a thumbnail. |
| `editors/rooms/RoomEditor.tsx` | Room composition and engine-preview input. |

New compact image surfaces should use `AssetImageThumbnail`; additions to the full-source list must
be deliberate and covered by the consumer-classification test.
