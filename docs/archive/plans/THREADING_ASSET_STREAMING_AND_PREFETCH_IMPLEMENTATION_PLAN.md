# Threading, Asset Streaming, and Prefetch Implementation Plan

Status: Complete — archived after Phase 9B validation on 2026-07-23
Date: 2026-07-22
Ambiguity audit: completed 2026-07-22
Last implementation update: 2026-07-23 — Phase 9B verification, review-finding remediation, completion report, and archival complete
Last remaining-phase review: 2026-07-23 — post-Phase-8 review clarified Phase 9 cleanup and verification boundaries

This document defines the implementation sequence for NovelTea's first production concurrency and
asset-residency foundation. It is intentionally narrower than a general-purpose task graph,
network-streaming framework, or advanced predictive asset system. The objective is to establish
durable boundaries now so later package segmentation, richer profiling, remote/generated content,
and more advanced prefetching do not require another foundational refactor.

This plan builds on the typed `AssetManager` facade and loader ownership already implemented in the
runtime. This document adds asynchronous execution, package-backed on-demand access, residency,
prefetch, and telemetry requirements; it does not create a competing public asset API. Historical
implementation rationale is archived under `docs/archive/plans/` and is not required reading for
this plan.

Where the older typed-asset plan shows synchronous prepared-asset examples such as `load_texture()`
or `load_audio()`, this document supersedes those examples for production runtime consumers with the
`request_*()` plus `AssetRequestHandle`/`AssetLease` model in Section 9. Synchronous byte/text reads
remain valid at explicit startup/tooling boundaries and in tests, but there must not be parallel
synchronous and asynchronous production APIs for the same prepared asset type.

## 0. Normative status and implementation rules

This is an implementation contract, not a brainstorming document. The following words are
normative:

- **must / must not**: required for the workstream to be complete;
- **should / should not**: the expected design; a deviation requires a written reason in the plan
  ledger and completion report;
- **may**: deliberately optional.

Class and enum names written in backticks are the required conceptual types. An implementation may
adjust a spelling only to match an established repository convention, and must update this document
in the same workstream before using the replacement name. It must not silently introduce parallel
abstractions with overlapping responsibilities.

Code snippets in this document are semantic interface sketches rather than copy/paste headers. The
implementation must preserve their ownership, lifecycle, scheduling, and failure semantics even
when repository-specific result or callable wrappers change the exact signatures.

The following responsibility split is fixed:

- `JobExecutor` schedules finite CPU or blocking-source work and delivers owner-thread completions.
- `AssetSource` is a synchronous, thread-safe byte/cursor primitive. It does not own scheduling.
- `AssetManager` owns asynchronous typed requests, request coalescing, and preparation orchestration.
- `ResidencyManager` owns prepared-resource accounting, pinning, admission, and eviction policy.
- `PrefetchPlanner` emits speculative `AssetManager` requests from structured runtime state.
- `AssetTelemetrySink` observes events and counters; it never controls runtime behavior.

No implementation workstream may move one of those responsibilities to another component merely
because doing so is locally convenient.

### 0.1 Deliberate implementation freedom

The following choices remain implementation-resolved. This is the complete initial list; an
implementer must update this section before treating another architectural choice as open:

- internal source/header file layout and private helper names, while preserving the public concepts
  and module boundaries in this plan;
- callable/type-erasure representation used to implement `JobTask` and owner completion storage;
- SDL condition variable versus semaphore for worker sleep/wake coordination;
- the private ZIP/miniz strategy used to provide independent concurrent readers, provided it meets
  the cursor, seekability, memory, and failure contracts;
- backend-specific methods used to measure or conservatively estimate GPU/audio allocations, with
  the method documented beside the resulting accounting code;
- measured numeric values for Low/Balanced/High memory presets and any later adjustment to host pump
  budgets, worker-count caps, completion limits, or telemetry-ring capacity, provided measurements
  and permanent documentation accompany the change;
- private tagged-union/variant layout of telemetry events and snapshots;
- whether an identified monolithic third-party decode remains one documented non-preemptible step or
  is replaced by an incremental decoder in the same workstream.

These choices do not permit changing ownership, state transitions, cancellation behavior, priority
rules, completion timing, package residency, source/request separation, or owner-thread finalization.

## 1. Scope and production policy

NovelTea production targets are threaded by default.

- Native desktop and Android distributed players use the threaded implementation.
- The threaded Web player is the primary production Web configuration.
- The Web player also supports an explicitly selected non-threaded compatibility build.
- The engine and player composition must nevertheless remain buildable and runnable with threading
  disabled on every supported target. Native and Android non-threaded configurations are portability,
  development, and verification modes rather than distributed player products for now.
- Tests may use deterministic inline execution regardless of target.

In this document, `NOVELTEA_ENABLE_THREADS=OFF` means NovelTea creates no job worker and configures
miniaudio with no resource-manager worker. It also means the Web artifact is built without
Emscripten pthread/shared-memory flags. It does not claim that an operating system, browser, SDL
implementation, graphics driver, or unrelated external runtime can never use an internal thread.

The target-independent CMake capability switch introduced by this plan is
`NOVELTEA_ENABLE_THREADS`:

- default `ON` for native desktop, Android, and the canonical threaded Web presets;
- `OFF` for explicit compatibility/verification presets;
- replaces `NOVELTEA_WEB_THREADS` rather than coexisting with it permanently;
- is consumed only by build wiring and bootstrap/composition;
- must not appear in runtime, asset, rendering, audio, UI, or gameplay source files as behavior
  branching.

Add `NOVELTEA_JOB_WORKER_COUNT` as an integer build/bootstrap setting:

- `0` means the documented native auto policy;
- native auto policy is `clamp(logical_cpu_count - 1, 1, 4)`;
- threaded Web uses an explicit fixed value in its preset, initially `1` NovelTea worker;
- Emscripten's precreated pthread pool equals NovelTea worker count plus every library-owned worker
  that must exist at startup, including miniaudio's initial one-worker policy;
- a non-threaded build with a nonzero worker count fails configuration with a clear diagnostic.

Preset policy after the cutover:

- canonical `linux-*`, Android, `web-debug`, and `web-release` presets enable threads;
- add explicit `linux-debug-no-threads`, `web-debug-no-threads`, and
  `web-release-no-threads` verification/compatibility presets;
- Android no-thread coverage may be a configure/build CI variant rather than a distributed preset;
- remove or rename legacy `*-threads` Web presets so the unqualified canonical Web preset is the
  threaded production default.

The Web build remains split because Emscripten pthread support changes the Wasm memory model and
requires cross-origin isolation. Web is currently the only target that exposes both modes as
distributed player configurations. The cooperative implementation itself is platform-neutral and
must preserve the same public job and asset-request contracts wherever threading is disabled. It may
complete background preparation more slowly and may need visible loading transitions for expensive
monolithic work.

Threading is an execution capability, not a subsystem-specific compile-time fork. Runtime, rendering,
audio, asset, and presentation consumers must not contain separate threaded and non-threaded logic.
Only bootstrap/composition selects the executor implementation.

Bootstrap resolves and passes an explicit execution configuration equivalent to:

```cpp
enum class JobExecutionMode : std::uint8_t {
    Threaded,
    Cooperative,
    InlineTest,
};

struct JobExecutionConfig {
    JobExecutionMode mode = JobExecutionMode::Cooperative;
    std::uint32_t worker_count = 0;
};
```

`JobExecutor::mode()` exposes this immutable capability for diagnostics/telemetry. Backend adapters
such as miniaudio may receive the resolved configuration to configure a library correctly; they must
not read the CMake macro or implement a separate scheduling model. Gameplay/runtime consumers depend
only on the executor/request contracts.

## 2. Explicitly deferred work

The following work is outside this plan:

- Lua asset-reference analysis.
- Script-derived automatic prefetch dependencies.
- HTTP range access into `.ntpkg` files.
- Segmented package generation or chapter packs.
- Partial Web package download.
- Generative-AI services or HTTP APIs.
- A general DAG scheduler, work stealing, fibers, or coroutines.
- Dynamic operating-system memory-pressure integration.
- A polished editor profiler UI.
- Automatic profiler-generated preload declarations.
- DLC, hot-loaded patches, or remote package overlays.

The interfaces introduced here must leave those features possible without implementing them now.

### 2.1 Prohibited interpretations

The following are specifically not acceptable implementations of this plan:

- running all queued work synchronously from `submit()`;
- making `CooperativeJobExecutor::pump()` run until the queue is empty regardless of its budget;
- creating separate job systems for assets, audio, rendering, or each platform;
- using `std::async`, one thread per asset, or direct pthread APIs in NovelTea job code;
- adding asynchronous callbacks or executor ownership to `AssetSource`;
- returning raw cache-entry pointers as asset handles;
- letting workers call Lua, mutate `RuntimeSession`, create/destroy bgfx resources, or modify RmlUi;
- treating prefetch analysis as required for correctness;
- retaining every decompressed `.ntpkg` entry because the Web download buffer is already in memory;
- blocking the browser owner thread on a worker join, condition variable, or synchronous network
  operation;
- implementing advanced Lua analysis, package segmentation, or a profiler UI under the claim that
  they are prerequisites for this plan.

## 3. Architectural invariants

The **owner thread** is the thread that constructs the player/engine host and `JobExecutor`. It is
also the `RuntimeSession` owner, bgfx submission/finalization thread, and RmlUi mutation thread for
that engine instance. Ownership does not migrate during the instance lifetime. Web uses the browser
main thread as this owner. Debug/test builds must assert owner-only API use.

1. `RuntimeSession`, Lua, mutable gameplay state, RmlUi documents, and authoritative presentation
   state remain owner-thread confined.
2. Workers prepare immutable results. The owner thread validates, finalizes, and commits them.
3. GPU and renderer-owned resource creation/destruction occurs on the required renderer/owner thread.
   This plan does not enable bgfx's internal multithreaded renderer mode.
4. Job completion is always queued. It is never invoked synchronously from `submit()`.
5. The same public operation model is used in threaded Web, non-threaded Web, native, Android, and
   deterministic tests.
6. Every supported target can compose the cooperative executor and compile without thread creation;
   production distribution policy does not narrow this architectural portability requirement.
7. Prefetch is an optimization. Any asset may still be loaded on demand when prediction misses.
8. A failed speculative prefetch must never invalidate gameplay.
9. Active assets are pinned and cannot be evicted.
10. Memory budgets bound the prepared working set, not the complete project size.
11. Package format details remain behind `AssetSource`; consumers do not depend on ZIP/miniz.

## 4. Target architecture

```text
Host/bootstrap
  ├── Platform
  ├── JobExecutor
  │     ├── SdlThreadPoolJobExecutor
  │     ├── CooperativeJobExecutor       (all targets; distributed non-threaded mode is Web-only)
  │     └── InlineJobExecutor            (tests)
  ├── AssetManager
  │     ├── AssetSource mounts
  │     ├── typed loading/preparation
  │     ├── ResidencyManager
  │     └── AssetTelemetrySink
  ├── StructuredAssetDependencyCollector
  └── PrefetchPlanner
```

The first implementation must remain within the components shown above. Do not add a global service
locator or a large `OSystem`-style platform interface. Bootstrap composes the services and passes
explicit dependencies to the owners that require them.

### 4.1 Component definitions

`JobExecutor` is the only execution interface visible to asset and engine consumers. It owns job
queues, cancellation state, terminal-state publication, and the owner-thread completion queue. It
does not own runtime state or asset caches.

Every submitted `JobTask` is finite. A task may yield many times but must eventually complete, fail,
or honor cancellation. Long-lived event loops, network services, and perpetual polling actors are not
jobs in this plan.

`SdlThreadPoolJobExecutor` implements `JobExecutor` with a fixed SDL3 worker pool. Workers call job
steps and produce immutable prepared state. They never invoke owner completions directly.

`CooperativeJobExecutor` implements the same `JobExecutor` contract with zero worker threads. The
owner thread advances queued jobs by calling bounded `step()` methods from `pump()`. It is not a Web
adapter, JavaScript event-loop wrapper, coroutine runtime, or synchronous "execute immediately"
fallback.

`InlineJobExecutor` is a deterministic test implementation. It shares the cooperative queue/state
semantics but exposes test-only controls such as advancing one step or running until idle. It still
does not execute work or completion recursively from `submit()`.

`AssetManager` submits source-read and preparation jobs, retains the typed request records, and
receives their owner-thread completions. The executor does not know asset types.

`ResidencyManager` is owned by `AssetManager` or by the same engine asset service composition. It
tracks only prepared/cacheable resources. It does not own the complete compiled project, the Web
package download buffer, or arbitrary memory allocated elsewhere in the engine.

`PrefetchPlanner` runs on the owner thread. Its initial dependency analysis must be bounded and
synchronous; it emits individual speculative asset requests and does not itself perform I/O or
decode work.

`StructuredAssetDependencyCollector` is a pure owner-thread query over typed compiled/runtime state.
It returns three deduplicated ordered sets: current mandatory dependencies, direct-next candidates,
and adjacent alternatives. It does not read files, execute Lua, inspect arbitrary source text, or
submit jobs. Current mandatory dependencies are consumed as Demand requests; only the latter two
sets are passed to `PrefetchPlanner`.

### 4.2 Required frame integration

The host integrates every executor through the same frame phases:

```text
process platform/input events
executor.pump(current cooperative budget)
executor.dispatch_owner_completions(current completion limit)
advance runtime/presentation/audio coordination
render
```

For `SdlThreadPoolJobExecutor`, `pump()` does not execute worker work; it may perform lightweight
queue maintenance and returns immediately. For cooperative and inline execution, `pump()` advances
job steps. `dispatch_owner_completions()` has identical semantics in every implementation.

Loading-screen loops may call those phases repeatedly with a larger cooperative budget, but must
continue processing platform events and rendering progress. No code may implement mandatory loading
as an unresponsive wait on the owner thread.

## 5. Job system contract

### 5.1 Normative job model

All executor implementations use the same logical records and state machine. The implementation must
provide concepts equivalent to the following:

```cpp
enum class JobPriority : std::uint8_t {
    Critical,
    Normal,
    Prefetch,
};

enum class JobStepStatus : std::uint8_t {
    Yielded,
    Completed,
    Failed,
};

enum class JobTerminalStatus : std::uint8_t {
    Completed,
    Failed,
    Canceled,
};

struct JobId {
    std::uint64_t value = 0;
};

struct JobStepOutcome {
    JobStepStatus status = JobStepStatus::Yielded;
    core::Diagnostics diagnostics;
};

struct JobCompletion {
    JobId id;
    JobTerminalStatus status = JobTerminalStatus::Canceled;
    core::Diagnostics diagnostics;
};

struct JobProgress {
    std::uint64_t completed_units = 0;
    std::optional<std::uint64_t> total_units;
};

struct JobPrioritySnapshot {
    std::uint64_t queued = 0;
    std::uint64_t running_steps = 0;
    std::uint64_t completions_queued = 0;
    std::uint64_t submitted_total = 0;
    std::uint64_t completed_total = 0;
    std::uint64_t failed_total = 0;
    std::uint64_t canceled_total = 0;
    std::chrono::nanoseconds maximum_queue_latency{};
};

struct JobExecutorSnapshot {
    JobExecutionMode mode = JobExecutionMode::Cooperative;
    JobPrioritySnapshot critical;
    JobPrioritySnapshot normal;
    JobPrioritySnapshot prefetch;
};

class JobContext {
public:
    [[nodiscard]] bool cancellation_requested() const noexcept;
    [[nodiscard]] bool cooperative_budget_expired() const noexcept;
    void report_progress(JobProgress progress) noexcept;
};

class JobTask {
public:
    virtual ~JobTask() = default;
    [[nodiscard]] virtual JobStepOutcome step(JobContext& context) noexcept = 0;
    virtual void complete_on_owner(JobCompletion completion) noexcept = 0;
};
```

`JobTask` owns any partially prepared and final immutable result until
`complete_on_owner()` runs. The completion method may move that result into an owner-owned service,
but must not perform another long-running operation. `Failed` requires at least one stable diagnostic;
`Completed` has no error diagnostics; cancellation is represented by terminal status rather than a
fabricated failure. Exceptions are not part of the contract.

An **atomic job** is an adapter whose first `step()` invocation returns `Completed` or `Failed`. It is
permitted only for work known to be bounded. A **cooperative job** may return `Yielded` and retain
state for a later step. They are not separate executor APIs and must not create duplicate submission
paths.

The required `JobExecutor` operations are semantically:

```cpp
class JobExecutor {
public:
    [[nodiscard]] virtual JobExecutionMode mode() const noexcept = 0;
    [[nodiscard]] virtual core::Result<JobId, core::Diagnostic>
    submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept = 0;
    [[nodiscard]] virtual bool request_cancel(JobId id) noexcept = 0;
    [[nodiscard]] virtual bool set_priority(JobId id, JobPriority priority) noexcept = 0;
    [[nodiscard]] virtual std::optional<JobProgress> progress(JobId id) const noexcept = 0;
    [[nodiscard]] virtual JobExecutorSnapshot snapshot_on_owner() const = 0;
    virtual void pump(std::chrono::nanoseconds budget) noexcept = 0;
    virtual std::size_t dispatch_owner_completions(std::size_t maximum) noexcept = 0;
    virtual void begin_shutdown() noexcept = 0;
    [[nodiscard]] virtual bool shutdown_complete() const noexcept = 0;
};
```

