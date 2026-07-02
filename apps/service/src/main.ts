import { findProjectRoot, loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { startSagaService } from './server.js';

const config = await Effect.runPromise(loadRuntimeConfig({ cwd: findProjectRoot(process.cwd()) }));
const service = await startSagaService(config);

process.stdout.write(`Saga service listening on ${service.url}\n`);

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

async function shutdown(exitCode: number): Promise<void> {
  await service.close();
  process.exit(exitCode);
}
