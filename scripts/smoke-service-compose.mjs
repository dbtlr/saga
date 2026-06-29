#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const projectName = `saga_service_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const composeArgs = ['compose', '-p', projectName, '-f', 'docker-compose.service.yml'];
const serviceUrl = 'http://127.0.0.1:4766/health';
let started = false;

try {
  await assertPortAvailable(serviceUrl);
  run('docker', [...composeArgs, 'build', 'saga-service']);
  run('docker', [...composeArgs, 'up', '-d', 'postgres', 'migrate', 'saga-service']);
  started = true;
  const health = await waitForHealth(serviceUrl);
  if (health.ok !== true || health.service !== 'saga') {
    throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);
  }

  console.log(`service compose smoke passed: ${serviceUrl}`);
  console.log(`uptime seconds: ${String(health.uptimeSeconds)}`);
} catch (error) {
  if (started) {
    console.error('docker compose logs:');
    const logs = spawnSync('docker', [...composeArgs, 'logs', '--no-color'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (logs.stdout.trim() !== '') {
      console.error(logs.stdout.trim());
    }
    if (logs.stderr.trim() !== '') {
      console.error(logs.stderr.trim());
    }
  }
  throw error;
} finally {
  run('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], { allowFailure: true });
}

async function assertPortAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    throw new Error(
      `service smoke requires port 4766, but ${url} already responded with ${String(response.status)}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('already responded')) {
      throw error;
    }
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 60_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`health returned HTTP ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `service did not become healthy within 60s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) {
    if (options.allowFailure === true) {
      return result;
    }
    throw result.error;
  }

  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with exit code ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter((part) => part.trim() !== '')
        .join('\n'),
    );
  }

  return result;
}
