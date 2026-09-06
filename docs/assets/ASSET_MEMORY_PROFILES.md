# Asset Memory Profiles

## Scope

Platform export profiles and the Play simulator resolve an asset-memory policy into four evictable
runtime ceilings plus three independent absolute Warm-prefetch ceilings:

- prepared CPU bytes and Warm prepared-CPU bytes;
- GPU bytes and Warm GPU bytes;
- decoded/streaming audio bytes and Warm audio bytes; and
- temporary preparation bytes.

Warm ceilings are absolute byte limits on speculative long-lived residency. They are not percentages
of the active totals. Current authoring, Play/export, runtime, telemetry, and profiler contracts carry
only the absolute ceilings. The legacy percentage field is recognized only while loading older Project
data, where it is deterministically materialized into absolute Warm bytes before strict canonical
validation or any runtime-facing policy resolution occurs.

Source-entry residency uses the prepared-CPU ceiling. The immutable compressed Web package backing is
not part of this evictable pool and remains resident once downloaded. Current and high-water values
are residency-accounting values, not process RSS or driver-reported allocation totals.

## Measurement Evidence

The baseline was measured on the production texture, material, font, and audio representations and
repository fixtures on 2026-07-23. The deterministic measurement inputs are:

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
| System UI font source | 139,764 source/transient | `engine/assets/system/fonts/LiberationSans.ttf` |

The texture figures are finalized residency, not estimates. Temporary texture admission remains based
on the loader's conservative source-plus-decode/mipmap estimate. A single preparation whose own peak
working set exceeds the temporary ceiling may be admitted serially for either Demand or Prefetch; the
ceiling limits concurrent transient work rather than making a large asset categorically ineligible for
speculation. If an individually oversized prefetch encounters active temporary work, it remains queued
until it can run exclusively. Ordinary speculative preparation that fits individually but would exceed
the aggregate ceiling because other preparation is active may still be rejected.

Prepared-CPU, audio, and temporary-preparation capacities remain the fixture-derived envelopes selected
by rounding representative units to MiB boundaries. Their Warm CPU/audio ceilings also preserve the
previous effective percentage-derived byte capacities exactly. Temporary preparation remains a
concurrency/transient ceiling; it is intentionally not enlarged to match any long-lived Warm cache, and
an asset larger than that ceiling is serialized rather than excluded from prefetch solely because of
its individual preparation peak.

GPU Warm capacity is now an independently selected absolute ceiling sized for multi-Room visual
speculation: Desktop uses 512 MiB / 1 GiB / 2 GiB for Low / Balanced / High, while Android and Web use
256 MiB / 512 MiB / 1 GiB. At the measured 44,236,220-byte 4K RGBA8+mips unit, those ceilings can hold
roughly 12 / 24 / 48 such textures on Desktop and 6 / 12 / 24 on Android/Web before smaller assets and
other residency costs are considered.

The total GPU residency envelopes add the previous full GPU residency ceiling to each new Warm GPU
ceiling. This deliberately preserves the formerly measured GPU pool as non-Warm headroom for pinned or
current presentation plus ordinary Cold-cache reuse instead of inventing a new cross-domain multiplier:
Desktop keeps 128 / 256 / 512 MiB of such headroom, Android keeps 96 / 192 / 384 MiB, and Web keeps
64 / 128 / 256 MiB. Consequently the resolved GPU totals are 640 MiB / 1.25 GiB / 2.5 GiB on Desktop,
352 MiB / 704 MiB / 1.375 GiB on Android, and 320 MiB / 640 MiB / 1.25 GiB on Web.

The historical percentages remain measurement provenance only. During legacy Project load, an explicit
percentage-authored custom policy is converted using the totals that applied to that policy. GPU
migration retains the pre-recalibration built-in denominator (Desktop 128 / 256 / 512 MiB, Android
96 / 192 / 384 MiB, Web 64 / 128 / 256 MiB for Low / Balanced / High) unless the policy explicitly
overrides its GPU total. This preserves the historical effective Warm GPU bytes even though current
built-in total residency uses the recalibrated envelope. If one legacy named policy is referenced by
target families whose equivalent absolute values differ, loading splits that policy deterministically
and rewrites those profile references so each target keeps its prior effective capacity. The
independent CPU/audio ceilings continue to admit at least two long-form stream page sets in every
preset, a 30-second decoded representative clip from Android Balanced/Desktop Balanced/Web High
upward, and multiple such clips in each High native profile. These are capacity ceilings, not
reservations or promises that all listed units will be requested simultaneously.

## Resolved Defaults

All values below are bytes. Built-in Warm values are fixed absolute ceilings.