The exact callable/type-erasure mechanism may differ, but there must remain one submission method,
one owner completion path, and one state machine.

`set_priority()` is the owner-thread operation used by the Phase-6 asset-request orchestrator when
the highest live interest in coalesced work changes. Phase 6A adds this narrow executor-contract and
shared-scheduler extension; it does not reopen Phase 2. For a queued job, changing priority removes
it from its old runnable queue and appends it to the tail of the new priority queue. For a running
step, the new priority applies if that step yields. Terminal or unknown jobs cannot be reprioritized.
Setting the existing priority is a successful no-op. Reprioritization never executes a step or owner
completion and must keep queue-depth/running-step snapshot accounting consistent.

`JobId{0}` is invalid. Accepted IDs are process-unique and are not reused during one engine process.
Submitting a null task or submitting after shutdown begins returns an explicit failure and queues no
completion. Progress is an optional latest snapshot, not an event stream; reported completed units
must not decrease within one job.

`progress(id)` is available from accepted submission until its owner completion is dispatched. After
dispatch, it returns no value. Reading progress never pumps work or invokes completion.

`JobStepOutcome::diagnostics` is empty for `Yielded` and `Completed` and nonempty for `Failed`.
`JobCompletion::id` is the accepted submission ID. Cancellation produces `Canceled` with no failure
diagnostics unless shutdown itself detects a separate invariant violation.

### 5.2 Ownership and call restrictions

- `submit()`, `request_cancel()`, `set_priority()`, `pump()`,
  `dispatch_owner_completions()`, and shutdown control are owner-thread operations.
- Worker threads call only `JobTask::step()` and thread-safe context methods.
- At most one `step()` call for a given `JobId` may execute at once. Different jobs may execute in
  parallel in the SDL pool.
- `complete_on_owner()` runs exactly once, only from `dispatch_owner_completions()`, including for
  failed and canceled jobs.
- The executor owns a submitted task until its owner completion returns. The task is then destroyed
  on the owner thread.
- A `JobId` is a non-owning correlation value. Destroying or dropping it does not cancel the job.
- Submitting from a worker step is not supported in this plan. A worker result may ask its owner
  completion to submit follow-up work.
- Runtime/Lua/presentation objects must never be captured by mutable reference in worker-visible
  state.

### 5.3 Job state machine

The internal states must be equivalent to:

```text
Queued -> RunningStep -> Queued          (step yielded)
Queued -> RunningStep -> CompletionQueued (completed or failed)
Queued ----------------> CompletionQueued (canceled before start)
RunningStep -----------> CompletionQueued (cancellation observed after current step returns)
CompletionQueued ------> Completed / Failed / Canceled (owner dispatch)
```

Required rules:

- Terminal state is immutable once queued.
- A cancellation request succeeds only before terminal state has been queued.
- Cancellation is cooperative: it cannot interrupt a function currently executing.
- After cancellation succeeds, the current step may finish, but its prepared result must not be
  committed; the owner completion receives `Canceled`.
- A failed step returns at least one stable diagnostic and queues `Failed`.
- A yielded task is placed at the tail of its priority queue.
- FIFO order is preserved among jobs at the same priority, subject to cancellation and a running
  worker finishing its current step.
- Priority changes affect queue selection after the current step; they do not preempt a step already
  executing.

### 5.4 Priority and fairness

The initial priorities are exactly:

```text
Critical   Required to make current gameplay or active audio/render state valid.
Normal     Explicit non-speculative work that is not immediately frame-critical.
Prefetch   Speculative future-use work.
```

Queue selection is strict priority: Critical, then Normal, then Prefetch. Starvation of Prefetch
while demand work remains queued is intentional. Within one priority, yielded jobs use FIFO
round-robin progression. Do not add hidden numeric priorities, work stealing, dependencies, or
deadline scheduling in this plan.

Asset request reason is separate from job priority. A prefetch request always submits at
`JobPriority::Prefetch`; there is no undefined "high-priority prefetch" fourth level.

### 5.5 Step and budget semantics

One call to `JobTask::step()` is the smallest scheduler-controlled unit. The executor cannot preempt
inside it.

- Every potentially expensive NovelTea-owned operation must be decomposed into steps that can
  observe cancellation and return `Yielded`.
- Initial NovelTea-owned read/copy/hash/decompression loops process at most 256 KiB of input or
  output per step before checking cancellation/budget and yielding. A measured reason to change that
  chunk size must be documented with the affected workstream.
- Third-party monolithic calls may remain one step initially and must be identified in telemetry and
  known limitations.
- `cooperative_budget_expired()` is a hint allowing a long incremental step to yield; it is always
  false for a worker-thread step.
- After any step returns `Yielded`, both threaded and cooperative executors requeue that task instead
  of immediately calling it in a tight loop. This preserves queue fairness and equivalent observable
  ordering.
- `pump(budget)` uses a monotonic clock, starts no new step after the deadline, and returns after the
  currently executing step finishes. Therefore elapsed time may exceed the requested budget by at
  most the duration of one non-preemptible step.
- A zero budget performs no job step but may do constant-time queue maintenance.

Initial host policy is configurable rather than embedded in the executor. Recommended starting
values are 2 ms for background gameplay, 8 ms for a transition/loading overlay, and 12 ms for an
otherwise blocking loading screen. Measurements may adjust these policies without changing executor
semantics.

### 5.6 Completion dispatch semantics

`dispatch_owner_completions(maximum)` drains at most `maximum` terminal records in terminal-queue
FIFO order. It must:

- invoke `complete_on_owner()` exactly once per record;
- permit completion code to submit new work without recursively executing that work;
- never invoke a second completion recursively;
- bound per-frame completion work through the supplied limit;
- leave undispatched completions queued for the next frame.

The initial host limits are 64 completions per normal frame and 256 per loading-frame iteration;
measurements may change these constants without changing semantics. A
completion that performs expensive decoding, file access, or arbitrary runtime execution violates
the contract; those operations belong in job steps.

### 5.7 Cancellation and shared consumers

Job cancellation and asset-request cancellation are related but not identical. A coalesced asset
load may have multiple consumers. Canceling one consumer detaches that consumer; it cancels the
underlying job only when no demand consumer, prefetch ticket, or active residency requirement still
needs the result.

The effective priority of coalesced work is the highest priority among its current live interests.
Adding a higher-priority consumer promotes queued work immediately. Removing/canceling that consumer
recomputes priority: a currently executing step is not interrupted, but yielded work is requeued at
the recomputed priority. This prevents a surviving Prefetch ticket from remaining Critical after the
real demand disappears. `AssetManager` performs that recomputation and applies it through
`JobExecutor::set_priority()`; it must not cancel and restart healthy partially prepared work merely
to change queue priority.

### 5.8 Shutdown semantics

Normal engine shutdown uses cancellation, not indefinite draining:

1. `begin_shutdown()` rejects future submissions.
2. Queued jobs become canceled.
3. Running jobs receive cancellation and finish their current bounded step.
4. SDL workers are joined after no step is running.
5. Canceled/failed/completed terminal records are dispatched on the owner thread.
6. Executor destruction is legal only after `shutdown_complete()` and an empty completion queue.

Tests and offline tools may provide a helper that drains work to completion, but drain-to-completion
is not the engine shutdown policy and must not block the browser owner thread waiting for workers.
In threaded Web, `begin_shutdown()` is nonblocking: the host continues normal event/frame pumping
until workers report exited, and only then performs the final SDL join/handle cleanup. Do not call a
potentially blocking wait while a worker still needs the browser event loop to make progress.

### 5.9 SDL3 threaded executor

The production executor uses SDL3 thread primitives rather than introducing another low-level thread
portability wrapper.

- Worker creation uses `SDL_CreateThreadWithProperties` or `SDL_CreateThread`; raw `pthread_create`,
  `std::thread`, and `std::async` are prohibited in this executor.
- Runnable queues and sleep/wake coordination use SDL mutex plus SDL condition/semaphore primitives.
- Cancellation/progress flags use a thread-safe atomic or locked representation consistent with the
  repository's C++ policy; they must not require polling while idle.
- Orderly shutdown joins every worker with `SDL_WaitThread`.
- Worker priority changes are not part of the initial implementation.

Use one fixed worker pool. Do not create one OS thread per job or per asset.

Workers select one task, execute one step, and return yielded work to the tail of its priority queue.
They sleep on an SDL synchronization primitive when no runnable task exists; polling/busy-wait loops
are prohibited.

The worker-count and Web pthread-pool policies are defined in Section 1. Do not rely on
`PTHREAD_POOL_SIZE=1` after NovelTea begins creating workers.

### 5.10 Platform-neutral cooperative executor

The cooperative executor keeps the same queueing, priority, cancellation, completion, and telemetry
behavior while creating zero worker threads. It must not depend on browser APIs or Emscripten and
must be composable on native desktop, Android, and Web.

- `submit()` changes a task only to `Queued`; it calls neither `step()` nor completion.
- `pump()` selects and calls job steps according to Sections 5.4 and 5.5.
- It creates no SDL thread, pthread, Web Worker, asynchronous JavaScript callback, or hidden helper
  thread.
- Browser/network callbacks may make source bytes available, but only `pump()` advances NovelTea CPU
  preparation.
- The same executor must run under a native no-thread test preset to prove platform neutrality.

Cooperative budget modes and initial values are defined in Section 5.5; the executor itself does not
inspect gameplay/loading state.

The scheduler cannot interrupt a monolithic third-party decoder. Such calls may still cause a frame
spike in the compatibility build. The plan does not require rewriting every codec immediately;
loading transitions are an acceptable fallback.

### 5.11 Inline test executor

`InlineJobExecutor` and `CooperativeJobExecutor` must share the same scheduler queue/state-transition
core. The inline implementation provides deterministic test helpers equivalent to:

- `advance_one_step()`;
- `dispatch_one_completion()`;
- `run_until_idle(maximum_steps)` with a mandatory finite guard.

It must preserve queued completion semantics rather than invoking callbacks recursively from
`submit()`. `run_until_idle()` is test-only and must not be used by production bootstrap.

Tests must cover:

- Submission ordering within a priority.
- Priority preemption.
- FIFO round-robin after yield.
- Cancellation before start and during cooperative execution.
- Cancellation race after work finishes but before owner dispatch.
- Failure completion.
- Shutdown with queued/running work.
- Completion delivery only on the owner thread.
- Submission from a completion without recursive execution.
- Equivalent terminal states and completion rules across threaded, cooperative, and inline
  implementations. Exact wall-clock completion order between simultaneously running threaded jobs
  is not required to match single-thread execution.

## 6. Miniaudio integration

Miniaudio must retain one dedicated resource-manager worker in threaded builds initially. NovelTea
does not need to fold miniaudio jobs into the general executor in this plan.

Required configuration:

- Threaded builds explicitly set the custom resource manager's `jobThreadCount = 1` initially.
- Every non-threaded build explicitly sets `jobThreadCount = 0` and
  `MA_RESOURCE_MANAGER_FLAG_NO_THREADING` on NovelTea's custom resource manager.
- The non-threaded mode uses miniaudio's supported no-thread resource-manager processing path. It
  does not wrap miniaudio's private jobs in `JobTask` or add a second NovelTea audio pump in this
  plan.
- Web pthread worker-pool sizing accounts for miniaudio plus NovelTea workers. With the initial
  threaded Web preset, `1` NovelTea worker plus `1` miniaudio worker means
  `PTHREAD_POOL_SIZE=2`.
- Audio initialization failure is a typed startup diagnostic visible to tests and player logs; it
  must not be silently hidden by the engine continuing without an audio backend.
- Audio tests verify initialization and actual playback/resource progress in threaded and
  non-threaded modes; rendering-only smoke tests are not sufficient evidence.

Long-form music streaming from package-backed data sources is part of the asset/audio migration below,
but unifying miniaudio's internal queue with NovelTea's executor is deferred.

The audio loader backend must adapt an independent seekable `AssetReader` to miniaudio's supported
VFS/data-source/resource-manager streaming path. Threaded builds let miniaudio's dedicated worker fill
its bounded stream buffers. Non-threaded builds use miniaudio's no-thread processing behavior. The
real-time audio callback must not submit or wait for a NovelTea `JobTask`, acquire a global package
cursor lock, or materialize the complete encoded track.

## 7. Package access and startup

### 7.1 Native and Android

Replace eager package extraction into `MemoryAssetSource` with an indexed, read-only package source.

At startup:

1. Open `.ntpkg` from its platform-resolved location.
2. Read and retain the package directory/index.
3. Read `manifest.json`, `game`, and required shader/material metadata.
4. Decode the typed compiled project.
5. Complete package/project validation and then release the generic JSON documents. A constructed
   `RunningGame` must not retain duplicate generic JSON DOMs beside the typed project/package model.
6. Load only resources required to render the first valid interactive/loading frame: system loading
   UI, the selected startup/title Layout, and the initial runtime presentation dependencies selected
   by the entrypoint.

Individual package entries are read and decompressed on demand. The package remains on disk or in
platform-managed storage.

Phase 4 may temporarily leave existing prepared-asset consumers using synchronous
`AssetSource::read_binary()` for one requested entry. That intermediate state is acceptable because
it removes whole-package extraction while keeping the tree buildable. Phase 6 must migrate those
prepared-asset paths to typed asynchronous requests; Phase 4 must not duplicate that later work.

The package source must:

- Validate safe paths.
- Support ZIP64 archive, entry-count, and entry-size records; do not impose a legacy 32-bit ZIP limit
  on runtime packages.
- Expose entry metadata without extraction.
- Permit concurrent independent reads safely.
- Avoid one shared mutable archive cursor across workers.
- Report compressed and uncompressed byte counts.
- Localize entry failures with stable diagnostics.

Package assembly obtains entry path, sizes, compression method, and stored CRC/hash metadata from the
archive index. It must not recompute inventory by extracting every entry. Manifest-vs-index validation
runs at startup; per-entry decompression/CRC failure is reported when that entry is read. A separate
whole-package checksum required by a player bootstrap is verified by that bootstrap without retaining
a second package copy.

Runtime-package export/storage policy required by this plan:

- The initial exporter stores already-compressed runtime media such as Ogg/Opus/MP3, PNG, JPEG, and
  WebP as ZIP stored entries; it does not apply a second deflate layer.
- Long-form music and ambience entries must be ZIP stored and directly seekable so miniaudio can
  decode through an `AssetReader` without copying the whole encoded file.
- Runtime package validation rejects a music/ambience entry that is not seekable under the selected
  package-source implementation, with a stable package diagnostic.
- Small SFX may be stored or compressed according to measured package-size/load tradeoffs because
  their initial typed path may decode the complete clip into a bounded audio cache.

### 7.2 Web

The first Web implementation downloads the complete `.ntpkg` before game startup.

The JavaScript/browser bootstrap owns the `fetch()` operation and byte-progress reporting. C++ does
not busy-poll a synchronous HTTP API. After checksum verification succeeds, bootstrap transfers or
exposes one immutable completed package buffer to the memory-backed `ZipAssetSource`. A failed or
retried download discards the previous incomplete buffer.

After successful handoff, bootstrap releases accumulated JavaScript chunks and any redundant
complete source buffer. Steady-state engine accounting retains one complete package buffer. A
temporary handoff copy is permitted only when required by the Emscripten boundary and must be visible
as a transient memory peak in tests/telemetry.

The browser bootstrap must expose these phases:

```text
Downloading package
Verifying package
Opening package index
Loading startup content
Ready
```

Download progress must include received bytes and total bytes when `Content-Length` is available, and
an indeterminate state otherwise. Errors must support a clear retry path.

After download, Web must open the package as an indexed source and extract entries only when
requested. The compressed package may remain resident in Web memory for now. Do not also retain every
decompressed entry.

Future segmented packages or range-backed sources must be able to replace this Web source without
changing `AssetManager` consumers.

## 8. Asset source boundary

`AssetSource` remains a synchronous byte-source interface. Do not add executor ownership, callbacks,
futures, or job queues to it. `AssetManager` obtains asynchronous behavior by calling source methods
inside submitted `JobTask` steps.

Retain and strengthen the existing operations equivalent to:

- `stat(path)` returning source entry metadata;
- `exists(path)` as a convenience query that does not replace `stat()` where errors/metadata matter;
- `open(path)` returning an independent `AssetReader` cursor;
- `AssetReader::read/seek/tell/size` for bounded or incremental reads;
- `read_binary(path)` as a compatibility convenience implemented through `open()`, not as the normal
  prepared-asset path;
- `describe()` / `kind()` for source identity and diagnostics.

The reader/source refactor must make I/O failures explicit. Required semantics are equivalent to:

```cpp
enum class AssetSeekOrigin : std::uint8_t {
    Begin,
    Current,
    End,
};

class AssetReader {
public:
    virtual ~AssetReader() = default;
    [[nodiscard]] virtual AssetResult<std::size_t>
    read(void* buffer, std::size_t bytes) noexcept = 0; // success with 0 means EOF
    [[nodiscard]] virtual AssetResult<void>
    seek(std::int64_t offset, AssetSeekOrigin origin) noexcept = 0;
    [[nodiscard]] virtual AssetResult<std::uint64_t> tell() const noexcept = 0;
    [[nodiscard]] virtual AssetResult<std::uint64_t> size() const noexcept = 0;
};
```

In this section, `AssetResult<T>` means an explicit success/failure result whose error is the
`AssetSourceError` defined below; it does not mean the current string-only result shape.

