# Browser media fixture

`opaque-colors.webm` is the canonical pinned-preparer output for Feature Lab's
`opaque-color-loop` / `colors` motion: a 96×64, two-second opaque visual-only range
from `tests/projects/feature-lab/assets/video/opaque-colors.mp4`.
Its independent expected samples are red for 0–500 ms, green for 500–1500 ms, and
blue for 1500–2000 ms. Creator audio is absent.

Regenerate through normal `noveltea package export` with the current media-tool pin,
then copy the motion's `browserVideo` file from the prepared-media package inventory.
This fixture is private representation evidence, not a promise of a permanent codec
or authoring/package wire layout.
