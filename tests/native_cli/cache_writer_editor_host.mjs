// Real Node-API editor resident used by the cross-host cache election test.
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const native = require(process.argv[2]);
const handle = native.open(process.argv[3]);
native.startCacheMaintenance(handle);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({ ready: true });

for await (const command of createInterface({ input: process.stdin })) {
  try {
    switch (command) {
      case 'tick':
        native.observe(handle);
        native.maintainCache(handle);
        send({ ok: true });
        break;
      case 'validate': {
        const result = JSON.parse(native.validateClean(handle));
        send({ ok: true, valid: result.valid, cacheHit: result.cacheHit,
               diagnostics: result.diagnostics });
        break;
      }
      case 'close':
        native.close(handle);
        send({ ok: true });
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    send({ ok: false, error: String(error) });
  }
}
native.close(handle);
