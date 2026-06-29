import { compileActiveContext, renderActiveContextMarkdown } from '@saga/active-context';
import {
  listActiveContextIndexEntries,
  listActiveContextClaims,
  listRecentRawEvents,
  makeDatabase,
  workspaceProfiles,
  type DatabaseService,
} from '@saga/db';
import { loadRuntimeConfig } from '@saga/runtime';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { findProjectRoot, readBindingFile } from './init.js';
import { formatCommandOutput } from './output.js';
import { type RenderOptions } from './render.js';

export async function runContextCommand(
  _args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const document = await compileProjectActiveContext();
  return formatCommandOutput(
    {
      id: 'active-context',
      records: renderActiveContextMarkdown(document),
      value: document,
    },
    options.format,
  );
}

export async function compileProjectActiveContext(input: { cwd?: string } = {}) {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error('workspace binding is missing; run saga init');
  }

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    return await compileActiveContextFromDatabase(service, binding.workspace);
  } finally {
    await Effect.runPromise(service.close());
  }
}

export async function compileActiveContextFromDatabase(
  service: DatabaseService,
  workspace: { handle: string; id: string },
) {
  const [profile] = await service.db
    .select()
    .from(workspaceProfiles)
    .where(eq(workspaceProfiles.workspaceId, workspace.id))
    .limit(1);
  const claims = await Effect.runPromise(
    listActiveContextClaims(service, {
      workspaceId: workspace.id,
    }),
  );
  const recentEvents = await Effect.runPromise(
    listRecentRawEvents(service, {
      limit: 5,
      workspaceId: workspace.id,
    }),
  );
  const contextIndex = await Effect.runPromise(
    listActiveContextIndexEntries(service, {
      limit: 6,
      workspaceId: workspace.id,
    }),
  );

  return compileActiveContext({
    claims,
    contextIndex: contextIndex.map((entry) => ({
      connector: entry.sourceBinding.sourceType,
      description: entry.description,
      externalId: entry.externalId,
      importance: entry.importance,
      includePolicy: entry.includePolicy,
      key: entry.key,
      sagaLink: entry.sagaLink,
      title: entry.title,
    })),
    recentEvents,
    workspace: {
      handle: workspace.handle,
      id: workspace.id,
      profile: {
        summary: profile?.summary,
      },
    },
  });
}
