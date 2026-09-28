import { readFileSync } from 'node:fs';

const [javascriptPath, expectedMode] = process.argv.slice(2);
if (!javascriptPath || !['on', 'off'].includes(expectedMode)) {
  console.error('usage: node scripts/check-web-editor-preview-exports.mjs <index.js> <on|off>');
  process.exit(2);
}

const devtoolsExports = [
  'noveltea_devtools_capabilities',
  'noveltea_devtools_snapshot',
  'noveltea_devtools_set_rmlui_debugger',
  'noveltea_devtools_console_delta',
  'noveltea_devtools_console_clear',
  'noveltea_devtools_trace_delta',
  'noveltea_devtools_trace_clear',
  'noveltea_runtime_set_variable',
  'noveltea_runtime_reset_variable',
  'noveltea_runtime_teleport_room',
  'noveltea_runtime_create_instance',
  'noveltea_runtime_replace_instance_configuration',
  'noveltea_runtime_clear_instance_configuration',
  'noveltea_runtime_destroy_instance',
  'noveltea_runtime_retarget_room_exit',
  'noveltea_runtime_debug_snapshot',
  'noveltea_runtime_fast_forward_to_input',
];

const javascript = readFileSync(javascriptPath, 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasExport = (name) =>
  new RegExp(`Module\\["_${escapeRegExp(name)}"\\]\\s*=\\s*wasmExports\\[`).test(javascript);

const mismatches = devtoolsExports.filter((name) =>
  expectedMode === 'on' ? !hasExport(name) : hasExport(name),
);
if (mismatches.length > 0) {
  const expectation = expectedMode === 'on' ? 'missing' : 'unexpectedly exported';
  console.error(`devtools ${expectedMode}: ${expectation}: ${mismatches.join(', ')}`);
  process.exit(1);
}

console.log(
  `devtools ${expectedMode}: verified ${devtoolsExports.length} editor-preview Emscripten exports`,
);
