import { Data, Effect } from 'effect';

import { DatabaseError } from './database.js';
import type { DatabaseService } from './database.js';
import { sourceBindings, workspaceProfiles, workspaces } from './schema.js';
import type { SourceBinding, Workspace } from './schema.js';

export type WorkspaceSummary = {
  handle: string;
  id: string;
};

export type RegisterWorkspaceInput = {
  displayName: string | undefined;
  handle: string;
  source: {
    config?: Record<string, unknown>;
    displayName?: string | undefined;
    type: string;
    uri: string;
  };
};

export type RegisterWorkspaceResult = {
  sourceBinding: SourceBinding;
  workspace: Workspace;
};

export type RegisterSourceBindingInput = {
  config?: Record<string, unknown>;
  displayName?: string | undefined;
  sourceType: string;
  sourceUri: string;
  workspaceId: string;
};

export class WorkspaceRegistrationError extends Data.TaggedError('WorkspaceRegistrationError')<{
  readonly message: string;
}> {}

export function registerWorkspace(
  service: DatabaseService,
  input: RegisterWorkspaceInput,
): Effect.Effect<RegisterWorkspaceResult, DatabaseError | WorkspaceRegistrationError> {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const [workspace] = await service.db
        .insert(workspaces)
        .values({
          displayName: input.displayName,
          handle: input.handle,
        })
        .onConflictDoUpdate({
          set: {
            displayName: input.displayName,
            updatedAt: now,
          },
          target: workspaces.handle,
        })
        .returning();

      if (workspace === undefined) {
        throw new WorkspaceRegistrationError({ message: 'workspace registration returned no row' });
      }

      await service.db
        .insert(workspaceProfiles)
        .values({
          profile: {},
          workspaceId: workspace.id,
        })
        .onConflictDoNothing()
        .returning();

      const [sourceBinding] = await service.db
        .insert(sourceBindings)
        .values({
          config: input.source.config ?? {},
          displayName: input.source.displayName,
          sourceType: input.source.type,
          sourceUri: input.source.uri,
          workspaceId: workspace.id,
        })
        .onConflictDoUpdate({
          set: {
            config: input.source.config ?? {},
            displayName: input.source.displayName,
            enabled: true,
            updatedAt: now,
          },
          target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
        })
        .returning();

      if (sourceBinding === undefined) {
        throw new WorkspaceRegistrationError({ message: 'source binding returned no row' });
      }

      return { sourceBinding, workspace };
    },
    catch: (cause) =>
      cause instanceof WorkspaceRegistrationError
        ? cause
        : new WorkspaceRegistrationError({ message: errorMessage(cause) }),
  });
}

export function registerSourceBinding(
  service: DatabaseService,
  input: RegisterSourceBindingInput,
): Effect.Effect<SourceBinding, DatabaseError | WorkspaceRegistrationError> {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const [sourceBinding] = await service.db
        .insert(sourceBindings)
        .values({
          config: input.config ?? {},
          displayName: input.displayName,
          sourceType: input.sourceType,
          sourceUri: input.sourceUri,
          workspaceId: input.workspaceId,
        })
        .onConflictDoUpdate({
          set: {
            config: input.config ?? {},
            displayName: input.displayName,
            enabled: true,
            updatedAt: now,
          },
          target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
        })
        .returning();

      if (sourceBinding === undefined) {
        throw new WorkspaceRegistrationError({ message: 'source binding returned no row' });
      }

      return sourceBinding;
    },
    catch: (cause) =>
      cause instanceof WorkspaceRegistrationError
        ? cause
        : new WorkspaceRegistrationError({ message: errorMessage(cause) }),
  });
}

// Every Workspace known to this Saga service, ordered by handle. This is the enumeration
// source for `saga index --all` — a central/cron indexer has no bound cwd, so it fills
// every Workspace the service knows rather than one resolved from a project binding.
export function listWorkspaces(
  service: DatabaseService,
): Effect.Effect<readonly WorkspaceSummary[], DatabaseError> {
  return Effect.tryPromise({
    try: async () =>
      service.db
        .select({ handle: workspaces.handle, id: workspaces.id })
        .from(workspaces)
        .orderBy(workspaces.handle),
    catch: (cause) =>
      cause instanceof DatabaseError
        ? cause
        : new DatabaseError({ message: errorMessage(cause), cause }),
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
