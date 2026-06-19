import { describe, expect, test } from "vitest";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { rawEvents, sourceBindings, workspaceProfiles, workspaces } from "./schema.js";

describe("schema", () => {
  test("defines workspace registration tables", () => {
    expect(getTableName(workspaces)).toBe("workspaces");
    expect(getTableName(workspaceProfiles)).toBe("workspace_profiles");
    expect(getTableName(sourceBindings)).toBe("source_bindings");
    expect(getTableName(rawEvents)).toBe("raw_events");
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
    expect(columns.payload.notNull).toBe(true);
    expect(columns.provenance.notNull).toBe(true);
  });
});
