import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compileActiveContext } from '@saga/active-context';
import type { ActiveContextDocument } from '@saga/active-context';
import {
  currentClaims,
  insertClaimPromotionEventAndProject,
  insertClaimReviewEventAndProject,
  listActiveContextClaims,
  listCurrentClaims,
  listRecentRawEvents,
  makeDatabase,
  sourceBindings,
  workspaceProfiles,
  workspaces,
} from '@saga/db';
import type { CurrentClaim, DatabaseService, RawEvent, SourceBinding } from '@saga/db';
import { DATABASE_URL_ENV, findProjectRoot, loadRuntimeConfig } from '@saga/runtime';
import type { SagaEnvironment } from '@saga/runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';

const BINDING_FILE_NAME = '.saga.local.json';

export type ControlPlaneStatus = 'misconfigured' | 'offline' | 'ready' | 'unbound';

export type ControlPlaneIssue = {
  key: string;
  message: string;
};

export type ControlPlaneSnapshot = {
  activeContext: ActiveContextDocument | undefined;
  binding:
    | {
        sourceBindingId: string;
        workspace: {
          handle: string;
          id: string;
        };
      }
    | undefined;
  claims: readonly ControlPlaneClaim[];
  generatedAt: string;
  issues: readonly ControlPlaneIssue[];
  profile:
    | {
        displayName: string;
        summary: string;
      }
    | undefined;
  projectRoot: string;
  recentActivity: readonly ControlPlaneRecentActivity[];
  runtime: {
    database: 'configured' | 'missing';
    environment: SagaEnvironment;
    serviceUrl: string;
  };
  sourceBindings: readonly ControlPlaneSourceBinding[];
  status: ControlPlaneStatus;
};

export type ControlPlaneClaim = {
  confidence: number;
  key: string;
  kind: string;
  pinned: boolean;
  promoted: boolean;
  promotionTitle: string | undefined;
  state: string;
  text: string;
  watched: boolean;
};

export type UpdateClaimReviewInput = {
  action: 'accept' | 'pin' | 'promote' | 'reject' | 'unpin' | 'unwatch' | 'watch';
  claimKey: string;
};

type ClaimReviewAttributes = {
  pinned?: boolean | undefined;
  promoted?: boolean | undefined;
  promotionTitle?: string | undefined;
  watched?: boolean | undefined;
};

export type ControlPlaneSourceBinding = {
  displayName: string;
  enabled: boolean;
  id: string;
  sourceType: string;
  sourceUri: string;
  updatedAt: string;
};

export type ControlPlaneRecentActivity = {
  eventType: string;
  id: string;
  occurredAt: string;
  sessionId: string | undefined;
  sourceType: string;
};

export type UpdateWorkspaceProfileInput = {
  displayName: string;
  summary: string;
};

export type UpdateSourceBindingInput = {
  displayName: string;
  enabled: boolean;
  id: string;
};

type WorkspaceBindingFile = {
  schemaVersion: 1;
  sourceBinding: {
    id: string;
  };
  workspace: {
    handle: string;
    id: string;
  };
};

