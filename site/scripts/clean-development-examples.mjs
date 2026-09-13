#!/usr/bin/env node

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicRoot = resolve(siteRoot, "public/examples/dev");

rmSync(resolve(publicRoot, "assets"), { recursive: true, force: true });
rmSync(resolve(publicRoot, "catalog.json"), { force: true });