Do not preserve ambiguous `0`/`false` error signaling as the only failure channel. Existing call
sites must be migrated or adapted through one compatibility wrapper that preserves source errors;
do not add per-consumer interpretations of reader failure.

Add source metadata/error records equivalent to:

```cpp
struct AssetEntryMetadata {
    std::uint64_t uncompressed_size = 0;
    std::optional<std::uint64_t> compressed_size;
    bool seekable = false;
};

struct AssetSourceError {
    std::string code;
    std::string message;
    AssetPath logical_path;
    std::string source_description;
};
```

New/changed source operations return explicit results containing `AssetSourceError`; do not add more
free-form error strings. Initial stable codes are:

```text
asset.source.not_found
asset.source.unsafe_path
asset.source.open_failed
asset.source.read_failed
asset.source.seek_failed
asset.source.corrupt
asset.source.unsupported_storage
asset.source.invalidated
```

`AssetManager` may add typed preparation context while preserving the underlying source code. New
codes require permanent documentation and focused failure-path tests.

Required concurrency contract:

- Calls on one mounted source may occur concurrently from multiple NovelTea workers.
- Each successful `open()` returns an independently usable reader with its own cursor/decompression
  state.
- One reader is confined to one job at a time unless an implementation explicitly documents
  stronger safety.
- Source metadata/index data is immutable after mounting.
- Mutable construction helpers such as `MemoryAssetSource::add()` are legal only before the source
  is mounted/published. Mounted sources are read-only for their shared lifetime.
- Unmount/replacement occurs on the owner thread only after jobs using the old mount have either
  completed or retained shared ownership safely.

Expected implementations:

- Directory source.
- Indexed `.ntpkg` source.
- Memory source for tests/transient data.
- Existing system/cache sources retain their current namespace semantics and are made safe for the
  access patterns introduced by this plan; do not replace them with new overlapping source classes.

Do not expose miniz handles outside the package-source implementation.

Complete the existing `ZipAssetSource` rather than creating a second overlapping ZIP source. It must
support two backing modes behind the same `AssetSource` behavior:

- path/file-backed storage for desktop and materialized Android packages;
- immutable memory-backed storage for the initially fully downloaded Web package.

Opening a path-backed `.ntpkg` must not first call `AssetManager::read_binary()` for the package. The
runtime-package loader reads package metadata through `ZipAssetSource` itself. Independent readers
must use per-reader archive/decompression state or another proven concurrent design; serializing all
entry decompression through one global archive cursor is not acceptable.

For a stored entry, `AssetReader::seek()` maps directly to the entry's byte range. For a compressed
entry, sequential incremental reads are required; arbitrary backward seek may return false unless the
reader owns a correct restart/index strategy. Consumers that require seekability, notably long-form
audio, must validate it rather than forcing whole-entry materialization as a hidden fallback.

## 9. Typed asset requests and state

Move runtime consumers away from synchronous whole-file reads for prepared assets. `AssetManager`
owns request identity and typed preparation.

All typed request/handle/lease/cache mutation APIs are owner-thread confined. Worker tasks receive
only immutable request descriptions, shared lifetime-safe source/loader state, and private prepared
output. They do not call public `AssetManager` mutation methods.

### 9.1 Required request and lease concepts

The typed API must distinguish an asynchronous request from a resident-resource lease:

```cpp
struct AssetRequestId {
    std::uint64_t value = 0;
};

enum class AssetRequestReason : std::uint8_t {
    Startup,
    Demand,
    Prefetch,
};

enum class AssetRequestState : std::uint8_t {
    Pending,
    Ready,
    Failed,
    Canceled,
};

template<class T> class AssetRequestHandle; // observes/cancels one consumer request
template<class T> class AssetLease;         // pins one resident prepared resource
```

An `AssetRequestHandle<T>` is nonblocking. Owner-thread code may inspect its state and consume a
Ready handle into an `AssetLease<T>`. It does not expose a blocking `get()` or wait operation.
Destroying the request handle detaches that consumer and has the same semantics as canceling that
consumer; it does not necessarily cancel coalesced underlying work.

`AssetRequestHandle<T>` is move-only so one handle represents exactly one consumer interest. Its
`AssetRequestId{0}` value is invalid; accepted request IDs are process-unique. Typed request methods
return an explicit result rather than an invalid handle. The surface must provide operations
equivalent to:

```cpp
auto submitted = assets.request_texture(texture_request, AssetRequestReason::Demand);
AssetRequestHandle<TextureAsset> request = std::move(*submitted.value_if());
AssetRequestState state = request.state();
if (state == AssetRequestState::Ready) {
    std::optional<AssetLease<TextureAsset>> ready = std::move(request).take_ready();
} else if (state == AssetRequestState::Failed) {
    core::Diagnostics failure = request.diagnostics();
} else {
    request.cancel();
}
```

`take_ready()` never pumps jobs or blocks. It succeeds only in `Ready` state and consumes/invalidates
the request handle. A Ready Startup/Demand request holds one reservation pin until it is consumed or
destroyed, preventing eviction between completion observation and lease acquisition. A Prefetch
ticket never creates such a reservation pin; completed prefetch content is Warm and evictable under
Section 10.

Startup/Demand typed methods return `AssetRequestHandle<T>`. Prefetch typed methods return a
move-only `PrefetchTicket` associated with one generation; they do not return a Ready request handle.
Both paths coalesce into the same cache/load entry and retain `AssetRequestReason` for telemetry and
priority mapping.

A Startup/Demand request for an already Resident cache key returns a Ready handle immediately with a
reservation pin; it still invokes no callback and performs no recursive work. A Prefetch request for
an already Resident entry attaches a ticket/Warm interest without creating a job.

Initial priority mapping is fixed:

- `Startup` submits `JobPriority::Critical`;
- `Demand` submits `JobPriority::Critical` because the current runtime/presentation is waiting for
  the asset;
- `Prefetch` submits `JobPriority::Prefetch`;
- `JobPriority::Normal` remains available for non-asset jobs and future explicitly nonblocking asset
  operations, but this plan does not relabel speculative work as Normal.

An `AssetLease<T>` gives access to the prepared typed asset and pins the corresponding cache entry.
`AssetLease<T>` is copyable/movable RAII ownership: every live copy contributes to the same pin count,
and the final destruction releases the pin. Lease acquisition, copy, and final release are
owner-thread operations in this plan. A lease exposes typed prepared data through const access; it
does not permit consumers to mutate cache ownership metadata.

### 9.2 Request and cache states

Consumer request states are the `AssetRequestState` values defined in Section 9.1.

The shared cache/load entry has the more detailed state machine:

```text
Missing
Queued
Reading
Preparing
WaitingForOwnerFinalization
Resident
Failed
Canceled
```

Required transitions are:

```text
Missing -> Queued -> Reading -> Preparing -> WaitingForOwnerFinalization -> Resident
Queued/Reading/Preparing/WaitingForOwnerFinalization -> Failed
Queued/Reading/Preparing/WaitingForOwnerFinalization -> Canceled
Resident -> Missing   (after owner-thread eviction/destruction)
Failed/Canceled -> Queued (only after a new request explicitly retries)
```

`Warm`, `Cold`, and `Pinned` are residency classifications, not additional load states.

Required behavior:

- Multiple requests for the same cache key coalesce.
- A demand request can raise the priority of existing prefetch work.
- Cache keys include every property that changes prepared output, including asset identity, variant,
  decode/preparation options, and relevant backend/profile identity.
- Each consumer has its own request state even when the underlying load is shared.
- A ready request becomes useful only after owner-thread finalization has produced a resident entry.
- Consumers receive leases rather than owning raw cache entries or backend handles directly.
- Prepared worker results remain immutable until owner-thread finalization.
- Failures contain stable diagnostics and do not leave partial cache entries.
- Canceling the final interested consumer requests cancellation of underlying work. Cancellation is
  best-effort and follows Section 5.7.
- A failed cache entry is not retried every frame; retry requires an explicit new request or source
  generation/change signal.
- Project/package replacement invalidates affected cache generations. Old leases remain lifetime-safe
  until released, but new requests must resolve against the new generation.

Initial typed migrations should prioritize the largest residency costs:

1. Textures/images.
2. Audio clips and music data sources.
3. Shader binaries/material dependencies as required by renderer initialization.
4. Font-file source bytes if they are currently retained redundantly. Renderer/text-owned glyph
   atlases remain under their existing bounded backend cache policy and are not moved into
   `ResidencyManager` by this plan.

## 10. Residency manager

Implement a small budgeted residency manager. Avoid advanced prediction algorithms in the first
version.

The manager consumes explicit cost reports; it must not guess asset type from file extensions.
Provide concepts equivalent to:

```cpp
struct ResidencyCost {
    std::uint64_t source_bytes = 0;
    std::uint64_t prepared_cpu_bytes = 0;
    std::uint64_t gpu_bytes = 0;
    std::uint64_t audio_bytes = 0;
    std::uint64_t temporary_bytes = 0;
};

enum class ResidencyAdmission : std::uint8_t {
    Admitted,
    AdmittedOverBudget,
    Deferred,
    RejectedPrefetch,
};
```

`AssetManager` asks `ResidencyManager` for a temporary-preparation reservation before starting a
large preparation step and for final admission before publishing a Resident entry. Estimated costs
may be used before finalization, but the actual committed cost must replace the estimate immediately
after backend creation. Reservations are released on completion, failure, or cancellation.

The manager exposes owner-thread operations equivalent to reserve preparation, admit/finalize an
entry, pin/unpin, mark used, attach/release prefetch interest, enforce budgets, and evict. It does not
load assets or submit jobs itself.

`source_bytes` charges retained per-entry encoded copies owned by a cache entry. It does not include
the immutable package backing/index itself. Encoded audio retained for playback is charged to the
audio domain; other retained encoded copies are charged against prepared CPU budget. Temporary read
buffers are charged to `temporary_bytes` only for their actual lifetime.

### 10.1 Residency classes

```text
Pinned      Required by active runtime/render/audio state or a Ready reservation; not evictable.
Warm        Completed prefetch with at least one active prefetch ticket.
Cold        Unpinned and eligible for eviction.
```

Classification rules:

- At least one `AssetLease` or unconsumed Ready Startup/Demand reservation makes an entry `Pinned`.
- A completed prefetch with no lease is `Warm` while at least one active prefetch-generation ticket
  references it.
- Releasing the final prefetch ticket demotes an unleased Warm entry immediately to `Cold`; the
  initial implementation has no time-based warm-aging heuristic.
- An unleased demand-loaded asset is `Cold`.
- The planner may release prefetch interest, but it may not override a live lease/pin.

Last-use order is updated when a lease is acquired and when an owning subsystem explicitly marks a
resident lease used for the current frame/operation. It is not updated merely by profiler inspection.

### 10.2 Initial eviction policy

Use deterministic cost-aware LRU behavior:

1. Never evict pinned resources.
2. Consider Cold entries before Warm entries.
3. Within one class, evict the least-recently-used entry first.
4. Break equal-age ties by larger charged resident cost first, then stable cache-key order.
5. Destroy backend-owned resources on the owner/render thread before removing the cache entry.
6. Permit an evicted resource to be loaded again through an ordinary request.
7. Cancel or decline speculative preparation before evicting useful demand-loaded content when
   budget pressure is already known.
8. Evicting a Warm entry drops/invalidates its active prefetch interests and records unused prefetch;
   it does not automatically requeue the same load while the old tickets remain alive.

Do not implement a complex graph-distance scoring model until telemetry demonstrates a need.

### 10.3 Memory accounting

Track at least:

- Source/compressed bytes currently retained by the asset system.
- Prepared CPU bytes.
- Estimated or actual GPU bytes.
- Audio encoded/decoded/streaming-buffer bytes.
- Temporary loading/preparation bytes.

The system must distinguish current residency from high-water marks and transient peaks.

### 10.4 Admission and budget-overrun rules

Budget enforcement must not make required gameplay incorrect:

- A speculative prefetch whose final admission would exceed its applicable budget may be discarded
  after preparation or declined before preparation when cost is known. Its request becomes Canceled,
  not Failed.
- A mandatory Startup/Demand resource may evict eligible entries and then be admitted even if pinned
  content or one oversized asset makes the configured budget impossible to satisfy.
- Such mandatory over-budget admission emits a stable pressure diagnostic and telemetry event; it
  must not enter an eviction/reload loop.
- Pinned content may exceed a budget. Budgets are cache-control targets, not permission to destroy
  active resources.
- Temporary preparation budget limits how many large preparations may be in flight. A mandatory
  single operation larger than that budget is allowed serially with a pressure diagnostic.
- `Deferred` means the request remains queued without busy retrying until another reservation is
  released or the owner explicitly re-runs budget admission. Critical work may cancel/deprioritize
  Prefetch reservations before waiting.
- `Deferred` is for mandatory Startup/Demand preparation. Prefetch admission that cannot fit returns
  `RejectedPrefetch` rather than occupying a deferred retry queue.
- The fully downloaded Web package buffer is reported as retained source memory but is not evicted by
  prepared-resource LRU in this plan.
- Budget accounting must charge a resource exactly once per owned allocation domain and must not
  double-count shared cache entries across multiple leases.

## 11. Export-profile memory policy

Add a per-platform export-profile setting with four required modes.

Required conceptual authoring surface:

```text
Asset memory preset:
  Low
  Balanced
  High
  Custom
```

Internally resolve the profile to a small set of budgets:

- Prepared CPU asset budget.
- GPU resource budget.
- Audio cache budget.
- Temporary preparation budget.
- Prefetch allowance percentage.

Resolved resource budgets are unsigned byte counts in the compiled/exported player profile.
`prefetch_allowance_percent` is an integer from 0 through 100 and caps the share of each otherwise
available prepared CPU/GPU/audio budget that Warm entries may occupy; it is not an additional pool
added on top of those budgets.

Custom byte-budget values must be positive and fit the runtime integer representation. Custom policy
must also satisfy:

- `prefetch_allowance_percent` is in the inclusive range 0–100;
- temporary preparation budget is at least 1 MiB;
- target/profile schema validation reports exact offending fields;
- missing values use target defaults rather than zero/unlimited behavior.

Phase 6 must measure representative fixtures and add the selected Low/Balanced/High values to the
permanent export-profile documentation before enabling the setting. A coding agent must not invent
undocumented defaults merely to complete the schema. Export validation must reject internally
inconsistent values and preserve target-specific defaults.

The player records the resolved policy in startup diagnostics and profiler telemetry.

## 12. Initial prefetch planner

The first planner uses only structured, reliable runtime/project relationships. Lua analysis is
explicitly excluded.

Initial structured dependency sources:

- Current room presentation dependencies.
- Currently mounted Layout dependencies.
- Visible character pose/expression dependencies.
- Current music/ambience requirements.
- Directly adjoining rooms.
- Explicit next Scene/Dialogue content when runtime state already identifies it.
- Required system/loading UI resources.

The collector follows typed references transitively through Layout, material, shader-binary,
character-pose/expression, room-presentation, and audio records with cycle detection and cache-key
deduplication. It does not scan file contents. The output buckets are assigned as follows:

The initial collector starts from current state, one explicitly selected next target, and directly
adjacent room/choice records only. It must not scan every Room/Scene/Dialogue in the project on each
runtime publication. Shared typed dependency closure may use precomputed immutable indexes created
when the compiled project is loaded.

- **current mandatory**: dependencies of currently published room/Layout/visible-character/audio and
  system loading state;
- **direct next**: dependencies of a specific Room/Scene/Dialogue transition already selected or
  identified by authoritative runtime state;
- **adjacent alternatives**: dependencies of outgoing room connections and other structured next
  choices not already in direct next.

When runtime state does not identify a specific next Scene/Dialogue/Room, there is no direct-next
guess; reachable alternatives belong in adjacent alternatives.

Initial horizon:

```text
Current content: Critical Demand requests, then pinned by acquired leases.
Directly likely next content: Prefetch requests submitted first.
Adjacent alternatives: Prefetch requests submitted afterward if allowance permits.
Unknown/dynamic references: ordinary on-demand loading.
```

The collector and planner use the following owner-thread lifecycle:

1. Runtime publication/navigation produces a stable structured context and a new
   `PrefetchGenerationId`.
2. `StructuredAssetDependencyCollector` synchronously derives the three deduplicated ordered sets.
   Analysis must not perform file I/O, decode assets, or execute Lua.
3. The current-content owner submits each mandatory typed descriptor through the matching
   `AssetManager::request_*()` entry point with reason `Demand`. `PrefetchPlanner` submits each
   direct-next/adjacent descriptor through the matching `AssetManager::prefetch_*()` entry point;
   the resulting shared work uses `JobPriority::Prefetch`.
4. The planner retains lightweight prefetch tickets for the active generation.
5. When a newer generation supersedes it, the planner releases old tickets. Shared loads continue
   when another request or generation still needs them.

The required correlation/ownership concepts are:

```cpp
struct PrefetchGenerationId {
    std::uint64_t value = 0;
};

class PrefetchTicket; // move-only interest in one coalesced request for one generation
```

`PrefetchGenerationId{0}` is invalid and accepted IDs are process-unique. `PrefetchTicket` is
move-only. Destroying/releasing it detaches only that generation's interest and follows the shared
consumer cancellation rules in Section 5.7.

The planner must not submit one giant multi-asset job. In cooperative execution, twenty assets become
twenty independently queued request pipelines. Submission order gives direct-next content preference
over adjacent alternatives within the one Prefetch priority; no hidden fourth priority is introduced.

