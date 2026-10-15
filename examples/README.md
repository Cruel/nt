# External example Project integration

The standalone [noveltea-examples](https://github.com/Cruel/noveltea-examples)
repository is intentionally versioned independently. This tree contains only
the exact commit pin in `noveltea-examples.revision`; do not copy its projects
into `nt` or silently change the pin to an unqualified commit.

The pin at `20a92a178ddc58fe63b1f9c1c20b2a575d5c3bff` contains the
canonical YAML versions of the Materials and Verbs Projects. Their source
format was certified with the current NovelTea CLI: both Projects validate,
compile, export and reimport as `.ntproject`, reopen successfully, and export
runtime `.ntpkg` files; formatting preserves compiled JSON byte-for-byte.
The examples build also produced both playable Web exports with a verified,
previously published threaded-player archive and its *embedded* descriptor.

When advancing the pin again, convert and test upstream first, then update the
revision and run `scripts/qualify-examples-local.sh` with the exact current
NovelTea toolchain and a clean examples checkout. Keep independently authored
Lua, RML, RCSS, shaders, assets (including data JSON), and machine formats
such as `examples.json` unchanged.

`scripts/qualify-examples.mjs` now rejects a pinned checkout with missing
YAML owners or residual JSON authoring files before invoking its builder.
