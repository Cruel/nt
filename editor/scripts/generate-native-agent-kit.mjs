import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

if (process.argv.length !== 3) throw new Error('Expected generated header output path.');
register('./native-agent-kit-loader.mjs', import.meta.url);
const { createNovelTeaAgentKitPayload } = await import('../src/shared/agent-kit/agent-kit.ts');
const payload = createNovelTeaAgentKitPayload();
const contents = Buffer.from(JSON.stringify(payload), 'utf8');
const packed = deflateSync(contents, { level: 9 });
const rows = [];
for (let offset = 0; offset < packed.length; offset += 16)
  rows.push(
    '    ' +
      [...packed.subarray(offset, offset + 16)]
        .map((value) => '0x' + value.toString(16).padStart(2, '0'))
        .join(', ') +
      ',',
  );
const result = [
  '// Generated from the build-time Agent Kit source payload. Do not edit.',
  '#pragma once',
  '#include <array>',
  `inline constexpr std::size_t native_agent_kit_uncompressed_size = ${contents.length};`,
  `inline constexpr std::array<unsigned char, ${packed.length}> native_agent_kit_deflated = {`,
  ...rows,
  '};',
  '',
].join('\n');
writeFileSync(process.argv[2], result);
