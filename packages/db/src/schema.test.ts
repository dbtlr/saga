import { DISPOSITION_KINDS, FINDING_TYPES } from '@saga/contracts';
import { getTableName } from 'drizzle-orm';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import type { AnyPgTable } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm/utils';
import { describe, expect, it } from 'vitest';

import {
  activityIntervals,
  claimEvents,
  consolidationDispositions,
  consolidationEvidencePointers,
  consolidationFindings,
  consolidationRecords,
  contextIndexEntries,
  currentClaims,
  rawEvents,
  rawSessionRecords,
  sessionRelationships,
  sessionSegmentEmbeddings,
  sessionSegments,
  sessionTurns,
  sessions,
  sourceBindings,
  users,
  workspaceProfiles,
  workspaces,
} from './schema.js';

describe('schema', () => {
  it('defines workspace registration tables', () => {
    expect(getTableName(workspaces)).toBe('workspaces');
    expect(getTableName(workspaceProfiles)).toBe('workspace_profiles');
    expect(getTableName(sourceBindings)).toBe('source_bindings');
    expect(getTableName(users)).toBe('users');
    expect(getTableName(rawEvents)).toBe('raw_events');
    expect(getTableName(claimEvents)).toBe('claim_events');
    expect(getTableName(currentClaims)).toBe('current_claims');
    expect(getTableName(contextIndexEntries)).toBe('context_index_entries');
    expect(getTableName(sessions)).toBe('sessions');
    expect(getTableName(activityIntervals)).toBe('activity_intervals');
    expect(getTableName(rawSessionRecords)).toBe('raw_session_records');
    expect(getTableName(sessionTurns)).toBe('session_turns');
    expect(getTableName(sessionRelationships)).toBe('session_relationships');
    expect(getTableName(sessionSegments)).toBe('session_segments');
    expect(getTableName(sessionSegmentEmbeddings)).toBe('session_segment_embeddings');
    expect(getTableName(consolidationRecords)).toBe('consolidation_records');
    expect(getTableName(consolidationFindings)).toBe('consolidation_findings');
    expect(getTableName(consolidationEvidencePointers)).toBe('consolidation_evidence_pointers');
    expect(getTableName(consolidationDispositions)).toBe('consolidation_dispositions');
  });

  it('keeps consolidation records scoped and provenance-stamped', () => {
    const recordColumns = getTableColumns(consolidationRecords);
    const findingColumns = getTableColumns(consolidationFindings);
    const pointerColumns = getTableColumns(consolidationEvidencePointers);
    const dispositionColumns = getTableColumns(consolidationDispositions);

    expect(recordColumns.workspaceId.notNull).toBe(true);
    expect(recordColumns.sessionId.notNull).toBe(true);
    expect(recordColumns.activityIntervalId.notNull).toBe(true);
    expect(recordColumns.narrative.notNull).toBe(true);
    expect(recordColumns.modelId.notNull).toBe(true);
    expect(recordColumns.authPath.notNull).toBe(true);

    expect(findingColumns.workspaceId.notNull).toBe(true);
    expect(findingColumns.sessionId.notNull).toBe(true);
    expect(findingColumns.recordId.notNull).toBe(true);
    expect(findingColumns.findingType.notNull).toBe(true);
    expect(findingColumns.text.notNull).toBe(true);
    expect(findingColumns.ordinal.notNull).toBe(true);

    expect(pointerColumns.workspaceId.notNull).toBe(true);
    expect(pointerColumns.findingId.notNull).toBe(true);
    expect(pointerColumns.pointerSessionId.notNull).toBe(true);
    expect(pointerColumns.activityIntervalOrdinal.notNull).toBe(false);
    expect(pointerColumns.turnOrdinal.notNull).toBe(false);

    expect(dispositionColumns.workspaceId.notNull).toBe(true);
    expect(dispositionColumns.recordId.notNull).toBe(true);
    expect(dispositionColumns.fromFindingId.notNull).toBe(true);
    expect(dispositionColumns.toFindingId.notNull).toBe(true);
    expect(dispositionColumns.kind.notNull).toBe(true);
  });

  it('derives consolidation check-constraint lists from the contract enums (drift lock)', () => {
    const dialect = new PgDialect();
    const checkLiterals = (table: AnyPgTable, name: string): string[] => {
      const check = getTableConfig(table).checks.find((candidate) => candidate.name === name);
      if (check === undefined) {
        throw new Error(`check constraint ${name} not found`);
      }
      const rendered = dialect.sqlToQuery(check.value).sql;
      return [...rendered.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? '');
    };

    expect(checkLiterals(consolidationFindings, 'consolidation_findings_type_check')).toStrictEqual(
      [...FINDING_TYPES],
    );
    expect(
      checkLiterals(consolidationDispositions, 'consolidation_dispositions_kind_check'),
    ).toStrictEqual([...DISPOSITION_KINDS]);
  });

  it('orders consolidation evidence and dispositions deterministically', () => {
    const pointerColumns = getTableColumns(consolidationEvidencePointers);
    const dispositionColumns = getTableColumns(consolidationDispositions);
    expect(pointerColumns.ordinal.notNull).toBe(true);
    expect(dispositionColumns.ordinal.notNull).toBe(true);
  });

  it('carries no metadata jsonb column on the consolidation tables', () => {
    expect('metadata' in getTableColumns(consolidationRecords)).toBe(false);
    expect('metadata' in getTableColumns(consolidationFindings)).toBe(false);
    expect('metadata' in getTableColumns(consolidationEvidencePointers)).toBe(false);
    expect('metadata' in getTableColumns(consolidationDispositions)).toBe(false);
  });

  it('keeps workspace profile one-to-one with workspace', () => {
    const columns = getTableColumns(workspaceProfiles);

    expect(columns.workspaceId.primary).toBe(true);
    expect(columns.profile.notNull).toBe(true);
  });

  it('keeps source binding identity explicit', () => {
    const columns = getTableColumns(sourceBindings);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceType.notNull).toBe(true);
    expect(columns.sourceUri.notNull).toBe(true);
    expect(columns.enabled.notNull).toBe(true);
  });

  it('keeps raw events append-only source facts explicit', () => {
    const columns = getTableColumns(rawEvents);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceBindingId.notNull).toBe(true);
    expect(columns.sourceType.notNull).toBe(true);
    expect(columns.eventType.notNull).toBe(true);
    expect(columns.externalEventId.notNull).toBe(true);
    expect(columns.payload.notNull).toBe(true);
    expect(columns.provenance.notNull).toBe(true);
  });

  it('keeps claim lifecycle and projection state explicit', () => {
    const eventColumns = getTableColumns(claimEvents);
    const currentColumns = getTableColumns(currentClaims);

    expect(eventColumns.workspaceId.notNull).toBe(true);
    expect(eventColumns.rawEventId.notNull).toBe(true);
    expect(eventColumns.claimKey.notNull).toBe(true);
    expect(eventColumns.eventType.notNull).toBe(true);
    expect(currentColumns.latestEventId.notNull).toBe(true);
    expect(currentColumns.state.notNull).toBe(true);
  });

  it('keeps Context Index entries tied to configured sources', () => {
    const columns = getTableColumns(contextIndexEntries);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceBindingId.notNull).toBe(true);
    expect(columns.key.notNull).toBe(true);
    expect(columns.externalId.notNull).toBe(true);
    expect(columns.sagaLink.notNull).toBe(true);
    expect(columns.includePolicy.notNull).toBe(true);
    expect(columns.importance.notNull).toBe(true);
  });

  it('keeps host-user attribution separate from authorization', () => {
    const columns = getTableColumns(users);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.handle.notNull).toBe(true);
    expect(columns.identitySource.notNull).toBe(true);
    expect(columns.externalSubject.notNull).toBe(false);
  });

  it('keeps sessions tied to workspace, source, and author provenance', () => {
    const columns = getTableColumns(sessions);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceBindingId.notNull).toBe(true);
    expect(columns.authorUserId.notNull).toBe(true);
    expect(columns.harness.notNull).toBe(true);
    expect(columns.harnessSessionId.notNull).toBe(false);
    expect(columns.sourceLocatorHash.notNull).toBe(false);
  });

  it('persists settlement state on activity intervals', () => {
    const columns = getTableColumns(activityIntervals);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sessionId.notNull).toBe(true);
    expect(columns.ordinal.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.settlementReason.notNull).toBe(false);
    expect(columns.settlementTriggerRawEventId.notNull).toBe(false);
  });

  it('stores raw session snapshots as durable evidence', () => {
    const columns = getTableColumns(rawSessionRecords);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sessionId.notNull).toBe(true);
    expect(columns.sourceBindingId.notNull).toBe(true);
    expect(columns.authorUserId.notNull).toBe(true);
    expect(columns.snapshotOrdinal.notNull).toBe(true);
    expect(columns.isActive.notNull).toBe(true);
    expect(columns.contentType.notNull).toBe(true);
    expect(columns.bodyText.notNull).toBe(false);
    expect(columns.bodyJson.notNull).toBe(false);
    expect(columns.contentHash.notNull).toBe(true);
  });

  it('keeps normalized turns structured and traceable to raw snapshots', () => {
    const columns = getTableColumns(sessionTurns);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sessionId.notNull).toBe(true);
    expect(columns.activityIntervalId.notNull).toBe(true);
    expect(columns.rawSessionRecordId.notNull).toBe(true);
    expect(columns.role.notNull).toBe(true);
    expect(columns.actorKind.notNull).toBe(true);
    expect(columns.contentParts.notNull).toBe(true);
    expect(columns.rawEventIds.notNull).toBe(true);
  });

  it('keeps recall segments positioned and embedding-backed', () => {
    const segmentColumns = getTableColumns(sessionSegments);
    const embeddingColumns = getTableColumns(sessionSegmentEmbeddings);

    expect(segmentColumns.workspaceId.notNull).toBe(true);
    expect(segmentColumns.sessionId.notNull).toBe(true);
    expect(segmentColumns.activityIntervalId.notNull).toBe(true);
    expect(segmentColumns.turnId.notNull).toBe(true);
    expect(segmentColumns.rawSessionRecordId.notNull).toBe(true);
    expect(segmentColumns.searchText.notNull).toBe(true);
    expect(embeddingColumns.segmentId.notNull).toBe(true);
    expect(embeddingColumns.rawSessionRecordId.notNull).toBe(true);
    expect(embeddingColumns.provider.notNull).toBe(true);
    expect(embeddingColumns.model.notNull).toBe(true);
    expect(embeddingColumns.dimensions.notNull).toBe(true);
    expect(embeddingColumns.embedding.notNull).toBe(true);
  });
});
