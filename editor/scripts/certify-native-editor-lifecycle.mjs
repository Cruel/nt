/** Linux Xvfb smoke of the assembled Electron renderer -> preload -> trusted
 * main-process IPC -> real native Project worker path. Not a production gate.
 * Usage: node editor/scripts/certify-native-editor-lifecycle.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(editor, '..');
const addon =
  process.env.NOVELTEA_AUTHORING_NODE_ADDON ||
  path.join(repository, 'build/native-authoring-host/noveltea-authoring-node.node');
const port = 19000 + (process.pid % 1500);
const temp = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-editor-gui-'));
const project = path.join(temp, 'GUI Smoke Project');
const command = spawn(
  'xvfb-run',
  [
    '-a',
    path.join(editor, 'node_modules/electron/dist/electron'),
    path.join(editor, 'dist-electron/main/main.cjs'),
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    '--certify-native-authoring-lifecycle',
  ],
  {
    cwd: editor,
    detached: true,
    env: {
      ...process.env,
      NOVELTEA_AUTHORING_NODE_ADDON: addon,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let stderr = '';
command.stderr.setEncoding('utf8');
command.stderr.on('data', (value) => {
  stderr = (stderr + value).slice(-5000);
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (command.exitCode !== null) throw new Error(`Electron exited: ${stderr}`);
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
        response.json(),
      );
      target = pages.find((page) => page.url === 'noveltea-editor://app/index.html');
      if (target) break;
    } catch {
      /* The debugger has not started yet. */
    }
    await pause(200);
  }
  if (!target) throw new Error(`Electron editor renderer did not load: ${stderr}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (message) => {
    const reply = JSON.parse(message.data);
    if (!pending.has(reply.id)) return;
    const resolve = pending.get(reply.id);
    pending.delete(reply.id);
    resolve(reply);
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (code) => {
    const response = await send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.error || response.result?.exceptionDetails)
      throw new Error(`Renderer evaluation failed: ${JSON.stringify(response)}`);
    return response.result.result.value;
  };
  let ready = false;
  let lastProbe;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      lastProbe = await evaluate(`({
      page: document.readyState,
      rendered: Boolean(document.body?.innerText?.length),
      preload: typeof window.noveltea,
      create: typeof window.noveltea?.createProject,
      open: typeof window.noveltea?.openProject,
      validate: typeof window.noveltea?.nativeProjectValidate,
    })`);
    } catch (error) {
      // DevTools may publish the page target before the first renderer world
      // exists. Retrying a read-only readiness probe is safe; never repeat
      // a submitted IPC mutation after an ambiguous transport failure.
      if (!String(error).includes('Cannot find default execution context')) throw error;
      await pause(200);
      continue;
    }
    ready =
      lastProbe.rendered &&
      lastProbe.create === 'function' &&
      lastProbe.open === 'function' &&
      lastProbe.validate === 'function';
    if (ready) break;
    await pause(200);
  }
  if (!ready)
    throw new Error(`Editor preload/renderer not ready: ${JSON.stringify(lastProbe)}; ${stderr}`);
  const result = await evaluate(`(async () => {
    const rendered = document.body?.innerText?.length > 0;
    const api = window.noveltea;
    if (!rendered || !api?.createProject || !api?.openProject || !api?.nativeProjectValidate)
      throw new Error('Renderer or preload API is missing.');
    const created = await api.createProject({
      projectName: 'GUI Smoke Project',
      projectDirectory: ${JSON.stringify(project)},
    });
    if (!created.success) throw new Error('GUI Create failed: ' + created.error);
    const opened = await api.openProject(created.projectPath);
    if (!opened.success || !opened.projectSessionId || opened.nativeWorkingRevision === undefined)
      throw new Error('GUI Open failed: ' + opened.error);
    const validation = await api.nativeProjectValidate(
      opened.projectSessionId,
      opened.nativeWorkingRevision,
    );
    const sources = await api.listProjectSourceFiles({ projectSessionId: opened.projectSessionId });
    await api.closeActiveProject();
    return {
      rendered,
      nativeSession: Boolean(opened.nativeWorkingRevision !== undefined),
      validated: Boolean(validation),
      sourceInventory: Array.isArray(sources.files),
    };
  })()`);
  if (!result.rendered || !result.nativeSession || !result.validated || !result.sourceInventory)
    throw new Error(`Incomplete Electron candidate smoke: ${JSON.stringify(result)}`);
  // Exercise the React workspace's *own* New Project command as well as the
  // preload boundary above: this must admit the native Project into the
  // renderer's inspector, Explorer and command state, not just into main.
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent.trim() === 'New Project');
    if (!button) throw new Error('New Project button is missing.');
    button.click();
    return true;
  })()`);
  let formReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    formReady = await evaluate(`Boolean(document.getElementById('new-project-name') &&
      document.getElementById('new-project-directory'))`);
    if (formReady) break;
    await pause(100);
  }
  if (!formReady) {
    const view = await evaluate(`({
      text: document.body?.innerText?.slice(0, 1200),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 20)
        .map((node) => node.textContent),
    })`);
    throw new Error(`The renderer did not open the New Project form: ${JSON.stringify(view)}`);
  }
  const guiProject = path.join(temp, 'GUI Routed Project');
  await evaluate(`(() => {
    for (const [id, value] of [
      ['new-project-name', 'GUI Routed Project'],
      ['new-project-directory', ${JSON.stringify(guiProject)}],
    ]) {
      const input = document.getElementById(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
  await pause(150);
  const enabled = await evaluate(`(() => {
    const form = document.getElementById('new-project-name').closest('form');
    return !form.querySelector('button[type="submit"]').disabled;
  })()`);
  if (!enabled) throw new Error('The real New Project form did not accept valid input.');
  await evaluate(
    `document.getElementById('new-project-name').closest('form').requestSubmit(); true`,
  );
  let uiRouted = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    uiRouted = await evaluate(`(() => {
      const text = document.body?.innerText || '';
      return text.includes('GUI Routed Project') && !document.getElementById('new-project-name');
    })()`);
    if (uiRouted) break;
    await pause(200);
  }
  if (!uiRouted) throw new Error('The renderer did not present its newly opened native Project.');
  const uiText = await evaluate(`document.body.innerText.slice(0, 700)`);
  process.stdout.write(
    `Native editor Electron/Xvfb smoke passed: ${JSON.stringify({
      ...result,
      rendererProjectOpen: uiRouted,
      view: uiText,
    })}\n`,
  );
} finally {
  socket?.close();
  if (command.pid) {
    try {
      process.kill(-command.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
  await rm(temp, { recursive: true, force: true });
}
