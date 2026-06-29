import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { contextIndexEntries, sourceBindings } from './schema.js';
import type { ContextIndexEntry } from './schema.js';

export type ContextIndexIncludePolicy = 'always' | 'when_relevant' | 'never';

export type UpsertContextIndexEntryInput = {
  description?: string | null | undefined;
  externalId: string;
  importance?: number | undefined;
  includePolicy?: ContextIndexIncludePolicy | undefined;
  key: string;
  metadata?: Record<string, unknown> | undefined;
  sagaLink?: string | undefined;
  sourceBindingId: string;
  title: string;
  workspaceId: string;
};

export type ListContextIndexEntriesInput = {
  includePolicies?: readonly ContextIndexIncludePolicy[] | undefined;
  limit?: number | undefined;
  workspaceId: string;
};

export type ResolveSagaLinkInput = {
  sagaLink: string;
  workspaceId: string;
};

export type ContextIndexSourceBinding = {
  config: Record<string, unknown>;
  displayName: string | null;
  enabled: boolean;
  id: string;
  sourceType: string;
  sourceUri: string;
};

export type ContextIndexEntryWithSource = {
  sourceBinding: ContextIndexSourceBinding;
} & ContextIndexEntry;

export type ResolvedSagaLink = {
  entry: ContextIndexEntryWithSource;
  provenance: {
    resolvedAt: string;
    sagaLink: string;
    sourceBindingId: string;
    sourceType: string;
    sourceUri: string;
    workspaceId: string;
  };
};

export class ContextIndexError extends Data.TaggedError('ContextIndexError')<{
  readonly message: string;
}> {}

const INCLUDE_POLICIES = new Set<ContextIndexIncludePolicy>(['always', 'when_relevant', 'never']);

export function makeSagaContextLink(key: string): string {
  return `saga:context/${encodeURIComponent(normalizeKey(key))}`;
}

export function parseSagaContextLink(link: string): { key: string } {
  if (!link.startsWith('saga:context/')) {
    throw new ContextIndexError({ message: `unsupported Saga Link: ${link}` });
  }

  const encodedKey = link.slice('saga:context/'.length);
  if (encodedKey.trim() === '') {
    throw new ContextIndexError({ message: 'Saga Link is missing a context key' });
  }

  return { key: normalizeKey(decodeURIComponent(encodedKey)) };
}

export function upsertContextIndexEntry(
  service: DatabaseService,
  input: UpsertContextIndexEntryInput,
): Effect.Effect<ContextIndexEntry, DatabaseError | ContextIndexError> {
  return Effect.tryPromise({
    try: async () => {
      const now = new Date();
      const key = normalizeKey(input.key);
      const sagaLink = input.sagaLink ?? makeSagaContextLink(key);
      const parsed = parseSagaContextLink(sagaLink);
      if (parsed.key !== key) {
        throw new ContextIndexError({
          message: 'Context Index entry key must match the Saga Link context key',
        });
      }

      const includePolicy = input.includePolicy ?? 'when_relevant';
      if (!INCLUDE_POLICIES.has(includePolicy)) {
        throw new ContextIndexError({ message: `unsupported include policy: ${includePolicy}` });
      }

      await assertSourceBindingInWorkspace(service, {
        sourceBindingId: input.sourceBindingId,
        workspaceId: input.workspaceId,
      });

      const [entry] = await service.db
        .insert(contextIndexEntries)
        .values({
          description: input.description,
          externalId: input.externalId,
          importance: input.importance ?? 0.5,
          includePolicy,
          key,
          metadata: input.metadata ?? {},
          sagaLink,
          sourceBindingId: input.sourceBindingId,
          title: input.title,
          workspaceId: input.workspaceId,
        })
        .onConflictDoUpdate({
          set: {
            description: input.description,
            externalId: input.externalId,
            importance: input.importance ?? 0.5,
            includePolicy,
            metadata: input.metadata ?? {},
            sagaLink,
            sourceBindingId: input.sourceBindingId,
            title: input.title,
            updatedAt: now,
          },
          target: [contextIndexEntries.workspaceId, contextIndexEntries.key],
        })
        .returning();

      if (entry === undefined) {
        throw new ContextIndexError({ message: 'Context Index upsert returned no row' });
      }

      return entry;
    },
    catch: (cause) =>
      cause instanceof ContextIndexError
        ? cause
        : new ContextIndexError({ message: errorMessage(cause) }),
  });
}

