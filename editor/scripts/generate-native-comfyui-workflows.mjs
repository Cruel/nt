// Build-time packaging only: the installed native CLI does not load Node or the editor tree.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Expected workflows directory and output header.');
const files = (await readdir(source))
  .filter((name) => /\.(manifest|workflow)\.json$/u.test(name))
  .sort();
const entries = await Promise.all(
  files.map(async (name) => {
    const value = await readFile(path.join(source, name), 'utf8');
    return `    {${JSON.stringify(name)}, R"NT_COMFY_EMBED(${value})NT_COMFY_EMBED"},`;
  }),
);
await writeFile(
  destination,
  [
    '#pragma once',
    '#include <array>',
    '#include <string_view>',
    'namespace noveltea::cli::embedded_comfyui {',
    'struct File { std::string_view name; std::string_view text; };',
    `inline constexpr std::array<File, ${entries.length}> files = {{`,
    ...entries,
    '}};',
    '}',
    '',
  ].join('\n'),
);