Demand loads always outrank prefetch. Navigation invalidation releases stale generation tickets.
Memory pressure rejects/deprioritizes Prefetch admission according to Section 10. Underlying job
cancellation occurs only after the shared-consumer rules determine that no remaining interest exists.

Dependency collection must return typed/cache-key-relevant references rather than raw strings where
the structured model already provides asset identity. Missing or invalid structured references are
ordinary project/runtime diagnostics; the planner must not guess replacement assets.

Phase 6 established domain-specific `AssetManager::prefetch_*()` entry points rather than one opaque
cache-key submission API. Each collector bucket therefore contains a tagged typed request descriptor
(`FontAssetRequest`, `TextureAssetRequest`, `ShaderProgramAssetRequest`, `MaterialAssetRequest`, or
`AudioAssetRequest`) together with its derived `AssetCacheKey` for deterministic deduplication,
ordering, and telemetry identity. `PrefetchPlanner` dispatches the descriptor to the matching typed
entry point. It must not parse `AssetCacheKey::stable_identity` to reconstruct requests or add a
parallel generic `prefetch(cache_key)` API.

The immutable dependency indexes are built from the loaded compiled package, including
`PreparedResourceRegistries` and the renderer-selected shader variant needed to resolve a material's
concrete shader program. Material closure emits the material request, the resolved shader-program
request, and each static `project:/` or `system:/` texture source with its exact sampler.
Backend-dynamic sources such as `$draw.texture`, renderer-owned glyph atlases, and other
renderer-generated handles are not submitted as asset requests. This is required because Phase 6's
material preparation task prepares the material definition itself; it does not recursively load its
shader program or texture assignments.

## 13. Loading and progress UX

Expose a unified progress model for:

- Initial Web package download.
- Package verification/index opening.
- Mandatory startup assets.
- Runtime loading transitions.

Progress should report phases and units that are actually measurable. Do not present false precision
when total work is unknown.

Use one owner-thread progress record equivalent to:

```cpp
enum class LoadingPhase : std::uint8_t {
    DownloadingPackage,
    VerifyingPackage,
    OpeningPackageIndex,
    LoadingStartupContent,
    LoadingRuntimeDemand,
};

enum class LoadingState : std::uint8_t {
    Active,
    Completed,
    Failed,
    Canceled,
};

struct LoadingOperationId {
    std::uint64_t value = 0;
};

struct LoadingProgress {
    LoadingOperationId operation;
    LoadingPhase phase;
    LoadingState state = LoadingState::Active;
    std::uint64_t completed_units = 0;
    std::optional<std::uint64_t> total_units;
    bool retryable = false;
    core::Diagnostics diagnostics;
};
```

The pre-Wasm/browser bootstrap uses the same fields in its typed JavaScript/editor protocol even when
the C++ object does not yet exist. Do not create a separate phase vocabulary or percentage model for
the HTML loading shell.

Rules:

- Units are bytes when byte totals are meaningful and completed asset/request count otherwise.
- A missing total produces an indeterminate phase; do not synthesize a percentage.
- Do not combine sequential phases into one weighted overall percentage unless all phase weights are
  measured and documented. The initial implementation displays the current phase independently.
- Progress is monotonic within one phase/generation. Retry starts a new generation and may reset it.
- `LoadingOperationId{0}` is invalid. IDs are process-unique; a retry creates a new operation ID.
- `Failed` requires diagnostics. `Completed` and `Canceled` are terminal and immutable.
- Background prefetch does not open a blocking loading overlay merely to display its progress.
- A runtime demand group closes its loading overlay only after all required requests are Ready or a
  terminal error/cancellation has been handled.
- A heterogeneous runtime demand group owns the concrete typed request handles while blocked. On
  success it consumes every Ready handle into a typed lease and atomically transfers those leases to
  the published presentation, mounted-Layout, renderer/material, text/font, or audio owner that uses
  the prepared object. Releasing the blocker must not leave a published raw backend handle or
  definition pointer without its corresponding lease. Rollback releases only the candidate leases
  and preserves the leases held by the last valid publication.
- A retryable package/network failure keeps the bootstrap loading shell active with Retry. A
  non-retryable startup/package validation failure remains on a fatal bootstrap error state. A
  mandatory runtime-asset failure aborts the pending transition/presentation transaction and retains
  the last valid published runtime presentation; when no valid publication exists, it enters the
  fatal player error state. It must not spin or silently skip the required asset.

The runtime must support:

- Continuing gameplay while background prefetch progresses.
- Raising cooperative job budget during transitions.
- Selecting the loading-frame job budget while a mandatory runtime demand group is active, while
  still polling input/window events and rendering the loading overlay. Phase 2's larger loading
  budget is currently used only around the synchronous startup boundary and must not remain detached
  from the new multi-frame blocker path.
- Retrying deferred typed preparation on the owner thread after completion dispatch and after lease
  or reservation release frees temporary/residency budget. Phase 6 exposed
  `retry_deferred_asset_requests_on_owner()` but deliberately did not install a production frame-loop
  caller.
- Treating a missing mandatory asset as an explicit asset blocker: the owning transition/presentation
  commit waits, while unrelated already-valid runtime state may continue.
- Showing an existing transition/loading overlay immediately when the miss occurs during a
  transition. For an unexpected in-game demand miss, use an initial 100 ms grace period to avoid a
  one-frame flash, then show the loading overlay until the mandatory request group is terminal.
- Never publishing a partially finalized room/Layout/audio presentation merely to avoid the loading
  overlay.
- Remaining responsive to input/window events while mandatory loading is in progress.

## 14. Asset telemetry foundation

Implement a bounded telemetry recorder suitable for later editor-profiler consumption. This plan
requires instrumentation and transport/storage boundaries, not a complete profiler UI.

Record events or counters for:

- Asset requested and request reason.
- Request coalescing and effective-priority promotion/demotion.
- Cache hit/miss.
- Source read start/completion/failure.
- Compressed and uncompressed bytes.
- Preparation/decode duration.
- Owner-thread finalization duration.
- CPU/GPU/audio residency costs.
- Pin/unpin.
- Eviction and eviction reason.
- Reload after eviction.
- Prefetch used before eviction.
- Prefetch completed but never used.
- Runtime demand satisfied by a ready prefetch, promoted from a late in-flight prefetch, or missing
  any matching prefetch.
- Current budget use and high-water marks.
- Queue depth and job latency by priority, obtained from `JobExecutorSnapshot`.

Telemetry must never affect correctness. Production builds may disable detailed event retention while
keeping essential counters.

Prefetch outcome definitions are exact:

- **used**: the first Demand request actually acquires a lease from an already Resident entry that
  completed through prefetch; creating or canceling a Ready handle is not use, and completed-prefetch
  provenance remains until the lifecycle is claimed or evicted even if its ticket has gone stale;
- **late**: a Demand request finds matching prefetch work in Queued/Reading/Preparing/finalization and
  promotes it before it becomes Ready;
- **miss**: a Demand request finds neither a matching Resident entry nor matching active prefetch;
- **unused**: a completed Warm entry is evicted or its generation is invalidated before any Demand
  lease acquisition.

The initial sink contract has two levels:

- always-available aggregate counters/high-water marks with constant bounded storage;
- an optional fixed-capacity chronological event ring for editor preview, tests, and diagnostics.

Provide an interface equivalent to:

```cpp
class AssetTelemetrySink {
public:
    virtual ~AssetTelemetrySink() = default;
    virtual void record(AssetTelemetryEvent event) noexcept = 0;
    [[nodiscard]] virtual AssetTelemetrySnapshot snapshot_on_owner() const = 0;
};
```

`AssetTelemetryEvent` must carry a monotonic timestamp, a typed event kind, threading capability,
stable cache-key identity when asset-related, applicable job/request/prefetch-generation IDs,
request reason/priority when applicable, relevant byte or duration values, and a stable diagnostic
code for failures or budget pressure. Use a tagged C++ event representation rather than an
unstructured boundary document inside the runtime.

`AssetTelemetrySnapshot` contains aggregate counters, current and high-water memory by domain,
chronological retained asset events, and the lost-event count. The editor-facing profiler snapshot
combines this with `JobExecutorSnapshot` on the owner thread; `JobExecutor` does not depend on
`AssetTelemetrySink`.

`record()` may be called from workers and must be thread-safe and nonblocking apart from a bounded
critical section. The recorder assigns the final monotonic timestamp inside that serialized section
so retained events stay chronological under concurrent producers. `snapshot_on_owner()` is
owner-thread only and returns copied immutable data.
Every player composition installs an `AssetTelemetrySink` implementation. Ordinary production uses
the normal recorder with event-ring capacity zero, so aggregate counters remain available without
detailed event retention; do not replace it with a sink that discards required counters.

Initial capacities are 8192 events for editor preview/test diagnostics and zero detailed events for
ordinary distributed players unless a diagnostic option enables the ring. These values are policy,
not part of event semantics.

When the ring is full, overwrite/drop the oldest event and increment an explicit lost-event counter.
Producers must not block, allocate without bound, or change scheduler/cache decisions because a sink
is slow or absent. Event timestamps use one monotonic clock and include stable job/request IDs,
cache-key identity suitable for diagnostics, threading mode, and prefetch generation where relevant.

The future editor transport reads immutable snapshots on the owner thread. It does not subscribe
directly to worker callbacks or receive pointers to live cache/job records.

## 15. Implementation phases

The phases and workstreams below are the intended implementation-prompt units. A phase with no
lettered workstream is one prompt unit. A phase is split into lettered workstreams only when its scope
contains multiple independently verifiable implementation boundaries. Each unit is deliberately
large enough for one capable coding-agent session and includes its own verification. Do not split a
unit into additional ledger entries merely because it touches several files. Adjacent units may be
implemented together only when the implementation prompt explicitly requests that combination; the
completion ledger must still record each named unit separately.

### Phase 1: Contracts and ownership

1. Add the initial Section 5 job IDs, priorities, task/context, progress, terminal-state,
   completion-queue, cancellation, shutdown, and executor-snapshot contracts under
   `engine/include/noveltea/jobs/`. The coalesced-interest reprioritization extension is deliberately
   owned by Phase 6A, when its first production consumer is introduced.
2. Add owner-thread assertions and the executor-owned completion queue. Do not create a second
   generic dispatcher abstraction.
3. Add the Section 9 move-only request-handle, request-state, cache-state, copyable lease, reservation
   pin, cancellation, and generation contracts.
4. Add the Section 10 residency classification, cost, reservation, admission, accounting, and
   eviction interfaces.
5. Add the Section 14 telemetry event/snapshot contracts and bounded fake/test recorders.
6. Add contract tests with fake jobs and fake typed assets before implementing production executors
   or loaders.

Phase gate:

- Public contracts contain no SDL, bgfx, miniaudio, Emscripten, or platform types.
- Completion cannot execute recursively from `submit()`.
- Job/request IDs, terminal states, cancellation, reservation pins, leases, and owner-thread
  restrictions match Sections 3, 5, 9, 10, and 14.

### Phase 2: Executors and build capability

#### Workstream 2A: Shared scheduler core, inline executor, and cooperative executor

1. Implement one shared scheduler queue/state-transition core.
2. Implement `InlineJobExecutor` using that core and provide the deterministic helpers from
   Section 5.11.
3. Implement platform-neutral `CooperativeJobExecutor`, bounded `pump()`, owner completion dispatch,
   cancellation, shutdown, progress, strict priority, and FIFO-yield behavior.
4. Integrate cooperative pumping into the normal frame/loading-loop phases without embedding
   gameplay policy inside the executor.
5. Add deterministic fake-clock and native no-thread tests, including the yielded 20-asset workload.

Workstream gate:

- `submit()` executes no task step or completion.
- Cooperative execution creates no worker thread and depends on no browser API.
- Inline and cooperative implementations share observable state, priority, cancellation, shutdown,
  and completion semantics.

#### Workstream 2B: SDL worker pool, bootstrap selection, and build/preset cutover

1. Implement `SdlThreadPoolJobExecutor` with a fixed worker pool, sleeping workers, one-step task
   execution, orderly cancellation, join, and owner-thread completion dispatch.
2. Select the executor only in host/bootstrap composition.
3. Replace `NOVELTEA_WEB_THREADS` with `NOVELTEA_ENABLE_THREADS`, add
   `NOVELTEA_JOB_WORKER_COUNT`, and implement the preset policy from Section 1.
4. Compute Web `PTHREAD_POOL_SIZE` from NovelTea plus library-owned startup workers and retain
   cross-origin-isolation requirements only for threaded Web artifacts.
5. Add threaded/cooperative equivalence, cancellation-race, shutdown, and stress tests. Prove a task
   is never stepped concurrently with itself.

Workstream gate:

- Native/Android and canonical Web production presets use SDL workers.
- Native, Android, and Web can compile with NovelTea thread creation disabled.
- Only Web exposes a distributed no-thread player for now.
- Runtime and subsystem source files contain no platform/thread-mode behavior branches.

Phase exit gate: Workstreams 2A and 2B are complete.

### Phase 3: Miniaudio build-mode correctness

1. Pass the resolved Phase-2 `JobExecutionConfig` from host/bootstrap composition into audio-system
   initialization, then configure NovelTea's custom miniaudio resource manager explicitly for both
   threading capabilities as specified in Section 6. Audio/miniaudio source must not inspect the
   build macro directly.
2. Make the no-thread resource-manager path target-independent and verify its supported processing
   behavior without wrapping miniaudio-private jobs in `JobTask`.
3. Retain the Phase-2 threaded-Web pool contribution of one miniaudio startup worker and add
   configure/runtime validation that the precreated pool calculation remains synchronized with the
   explicit resource-manager `jobThreadCount` policy. Do not introduce a second independent worker
   count source.
4. Surface audio initialization failures as typed startup diagnostics.
5. Add Linux threaded/no-thread initialization and resource-progress tests plus real browser-harness
   playback/progress tests for both Web modes.

Phase gate:

- Audio initializes and makes resource/playback progress under both executor capabilities.
- Native tests prove the no-thread path is not Emscripten-specific.
- Rendering-only smoke cannot mask an audio initialization failure.
- Audio capability selection comes from the resolved bootstrap configuration, not subsystem build
  branches.

### Phase 4: Indexed package access

#### Workstream 4A: Source result contract and production `ZipAssetSource`

1. Upgrade `AssetReader`/`AssetSource` metadata and error results as required by Section 8.
2. Complete the existing `ZipAssetSource` with path-backed and immutable-memory-backed construction.
3. Implement independent readers, ZIP64, path validation, compressed/stored entry behavior,
   seekability reporting, stable diagnostics, and safe concurrent entry reads.
4. Implement and validate the runtime-package storage policy for already-compressed media and
   seekable long-form audio.
5. Add source-level path-safety, ZIP64, corruption, seekability, independent-cursor, concurrent-read,
   and reload tests.

Workstream gate:

- Opening a path-backed package never materializes the full archive in an `AssetBlob`.
- One reader cannot move or corrupt another reader's state.
- Long-form audio entries are validated as directly seekable.

#### Workstream 4B: Runtime-package loader migration and large-package validation

1. Make `running_game_loader.cpp` open package metadata through `ZipAssetSource` instead of eager
   extraction into `MemoryAssetSource`.
2. Retain only package metadata, the typed project/package model, and minimum startup resources.
3. Complete package validation and release duplicate generic JSON DOMs.
4. Preserve the documented temporary Phase-4 synchronous per-entry path until Phase 6 migrates
   prepared assets; do not retain whole-package extraction as that bridge.
5. Add generated large/sparse package, corrupt-entry, startup-memory, release/reload, and Android
   materialized-package tests.

Workstream gate:

- Native/Android startup memory does not scale with total decompressed package size.
- A large unrequested sentinel entry is not read at startup and remains readable later.
- Individual entries can be loaded, released, and loaded again.

Phase exit gate: Workstreams 4A and 4B are complete.

### Phase 5: Web package bootstrap

1. Implement the browser-owned full `.ntpkg` download with the Section 13 loading-operation fields,
   byte progress, indeterminate totals, cancellation, retry, and fatal/retryable error states.
2. Verify the configured package checksum before runtime use.
3. Transfer one immutable completed package buffer to memory-backed `ZipAssetSource` without keeping
   duplicate completed copies.
4. Open entries on demand and stop extracting/retaining every entry.
5. Add deterministic browser tests for known/unknown length, retry, checksum failure,
   cancellation/navigation, duplicate-buffer avoidance, and successful startup.

Phase gate:

- Web shows truthful current-phase progress.
- The completed compressed package remains resident only once.
- Web retains the compressed package plus the active working set, not all decompressed entries.

### Phase 6: Typed loading and residency

#### Workstream 6A: Asynchronous request orchestration and residency core

1. Extend the completed executor contract and shared scheduler core with the owner-thread
   `set_priority()` operation defined in Sections 5.1 and 5.7, and implement identical queued,
   running-yield, terminal, snapshot-accounting, and completion-isolation semantics in inline,
   cooperative, and SDL executors.
2. Implement move-only request handles, Ready reservations, copyable leases, typed cache keys,
   coalescing, per-consumer cancellation, retry, source generations, and highest-live-interest
   priority recomputation.
3. Implement preparation reservations, residency classifications, domain accounting, admission,
   deterministic eviction, warm-ticket behavior, owner-thread destruction, and pressure diagnostics.
4. Integrate scheduler and asset telemetry hooks without making telemetry control behavior.
5. Add executor-independent contract tests for coalescing, cancellation, reservations, leases,
   generation replacement, deferred preparation, rejected prefetch, over-budget demand, and reload.