export function listContextIndexEntries(
  service: DatabaseService,
  input: ListContextIndexEntriesInput,
): Effect.Effect<ContextIndexEntryWithSource[], DatabaseError | ContextIndexError> {
  return Effect.tryPromise({
    try: async () => {
      const conditions = [
        eq(contextIndexEntries.workspaceId, input.workspaceId),
        eq(sourceBindings.enabled, true),
      ];
      if (input.includePolicies !== undefined) {
        conditions.push(inArray(contextIndexEntries.includePolicy, [...input.includePolicies]));
      }

      const rows = await service.db
        .select({
          entry: contextIndexEntries,
          sourceBinding: {
            config: sourceBindings.config,
            displayName: sourceBindings.displayName,
            enabled: sourceBindings.enabled,
            id: sourceBindings.id,
            sourceType: sourceBindings.sourceType,
            sourceUri: sourceBindings.sourceUri,
          },
        })
        .from(contextIndexEntries)
        .innerJoin(
          sourceBindings,
          and(
            eq(contextIndexEntries.sourceBindingId, sourceBindings.id),
            eq(contextIndexEntries.workspaceId, sourceBindings.workspaceId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(contextIndexEntries.importance), asc(contextIndexEntries.title))
        .limit(input.limit ?? 50);

      return rows.map(({ entry, sourceBinding }) => ({ ...entry, sourceBinding }));
    },
    catch: (cause) =>
      cause instanceof ContextIndexError
        ? cause
        : new ContextIndexError({ message: errorMessage(cause) }),
  });
}

export function listActiveContextIndexEntries(
  service: DatabaseService,
  input: { limit?: number | undefined; workspaceId: string },
): Effect.Effect<ContextIndexEntryWithSource[], DatabaseError | ContextIndexError> {
  return listContextIndexEntries(service, {
    includePolicies: ['always'],
    limit: input.limit ?? 6,
    workspaceId: input.workspaceId,
  });
}

export function resolveSagaLink(
  service: DatabaseService,
  input: ResolveSagaLinkInput,
): Effect.Effect<ResolvedSagaLink, DatabaseError | ContextIndexError> {
  return Effect.tryPromise({
    try: async () => {
      parseSagaContextLink(input.sagaLink);
      const rows = await service.db
        .select({
          entry: contextIndexEntries,
          sourceBinding: {
            config: sourceBindings.config,
            displayName: sourceBindings.displayName,
            enabled: sourceBindings.enabled,
            id: sourceBindings.id,
            sourceType: sourceBindings.sourceType,
            sourceUri: sourceBindings.sourceUri,
          },
        })
        .from(contextIndexEntries)
        .innerJoin(
          sourceBindings,
          and(
            eq(contextIndexEntries.sourceBindingId, sourceBindings.id),
            eq(contextIndexEntries.workspaceId, sourceBindings.workspaceId),
          ),
        )
        .where(
          and(
            eq(contextIndexEntries.workspaceId, input.workspaceId),
            eq(contextIndexEntries.sagaLink, input.sagaLink),
            eq(sourceBindings.enabled, true),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (row === undefined) {
        throw new ContextIndexError({ message: `Saga Link not found: ${input.sagaLink}` });
      }

      return {
        entry: { ...row.entry, sourceBinding: row.sourceBinding },
        provenance: {
          resolvedAt: new Date().toISOString(),
          sagaLink: row.entry.sagaLink,
          sourceBindingId: row.sourceBinding.id,
          sourceType: row.sourceBinding.sourceType,
          sourceUri: row.sourceBinding.sourceUri,
          workspaceId: row.entry.workspaceId,
        },
      };
    },
    catch: (cause) =>
      cause instanceof ContextIndexError
        ? cause
        : new ContextIndexError({ message: errorMessage(cause) }),
  });
}

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (normalized === '') {
    throw new ContextIndexError({ message: 'Context Index key is required' });
  }
  return normalized;
}

async function assertSourceBindingInWorkspace(
  service: DatabaseService,
  input: { sourceBindingId: string; workspaceId: string },
): Promise<void> {
  const [sourceBinding] = await service.db
    .select({ id: sourceBindings.id })
    .from(sourceBindings)
    .where(
      and(
        eq(sourceBindings.id, input.sourceBindingId),
        eq(sourceBindings.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (sourceBinding === undefined) {
    throw new ContextIndexError({
      message: 'Context Index source binding must belong to the same workspace',
    });
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
