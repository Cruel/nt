# Native Runtime physical preparation (#559)

`native_runtime_physical.cpp::prepare_native_runtime_physical` consumes the
already admitted Project and the pure Prepared Runtime Artifact from #558. It
does not readmit source records or publish a runtime cache; that ownership
remains with #560. The physical stage verifies its package file sources against
the admitted exact `sha256:` source revisions, before and after external tools.
Stale, missing, external, or symlinked sources produce blocking diagnostics
without an artifact. Cancellation similarly yields no publishable artifact.

The stage uses native `ShaderCompilerService` on admitted Material effective
inputs and requested shader variants, verifies binary SHA-256 and Project
dependency revisions, and updates compiled Material stage metadata, required
package-relative shader paths, and the shader asset root. Runtime shader
identities retain `project:/` in Material metadata; package-required paths do
not. The established C++ package writer remains responsible for its own
required-file and source verification.

Video-backed Animation motions are converted with the pinned `ffmpeg-r3`
(FFmpeg 9.0.1) into a private VP9/BT.709 WebM representation. Source-range and
sampling requests derive the prepared frame durations from decoded frame
presentation timestamps, never average FPS. The private manifest is published
as `assets/.prepared-media/manifest.json`. Source alpha is probed using the
appropriate VPx decoder and, when present, uses the existing native animated
WebP alpha encoder and decoder proof to produce the private sidecar. Media is
first written to a disposable staging directory and only exposed under a
content-addressed build directory after source revisions are rechecked.

Explicit and included-Asset distribution notices are collected into the
canonical `licenses/index.json` plus SHA-pinned, stored `.md`/`.txt` package
entries. Each notice must be nonempty valid UTF-8 text, at most 1 MiB, and
match an admitted revision. The 512-entry notice limit and conflicting display
names block preparation. Localization-quality diagnostics from #558 are
retained; the CLI's explicit acknowledgement policy remains enforced by the
public package command.

## Focused Linux verification

```
cmake --build --preset linux-debug --target noveltea-runtime-cache-publish-certify
ctest --test-dir build/linux-debug --output-on-failure \
  -R '^native_runtime_(artifact_parity|physical)$'
```

`tests/native_runtime_physical.py` uses the pinned FFmpeg executable from
`NOVELTEA_FFMPEG` or a staged CLI tool under `build/cli/linux/tools/ffmpeg`.
When neither exists it reports a skipped media-tool prerequisite, not a false
pass. It cold-admits Feature Lab and checks the private media manifest,
content-addressed source key, source-revision failures, cancellation, unsafe
paths, native shader bin inventories, and distribution notice freshness. It
then exports an actual `.ntpkg` using the C++ package writer and inspects the
runtime payload and private media entries. The separate #558 differential test
continues to check pure assembled artifact parity against the reference.

**Follow-on boundaries:** #560 connects this stage to cold cache builds,
generation and recovery checks, cancellation and competing publication.
#561 independently certifies complete cold/warm Runtime Package and authored
Test execution. Platform-specific export orchestration is #545, and shipping
the ScriptC-free native CLI is #551. This stage is not evidence that those
later acceptance gates have passed.