export async function readControlPlaneSnapshot(input: { cwd?: string } = {}) {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const generatedAt = new Date().toISOString();
  const runtimeExit = await Effect.runPromiseExit(loadRuntimeConfig({ cwd: projectRoot }));
  const config = Exit.isSuccess(runtimeExit)
    ? runtimeExit.value
    : {
        databaseUrl: undefined,
        environment: 'development' as const,
        service: { host: '127.0.0.1', port: 4766 },
      };
  const runtime = {
    database: config.databaseUrl === undefined ? ('missing' as const) : ('configured' as const),
    environment: config.environment,
    serviceUrl: `http://${config.service.host}:${config.service.port.toString()}`,
  };
  const configIssues = Exit.isFailure(runtimeExit)
    ? runtimeExit.cause
        .toString()
        .split('\n')
        .map((message) => ({ key: 'runtime', message }))
    : [];
  const bindingResult = readBindingFile(projectRoot);

  if (bindingResult.issue !== undefined) {
    return {
      activeContext: undefined,
      binding: undefined,
      claims: [],
      generatedAt,
      issues: [...configIssues, bindingResult.issue],
      profile: undefined,
      projectRoot,
      recentActivity: [],
      runtime,
      sourceBindings: [],
      status: 'unbound' as const,
    } satisfies ControlPlaneSnapshot;
  }

  const binding = bindingResult.binding;
  if (config.databaseUrl === undefined) {
    return {
      activeContext: undefined,
      binding: bindingSummary(binding),
      claims: [],
      generatedAt,
      issues: [
        ...configIssues,
        {
          key: DATABASE_URL_ENV,
          message: `Set ${DATABASE_URL_ENV} before reading workspace memory.`,
        },
      ],
      profile: undefined,
      projectRoot,
      recentActivity: [],
      runtime,
      sourceBindings: [],
      status: 'offline' as const,
    } satisfies ControlPlaneSnapshot;
  }

  const serviceExit = await Effect.runPromiseExit(makeDatabase(config, { postgres: { max: 1 } }));
  if (Exit.isFailure(serviceExit)) {
    return {
      activeContext: undefined,
      binding: bindingSummary(binding),
      claims: [],
      generatedAt,
      issues: [{ key: 'database', message: serviceExit.cause.toString() }],
      profile: undefined,
      projectRoot,
      recentActivity: [],
      runtime,
      sourceBindings: [],
      status: 'offline' as const,
    } satisfies ControlPlaneSnapshot;
  }

  const service = serviceExit.value;
  try {
    const [workspace] = await service.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, binding.workspace.id))
      .limit(1);
    const [profile] = await service.db
      .select()
      .from(workspaceProfiles)
      .where(eq(workspaceProfiles.workspaceId, binding.workspace.id))
      .limit(1);
    const bindings = await listWorkspaceSourceBindings(service, binding.workspace.id);
    const claims = await Effect.runPromise(
      listCurrentClaims(service, { limit: 8, workspaceId: binding.workspace.id }),
    );
    const activeContextClaims = await Effect.runPromise(
      listActiveContextClaims(service, { limit: 8, workspaceId: binding.workspace.id }),
    );
    const recentEvents = await Effect.runPromise(
      listRecentRawEvents(service, { limit: 5, workspaceId: binding.workspace.id }),
    );
    const activeContext = compileActiveContext({
      claims: activeContextClaims,
      generatedAt,
      recentEvents,
      workspace: {
        handle: binding.workspace.handle,
        id: binding.workspace.id,
        profile: {
          summary: profile?.summary,
        },
      },
    });

    return {
      activeContext,
      binding: bindingSummary(binding),
      claims: claims.map(toControlPlaneClaim),
      generatedAt,
      issues: [],
      profile: {
        displayName: workspace?.displayName ?? binding.workspace.handle,
        summary: profile?.summary ?? '',
      },
      projectRoot,
      recentActivity: recentEvents.map(toControlPlaneRecentActivity),
      runtime,
      sourceBindings: bindings.map(toControlPlaneSourceBinding),
      status: 'ready' as const,
    } satisfies ControlPlaneSnapshot;
  } catch (cause) {
    return {
      activeContext: undefined,
      binding: bindingSummary(binding),
      claims: [],
      generatedAt,
      issues: [{ key: 'database', message: errorMessage(cause) }],
      profile: undefined,
      projectRoot,
      recentActivity: [],
      runtime,
      sourceBindings: [],
      status: 'offline' as const,
    } satisfies ControlPlaneSnapshot;
  } finally {
    await Effect.runPromise(service.close());
  }
}

export async function updateWorkspaceProfile(input: UpdateWorkspaceProfileInput): Promise<void> {
  await withBoundDatabase(async ({ binding, service }) => {
    const now = new Date();
    await service.db
      .update(workspaces)
      .set({
        displayName: emptyToUndefined(input.displayName),
        updatedAt: now,
      })
      .where(eq(workspaces.id, binding.workspace.id));
    await service.db
      .insert(workspaceProfiles)
      .values({
        profile: {},
        summary: emptyToUndefined(input.summary),
        workspaceId: binding.workspace.id,
      })
      .onConflictDoUpdate({
        set: {
          summary: emptyToUndefined(input.summary),
          updatedAt: now,
        },
        target: workspaceProfiles.workspaceId,
      });
  });
}

export async function updateSourceBinding(input: UpdateSourceBindingInput): Promise<void> {
  await withBoundDatabase(async ({ binding, service }) => {
    const [updated] = await service.db
      .update(sourceBindings)
      .set({
        displayName: emptyToUndefined(input.displayName),
        enabled: input.enabled,
        updatedAt: new Date(),
      })
      .where(
        and(eq(sourceBindings.workspaceId, binding.workspace.id), eq(sourceBindings.id, input.id)),
      )
      .returning({ id: sourceBindings.id });

    if (updated === undefined) {
      throw new Error('source binding is not available for update');
    }
  });
}