Workstream gate:

- No blocking wait/get API exists for typed prepared assets.
- Active reservation/lease pins prevent eviction.
- Shared work is canceled only when no live consumer, prefetch ticket, or residency requirement
  remains.
- Demand promotion and later demotion reprioritize queued/yielded shared work without canceling and
  restarting it, with equivalent behavior under all three executors.
- The same request/residency tests pass with inline, cooperative, and SDL executors.

#### Workstream 6B: Texture, shader/material, and font-source migration

1. Migrate texture/image source reads and decode preparation to typed asynchronous requests.
2. Perform bgfx texture creation/destruction only during owner-thread finalization and residency
   eviction.
3. Integrate shader-binary reads and material-parameter preparation with coalescing/residency while
   retaining renderer ownership of bgfx programs.
4. Account for duplicated font-file source bytes where applicable; leave glyph atlases under the
   existing text-renderer cache policy.
5. Add demand/prefetch, cancellation, eviction/reload, owner-finalization, and renderer-lifetime
   tests under threaded and cooperative executors.

Workstream gate:

- Concrete visual request and prefetch paths use request handles/leases. Existing synchronous load
  methods remain compatibility paths until production blocker integration and final cleanup.
- GPU resources are never created or destroyed on workers.
- Eviction and reload preserve renderer correctness.

#### Workstream 6C: Audio residency and seekable package streaming

1. Migrate SFX/audio clips to typed requests and a bounded decoded/encoded audio cache.
2. Implement a seekable package-backed miniaudio data source for music and ambience.
3. Remove whole-file encoded `AssetBlob` residency from long-form music playback.
4. Integrate active-voice/track pinning, cancellation, errors, memory accounting, and owner-thread
   lifetime transitions.
5. Add bounded-read, seek, playback-progress, cache-pressure, cancellation, and reload tests in both
   threading modes.

Workstream gate:

- Concrete audio request and prefetch paths use request handles and leases. Existing synchronous load
  and raw-handle playback methods remain compatibility paths until mandatory blocker integration and
  final cleanup, but long-form compatibility playback also uses seekable streaming.
- Long-form package-backed audio uses bounded streaming buffers.
- Active audio cannot be evicted.
- Audio resource progress and teardown remain correct in threaded and cooperative execution.

#### Workstream 6D: Measured memory profiles and full residency matrix

1. Measure representative visual/audio/package fixtures after Workstreams 6A–6C.
2. Document and implement Low/Balanced/High target defaults plus Custom export-profile fields and
   validation from Section 11.
3. Record the resolved policy in player diagnostics and profiler snapshots.
4. Run the complete threaded/cooperative request, residency, package, visual, and audio matrix under
   the selected budgets, including deterministic pressure and high-water assertions.

Workstream gate:

- No preset value is undocumented or guessed without measurement evidence.
- Configured budgets control evictable residency while preserving mandatory correctness.
- The same policy schema and runtime semantics apply in threaded and non-threaded builds.

Phase exit gate: Workstreams 6A, 6B, 6C, and 6D are complete.

### Phase 7: Structured prefetch and loading UX

#### Workstream 7A: Structured dependency collection and prefetch generations

1. Implement `StructuredAssetDependencyCollector` with the current, direct-next, and adjacent sets
   defined in Sections 4.1 and 12. Its output is the tagged typed request descriptor plus derived
   cache key established by the post-Phase-6 review, not an opaque string or cache key alone.
2. Implement `PrefetchPlanner`, process-unique generations, move-only tickets, deterministic
   deduplication/order, and structured transitive dependency traversal with cycle detection.
3. Build immutable lookup indexes from `LoadedCompiledPackage`/`PreparedResourceRegistries`, resolve
   material shader programs against the active renderer variant, expand static material texture
   assignments, and exclude backend-dynamic sources that are not package assets.
4. Dispatch each descriptor through the matching typed `AssetManager::prefetch_*()` entry point at
   Prefetch priority; use its cache key only for deduplication, order, and correlation.
5. Release stale-generation tickets on navigation and cancel underlying work only when shared
   interest rules permit.
6. Add collector, typed-dispatch, material/shader/texture closure, dynamic-source exclusion, ordering,
   deduplication, generation replacement, rejected-prefetch, and ticket-lifetime tests.

Workstream gate:

- Prefetch analysis performs no file I/O, decode, or Lua execution.
- Direct-next requests precede adjacent alternatives without inventing another priority.
- Planner submission never reconstructs typed requests by parsing cache-key strings and never adds a
  competing generic prepared-asset API.
- Prefetch remains optional for correctness.

#### Workstream 7B: Mandatory asset blockers, progress UI, and end-to-end prefetch matrix

1. Integrate mandatory asset blockers with transition/presentation transactions and the Section 13
   loading-operation state/progress model.
2. Implement the grace period, loading overlay, retry/fatal handling, and last-valid-publication rules.
3. Add the private heterogeneous request-group ownership needed to retain typed handles while
   pending, consume Ready handles into leases, and atomically transfer those leases into the actual
   published visual, Layout/font, material/shader/texture, and audio owners. Candidate rollback must
   release candidate leases without disturbing the last valid publication.
4. Make an active mandatory group select the existing loading-frame cooperative budget, dispatch
   owner completions, and retry deferred asset preparation each owner frame without blocking event
   handling or rendering.
5. Run representative threaded and cooperative 20-asset scenarios covering background progression,
   a new Critical demand, used/late/missed/unused prefetch, stale tickets, failures, and cancellation.
6. Verify loading loops remain event-responsive, retain lease-backed resources for the full published
   lifetime, survive eviction pressure, and never publish partially finalized presentation.

Workstream gate:

- Gameplay remains responsive while background prefetch progresses.
- Demand work preempts speculative work.
- A published backend handle or definition pointer cannot outlive its typed asset lease, and rollback
  cannot release resources still used by the last valid publication.
- Deferred mandatory preparation resumes when budget becomes available; the loading overlay cannot
  remain active forever solely because no owner-frame retry service was installed.
- A prefetch miss loads correctly on demand or produces the documented terminal failure state.

Phase exit gate: Workstreams 7A and 7B are complete.

### Phase 8: Telemetry and editor-profiler handoff

1. Complete the production event payloads behind the Phase-6 telemetry hooks: source compressed and
   uncompressed bytes, preparation/decode duration, owner-finalization duration, eviction reason,
   stable failure/budget codes, and exact used/late/missed/unused prefetch classification with
   request/job/generation correlation. Extend preparation result/task reporting narrowly where
   needed; the recorder must not infer stage timings or byte counts after the fact.
2. Implement the bounded asset telemetry recorder, aggregate counters, optional event ring, and
   lost-event accounting.
3. Install one recorder with composition-owned lifetime before constructing residency/request
   orchestration, and pass that same sink to both `AssetResidencyManager` and
   `AssetManager::configure_async_requests()`. Editor preview/test compositions use the documented
   8192-event ring; ordinary players use ring capacity zero while retaining aggregates. Phase 6
   currently passes no production sink, so merely implementing a recorder class is insufficient.
4. Consume the `JobExecutorSnapshot` implementation completed in Phase 2 and combine copied job/asset
   snapshots on the owner thread without coupling `JobExecutor` to `AssetTelemetrySink` or adding a
   second scheduler-snapshot path.
5. Add the immutable editor transport/storage boundary without exposing worker callbacks or live
   cache/job records.
6. Add fixture-driven assertions/reports for memory peaks, queue latency, stage durations and bytes,
   budget pressure, eviction/reload churn, and used/late/missed/unused prefetch.
7. Update the future editor-profiler integration documentation; do not implement the polished UI.

Phase gate:

- Telemetry storage is bounded and cannot alter scheduling or cache decisions.
- Ordinary players retain required aggregates with a zero-capacity detailed event ring.
- Required byte, duration, eviction, and prefetch-outcome fields come from actual runtime events rather
  than remaining zero/default placeholders.
- Tests can identify memory high-water marks, churn, and each prefetch outcome class.

### Phase 9: Cleanup, certification, and archival

#### Workstream 9A: Production-path cleanup and permanent documentation reconciliation

1. Audit the packaged runtime path for obsolete whole-package or every-entry extraction bridges and
   remove any remaining production use. Do not treat indexed decompression of one requested entry,
   the single-entry startup manifest read, or `MemoryAssetSource` used only by explicit tests/tooling
   as a duplicate production package source. No production composition may rebuild a `.ntpkg` as a
   `MemoryAssetSource` or write the downloaded Web package through Emscripten's virtual filesystem.
2. Migrate every remaining synchronous prepared-asset fallback before deleting its compatibility
   API. Audit at least world-presentation resource resolution, bgfx material/shader/texture binding,
   ActiveText and mounted-Layout font ownership, runtime and editor-preview audio playback, and
   renderer-side caches. A missing mandatory lease must remain in the loading/failure/rollback model;
   it must not silently call a synchronous prepared loader. Editor preview is included because its
   Phase-8 profiler snapshot must observe the same async residency path as the player.
3. After those callers are migrated, remove the Phase-6 `AssetManager` synchronous prepared-asset
   facade methods and aliases for font, texture, shader program, material, and audio, plus path-based
   or raw-clip playback overloads that bypass lease ownership. Preserve synchronous source/config
   reads such as startup resource-alias loading, and private loader/task primitives needed to
   implement bounded preparation or explicit tests/tooling, only when they do not remain a competing
   public production prepared-asset API.
4. Verify any retained backend handle or material/font pointer is backed by a live `AssetLease` or is
   explicitly outside `ResidencyManager` ownership. Candidate-first/published-second lookup must not
   permit renderer, text, presentation, or audio caches to retain a residency-managed raw object after
   its lease set is replaced or cleared.
5. Remove stale thread-mode symbols, genuinely duplicate production source/cache abstractions, dead
   compatibility code, and orphaned tests. Test-only source implementations and deterministic
   executor fixtures are not duplicates merely because production has a different implementation.
6. Reconcile architecture, assets, runtime package/export, audio, Web, build, editor-profile, and
   profiler-boundary documentation, including profiler snapshot schema version `2` and the explicit
   absence of editor IPC/UI transport in this plan.
7. Run focused builds/tests for touched cleanup and fix warnings/formatting without broad unrelated
   refactors. Add integration or source-audit coverage proving production and editor-preview prepared
   assets cannot bypass request orchestration, residency accounting, or asset telemetry.

Workstream gate:

- Production source has one job system, one async typed prepared-asset path, and one indexed package
  source abstraction. Explicit test/tooling sources do not count as production alternatives.
- Production renderer, text, presentation, and audio state retain lease-backed ownership for every
  residency-managed prepared object they continue to use.
- Production and editor-preview prepared-asset activity cannot bypass request orchestration,
  residency accounting, or the Phase-8 telemetry recorder through a synchronous fallback.
- Permanent documentation matches delivered behavior and accepted limitations.

#### Workstream 9B: Full verification, completion report, and plan archival

1. Run the complete Section 16 verification matrix.
2. Perform stale-symbol, forbidden-boundary, thread-creation, platform-branch, whole-package/every-
   entry extraction, Web virtual-filesystem package handoff, and synchronous-prepared-load audits.
   The extraction audit must allow the indexed ZIP source to decompress a requested entry and the
   bootstrap validator to read the single manifest entry; it is not a ban on miniz extraction APIs.
3. Record exact measured profile values, test results, known limitations, and any approved deviations.
4. Write the final completion report, close every ledger row, mark the plan complete, and archive it
   according to repository policy.

Workstream gate:

- Every final acceptance criterion passes or is reported as a blocking issue.
- The completion report and permanent documentation are sufficient to resume without chat history.

Phase exit gate: Workstreams 9A and 9B are complete.

## 16. Required verification matrix

At minimum, final verification must cover:

- Canonical Linux threaded debug build and full affected tests.
- Linux no-thread preset build and the same executor/request/residency contract tests.
- Native threaded executor stress and shutdown tests with many yielded, canceled, failed, and
  completion-submitting jobs; no task may execute concurrently with itself.
- Deterministic fake-clock cooperative tests proving `pump()` stops selecting new steps at budget,
  a yielded 20-asset workload progresses over multiple pumps, and a new Critical job precedes queued
  Prefetch work.
- Threaded Android build plus the existing CI/emulator package-backed asset smoke. A local environment
  may report emulator unavailability, but the plan is not complete until the CI/emulator smoke passes.
- Android non-threaded configure/compile coverage, even though no non-threaded Android player is
  distributed.
- Threaded Web build with cross-origin isolation.
- Non-threaded Web build without pthread requirements.
- Web package progress tests for known length, unknown length, retry, checksum failure, and success.
- Web audio initialization/playback in both modes.
- Editor checks/tests for export-profile schema changes, plus C++ tests and documentation checks for
  the immutable `EngineTooling` profiler-snapshot handoff. Phase 8 intentionally added no editor IPC,
  polling, storage, or profiler UI transport to verify.
- C++ policy/module-boundary checks.
- Generated large/ZIP64 package tests proving a large unrequested sentinel entry is never read or
  extracted at startup and is readable later through an independent cursor.
- Residency tests for reservation pins, lease copies, Warm-to-Cold demotion, deterministic eviction,
  mandatory over-budget admission, rejected prefetch, deferred preparation, and reload.
- Structured-prefetch tests proving typed descriptor dispatch, active-variant material closure,
  static texture expansion, dynamic-source exclusion, and no cache-key-string reconstruction.
- Runtime blocker tests proving Ready handles transfer atomically into published leases, rollback
  preserves the last valid publication, eviction cannot destroy in-use renderer/text/audio objects,
  and deferred requests resume under the loading-frame service path.
- Long-form music test proving package entry reads remain bounded and no full encoded `AssetBlob` is
  retained.
- Telemetry tests proving bounded zero/8192-capacity recorder behavior, lost-event accounting,
  non-placeholder source bytes and stage durations, exact eviction reasons, and all four prefetch
  outcome classes.
- Owner-thread completion and runtime-mutation tests.
- Build/source audit proving runtime consumers contain no platform/thread-mode branches, Web no-thread
  artifacts contain no pthread requirement, and NovelTea executor code contains no raw pthread,
  `std::thread`, or `std::async` creation.
- Package-source audit proving production performs no whole-package/every-entry extraction bridge and
  no Web virtual-filesystem package write, while preserving valid indexed per-entry decompression and
  single-entry startup manifest validation.
- Production/editor-preview source and integration audit proving migrated consumers no longer call
  synchronous prepared-asset `load_*()` APIs, bypass telemetry/residency through path-based playback,
  or retain residency-managed raw backend handles/pointers without lease ownership. Synchronous
  byte/text/config reads at explicit startup/tooling boundaries remain permitted.

## 17. Known limitations accepted by this plan

- Non-threaded execution cannot parallelize CPU work and may complete prefetch much more slowly on
  any target.
- Monolithic third-party decode calls may cause isolated frame spikes in any non-threaded build.
- The initial Web player downloads the complete package before startup.
- The complete Web package must fit the selected WebAssembly address space/memory policy; package
  segmentation or range access is the later remedy for games that do not.
- The compiled typed project remains resident.
- Initial prefetching misses dynamic Lua-selected assets.
- Initial memory costs may include estimates where backend APIs do not expose exact allocation size.
- Initial eviction is cost-aware LRU, not advanced graph-distance prediction.
- Miniaudio retains a separate one-worker resource queue in threaded builds.
- Native/Android cooperative mode can still experience a blocking filesystem call inside one bounded
  read step; the executor cannot preempt an operating-system call already in progress.
- Ordinary distributed players retain aggregate telemetry but no detailed event ring by default.

These limitations are acceptable only because demand loading, loading overlays, telemetry, and stable
interfaces preserve correctness and provide evidence for later optimization.

## 18. Completion ledger

Workstreams are ordered. A later workstream may prepare tests/interfaces but must not bypass an
earlier incomplete exit gate. Every implementation session updates this ledger with files changed,
tests run, measured policy values, and any approved deviation.

Track parent phases and implementation units separately. A parent phase is complete only after its
phase gate or exit gate passes and every listed implementation unit is complete. For phases without
lettered workstreams, the phase row and same-numbered implementation-unit row advance together.
For split phases, update the applicable lettered workstream after each implementation session and
mark the parent phase complete only after all of its workstreams and the phase exit gate are complete.

### 18.1 Phase completion

| Phase | Scope | Status | Notes |
|---|---|---:|---|
| 1 | Contracts and ownership | [x] | Phase gate passed 2026-07-22; no production executor or loader implementation added. |
| 2 | Executors and build capability | [x] | Workstreams 2A and 2B complete; phase exit gate passed 2026-07-22. |
| 3 | Miniaudio build-mode correctness | [x] | Phase gate passed 2026-07-23 in threaded and cooperative Linux/Web modes. |
| 4 | Indexed package access | [x] | Workstreams 4A and 4B complete; phase exit gate passed 2026-07-23. |
| 5 | Web package bootstrap | [x] | Phase gate passed 2026-07-23 in threaded and cooperative Web modes. |
| 6 | Typed loading and residency | [x] | Workstreams 6A through 6D complete; phase exit gate passed 2026-07-23. |
| 7 | Structured prefetch and loading UX | [x] | Workstreams 7A and 7B complete at commits `5fc97e3` and `665ed18`; completion audit on 2026-07-23 corrected optional-diagnostic gating, test compilation, formatting, and matrix coverage before re-passing the phase exit gate. |
| 8 | Telemetry and editor-profiler handoff | [x] | Composition-owned bounded recorder, exact event payloads/outcomes, immutable profiler snapshot, documentation, and focused matrix complete 2026-07-23. |
| 9 | Cleanup, certification, and archival | [x] | Workstreams 9A and 9B complete; final matrix and archival gate passed. |

