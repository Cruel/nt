# Finalized-player Licenses certification (#418)

This report distinguishes notice **inventory**, the **native built-in RmlUi
viewer against finalized resources**, and **live target-player UI interaction**.
None implies another. It is a certification progress record, not a statement
that #418 or parent #410 has achieved full cross-platform acceptance.

## End-to-end native resource/viewer witness

`scripts/native-canonical-export-evidence.mjs` runs as part of the existing
canonical native CLI export smokes. For non-Android final exports it requires
`NOVELTEA_LICENSE_VIEWER_RUNNER` to point to the corresponding installed
`noveltea-ui-test-runner` executable. That existing runner accepts
`license-export-acceptance` with the **final exported** `assets/system`
directory and **final shipped** `game.ntpkg`. It mounts the physical resources
in the production AssetManager, loads the production RuntimeLicenseCatalog,
opens the built-in RmlUi Licenses Layout and clicks every generated entry.
The text pane's entire bound RmlUi text node must match the exact authenticated
source, not merely its heading or a short prefix.

The canonical fixture under `tests/fixtures/native-platform-export-web` has
two fonts sharing a single notice, one Project-wide notice and a localized
Asset notice. The collector checks the shipped compiled Asset set, exact
Project notice membership and source bytes, one shared copy, engine index and
physical notice paths, and identical public and runtime-mounted engine files.
It compares the native viewer's complete notice membership and byte hashes
against both final indexes. Corrupted and removed engine texts and a malformed
engine index must fail the running native viewer; an additional physical
unindexed engine notice must fail exact filesystem inventory reconciliation.
Existing native runtime reader and Runtime Package tests cover malformed and
missing Project notice paths/texts. Neither verification code path infers an
engine notice from its filename or adds a second notice reader.

Release's native CLI canonical evidence gate rejects missing or inconsistent
viewer evidence, including missing negative-case results. The existing Build
CTest UI and Runtime Package suites continue to exercise reader and RmlUi
binding semantics; Release's export smokes exercise the bridge using the
correct target's own finalized files. Web's Playwright export certification
separately hashes the engine notice bytes actually mounted in the initialized
Emscripten filesystem for root and nested deployment paths.

The shared runtime menu-entry interaction is also covered by
`tests/ui/runtime_ui_lifecycle_integration_tests.cpp`: it loads the **shipped**
Title, Pause and Licenses RML documents and dispatches their real RmlUi click
callbacks, verifying the typed OpenLicenses and Close commands. The existing
`runtime_system_layouts_tests.cpp` then proves the shell stack returns to the
originating Title/Pause screen without resuming gameplay; the native finalized
export viewer witness selects every notice and validates full displayed text.
Together with platform-specific packaged-resource and launch checks, these
provide **composed CI evidence** of the shared viewer workflow without adding
one UI automation framework per platform.

## Qualification scope and outstanding target interactions

| Target | Confirmed or automated seam | Live target Licenses interaction |
| --- | --- | --- |
| Linux | Local native CLI canonical fixture produced 145-file portable export, verified 31 engine notice files plus 3 Project notices in native RmlUi, and launched portable player under Xvfb. Release also covers X11, Wayland and AppImage. | **Not certified** by the native headless viewer witness; the launched player did not itself navigate the Licenses menu. |
| Windows | Release native export + portable launch, target-specific notice inventory, and newly required host RmlUi viewer witness. | **Not yet independently demonstrated** through the live Windows player's menu. |
| macOS | Release native export + app/LaunchServices launch and newly required host RmlUi viewer witness against app resources. | **Not yet independently demonstrated** through the live macOS player's menu. |
| Web threaded/single | Release native host RmlUi witness against each finalized export; real Chromium launch and byte-verified `player_pre.js` engine notice mounts at `/` and `/nested/game/`. | **Not certified**: a browser-side click, selection and visible text readback through the running Web player is still missing. |
| Android arm64/x86_64 | Release APK/AAB byte/index and metadata inspection through the real packaged resource namespace; separate device workflow for arm64. | **Not certified**: the exact engine + Project catalog has not been navigated/observed in a launched APK on an Android device or emulator. |

On November 6, 2026, the local Linux native CLI export smoke passed with a
fresh `v418-local` release template, the rebuilt native RmlUi viewer witness,
and an Xvfb portable-player launch. The resulting canonical evidence records
31 engine notice files, 3 Project notice entries, and all four negative cases.
The same native viewer witness passed on the freshly packaged threaded Web
release export at both `/` and `/nested/game/`; the existing Chromium browser
certification independently passed both deployment paths, including player
startup and mounted engine notice hashes. The 8 targeted native CTests, 10
editor certification/fixture tests, and Build/Release workflow contract tests
also passed. These local observations do not certify Windows, macOS, Android,
or actual canvas-level Web license navigation on this revision.

The native host UI runner tests production RmlUi logic with real exported
resources, but runs **outside** the final desktop, Web or Android player binary.
An SDL desktop process launch, browser `NOVELTEA_PLAYER_READY` marker or APK
readback alone cannot be substituted for a visible Licenses interaction. The
composed shared-runtime tests above cover the missing interaction boundary,
but are **not** evidence of direct mouse/touch navigation through each target's
running player. Any #418/#410 acceptance based on this combined CI coverage
must state that distinction and cite green Build/Release jobs from the revision
containing the menu-entry test; never claim that individual target-player menu
clicks were performed.

## Local reproducer (Linux)

Package a Linux release template using `cmake/PackageNovelTeaPlayerTemplate.cmake`,
then use the existing `tests/native_cli/linux_release_smoke.py` under Xvfb with
`NOVELTEA_CANONICAL_EVIDENCE_OUTPUT` set and
`NOVELTEA_LICENSE_VIEWER_RUNNER` pointing to a rebuilt native UI Test runner.
The collector emits separate `licenseCatalog` inventory and `licenseViewer`
native RmlUi witness fields in its canonical JSON. The smoke must fail if
either cannot be reconciled. On a headless machine, omitting Xvfb can cause
SDL X11 initialization to fail even when the export and viewer are correct.

The fixture is an export certification fixture rather than new Feature Lab
content. No separate licensing test framework or Project schema version was
added.
