import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

const emptyJson = sql`'{}'::jsonb`;

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspaces_handle_unique").on(table.handle)],
);

export const workspaceProfiles = pgTable("workspace_profiles", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default(emptyJson),
  summary: text("summary"),
  ...timestamps,
});

export const sourceBindings = pgTable(
  "source_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceUri: text("source_uri").notNull(),
    displayName: text("display_name"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(emptyJson),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("source_bindings_workspace_id_idx").on(table.workspaceId),
    uniqueIndex("source_bindings_workspace_source_unique").on(
      table.workspaceId,
      table.sourceType,
      table.sourceUri,
    ),
  ],
);

export const rawEvents = pgTable(
  "raw_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceBindingId: uuid("source_binding_id")
      .notNull()
      .references(() => sourceBindings.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    actorId: text("actor_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    externalEventId: text("external_event_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    sessionId: text("session_id"),
    traceId: text("trace_id"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default(emptyJson),
    trustLevel: text("trust_level").notNull(),
    ...timestamps,
  },
  (table) => [
    index("raw_events_workspace_occurred_idx").on(table.workspaceId, table.occurredAt),
    index("raw_events_source_session_idx").on(table.sourceType, table.sourceId, table.sessionId),
    uniqueIndex("raw_events_source_external_unique").on(
      table.sourceType,
      table.sourceId,
      table.externalEventId,
    ),
  ],
);

export const workspaceRelations = relations(workspaces, ({ many, one }) => ({
  profile: one(workspaceProfiles),
  sourceBindings: many(sourceBindings),
}));

export const workspaceProfileRelations = relations(workspaceProfiles, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceProfiles.workspaceId],
    references: [workspaces.id],
  }),
}));

export const sourceBindingRelations = relations(sourceBindings, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [sourceBindings.workspaceId],
    references: [workspaces.id],
  }),
}));

export const rawEventRelations = relations(rawEvents, ({ one }) => ({
  sourceBinding: one(sourceBindings, {
    fields: [rawEvents.sourceBindingId],
    references: [sourceBindings.id],
  }),
  workspace: one(workspaces, {
    fields: [rawEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const schema = {
  rawEventRelations,
  rawEvents,
  sourceBindingRelations,
  sourceBindings,
  workspaceProfileRelations,
  workspaceProfiles,
  workspaceRelations,
  workspaces,
};

export type SagaSchema = typeof schema;

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceProfile = typeof workspaceProfiles.$inferSelect;
export type NewWorkspaceProfile = typeof workspaceProfiles.$inferInsert;
export type SourceBinding = typeof sourceBindings.$inferSelect;
export type NewSourceBinding = typeof sourceBindings.$inferInsert;
export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;
