import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const retiredShaderVariants = [
  ["glsl", "120"].join("-"),
  ["essl", "100"].join("-"),
];

test("tracked repository content contains no retired shader variants", () => {
  const patterns = retiredShaderVariants.flatMap((variant) => ["-e", variant]);
  const result = spawnSync("git", ["grep", "-n", "-F", ...patterns, "--", "."], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  if (result.status === 0) {
    assert.fail(`Retired shader variants remain in tracked files:\n${result.stdout}`);
  }
  assert.equal(result.status, 1, result.stderr || "git grep failed unexpectedly");
});