### 18.2 Implementation-unit completion

| Unit | Implementation scope | Status | Notes |
|---|---|---:|---|
| 1 | Contracts and ownership | [x] | Job, request/lease/generation, residency, telemetry, owner-thread, and queued-completion contracts plus fake contract tests. |
| 2A | Shared scheduler core, inline executor, and cooperative executor | [x] | Shared strict-priority/FIFO scheduler, deterministic inline controls, bounded zero-thread cooperative pumping, host frame/loading integration, and fake-clock/native no-thread tests. |
| 2B | SDL worker pool, bootstrap selection, and build/preset cutover | [x] | Fixed SDL worker pool, bootstrap-only mode selection, target-wide thread capability cutover, Web pool sizing, and threaded/cooperative race and stress coverage. |
| 3 | Miniaudio build-mode correctness | [x] | Resolved executor capability now configures miniaudio resource-manager threading, typed startup failure, and native/Web progress coverage. |
| 4A | Source result contract and production `ZipAssetSource` | [x] | Typed source metadata/errors, path- and immutable-memory-backed ZIP64 indexing, independent stored/deflated readers, storage/seekability policy, and source-level safety/concurrency/reload coverage. |
| 4B | Runtime-package loader migration and large-package validation | [x] | Path-backed native/Android package mount, metadata-only typed assembly, JSON-DOM release, synchronous per-entry bridge, and large/corrupt/reload/materialized-package coverage. |
| 5 | Web package bootstrap | [x] | Browser-owned fetch/progress/checksum/cancel/retry, one final memory-backed ZIP, no package VFS copy, and deterministic browser/startup coverage. |
| 6A | Asynchronous request orchestration and residency core | [x] | Nonblocking typed orchestration, executor reprioritization, residency admission/accounting/eviction, source generations, telemetry hooks, and three-executor contract coverage. |
| 6B | Texture, shader/material, and font-source migration | [x] | Steppable texture, shader/material, and font-source preparation; typed cache keys; owner-thread backend lifetime; threaded/cooperative coverage. |
| 6C | Audio residency and seekable package streaming | [x] | Concrete audio preparation, decoded SFX residency, seekable miniaudio VFS streaming, active-playback pinning, and threaded/cooperative coverage. |
| 6D | Measured memory profiles and full residency matrix | [x] | Measured Desktop/Android/Web presets, validated Custom export policy, runtime/telemetry policy reporting, Warm allowance enforcement, and threaded/cooperative package/visual/audio pressure matrix. |
| 7A | Structured dependency collection and prefetch generations | [x] | Immutable structured dependency index, deterministic bucket traversal, typed prefetch generations/tickets, residency-aware replacement publication, and mandatory-versus-speculative diagnostic isolation completed and audited. |
| 7B | Mandatory asset blockers, progress UI, and end-to-end prefetch matrix | [x] | Typed mandatory gate, atomic lease publication/rollback, loading-frame progress/retry integration, runtime lease consumers, and threaded/cooperative end-to-end matrix completed and audited. |
| 8 | Telemetry and editor-profiler handoff | [x] | Worker-safe aggregate/ring recorder, exact stage/outcome/correlation evidence, production composition policy, owning job/asset snapshot DTO, future-editor contract, and focused validation. |
| 9A | Production-path cleanup and permanent documentation reconciliation | [x] | Synchronous prepared facades/fallbacks removed, residency-owned handles are lease-backed, package/Web source audits are permanent, and documentation is reconciled. |
| 9B | Full verification, completion report, and plan archival | [x] | Full Linux/Web/Android/editor verification, review-finding remediation, completion report, and archival completed 2026-07-23. |

### 18.3 Implementation session log

#### 2026-07-22 — Phase 1 / Unit 1

- Added job contracts under `engine/include/noveltea/jobs/`: owner-thread guard, job IDs and
  priorities, task/context and bounded-step outcomes, progress, terminal completion, cancellation and
  shutdown executor interface, executor snapshots, and the executor-owned FIFO completion queue with
  recursive-dispatch suppression.
- Added asset request/residency contracts under `engine/include/noveltea/assets/`: request and source
  generations, request/cache states, move-only request handles and prefetch tickets, copyable
  owner-thread leases, preparation reservations, reservation pins, residency classes/costs/budgets,
  admission/accounting/eviction results, and the residency-manager interface.
- Added backend-neutral telemetry contracts under `engine/include/noveltea/core/asset_telemetry.hpp`
  and bounded fake recorders in contract tests.
- Added Catch2 contract coverage in `tests/jobs/job_contract_tests.cpp` and
  `tests/assets/asset_streaming_contract_tests.cpp`; registered the tests and all new engine public
  headers in the applicable CMake lists.
- Validation: Linux debug configure and full build passed; `noveltea_asset_tests` passed 581
  assertions in 60 test cases; all 616 non-display Linux tests passed; public-header probes,
  module-dependency inventory, C++ policy, formatting, and forbidden-backend reference audits passed;
  the complete non-threaded Web debug build passed.
- The unfiltered 628-test Linux run had 10 display-dependent readback/sandbox failures because X11
  was unavailable in the execution environment. The repository's non-display matrix passed in full,
  so this is not a Phase 1 blocker.
- Measured runtime policy values: not applicable to the contracts-only phase. Approved deviations:
  none. Blocking issues: none.

#### 2026-07-22 — Phase 2 / Workstream 2A

- Added one internal scheduler queue/state-transition core under `engine/src/jobs/` and used it from
  both `InlineJobExecutor` and `CooperativeJobExecutor`. The shared core owns process-unique IDs,
  strict Critical/Normal/Prefetch selection, same-priority FIFO-yield requeueing, cancellation,
  monotonic progress, terminal publication, shutdown, queue-latency/counter snapshots, and the
  executor-owned completion queue.
- Added platform-neutral public executor headers and an injectable monotonic `JobClock` under
  `engine/include/noveltea/jobs/`. Inline execution exposes `advance_one_step()`,
  `dispatch_one_completion()`, and finite-guarded `run_until_idle(maximum_steps)`; cooperative
  execution advances only through bounded `pump()` calls. `submit()` performs no task step or owner
  completion in either implementation.
- Extended `JobCompletionQueue` with a nonthrowing post-dispatch observer used by the scheduler to
  retain progress and terminal records through the owner callback, then retire them without adding
  another dispatcher abstraction. Recursive completion dispatch remains suppressed.
- Added host-owned integration policy in `Engine::Impl`: normal frames pump for 2 ms and dispatch at
  most 64 completions; the current synchronous project-loading boundary uses a 12 ms loading budget
  and a 256-completion limit. The executor contains no gameplay/loading-state policy. The repository
  does not yet have the asynchronous loading-screen loop introduced by later asset workstreams, so
  the loading service point is invoked around the existing synchronous load boundary.
- Added deterministic Catch2 coverage in `tests/jobs/job_executor_tests.cpp` for submit isolation,
  strict priority, FIFO round-robin yields, fake-clock deadlines, progress lifetime, cancellation
  before start/after yield/after terminal publication, failure and malformed outcomes, shutdown,
  completion recursion suppression, full observable equivalence between inline and cooperative
  execution, owner-thread delivery, and a yielded 20-asset native no-thread workload spanning
  multiple bounded pumps.
- Registered all new headers, sources, and tests in the engine module classification and test target.
  No SDL worker pool, thread-mode bootstrap selection, build/preset cutover, asset loader, or later
  phase work was added.
- Validation: Linux debug full build passed; `noveltea_asset_tests` passed 850 assertions in 71 test
  cases; all 621 non-display Linux tests passed; formatting, diff whitespace, C++ policy,
  public-header probes, module-dependency inventory, and forbidden SDL/browser/thread-creation audits
  passed. The complete non-threaded Web debug build and its C++ policy/public-header/module inventory
  targets passed.
- Approved deviations: none. Blocking issues: none. Phase 2 remains incomplete until Workstream 2B
  and the Phase 2 exit gate are complete.

#### 2026-07-22 — Phase 2 / Workstream 2B

- Added `SdlThreadPoolJobExecutor` with a fixed SDL3 worker pool, condition-variable worker sleep,
  one-step claims through the Phase-2A scheduler core, owner-thread completion dispatch, queued and
  running cancellation, nonblocking finished-thread collection, and orderly shutdown/join. The
  scheduler now protects shared records, runnable queues, snapshots, progress, and shutdown state;
  tasks execute outside the scheduler lock after an exclusive `RunningStep` claim, proving that one
  task cannot be stepped concurrently with itself.
- Added the sole executor-capability branch in host bootstrap composition. Threaded builds construct
  the SDL executor and native/Android builds apply `clamp(logical_cpu_count - 1, 1, 4)` when the
  worker count is automatic; no-thread builds construct `CooperativeJobExecutor`. Runtime,
  rendering, audio, UI, asset, and gameplay sources contain no thread-mode behavior branches.
- Converted normal host shutdown to a frame-driven executor drain so threaded Web can keep the event
  loop responsive while workers finish and handles are joined. Native destruction retains a final
  synchronous safety drain without changing executor semantics.
- Replaced `NOVELTEA_WEB_THREADS` with target-independent `NOVELTEA_ENABLE_THREADS`, added validated
  `NOVELTEA_JOB_WORKER_COUNT`, made canonical native/Android/Web configurations threaded, and added
  Linux, Android, and Web no-thread verification configurations. Only Web packages a no-thread
  compatibility player. Canonical threaded Web uses one NovelTea worker and computes
  `PTHREAD_POOL_SIZE=2` from one NovelTea worker, one miniaudio startup worker, and zero bgfx startup
  workers because bgfx multithreading remains disabled.
- Updated Web run, package, release, certification, editor-default, and documentation wiring so
  cross-origin isolation and pthread/shared-memory code are present only in threaded Web artifacts.
  Added CI compilation coverage for Linux, Android, and Web with NovelTea thread creation disabled.
- Added Catch2 coverage for SDL/cooperative terminal equivalence, cancellation after terminal
  publication, completion/cancellation races, queued/running shutdown, owner-thread callbacks, a
  four-worker yielded stress workload, and zero concurrent re-entry into the same task.
- Validation: complete Linux debug build and all 646 CTest tests passed; threaded and no-thread
  `noveltea_asset_tests` passed; C++ policy, public-header probes, and module inventory passed; Web
  threaded and no-thread players built, with the threaded link using `-pthread
  -sPTHREAD_POOL_SIZE=2` and the no-thread output containing neither pthread flags nor
  `SharedArrayBuffer`; Android x86_64 external native builds passed with threading both enabled and
  disabled; editor check passed and all 881 editor tests passed. CMake option guard negative tests,
  JSON/YAML syntax checks, stale-option audits, and thread-branch placement audits passed.
- Approved deviations: none. Blocking issues: none. Phase 2 exit gate passed; Phase 3 remains
  unstarted.

#### 2026-07-23 — Phase 2 full audit and correction

- Re-audited every Phase 2A/2B requirement against the repository instead of relying on the checked
  completion ledger. The audit found one falsely complete Workstream-2B detail: the shared scheduler
  core hard-coded `std::mutex` for runnable queues and state even when composed by
  `SdlThreadPoolJobExecutor`, contrary to Section 5.9's SDL synchronization requirement.
- Added a private scheduler-mutex backend contract. Inline and cooperative execution retain the
  standard mutex backend, while `SdlThreadPoolJobExecutor` now injects an SDL-owned mutex into the
  same scheduler core. SDL condition-variable sleep/wake coordination remains separate; task steps
  still execute outside the scheduler mutex after the exclusive one-step claim. Startup failure of
  the scheduler mutex is reported through the existing typed executor-startup path.
- Reconfirmed that executor selection and the only `NOVELTEA_ENABLE_THREADS` source branch remain in
  host/bootstrap composition, that the legacy option is absent, and that the SDL executor contains
  no `pthread_create`, `std::thread`, or `std::async` worker creation.
- Validation after the correction: canonical threaded Linux and `linux-debug-no-threads` built
  `noveltea_asset_tests`; both executions passed 1,056 assertions in 76 test cases. `cxx-policy`
  passed, including public-header, module-boundary, JSON-boundary, dependency-compiler, runtime-link,
  exception/RTTI, and source-policy checks. Canonical threaded and no-thread Web debug players built;
  the threaded link contains `-pthread -sPTHREAD_POOL_SIZE=2`, while the no-thread link omits pthread,
  pool, and `threading_pre.js` flags and its generated JavaScript contains no `SharedArrayBuffer`,
  `MessageChannel`, or `pthread_create` surface. Existing Android x86_64 threaded and no-thread CMake
  trees rebuilt and linked `libnoveltea-player.so` successfully. Native OFF/nonzero-worker and Web
  threaded/zero-worker negative configurations both failed with their intended diagnostics.
- The Gradle Android wrapper attempt stopped before native compilation because the local prebuilt
  shader fixture lacks the two `essl-300/postprocess_tint` binaries; the underlying threaded and
  no-thread Android native targets were therefore built directly and passed. This is not a Phase 2
  implementation blocker.
- Approved deviations: none. Blocking issues: none. Phase 2 remains complete after correction;
  Phase 3 and later phases remain untouched.

#### 2026-07-23 — Phase 3 / Unit 3

- Extended the audio backend initialization boundary to accept the host-resolved
  `JobExecutionConfig` and return `DiagnosticResult<void>`. `Engine::Impl` now passes the bootstrap
  configuration into `AudioSystem` and treats any audio initialization diagnostic as a fatal startup
  failure: it emits the typed diagnostic through the preview bridge, rolls back initialized
  subsystems, and returns failure instead of continuing into a rendering-only smoke path.
- Configured NovelTea's custom miniaudio resource manager explicitly. Threaded execution uses one
  miniaudio resource-manager worker; cooperative/inline execution uses zero workers together with
  `MA_RESOURCE_MANAGER_FLAG_NO_THREADING`. The selection depends only on the target-independent job
  capability passed by host composition and contains no Emscripten-specific branch.
- Defined the miniaudio worker count once in root CMake and passed that same value to the engine as a
  private compile definition and directly into the threaded Web `PTHREAD_POOL_SIZE` expression.
  Canonical threaded Web therefore remains `PTHREAD_POOL_SIZE=2` (one NovelTea worker, one miniaudio
  worker, zero bgfx workers), without a second independently maintained miniaudio count.
- Converted resource-manager, engine, and sound-group initialization failures to typed fatal
  diagnostics. Added backend policy/status fields for deterministic verification and a no-device
  test configuration that initializes miniaudio with explicit channel/sample-rate values without
  depending on a desktop audio server.
- Added Linux Catch2 coverage using a real in-memory PCM WAV for threaded initialization, native
  target-independent no-thread initialization, resource decode/load progress, voice start, bootstrap
  capability matching, and typed rejection of inconsistent execution configurations. Existing fake
  audio backends were updated to the typed initialization contract.
- Added a browser audio harness and CMake smoke target for both Web modes. The harness serves the
  sandbox with the required isolation headers, verifies the active resource-manager policy, starts
  `project:/audio/notification.mp3`, waits for both voice-start and voice-finish progress, and fails
  on backend or page errors.
- Validation: the focused 11-test audio/runtime matrix passed in both `linux-debug` and
  `linux-debug-no-threads`; `noveltea-web-audio-smoke` passed in both `web-debug` and
  `web-debug-no-threads`; threaded Web configuration reported pool size 2 with the expected
  one-plus-one worker composition. `format-check`, `module-boundary-policy`, and the aggregate
  `cxx-policy` target passed.
- Approved deviations: none. Blocking issues: none. The Phase 3 gate passed; Phase 4 and later phases
  remain untouched.

#### 2026-07-23 — Phase 4 / Workstream 4B

- Replaced the runtime loader's whole-package `AssetManager::read_binary()` plus
  `extract_compiled_package()` path. `.ntpkg` inputs now open through `AssetManager`, reuse a native
  reader path when available, construct one path-backed `ZipAssetSource`, and mount that source as
  the replacement `project:/` namespace. Non-path sources use one immutable compressed package
  buffer rather than an extracted-entry `MemoryAssetSource`.
- Added a narrow optional native-path capability to `AssetReader` and implemented it for directory
  file readers. Added read-free `ZipAssetSource` inventory reporting with uncompressed/compressed
  sizes, seekability, and central-directory CRC metadata, while retaining typed initialization,
  unsupported-storage, and path-safety failures.
- Runtime-package startup now reads only `manifest.json`, `game`, and the optional manifest-declared
  shader/material document. It decodes and assembles `LoadedCompiledPackage` before returning the
  resolved source, clears the generic JSON documents after each typed decode, and passes the typed
  package into `RunningGame` without retaining duplicate generic DOMs. Loose compiled-project JSON
  remains on its existing non-package path.
- Preserved the temporary Phase-4 synchronous per-entry `AssetManager` bridge for prepared assets.
  Unrequested entries remain indexed but unread; there is no whole-package extraction bridge and no
  Phase-5 Web download/bootstrap or Phase-6 typed residency work.
