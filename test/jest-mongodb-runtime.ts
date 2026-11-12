/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * mongodb >= 7.6 loads Node's `os` module with a dynamic `import('os')` while building the connection handshake. Jest runs
 * every test file in a vm sandbox that refuses dynamic imports (unless node runs with --experimental-vm-modules), so the
 * driver silently sends a handshake without its required `driver` section and every connection fails with
 * "Missing required sub-document 'driver' in the client metadata document". Production is unaffected (no vm sandbox).
 * This hands the driver the `os` module directly, the same way its own `runtimeAdapters` option does.
 */
import * as os from 'os';

const adapters = require('mongodb/lib/runtime_adapters');
adapters.resolveRuntimeAdapters = (options: {
  runtimeAdapters?: { os?: unknown };
}) => Promise.resolve({ os: options?.runtimeAdapters?.os ?? os });
