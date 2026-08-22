import { appendFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import process from 'node:process';

const logPath = process.env.NOVELTEA_COMFYUI_CERT_LOG;
const mode = process.env.NOVELTEA_COMFYUI_CERT_MODE ?? 'success';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const prompts = new Map();
let promptCounter = 0;

const classes = [
  'CFGGuider',
  'CLIPLoader',
  'CLIPTextEncode',
  'ConditioningZeroOut',
  'EmptyFlux2LatentImage',
  'Flux2Scheduler',
  'GetImageSize',
  'ImageScaleToTotalPixels',
  'KSamplerSelect',
  'LoadImage',
  'PrimitiveInt',
  'PrimitiveStringMultiline',
  'RandomNoise',
  'ReferenceLatent',
  'SamplerCustomAdvanced',
  'SaveImage',
  'UNETLoader',
  'VAEDecode',
  'VAEEncode',
  'VAELoader',
];
const inputNames = ['filename_prefix', 'image', 'noise_seed', 'steps', 'text', 'value'];
const objectInfo = Object.fromEntries(
  classes.map((name) => [
    name,
    { input: { required: Object.fromEntries(inputNames.map((input) => [input, ['STRING']])) } },
  ]),
);

async function log(record) {
  if (logPath) await appendFile(logPath, `${JSON.stringify(record)}\n`);
}

async function readBody(request, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = request.method === 'POST' ? await readBody(request) : Buffer.alloc(0);
    await log({
      method: request.method,
      path: url.pathname,
      search: url.search,
      bodySha256: body.length ? undefined : null,
      bodyBytes: body.length,
    });
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/system_stats') {
      if (mode === 'request-timeout') return;
      return response.end(JSON.stringify({ system: { comfyui_version: 'certification-1.0' } }));
    }
    if (url.pathname === '/queue' && request.method === 'GET')
      return response.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (url.pathname === '/queue' && request.method === 'POST') return response.end('{}');
    if (url.pathname === '/object_info') return response.end(JSON.stringify(objectInfo));
    if (url.pathname === '/upload/image') {
      if (mode === 'upload-failure') {
        response.statusCode = 500;
        return response.end(JSON.stringify({ error: 'certified upload failure' }));
      }
      return response.end(
        JSON.stringify({ name: `uploaded-${Date.now()}.png`, subfolder: 'noveltea' }),
      );
    }
    if (url.pathname === '/prompt') {
      if (mode === 'prompt-failure') {
        response.statusCode = 400;
        return response.end(JSON.stringify({ error: 'certified prompt failure' }));
      }
      const parsed = JSON.parse(body.toString('utf8'));
      const promptId = parsed.prompt_id ?? `cert-${++promptCounter}`;
      prompts.set(promptId, 0);
      return response.end(JSON.stringify({ prompt_id: promptId, number: 1 }));
    }
    if (url.pathname.startsWith('/history/')) {
      const promptId = decodeURIComponent(url.pathname.slice('/history/'.length));
      const polls = prompts.get(promptId) ?? 0;
      prompts.set(promptId, polls + 1);
      if (mode === 'history-failure')
        return response.end(
          JSON.stringify({
            [promptId]: {
              status: {
                status_str: 'error',
                messages: [['execution_error', { exception_message: 'certified history failure' }]],
              },
            },
          }),
        );
      if (mode === 'never-complete' || polls === 0) return response.end('{}');
      return response.end(
        JSON.stringify({
          [promptId]: {
            status: { completed: true, status_str: 'success' },
            outputs: {
              9: { images: [{ filename: 'certified.png', subfolder: '', type: 'output' }] },
              output: { images: [{ filename: 'certified.png', subfolder: '', type: 'output' }] },
            },
          },
        }),
      );
    }
    if (url.pathname === '/view') {
      if (mode === 'oversized-output') {
        response.setHeader('content-type', 'application/octet-stream');
        response.setHeader('content-length', String(33 * 1024 * 1024));
        return response.end(Buffer.alloc(1));
      }
      response.setHeader('content-type', 'image/png');
      return response.end(png);
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('failed to bind certification server');
  if (logPath) await writeFile(logPath, '');
  process.stdout.write(`${address.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
