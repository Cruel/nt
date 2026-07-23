# Asset Memory Profiles

## Scope

Platform export profiles resolve an asset-memory preset into four evictable runtime ceilings and a
Warm-prefetch allowance:

- prepared CPU bytes;
- GPU bytes;
- decoded/streaming audio bytes;
- temporary preparation bytes; and
- the percentage of prepared CPU, GPU, and audio ceilings that speculative Warm entries may occupy.

Source-entry residency uses the prepared-CPU ceiling. The immutable compressed Web package backing is
not part of this evictable pool and remains resident once downloaded. Current and high-water values
are residency-accounting values, not process RSS or driver-reported allocation totals.

## Measurement Evidence

The Phase 6D baseline was measured on the concrete Phase 6B/6C representations and repository
fixtures on 2026-07-23. The deterministic measurement inputs are:

| Representative unit | Resident or transient bytes | Derivation |
| --- | ---: | --- |
| 3840 x 2160 RGBA8 texture with full mip chain | 44,236,220 GPU | Sum of the finalized mip levels produced by `TexturePreparationTask` |
| 1920 x 1080 RGBA8 texture with full mip chain | 11,058,620 GPU | Same finalized mip calculation |
| 2560 x 1440 RGBA8 texture with full mip chain | 19,660,652 GPU | Same finalized mip calculation |
| 1024 x 1024 RGBA8 texture with full mip chain | 5,592,404 GPU | Same finalized mip calculation |
| 30 seconds decoded at 48 kHz, stereo, float32 | 11,520,000 audio | Exact decoded-cache representation |
| One resident long-form stream source | 768,000 audio | Two one-second 48 kHz stereo float32 decode pages |
| Sandbox long-form MP3 | 1,034,031 source | `apps/sandbox/assets/audio/cello-loop.mp3` |
| Sandbox notification MP3 | 36,864 source | `apps/sandbox/assets/audio/notification.mp3` |
| Sandbox UI font source | 139,764 source/transient | `apps/sandbox/assets/rmlui/LiberationSans.ttf` |

The texture figures are finalized residency, not estimates. Temporary texture admission remains based
on the loader's conservative source-plus-decode/mipmap estimate, so an unusually compressed mandatory
texture may be admitted serially over the temporary ceiling. That is intentional: ceilings govern
evictable concurrency and speculative work, never mandatory correctness.

Preset capacities were selected by rounding representative-unit envelopes to MiB boundaries. Web Low
holds one 4K background plus smaller UI textures and one decoded 30-second clip; Android Low holds two
4K-class backgrounds and two decoded clips; Desktop Low holds two 4K-class backgrounds with additional
render-target/material room. Balanced doubles the principal ceilings, and High doubles Balanced.
Warm percentages leave progressively larger mandatory headroom on constrained targets.

The Warm percentages are also fixture-derived. Per-domain percentage rounding produces these minimum
representative GPU envelopes: Desktop Low admits one 2560 x 1440 texture, Balanced admits one 4K plus
one 1080p texture, and High admits four 4K textures; Android Low admits one 1080p texture, Balanced one
4K texture, and High three 4K textures; Web Low admits one 1024 x 1024 texture, Balanced one 2560 x
1440 texture, and High one 4K plus one 1080p texture. The independent audio allowances admit at least
two long-form stream page sets in every preset, a 30-second decoded representative clip from Android
Balanced/Desktop Balanced/Web High upward, and multiple such clips in each High native profile. These
are capacity targets for speculative residency, not promises that all listed units will be requested
simultaneously.

## Resolved Defaults

All values below are bytes except the final percentage.

| Target | Preset | Prepared CPU | GPU | Audio | Temporary | Warm allowance |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Desktop | Low | 67,108,864 | 134,217,728 | 33,554,432 | 33,554,432 | 20% |
| Desktop | Balanced | 134,217,728 | 268,435,456 | 67,108,864 | 67,108,864 | 30% |
| Desktop | High | 268,435,456 | 536,870,912 | 134,217,728 | 134,217,728 | 40% |
| Android | Low | 50,331,648 | 100,663,296 | 25,165,824 | 25,165,824 | 15% |
| Android | Balanced | 100,663,296 | 201,326,592 | 50,331,648 | 50,331,648 | 25% |
| Android | High | 201,326,592 | 402,653,184 | 100,663,296 | 100,663,296 | 35% |
| Web | Low | 33,554,432 | 67,108,864 | 16,777,216 | 16,777,216 | 10% |
| Web | Balanced | 67,108,864 | 134,217,728 | 33,554,432 | 33,554,432 | 20% |
| Web | High | 134,217,728 | 268,435,456 | 67,108,864 | 67,108,864 | 30% |

Windows, Linux, and macOS use the Desktop row. Missing profile data resolves to the target's Balanced
row. A Custom profile inherits omitted fields from that same Balanced row.

## Custom Validation

Custom byte values are positive safe integers representable by both the editor JSON boundary and the
runtime. `temporaryBytes` is at least 1 MiB. `prefetchAllowancePercent` is an integer from 0 through
100. Diagnostics identify the exact offending field. The exported `player.json` contains the fully
resolved values rather than nullable or implicit limits.

## Runtime Semantics

Demand admission evicts eligible Cold entries before Warm entries and may remain over budget when all
remaining residency is pinned or one mandatory asset is oversized. Prefetch admission is rejected if
either a domain ceiling or the Warm allowance would be exceeded. Releasing the last pin re-enforces
both constraints. The same policy object and residency implementation are used by cooperative and
threaded executors.

`AssetResidencyManager` emits `MemoryPolicyResolved` telemetry when a sink is attached. Profiler
snapshots retain that resolved policy beside current and high-water accounting. The player also writes
the resolved target, preset, byte ceilings, and Warm percentage to its startup log.