- Added generated runtime-package coverage for a 16 MiB decompressed sentinel with exactly one
  package open and zero whole-package `read_binary()` calls, later sentinel readability, release and
  reload, corruption deferred until an unrequested entry is read, required-metadata corruption, and
  Android-style materialized package replacement/reload. The tests also assert a typed-only load
  input and a path-backed ZIP mount.
- Corrected one Android-only Phase-4A migration omission discovered by the platform build: the shader
  startup smoke log now consumes `AssetSourceError.code` and `.message` instead of treating the typed
  error as a string.
- Validation: complete Linux debug build passed; aggregate Linux and Web `cxx-policy` targets passed;
  the 86-case asset suite passed 1,273 assertions and the 79-case host suite passed 1,018 assertions;
  all focused loader/runtime tests and the packaged-player smoke passed; the threaded Web debug player
  built; and Android arm64 debug APK assembly completed successfully. Two optional sandbox package
  smoke attempts could not initialize SDL because X11 was unavailable; the headless packaged-player
  smoke and direct runtime-loader coverage passed, so this is not a Phase-4 blocker.
- Measured policy evidence: the generated 16 MiB decompressed sentinel package was opened once through
  the backing directory source, incurred zero whole-package blob reads, and remained readable on two
  independent later loads. Approved deviations: none. Blocking issues: none. Workstream 4B and the
  Phase 4 exit gate are complete; Phase 5 and later phases remain untouched.

#### 2026-07-23 — Phase 5 / Unit 5

- Added the shared C++ loading-operation vocabulary for operation IDs, the five Section 13 phases,
  active/completed/failed/canceled states, byte totals, retryability, and typed diagnostics. Added a
  borrowed package-verification entry point so Web can validate `player.json`, SHA-256, and package
  metadata without creating a second retained package vector.
- Replaced the old Web bootstrap package `FS.writeFile()` path with a browser-owned streaming fetch.
  Known response lengths report exact downloaded bytes; unknown lengths remain indeterminate. The
  bootstrap cancels on navigation, classifies retryable transport failures, starts retries with a new
  operation ID, and exposes fatal checksum/config/package failures through the loading shell.
- Added `web/player_shell.html` with current-phase text, determinate/indeterminate progress, fatal
  diagnostics, and retry UI. The reusable bootstrap state machine is separate from Emscripten glue so
  its state transitions can be tested deterministically and embedded by the editor-generated shell.
- Added the Web-to-C++ package handoff and progress bridge. After browser checksum verification, one
  completed JavaScript byte view is retained only until Emscripten runtime initialization. It is then
  copied directly into the final C++ archive allocation, the JavaScript reference is cleared
  immediately, and a memory-backed `ZipAssetSource` is passed through `EngineConfig`/`GameHost` into
  the indexed runtime-package loader. `/game.ntpkg` is never created in Emscripten's VFS.
- Preserved Phase 4's synchronous per-entry bridge and on-demand ZIP reads. Web startup reads only
  `manifest.json`, `game`, and optional shader/material metadata; it does not extract or retain every
  package entry. Desktop and Android continue to use their path-backed package flow unchanged.
- Added C++ contract/ownership tests, deterministic Node Web-API tests, real Chromium bootstrap
  contracts, and a full generated-package Emscripten smoke. Required cases cover known and unknown
  lengths, retry, checksum failure, cancellation/navigation, duplicate-buffer avoidance, direct
  memory-backed ZIP lifetime, on-demand entry reads, and successful startup.
- Validation: Linux domain/content/asset/host suites passed 134/1,031/1,295/1,018 assertions across
  16/67/87/79 cases. The seven deterministic bootstrap tests and ten Chromium contract checks passed.
  Threaded and cooperative Web debug players built and each completed the full package smoke with one
  39,236-byte package request and the ordered phases `DownloadingPackage`, `VerifyingPackage`,
  `OpeningPackageIndex`, and `LoadingStartupContent`; the smoke verified no `/game.ntpkg` VFS entry,
  no retained JavaScript package after native handoff, and no retained bootstrap C++ package pointer
  after ownership moved into `ZipAssetSource`. Linux and Web C++ policy targets and C++ formatting
  passed. The editor staging/export regression run passed 881 tests in 150 files (four existing skips).
- Approved deviations: none. Blocking issues: none. The Phase 5 gate is complete; Phase 6 and later
  phases remain untouched.

#### 2026-07-23 — Phase 6 / Workstream 6A

- Extended `JobExecutor` and the shared scheduler core with owner-thread `set_priority()`. Queued
  work moves to the tail of the destination priority queue without executing a step or completion;
  running work changes accounting immediately and requeues at the new priority only after yielding;
  unknown, canceled, and terminal jobs cannot be reprioritized. Inline, cooperative, and SDL
  executors expose the same behavior and snapshot accounting.
- Added generic nonblocking typed request orchestration in
  `engine/include/noveltea/assets/asset_request_orchestrator.hpp`. The implementation owns typed
  cache keys, process-unique request/source/prefetch generations, request coalescing, independent
  consumer and ticket cancellation, retry after failure/eviction, Ready reservation pins, copyable
  lease pins, highest-live-interest priority promotion/demotion, deferred preparation retry, source
  generation replacement, and owner-thread finalization/destruction. It exposes no blocking
  `wait()` or prepared-asset `get()` API.
- Implemented `AssetResidencyManager` with source, prepared-CPU, GPU, audio, and temporary-domain
  current/high-water accounting; preparation reservations; Pinned/Warm/Cold classification;
  demand/prefetch admission; mandatory over-budget diagnostics; speculative rejection;
  deterministic Cold-before-Warm, least-recently-used, larger-cost, stable-key eviction; warm-ticket
  reference counts; lease/reservation eviction protection; and owner-thread destruction callbacks.
- Integrated `AssetTelemetrySink` hooks for requests, cache hits/misses, coalescing, priority changes,
  source/preparation/finalization outcomes, pins, budget pressure, eviction, and reload. Null and
  recording sinks use the same scheduling/residency paths; telemetry does not make control
  decisions.
- Extended `AssetManager` with configured asynchronous request/prefetch entry points for fonts,
  textures, shader programs, materials, and audio, plus source-generation invalidation and deferred
  retry. As the deliberate 6A compatibility bridge, existing synchronous typed loaders execute only
  during owner-thread finalization and currently contribute zero prepared-resource cost. Worker-side
  visual/audio source reads, decode, backend lifetime migration, real cost measurement, and profile
  defaults remain exclusively in Workstreams 6B, 6C, and 6D.
- Added Catch2 coverage for queued and running-yield reprioritization; terminal/unknown rejection;
  coalescing; per-consumer and last-interest cancellation; Ready-to-lease pin transfer; copied lease
  pins; Warm-to-Cold behavior; deterministic eviction; owner-thread destruction; generation
  replacement; deferred preparation; rejected speculative preparation/residency; mandatory
  over-budget demand; retry/reload; telemetry; and the `AssetManager` owner-finalization bridge. The
  same request/residency contract runs under inline, cooperative, and SDL executors.
- Validation: canonical `linux-debug` and `linux-debug-no-threads` built
  `noveltea_asset_tests`; both executions passed 1,539 assertions in 95 test cases. Aggregate
  `cxx-policy`, `cxx-runtime-policy`, `cxx-dependency-policy`, `module-boundary-policy`,
  `json-boundary-policy`, public-header probes, repository `format-check`, touched-file
  `clang-format --dry-run --Werror`, and `git diff --check` passed.
- Measured memory-profile defaults: not applicable until Workstream 6D. Approved deviations: none.
  Blocking issues: none. Workstream 6A is complete; parent Phase 6 remains incomplete until
  Workstreams 6B, 6C, and 6D and the Phase 6 exit gate pass.

#### 2026-07-23 — Phase 6 / Workstream 6B

- Replaced the visual-domain 6A compatibility adapters with loader-provided concrete preparation
  tasks. `AssetManager::request_*()` and `prefetch_*()` now create texture, shader-program,
  material, and font-source tasks and submit them through the existing typed orchestrators. Added
  public typed cache-key builders for those domains, including source-generation identity and
  texture sampler, shader variant, material ID, and font-family/style dimensions.
- Added a shared incremental source-read helper that opens through `AssetManager`, advances in
  bounded 256 KiB steps, reports monotonic byte progress, honors cancellation between steps, and
  preserves typed source diagnostics. `AssetManager::stat()` now exposes mounted-source metadata for
  preparation estimates without reading the asset.
- Added `TexturePreparationTask`: source reads and bimg RGBA8 decode occur in worker/cooperative
  steps, linear-filtered textures generate one mip level per yielded step, and only owner
  finalization creates the bgfx texture. Residency records exact uploaded GPU bytes and eviction
  destroys the bgfx handle on the owner thread.
- Added `ShaderMaterialPreparationTask` specializations. Compiled vertex and fragment binaries are
  read incrementally before owner-thread bgfx shader/program creation; material definitions are
  copied, parameter assignments are validated in bounded steps, and the resident definition reports
  prepared-CPU cost. Owner-thread eviction destroys programs or owned material definitions.
- Added `FontSourcePreparationTask`: regular and optional styled faces are read incrementally,
  optional source failure retains synthetic-style fallback, and owner finalization constructs a
  private FreeType/HarfBuzz family from the prepared bytes. Font-file bytes are charged to the source
  domain and owner-thread eviction unregisters the private family. Glyph-atlas generation and glyph
  caching remain under the existing text-renderer cache policy.
- Preserved `load_texture()`, `load_shader_program()`, `load_material()`, and `load_font()` as working
  synchronous compatibility paths. Audio remains on the explicit 6A owner-finalization adapter for
  Workstream 6C. Production blocker composition and final removal of parallel synchronous consumer
  paths remain in the already ordered later integration/cleanup work; no 6C, 6D, 7, 8, or 9 code was
  implemented.
- Added concrete preparation coverage in `tests/assets/visual_asset_preparation_tests.cpp` for
  demand, prefetch/demand coalescing, cancellation, source-generation keys, residency accounting,
  owner-thread finalization/destruction, eviction/reload, and a real FreeType/HarfBuzz font-source
  register/evict cycle. The texture contract runs under inline, cooperative, and SDL thread-pool
  executors and verifies that threaded source reads occur off the owner thread.
- Validation: canonical `linux-debug` and `linux-debug-no-threads` built and ran
  `noveltea_asset_tests`; both passed 1,652 assertions in 100 test cases. `noveltea_text_tests`
  passed 230 assertions in 22 cases and `noveltea_render_backend_tests` passed 318 assertions in 39
  cases. Repository `format-check`, touched-file `clang-format --dry-run --Werror`, aggregate
  `cxx-policy` (including public-header, module-boundary, dependency, runtime-link, exception/RTTI,
  and source-policy checks), and `git diff --check` passed.
- Measured profile defaults remain deferred to Workstream 6D. Approved deviation: the workstream gate
  now states the concrete async path boundary explicitly; existing synchronous methods remain
  compatibility paths until the already ordered production blocker integration and cleanup.
  Blocking issues: none. Workstream 6B is complete; parent Phase 6 remains incomplete until
  Workstreams 6C and 6D and the Phase 6 exit gate pass.

#### 2026-07-23 — Phase 6 / Workstream 6C

- Replaced the audio-domain 6A owner-finalization adapter with a concrete miniaudio preparation
  task. `AssetManager::request_audio()` and `prefetch_audio()` now use a typed audio cache key and a
  loader-provided task rather than invoking the synchronous loader during finalization. Binding or
  replacing the audio loader advances the source generation like the other typed loader domains.
- Added a source-bound `AssetReaderFactory` selected through `AssetManager`. The factory retains the
  exact mounted source and logical path from preparation time and opens a fresh independent reader
  for each consumer. A resident stream therefore remains on its original package generation after a
  namespace replacement instead of drifting to the replacement mount.
- Added bounded SFX preparation. Encoded input is read in 256 KiB steps, miniaudio decodes at most
  256 KiB of output per yielded step to 48 kHz stereo float PCM, cancellation is observed between
  steps, and owner finalization registers the completed decoded cache. Residency charges exact PCM
  bytes to `audio_bytes`; eviction unregisters and releases the cache on the owner thread.
- Added a custom miniaudio VFS backed by `AssetReaderFactory`. Music and ambience preparation validates
  direct seekability without reading payload bytes, and playback opens independent package readers
  for miniaudio's stream data sources. Long-form playback no longer retains a whole-file encoded
  `AssetBlob`; miniaudio's two one-second decoded pages are conservatively charged as 768,000 audio
  bytes per resident stream source at the configured 48 kHz stereo float format.
- Added lease-aware voice and track playback to `AudioSystem`. A voice or track started from
  `AssetLease<AudioAsset>` retains that lease until the backend reports its voice inactive. Backend
  clip destruction is also deferred while any voice still references the clip, so residency eviction
  and owner teardown cannot destroy active audio. Stopping and collecting the final voice releases
  the pin and completes deferred destruction.
- Preserved synchronous audio loading and raw-handle playback as compatibility paths until the
  already ordered mandatory blocker integration and final cleanup. The synchronous long-form path
  was nevertheless moved to the same seekable VFS stream boundary, so compatibility playback does
  not reintroduce whole-file music residency. No Workstream 6D or Phase 7–9 implementation was added.
- Added `tests/assets/audio_asset_preparation_tests.cpp` with inline, cooperative, and SDL executor
  coverage for bounded decoded preparation, exact accounting, active-voice pinning, cancellation,
  mandatory over-budget diagnostics, eviction/reload, source-generation replacement, seek activity,
  bounded long-form reads, and typed non-seekable failure. An actual stored-entry `ZipAssetSource`
  fixture proves preparation and playback perform zero `read_binary()` calls and never materialize a
  whole-entry `AssetBlob`.
- Validation: canonical `linux-debug` and `linux-debug-no-threads` built `noveltea_asset_tests` and
  `noveltea_host_tests`; both asset suites passed 1,788 assertions in 106 test cases. Focused audio
  host coverage passed 165 assertions in 15 cases for threaded Linux and 158 assertions in 15 cases
  for no-thread Linux. Both aggregate `cxx-policy` targets passed, including public-header,
  module-boundary, dependency, runtime-link, exception/RTTI, and source-policy checks. Touched-file
  `clang-format --dry-run --Werror` and `git diff --check` passed. Threaded and no-thread Web players
  built, and `noveltea-web-audio-smoke` completed playback successfully in both threaded and
  cooperative browser modes.
- Measured profile defaults remain deferred to Workstream 6D. The 256 KiB preparation quantum,
  exact decoded PCM charge, and 768,000-byte stream-page charge are implementation measurements for
  this workstream rather than Low/Balanced/High profile defaults. Approved deviations: none.
  Blocking issues: none. Workstream 6C is complete; parent Phase 6 remains incomplete until
  Workstream 6D and the Phase 6 exit gate pass.

#### 2026-07-23 — Phase 6 / Workstream 6D

- Measured the finalized Phase 6 visual and audio representations against representative repository
  fixtures and documented the derivation in `docs/assets/ASSET_MEMORY_PROFILES.md`. The recorded
  units include exact RGBA8 full-mip residency for 3840 x 2160 (44,236,220 bytes), 1920 x 1080
  (11,058,620 bytes), 2560 x 1440 (19,660,652 bytes), and 1024 x 1024 (5,592,404 bytes), exact
  30-second 48 kHz stereo float PCM (11,520,000 bytes), the existing two-page long-form stream charge
  (768,000 bytes), and current package audio/font source fixtures. Preset envelopes are rounded MiB
  capacities derived from those units rather than host RSS guesses.
- Added measured Low/Balanced/High defaults for Desktop, Android, and Web. Desktop prepared-CPU/GPU/
  audio/temporary ceilings are 64/128/32/32 MiB, 128/256/64/64 MiB, and 256/512/128/128 MiB;
  Android uses 48/96/24/24, 96/192/48/48, and 192/384/96/96 MiB; Web uses 32/64/16/16,
  64/128/32/32, and 128/256/64/64 MiB. Warm-prefetch allowances are 20/30/40 percent on Desktop,
  15/25/35 percent on Android, and 10/20/30 percent on Web. Source-entry residency follows the
  prepared-CPU ceiling; the immutable compressed Web package backing remains outside the evictable
  pool.
- Added shared runtime policy types and resolution. Custom profiles inherit omitted fields from the
  target's Balanced baseline, require positive prepared-CPU/GPU/audio values, require at least 1 MiB
  of temporary preparation memory, and constrain the Warm allowance to 0 through 100 percent with
  exact diagnostic paths. Missing policy data in older player-config version-2 files resolves to the
  target's Balanced profile.
- Extended platform export profiles and the export dialog with Low/Balanced/High/Custom selection,
  MiB Custom inputs, resolved-byte preview, strict schema validation, and deterministic policy
  resolution. Desktop, Web, and Android staging write the fully resolved byte ceilings and Warm
  percentage into `player.json`; no omitted or zero field means unlimited.
- Wired production engine composition to construct the asynchronous request orchestrators with the
  resolved residency manager. Player startup logs the target, preset, byte ceilings, and Warm
  allowance. `AssetTelemetrySnapshot` retains the same resolved policy through a
  `MemoryPolicyResolved` event beside current and high-water domain accounting.
- Added an independent Warm-residency allowance on prepared CPU, GPU, and audio. Speculative
  admission or Cold-to-Warm promotion is rejected before consuming mandatory headroom. Demand retains
  existing deterministic cost-aware eviction and may remain over budget when correctness requires an
  oversized or pinned asset. Releasing the final pin re-enforces total residency first with the
  documented Cold-before-Warm ordering, then enforces the independent Warm allowance; mandatory
  over-budget residency remains protected only while it is actively reservation/lease-pinned.
