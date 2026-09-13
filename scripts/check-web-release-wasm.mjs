#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [wasmArgument, dwarfArgument] = process.argv.slice(2);
if (!wasmArgument || !dwarfArgument) {
  throw new Error(
    "Usage: node scripts/check-web-release-wasm.mjs <player.wasm> <player.wasm.debug.wasm>",
  );
}

const wasmPath = resolve(wasmArgument);
const dwarfPath = resolve(dwarfArgument);
const bytes = readFileSync(wasmPath);
if (bytes.length < 8 || bytes.subarray(0, 4).toString("hex") !== "0061736d") {
  throw new Error(`${wasmPath} is not a WebAssembly module.`);
}

let offset = 8;
const readVarUint32 = () => {
  let value = 0;
  let shift = 0;
  while (true) {
    if (offset >= bytes.length || shift > 28) throw new Error("Invalid WebAssembly varuint32.");
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
};

const customSections = new Map();
while (offset < bytes.length) {
  const id = bytes[offset++];
  const size = readVarUint32();
  const payloadStart = offset;
  const payloadEnd = payloadStart + size;
  if (payloadEnd > bytes.length) throw new Error("WebAssembly section extends past end of file.");
  if (id === 0) {
    const nameLength = readVarUint32();
    if (offset + nameLength > payloadEnd)
      throw new Error("Invalid WebAssembly custom section name.");
    const name = bytes.subarray(offset, offset + nameLength).toString("utf8");
    customSections.set(name, size);
  }
  offset = payloadEnd;
}

if (customSections.has("name")) {
  throw new Error(
    `Release player still contains a ${customSections.get("name")} byte WebAssembly name section.`,
  );
}
if (!customSections.has("external_debug_info")) {
  throw new Error("Release player does not reference its separate DWARF artifact.");
}

const maximumBytes = 25 * 1024 * 1024;
if (bytes.length > maximumBytes) {
  throw new Error(
    `Release player is ${bytes.length} bytes, above the ${maximumBytes} byte size guard.`,
  );
}
const dwarfSize = statSync(dwarfPath).size;
if (dwarfSize < 1) throw new Error("Separate DWARF artifact is empty.");

process.stdout.write(
  `Web release player audit passed: ${bytes.length} byte runtime Wasm, ${dwarfSize} byte separate DWARF.\n`,
);
