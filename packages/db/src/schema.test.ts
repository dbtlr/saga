import { describe, expect, test } from "vitest";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import {
  claimEvents,
  contextIndexEntries,
  currentClaims,
  rawEvents,
  sourceBindings,
  workspaceProfiles,
  workspaces,
} from "./schema.js";

describe("schema", () => {
  test("defines workspace registration tables", () => {
    expect(getTableName(workspaces)).toBe("workspaces");
    expect(getTableName(workspaceProfiles)).toBe("workspace_profiles");
    expect(getTableName(sourceBindings)).toBe("source_bindings");
    expect(getTableName(rawEvents)).toBe("raw_events");
    expect(getTableName(claimEvents)).toBe("claim_events");
    expect(getTableName(currentClaims)).toBe("current_claims");
    expect(getTableName(contextIndexEntries)).toBe("context_index_entries");
  });

  test("keeps workspace profile one-to-one with workspace", () => {
    const columns = getTableColumns(workspaceProfiles);

    expect(columns.workspaceId.primary).toBe(true);
    expect(columns.profile.notNull).toBe(true);
  });

  test("keeps source binding identity explicit", () => {
    const columns = getTableColumns(sourceBindings);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceType.notNull).toBe(true);
    expect(columns.sourceUri.notNull).toBe(true);
    expect(columns.enabled.notNull).toBe(true);
  });

  test("keeps raw events append-only source facts explicit", () => {
    const columns = getTableColumns(rawEvents);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceBindingId.notNull).toBe(true);
    expect(columns.sourceType.notNull).toBe(true);
    expect(columns.eventType.notNull).toBe(true);
    expect(columns.externalEventId.notNull).toBe(true);
    expect(columns.payload.notNull).toBe(true);
    expect(columns.provenance.notNull).toBe(true);
  });

  test("keeps claim lifecycle and projection state explicit", () => {
    const eventColumns = getTableColumns(claimEvents);
    const currentColumns = getTableColumns(currentClaims);

    expect(eventColumns.workspaceId.notNull).toBe(true);
    expect(eventColumns.rawEventId.notNull).toBe(true);
    expect(eventColumns.claimKey.notNull).toBe(true);
    expect(eventColumns.eventType.notNull).toBe(true);
    expect(currentColumns.latestEventId.notNull).toBe(true);
    expect(currentColumns.state.notNull).toBe(true);
  });

  test("keeps Context Index entries tied to configured sources", () => {
    const columns = getTableColumns(contextIndexEntries);

    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.sourceBindingId.notNull).toBe(true);
    expect(columns.key.notNull).toBe(true);
    expect(columns.externalId.notNull).toBe(true);
    expect(columns.sagaLink.notNull).toBe(true);
    expect(columns.includePolicy.notNull).toBe(true);
    expect(columns.importance.notNull).toBe(true);
  });
});