- Added the `noveltea_phase_6d_asset_matrix` CTest aggregate. It covers inline/cooperative/SDL request
  semantics, deterministic residency pressure/high-water accounting, measured target policy
  resolution, texture/shader/material/font preparation, decoded and seekable-streamed audio, and
  native/Web/Android-style package source paths. The same tagged matrix passed in threaded and
  no-thread Linux builds.
- Validation: `noveltea_asset_tests` passed 1,870 assertions in 108 cases in both `linux-debug` and
  `linux-debug-no-threads`; `noveltea_content_tests` passed 1,039 assertions in 68 cases in both
  builds. The 6D CTest aggregate and player-config compatibility/validation tests passed in both
  modes. Threaded and no-thread Web release players built successfully, and the Android arm64-v8a
  debug APK assembled through Gradle/CMake. Editor type checking, formatting, focused lint, and 17
  focused export/deployment/staging tests passed; three
  environment-gated staging cases remained skipped. C/C++ `format-check`, aggregate `cxx-policy`,
  public-header probes, module/dependency/runtime-link/JSON/exception/RTTI/source policies, and
  `git diff --check` passed.
- Approved deviations: none. No Phase 7, 8, or 9 implementation was added. Blocking issues: none.
  Workstream 6D and parent Phase 6 are complete.

#### 2026-07-23 — Phase 6 completion audit

- Corrected two falsely complete Phase 6 residency/request details found by the all-workstream audit.
  Active jobs now publish the declared `Reading`, `Preparing`, and
  `WaitingForOwnerFinalization` cache states through a worker-safe phase signal instead of remaining
  externally `Queued` until completion dispatch.
- Releasing the final reservation or lease pin now invokes full budget enforcement. Total residency
  pressure is resolved with deterministic Cold-before-Warm eviction before the independent Warm
  allowance is enforced, so newly evictable mandatory assets cannot remain permanently over budget.
- Added focused Workstream 6D regression coverage for the complete cache-state sequence, final-pin
  total-budget enforcement, and combined total/Warm pressure ordering. Approved deviations: none.
- Validation after the audit: `noveltea_asset_tests` passed 1,900 assertions in 111 cases and
  `noveltea_content_tests` passed 1,039 assertions in 68 cases in both `linux-debug` and
  `linux-debug-no-threads`; `noveltea_host_tests` passed 1,018 threaded and 1,011 cooperative
  assertions across 79 cases. The Phase 6D CTest aggregate passed in both modes. C/C++ formatting,
  aggregate policy, public-header, module/dependency/runtime-link/JSON/exception/RTTI/source checks,
  and `git diff --check` passed. Both Web release players and threaded/cooperative browser audio
  smoke targets built and passed, and the Android arm64-v8a debug APK assembled. Editor type checking,
  formatting, and the full renderer suite passed 882 tests with four environment-gated skips; the
  installed Node 22 runtime emitted the repository's Node 24 engine-version warning but caused no
  validation failure. Blocking issues: none.

#### 2026-07-23 — Phase 8 telemetry and editor-profiler handoff

- Reconciled completion tracking with the reviewed repository baseline: Phase 7A is present at
  `5fc97e3`, and Phase 7B is present at the requested baseline `665ed18`. No Phase 7 implementation
  was added during this session.
- Added one composition-owned `AssetTelemetryRecorder`. Ordinary player composition keeps complete
  aggregate counters/high-water values with detailed-event capacity `0`; preview/test composition
  keeps a fixed ring of the newest `8,192` events and reports overwrite loss separately. Recording is
  worker-safe, snapshot capture is owner-thread-only, and the sink remains observational.
- Replaced placeholder asset telemetry payloads with real source byte totals for fully-read texture,
  shader, font, and decoded-audio tasks; measured source-read, preparation, and owner-finalization
  durations; exact execution mode and eviction reason; stable request failure/cancellation and budget
  codes; current/high-water memory; and retained job/request/prefetch-generation correlation.
  Seekable streamed audio correctly reports zero preparation-read bytes because payload data is read
  later by the streaming voice rather than by asset preparation.
- Implemented mutually exclusive `PrefetchUsed`, `PrefetchLate`, `PrefetchMiss`, and
  `PrefetchUnused` classification at demand/eviction boundaries. Completed prefetches retain their
  producing job and generation identity through later demand or eviction reporting.
- Added schema-versioned, owning `AssetProfilerSnapshot` capture that combines
  `JobExecutorSnapshot` and `AssetTelemetrySnapshot`. Exposed it through `EngineTooling` and documented
  the future editor transport, retention, versioning, cadence, and UI boundaries without adding IPC,
  polling, charting, or profiler UI.
- Added `noveltea_asset_telemetry_tests` and the `noveltea_phase_8_asset_telemetry` CTest gate. The
  matrix covers aggregate-only and bounded-ring retention, concurrent recording, loss accounting,
  memory high-water, queue latency, real stage payloads, budget pressure, reload/eviction churn, all
  four prefetch outcomes, typed orchestration, concrete texture/shader/material/font preparation,
  decoded audio, and stored-package seekable audio across inline, cooperative, and SDL-threaded
  execution.
- Validation: the focused executable passed `702` assertions in `23` cases under both `linux-debug`
  and `linux-debug-no-threads`; the Phase 8 CTest gate passed in both presets. The engine facade public
  header probe, aggregate `cxx-policy`, module boundary policy, dependency inventory, Phase 8-owned
  clang-format ranges/files, and `git diff --check` passed.
- Repository-wide validation limitations are pre-existing Phase 7 working-tree defects outside this
  phase: `noveltea_asset_tests` cannot compile because
  `tests/assets/structured_prefetch_tests.cpp` references nonexistent
  `AudioOperationPurpose::GameplayTransient`, and the global `format-check` reports unformatted Phase
  7 files. These do not block the focused Phase 8 implementation or its validation. Approved
  deviations: none. Phase 8 is complete; Phase 9 remains unimplemented.

#### 2026-07-23 — Phase 7 completion audit after Phase 8

- Corrected the two repository-wide Phase 7 defects recorded by the Phase 8 session: the structured
  prefetch test now uses the current `AudioOperationPurpose::Gameplay` contract, and every Phase 7
  production/test integration file passes repository-wide `clang-format` validation.
- Corrected one falsely complete correctness boundary. Collector diagnostics are now retained by
  semantic bucket: invalid current-publication dependencies and global index configuration remain
  mandatory failures, while direct-next and adjacent speculative diagnostics stay observable without
  aborting an otherwise-valid publication. Material and Layout closure diagnostics are retained with
  their immutable dependency records so the same defect blocks only when that record is mandatory.
- Added regression coverage proving speculative renderer-variant failures do not block a valid
  current publication, candidate rollback preserves the previously published lease set, terminal
  non-retryable failures remain terminal, and retry/cancellation plus used/late/missed/unused prefetch
  behavior execute in both cooperative and SDL-threaded matrices.
- Validation: the Phase 7A and 7B CTest gates passed in `linux-debug` and
  `linux-debug-no-threads`; the complete asset suite passed 2,241 assertions in 124 cases in both
  modes; host tests passed 1,018 threaded and 1,011 cooperative assertions in 79 cases; render-backend
  tests passed 318 assertions in 39 cases in both modes. Threaded and no-thread Web debug players and
  their aggregate C++ policy targets built successfully. Repository `format-check`, both Linux
  aggregate `cxx-policy` targets, and `git diff --check` passed. Approved deviations: none. Blocking
  issues: none. Phase 7 remains complete; Phase 8 and later implementation were not changed.

#### 2026-07-23 — Phase 8 completion audit at `0291214`

- Corrected falsely complete prefetch outcome semantics. `PrefetchUsed` is now emitted only when the
  first Demand consumer actually takes its Ready lease, not when a Ready handle is created. Canceling
  a Ready handle therefore leaves the completed prefetch eligible for `PrefetchUnused`, concurrent
  Demand consumers cannot duplicate one lifecycle outcome, and an older Ready consumer cannot claim
  a newer resident-prefetch generation. Completed-prefetch provenance remains correlated after stale
  ticket release until the lifecycle is claimed or evicted.
- Corrected incomplete stage evidence. Preparation and owner-finalization failures have distinct
  event kinds and contribute their measured durations to the corresponding aggregates. Successful
  owner finalization is recorded before later admission/discard outcomes, preparation-only tasks no
  longer emit zero-valued source-read placeholders, and deferred mandatory preparation now emits the
  stable `assets.preparation_deferred` budget-pressure event.
- The recorder now assigns timestamps inside its bounded recording critical section, preserving
  chronological retained events under concurrent producers. The owning profiler DTO schema advanced
  to version `2` for the added event kinds; no live runtime records or control dependencies were
  introduced.
- Added regression coverage for canceled versus acquired Ready handles, one outcome per lifecycle,
  overlapping resident-prefetch generations, deferred pressure, concurrent timestamp order,
  preparation/finalization failures, failed-stage aggregates, and absence of false material
  source-read events. Updated the assets overview and editor-profiler handoff documentation.
- Validation: `noveltea_asset_telemetry_tests` passed 764 assertions in 25 cases and
  `noveltea_asset_tests` passed 2,243 assertions in 124 cases in both `linux-debug` and
  `linux-debug-no-threads`. The Phase 7A, Phase 7B, and Phase 8 CTest gates passed in both presets.
  Repository `format-check`, both aggregate `cxx-policy` targets (including public-header,
  module-boundary, dependency, JSON, exception/RTTI, and runtime-link checks), and `git diff --check`
  passed. Approved deviations: none. Blocking issues: none. Phase 8 is complete; Phase 9 remains
  unimplemented.

#### 2026-07-23 — Post-Phase-8 remaining-work review at `27af66f`

- Reviewed Workstreams 9A and 9B against the completed request/residency, structured-prefetch,
  mandatory-publication, and telemetry implementations. Their order remains correct: cleanup and
  production-path closure must complete before full certification and archival. No additional phase
  or workstream is required.
- Clarified that remaining synchronous prepared-asset fallbacks are not merely obsolete APIs. Current
  production/editor-preview call sites in world presentation, bgfx material binding, ActiveText/font
  resolution, and runtime/preview audio can bypass residency ownership and Phase-8 telemetry. Phase
  9A must migrate those callers first, then remove the public prepared-asset facade and path/raw-audio
  compatibility overloads while preserving explicit synchronous byte/text/config startup boundaries.
- Clarified the package-source audit after confirming production already uses indexed ZIP access.
  Per-entry miniz decompression, the single manifest-entry validation read, and test/tooling-only
  `MemoryAssetSource` fixtures are valid; whole-package/every-entry reconstruction and the old Web
  virtual-filesystem handoff are the forbidden paths.
- Corrected the final editor verification boundary. Phase 8 delivered the schema-versioned owning C++
  snapshot and future-transport documentation, but intentionally did not add editor IPC, polling,
  storage, or profiler UI transport. Section 16 now verifies the actual handoff rather than requiring
  nonexistent editor transport work.
- Plan-only review; no Phase 9 implementation or completion tracking changed. Approved deviations:
  none. Blocking issues: none.

#### 2026-07-23 — Workstream 9A production-path cleanup

- Removed the public synchronous prepared-asset `AssetManager` facade and aliases for font, texture,
  shader program, material, and audio. Removed public raw-clip/path/alias playback overloads from
  `AudioSystem`; prepared playback now accepts and retains `AssetLease<AudioAsset>`.
- Migrated world presentation, bgfx material/shader/texture binding, mounted-Layout fonts,
  ActiveText, runtime audio, editor-preview audio, and sandbox postprocess tooling to mandatory or
  Demand/Startup request paths. Published world/Layout/audio state and tooling postprocess state retain
  leases for the lifetime of backend handles and definition pointers. The bgfx material binder no
  longer owns a duplicate cache of residency-managed texture handles.
- Confirmed the packaged runtime already uses one indexed `ZipAssetSource`: native/Android use the
  path-backed form and Web transfers one immutable archive allocation directly to the memory-backed
  form. Production contains no whole-package/every-entry `MemoryAssetSource` reconstruction and no
  `.ntpkg` write to Emscripten's virtual filesystem. Test/tooling memory sources remain supported.
- Added `noveltea_phase_9a_production_asset_paths`, a permanent source-policy CTest that rejects the
  deleted synchronous facades, raw/path-based production audio, audited synchronous fallbacks,
  sandbox postprocess bypass, production package materialization, Web package VFS writes, and the
  removed `NOVELTEA_WEB_THREADS` symbol.
- Reconciled architecture, asset/residency, package/export/Web, runtime audio, rendering, build,
  engine asset, and editor-profiler documentation. Profiler snapshot schema version `2`, the
  preview/test 8,192-event policy, ordinary-player aggregate-only policy, and the absence of editor
  IPC/polling/storage/UI transport are explicit.
- Validation: canonical threaded Linux configure/full build passed. The Phase-9A source-policy CTest
  passed. Threaded focused suites passed: asset 2,220 assertions/121 cases, telemetry 764/25, host
  1,074/79, text 230/22, render backend 318/39, UI 485/57, and UI backend 540/37. The cooperative
  Linux build passed for asset, telemetry, and host targets; their suites passed 2,219/121, 764/25,
  and 1,067/79 respectively. Aggregate `cxx-policy`, public-header/module/dependency/JSON/runtime
  policy checks, and `format-check` passed. Approved deviations: none. Blocking issues: none.
- Workstream 9A is complete. Phase 9 remains incomplete because Workstream 9B's full platform matrix,
  completion report, and archival were intentionally not performed.

#### 2026-07-23 — Phase 9B verification, review remediation, report, and archival

- Repaired ActiveText font-request invalidation by making the presenter source-generation-aware and
  adding an initialization-plus-project-font-configuration integration test.
- Replaced filename-based streaming-audio ZIP storage with explicit per-entry storage policy and
  required-seekable validation from editor compilation through the native package writer.
- Made path-backed ZIP generations retain one open archive identity and added same-path atomic
  replacement coverage for stored and compressed entries.
- Added owner-thread atomic preparation-reservation resizing. Texture preparation now sizes decoded
  dimensions and mip buffers before decode; decoded audio sizes full PCM before allocation. Oversized
  prefetch is rejected and mandatory work defers or runs serially according to the plan's budget
  semantics.
- Made Web teardown event-loop-driven instead of spinning the owner thread.
- Bound candidate mandatory asset gates before initial presentation publication; the exact Android
  package smoke exposed and verified this sequencing requirement.
- Fixed repository diff hygiene and reconciled permanent asset, export, UI, host-lifecycle, and
  memory-profile documentation.
- Final validation passed: Linux threaded 740/740, Linux cooperative 740/740, both Web builds, Android
  threaded and cooperative native builds, API 24 and API 35 exported-package lifecycle smokes,
  C++ policy/format/diff checks, editor checks, and 883 passing editor tests with 4 expected skips.
- Remote GitHub Actions was not invoked because the work remained intentionally uncommitted. The
  completion report records this validation-venue deviation and the equivalent local job/emulator
  coverage.
- Wrote
  `docs/archive/reports/THREADING_ASSET_STREAMING_AND_PREFETCH_COMPLETION_REPORT.md` and archived this
  plan under `docs/archive/plans/`.
- Phase 9B and the implementation plan are complete. No blocking issue remains.

## 19. Final acceptance criteria

This plan is complete when all of the following are true:

1. Production native, Android, and primary Web builds use the SDL-backed threaded executor.
2. Every supported target can compile and run with thread creation disabled through the same
   platform-neutral cooperative executor.
3. Only the Web player exposes the non-threaded mode as a distributed-player option for now.
4. Runtime and asset consumers use one executor/request contract without build-mode or platform
   branches.
5. `CooperativeJobExecutor` advances only through bounded `pump()` steps and never executes work from
   `submit()`.
6. Job terminal states, cancellation, progress, shutdown, and owner completion semantics are shared
   across inline, cooperative, and SDL implementations.
7. `AssetSource` remains a synchronous independent-reader boundary with metadata and stable source
   errors; `AssetManager` owns asynchronous typed orchestration.
8. Production prepared-asset consumers use request handles and leases rather than parallel
   synchronous load APIs or raw cache pointers.
9. Packaged native games do not read/extract the complete `.ntpkg` into RAM, and ZIP64/seekability
   policies are validated.
10. Web reports full-package download progress and avoids retaining every extracted entry.
11. Prepared asset residency is budgeted, reservation/lease-pinned while active, and evictable when
   Cold/Warm policy permits.
12. Long-form package-backed music/ambience uses bounded seekable streaming rather than whole-file
   encoded residency.
13. Structured prefetch runs in the background, uses generation tickets, and yields to demand work.
14. A prefetch miss remains correct through on-demand loading and the mandatory asset-blocker path.
15. Asset/job telemetry exposes memory peaks, misses, stalls, evictions, queue latency, and wasted
   prefetch without controlling correctness.
16. Audio works in threaded and non-threaded execution modes with explicit miniaudio threading
    policy.
17. Owner-thread runtime mutation and renderer/RmlUi finalization invariants remain intact.
18. Temporary-plan completion tracking and final documentation accurately describe the delivered
    system and accepted limitations.

All final acceptance criteria passed on 2026-07-23. Current behavior and operational requirements
are documented under the active asset, runtime export, UI, host-contract, and build documentation
trees. Future package segmentation, profiler UI/transport, or prediction work requires a new scoped
plan.
