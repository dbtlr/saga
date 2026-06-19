import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
import {
  sourceBindings,
  workspaceProfiles,
  workspaces,
  type SourceBinding,
  type Workspace,
} from "./schema.js";

export interface RegisterWorkspaceInput {
  displayName: string | undefined;
  handle: string;
  source: {
    config?: Record<string, unknown>;
    displayName?: string | undefined;
    type: string;
    uri: string;
  };
}

export interface RegisterWorkspaceResult {
  sourceBinding: SourceBinding;
  workspace: Workspace;
}

export class WorkspaceRegistrationError extends Data.TaggedError("WorkspaceRegistrationError")<{
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
        throw new WorkspaceRegistrationError({ message: "workspace registration returned no row" });
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
        throw new WorkspaceRegistrationError({ message: "source binding returned no row" });
      }

      return { sourceBinding, workspace };
    },
    catch: (cause) =>
      cause instanceof WorkspaceRegistrationError
        ? cause
        : new WorkspaceRegistrationError({ message: errorMessage(cause) }),
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