export async function updateClaimReview(input: UpdateClaimReviewInput): Promise<void> {
  await withBoundDatabase(async ({ binding, service }) => {
    const [claim] = await service.db
      .select()
      .from(currentClaims)
      .where(
        and(
          eq(currentClaims.workspaceId, binding.workspace.id),
          eq(currentClaims.claimKey, input.claimKey),
        ),
      )
      .limit(1);

    if (claim === undefined) {
      throw new Error('claim is not available for review');
    }

    if (input.action === 'promote') {
      await Effect.runPromise(
        insertClaimPromotionEventAndProject(service, {
          claimKey: claim.claimKey,
          workspaceId: binding.workspace.id,
        }),
      );
      return;
    }

    await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: input.action,
        claimKey: claim.claimKey,
        workspaceId: binding.workspace.id,
      }),
    );
  });
}

async function withBoundDatabase<T>(
  run: (input: { binding: WorkspaceBindingFile; service: DatabaseService }) => Promise<T>,
): Promise<T> {
  const projectRoot = findProjectRoot(process.cwd());
  const bindingResult = readBindingFile(projectRoot);
  if (bindingResult.issue !== undefined) {
    throw new Error(bindingResult.issue.message);
  }

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    return await run({ binding: bindingResult.binding, service });
  } finally {
    await Effect.runPromise(service.close());
  }
}

function readBindingFile(
  projectRoot: string,
):
  | { binding: WorkspaceBindingFile; issue?: undefined }
  | { binding?: undefined; issue: ControlPlaneIssue } {
  const bindingPath = join(projectRoot, BINDING_FILE_NAME);
  if (!existsSync(bindingPath)) {
    return {
      issue: {
        key: BINDING_FILE_NAME,
        message: 'No local workspace binding found. Run saga init from this repository.',
      },
    };
  }

  try {
    // Boundary: the binding file is external JSON; assert only a Partial shape
    // and validate the required fields immediately below before use.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- external JSON; required fields validated below
    const parsed = JSON.parse(readFileSync(bindingPath, 'utf8')) as Partial<WorkspaceBindingFile>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.workspace?.id === undefined ||
      parsed.workspace.handle === undefined ||
      parsed.sourceBinding?.id === undefined
    ) {
      return {
        issue: {
          key: BINDING_FILE_NAME,
          message: 'Local workspace binding is missing required workspace or source fields.',
        },
      };
    }

    return {
      binding: {
        schemaVersion: parsed.schemaVersion,
        sourceBinding: { id: parsed.sourceBinding.id },
        workspace: {
          handle: parsed.workspace.handle,
          id: parsed.workspace.id,
        },
      },
    };
  } catch (cause) {
    return {
      issue: {
        key: BINDING_FILE_NAME,
        message: `Could not read local workspace binding: ${errorMessage(cause)}`,
      },
    };
  }
}

function bindingSummary(binding: WorkspaceBindingFile): ControlPlaneSnapshot['binding'] {
  return {
    sourceBindingId: binding.sourceBinding.id,
    workspace: binding.workspace,
  };
}

function toControlPlaneClaim(claim: CurrentClaim): ControlPlaneClaim {
  const review = readClaimReviewAttributes(claim.attributes);
  return {
    confidence: claim.confidence,
    key: claim.claimKey,
    kind: claim.claimKind,
    pinned: review.pinned ?? false,
    promoted: review.promoted ?? false,
    promotionTitle: review.promotionTitle,
    state: claim.state,
    text: claim.claimText,
    watched: review.watched ?? false,
  };
}

function toControlPlaneSourceBinding(binding: SourceBinding): ControlPlaneSourceBinding {
  return {
    displayName: binding.displayName ?? binding.sourceType,
    enabled: binding.enabled,
    id: binding.id,
    sourceType: binding.sourceType,
    sourceUri: binding.sourceUri,
    updatedAt: binding.updatedAt.toISOString(),
  };
}

function toControlPlaneRecentActivity(event: RawEvent): ControlPlaneRecentActivity {
  return {
    eventType: event.eventType,
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    sessionId: event.sessionId ?? undefined,
    sourceType: event.sourceType,
  };
}

function listWorkspaceSourceBindings(
  service: DatabaseService,
  workspaceId: string,
): Promise<SourceBinding[]> {
  return service.db
    .select()
    .from(sourceBindings)
    .where(eq(sourceBindings.workspaceId, workspaceId))
    .orderBy(sourceBindings.sourceType, sourceBindings.sourceUri);
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function readClaimReviewAttributes(
  attributes: Record<string, unknown>,
): ClaimReviewAttributes {
  return {
    pinned: attributes.reviewPinned === true,
    promoted: attributes.adrPromoted === true,
    promotionTitle:
      typeof attributes.adrTitle === 'string' && attributes.adrTitle.trim() !== ''
        ? attributes.adrTitle
        : undefined,
    watched: attributes.reviewWatched === true,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
