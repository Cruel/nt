# C++ No-Exceptions / No-RTTI Phase 9 Report

## Scope

This report compares the last pre-migration revision,
`347bb338a36396037398d0f35184d7296286b6c8`, with post-Phase-8 revision `6b2f6e1`.
The baseline is the parent of the first dedicated C++ runtime-policy commit. Measurement data is
stored in `phase9-baseline.json` and `phase9-current.json` beside this report.

The comparison used an Intel Core Ultra 7 265K host with 16 available logical CPUs, Ubuntu GCC
13.3.0, and Emscripten 6.0.0. Native builds used `Release`; Web builds used `MinSizeRel`. Devtools and
render-performance logging were disabled. Dependency versions were held constant. Native baseline
dependencies used the ordinary `x64-linux` triplet; the current build used the policy
`x64-linux-noveltea` triplet.

No LTO option was enabled in either revision. This is therefore an equal non-LTO comparison, not an
estimate of a future LTO release.

## Reproduction

Configure a native release build in a clean directory with `NOVELTEA_BUILD_BENCHMARKS=ON`, build
`noveltea-benchmark`, `noveltea-player`, and `noveltea-sandbox`, and optionally produce matching
MinSizeRel Web player and sandbox artifacts. Then collect one revision with:

```sh
python3 scripts/release_benchmark.py \
  --label current \
  --revision "$(git rev-parse HEAD)" \
  --linux-build build/phase9-current-linux \
  --web-build build/phase9-current-web \
  --output docs/architecture/benchmarks/phase9-current.json \
  --iterations 1000 --samples 11
```

The collector intentionally measures one supplied build at a time. Historical checkout creation,
build orchestration, and cross-revision comparison remain outside the reusable tool. The baseline and
current collectors must run on the same host without concurrent benchmark jobs. The JSON files retain
artifact hashes and native microbenchmark results so later reports can distinguish measurement changes
from artifact changes.

The one-frame and 120-frame process measurements below were captured by the temporary Phase 9
comparison runner and retained in the raw evidence. They are intentionally not part of the permanent
collector because sandbox command-line orchestration is not a stable release-benchmark contract.

## Artifact Size Results

| Artifact | Baseline raw | Current raw | Delta | Baseline gzip | Current gzip | Delta |
|---|---:|---:|---:|---:|---:|---:|
| Linux player | 18,179,056 | 16,934,144 | -6.85% | 7,503,716 | 7,145,500 | -4.77% |
| Linux sandbox | 18,135,664 | 16,894,016 | -6.85% | 7,482,780 | 7,129,479 | -4.72% |
| Web player Wasm | 8,455,803 | 8,588,069 | +1.56% | 2,050,903 | 2,093,044 | +2.05% |
| Web player JavaScript | 440,651 | 438,875 | -0.40% | 94,478 | 94,021 | -0.48% |
| Web sandbox Wasm | 4,988,255 | 4,860,782 | -2.56% | 1,807,983 | 1,807,773 | -0.01% |
| Web sandbox JavaScript | 257,131 | 256,318 | -0.32% | 58,989 | 58,741 | -0.42% |

The native result is a clear size improvement. Web results are mixed: the player Wasm payload grew
slightly, while the sandbox Wasm payload shrank. Shared `.data` payloads were byte-identical in raw
size; tiny gzip differences are compression-stream noise rather than content growth.

After `strip --strip-all`, the Linux player decreased from 15,629,504 to 14,792,840 bytes (-5.35%)
and the sandbox decreased from 15,588,800 to 14,756,200 bytes (-5.34%). The native reduction is
therefore not merely removed debug or symbol-table data.

## Runtime Measurements

Each microbenchmark reports the median of 11 samples, with 1,000 operations per sample. Process and
fixed-frame measurements report the median of seven runs.

| Measurement | Baseline median | Current median | Delta |
|---|---:|---:|---:|
| Valid JSON parse + typed runtime decode, 1,000 ops | 7.160 ms | 6.965 ms | -2.72% |
| Invalid JSON rejection, 1,000 ops | 0.417 ms | 0.409 ms | -1.92% |
| Healthy Lua execution, 1,000 ops | 1.222 ms | 1.218 ms | -0.31% |
| Protected Lua error, 1,000 ops | 1.459 ms | 1.371 ms | -6.07% |
| Sandbox startup and one frame | 194.34 ms | 195.22 ms | +0.45% |
| Sandbox 120-frame workload | 688.13 ms | 672.56 ms | -2.26% |

These results do not show a material normal-gameplay regression. The healthy JSON, Lua, and startup
changes are below three percent and should be treated as neutral on this host without a larger
controlled sample. The protected-error path improved by 6.07%, but it is not a gameplay hot path and
the absolute difference is under 0.1 ms per 1,000 failures. The fixed-frame workload improved by
2.26%, but this report does not claim that disabling
exceptions or RTTI caused a frame-rate improvement; the revisions contain other implementation and
build-graph changes.

## GPU and Web Startup Limitations

The native fixed-frame workload runs through SDL3, bgfx, RmlUi, and the OpenGL backend under Xvfb in
the WSLg/Linux environment. It is useful as an end-to-end regression signal, but it does not separate
CPU frame time from GPU frame time. The current engine does not publish stable bgfx GPU timestamp
results to a benchmark interface, and software/virtualized presentation makes such values unsuitable
as a cross-revision release claim.

Likewise, Web payload sizes are deterministic, but browser download, Wasm compilation, and first-frame
timings depend heavily on browser version, cache state, serving headers, and hardware. Those timings
should be collected in browser CI when a stable browser performance harness is introduced. This phase
does not fabricate them from Node execution or local file access.

## Conclusion

The migration achieved its clearest measurable benefit in Linux native binary size: approximately
6.85% raw and 4.7% gzip-compressed. The measured healthy JSON, Lua, startup, and fixed-frame paths do
not materially regress. Web size is not uniformly improved, so no blanket Web-payload reduction claim
is justified. Future release changes can reuse `NOVELTEA_BUILD_BENCHMARKS` and
`scripts/release_benchmark.py` against this recorded baseline.