| Target | Preset | Prepared CPU | GPU | Audio | Temporary | Warm CPU | Warm GPU | Warm audio |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop | Low | 67,108,864 | 671,088,640 | 33,554,432 | 33,554,432 | 13,421,772 | 536,870,912 | 6,710,886 |
| Desktop | Balanced | 134,217,728 | 1,342,177,280 | 67,108,864 | 67,108,864 | 40,265,318 | 1,073,741,824 | 20,132,659 |
| Desktop | High | 268,435,456 | 2,684,354,560 | 134,217,728 | 134,217,728 | 107,374,182 | 2,147,483,648 | 53,687,091 |
| Android | Low | 50,331,648 | 369,098,752 | 25,165,824 | 25,165,824 | 7,549,747 | 268,435,456 | 3,774,873 |
| Android | Balanced | 100,663,296 | 738,197,504 | 50,331,648 | 50,331,648 | 25,165,824 | 536,870,912 | 12,582,912 |
| Android | High | 201,326,592 | 1,476,395,008 | 100,663,296 | 100,663,296 | 70,464,307 | 1,073,741,824 | 35,232,153 |
| Web | Low | 33,554,432 | 335,544,320 | 16,777,216 | 16,777,216 | 3,355,443 | 268,435,456 | 1,677,721 |
| Web | Balanced | 67,108,864 | 671,088,640 | 33,554,432 | 33,554,432 | 13,421,772 | 536,870,912 | 6,710,886 |
| Web | High | 134,217,728 | 1,342,177,280 | 67,108,864 | 67,108,864 | 40,265,318 | 1,073,741,824 | 20,132,659 |

Windows, Linux, and macOS use the Desktop row. Missing profile data resolves to the target's Balanced
row.

## Reusable Project Policies

The Project may define named reusable policies under `/export/assetMemoryPolicies`. Each policy has a
stable generated ID, a unique case-insensitive display name, one direct built-in base (`low`,
`balanced`, or `high`), and optional absolute overrides. Policies never derive from other named
policies, so resolution cannot form chains or cycles.

An omitted total-residency, temporary, or Warm override tracks the selected built-in's current absolute
value for the concrete target. Enabling a Warm override materializes that domain's selected built-in
absolute value before further editing. An overridden byte value is absolute across targets.
Total-residency byte overrides are positive safe integers representable by both the editor JSON
boundary and runtime; `temporaryBytes` is at least 1 MiB.
`warmPreparedCpuBytes`, `warmGpuBytes`, and `warmAudioBytes` are non-negative safe integers and each
must not exceed its corresponding resolved total ceiling on any supported target. Zero is valid and
disables speculative residency in that domain.

For compatibility, the Project-load migration recognizes the legacy `prefetchAllowancePercent` field
on named policies. It converts any Warm domain not already authored as an absolute byte override and
then removes the percentage before the canonical Project schema is accepted. Prepared CPU and audio
use the legacy percentage against their applicable resolved totals. GPU uses an explicit GPU-total
override when present; without one, migration uses the historical built-in GPU baseline listed above
so total-envelope recalibration does not silently inflate the old effective Warm capacity. Built-in
profiles resolve directly to the fixed absolute Warm defaults above. No current authoring, export,
player, residency, planner, telemetry, or profiler path carries a competing percentage limit.

Export profiles reference either a built-in preset or a named policy by stable ID. Missing policy
references and duplicate policy IDs/names are semantic authoring errors. A policy referenced by an
Export profile cannot be deleted from Project Settings until those references are changed. The
exported `player.json` and deployment manifest contain only the fully resolved policy; authoring IDs
and inherited values do not cross into the player runtime contract.

## Runtime Semantics

Demand admission evicts eligible Cold entries before Warm entries and may remain over budget when all
remaining residency is pinned or one mandatory asset is oversized. Prefetch residency admission is
rejected if either a total domain ceiling or that domain's absolute Warm ceiling would be exceeded.
Releasing the last pin re-enforces both constraints. Temporary preparation remains an independent
transient-concurrency budget and has no Warm counterpart: one individually oversized Demand or
Prefetch preparation may run over it serially; an oversized Prefetch waits for exclusive temporary
capacity rather than being discarded solely for its size. Ordinary additional speculative work is not
admitted when the aggregate temporary working set would exceed the ceiling. The same policy object and
residency implementation are used by cooperative and threaded executors.

These profile limits apply to the sole production prepared-asset path. Runtime and editor-preview
consumers acquire prepared resources through asynchronous requests and retained leases; there is no
synchronous prepared fallback outside residency accounting. The immutable compressed Web package
backing remains the documented exception because it is archive source storage rather than prepared
evictable residency.

`AssetResidencyManager` emits `MemoryPolicyResolved` telemetry when a sink is attached. Profiler
snapshots retain that resolved policy beside current and high-water accounting. A live policy change
replaces the active policy on the owner thread, immediately enforces eligible Cold-before-Warm
eviction, preserves pinned residency and already-running preparation, and starts a new profiler
high-water epoch from the actual post-eviction accounting. The policy change succeeds even when
mandatory pins or active preparation leave current usage above the new limit. The player and engine
startup logs report the resolved target, preset, total byte ceilings, and absolute Warm CPU/GPU/audio
ceilings. Percentage migration provenance does not cross into runtime startup diagnostics.
