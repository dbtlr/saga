import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect } from "effect";
import postgres from "postgres";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import { sourceBindings, workspaceProfiles, workspaces } from "./schema.js";

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("postgres integration", () => {
  const databaseName = `saga_test_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? "", { max: 1 });
  let service: DatabaseService | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const testDatabaseUrl = new URL(databaseUrl ?? "");
    testDatabaseUrl.pathname = `/${databaseName}`;

    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: testDatabaseUrl.toString(),
          environment: "test",
          logLevel: "info",
          service: {
            host: "127.0.0.1",
            port: 4766,
          },
          secrets: {
            openaiApiKey: undefined,
          },
        },
        {
          postgres: {
            max: 1,
          },
        },
      ),
    );
    await Effect.runPromise(runMigrations(service));
  });

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test("runs migrations and persists workspace registration rows", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        displayName: "Saga Integration Workspace",
        handle: `saga-${Date.now().toString(36)}`,
      })
      .returning();

    expect(workspace).toBeDefined();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [profile] = await service.db
      .insert(workspaceProfiles)
      .values({
        profile: { northstar: "integration test" },
        summary: "integration profile",
        workspaceId: workspace.id,
      })
      .returning();

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        config: { branch: "main" },
        displayName: "Saga repository",
        sourceType: "git",
        sourceUri: "file:///Volumes/data/workspaces/saga",
        workspaceId: workspace.id,
      })
      .returning();

    expect(profile?.workspaceId).toBe(workspace.id);
    expect(sourceBinding?.workspaceId).toBe(workspace.id);
    expect(sourceBinding?.enabled).toBe(true);
  });
});
