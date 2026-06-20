import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
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
      table.workspaceId,
      table.sourceType,
      table.sourceId,
      table.externalEventId,
    ),
  ],
);

export const claimEvents = pgTable(
  "claim_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rawEventId: uuid("raw_event_id")
      .notNull()
      .references(() => rawEvents.id, { onDelete: "cascade" }),
    claimKey: text("claim_key").notNull(),
    eventType: text("event_type").notNull(),
    claimKind: text("claim_kind").notNull(),
    claimText: text("claim_text").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(emptyJson),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default(emptyJson),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("claim_events_workspace_occurred_idx").on(table.workspaceId, table.occurredAt),
    index("claim_events_claim_key_idx").on(table.workspaceId, table.claimKey),
    uniqueIndex("claim_events_raw_event_unique").on(
      table.workspaceId,
      table.eventType,
      table.claimKey,
      table.rawEventId,
    ),
  ],
);

export const currentClaims = pgTable(
  "current_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    latestEventId: uuid("latest_event_id")
      .notNull()
      .references(() => claimEvents.id, { onDelete: "cascade" }),
    claimKey: text("claim_key").notNull(),
    claimKind: text("claim_kind").notNull(),
    claimText: text("claim_text").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    state: text("state").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(emptyJson),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default(emptyJson),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("current_claims_workspace_state_idx").on(table.workspaceId, table.state),
    uniqueIndex("current_claims_workspace_key_unique").on(table.workspaceId, table.claimKey),
  ],
);

export const contextIndexEntries = pgTable(
  "context_index_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceBindingId: uuid("source_binding_id")
      .notNull()
      .references(() => sourceBindings.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    externalId: text("external_id").notNull(),
    sagaLink: text("saga_link").notNull(),
    importance: doublePrecision("importance").notNull().default(0.5),
    includePolicy: text("include_policy").notNull().default("when_relevant"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index("context_index_entries_workspace_include_idx").on(
      table.workspaceId,
      table.includePolicy,
      table.importance,
    ),
    index("context_index_entries_source_idx").on(table.sourceBindingId, table.externalId),
    uniqueIndex("context_index_entries_workspace_key_unique").on(table.workspaceId, table.key),
    uniqueIndex("context_index_entries_workspace_link_unique").on(
      table.workspaceId,
      table.sagaLink,
    ),
    uniqueIndex("context_index_entries_workspace_source_external_unique").on(
      table.workspaceId,
      table.sourceBindingId,
      table.externalId,
    ),
  ],
);

export const workspaceRelations = relations(workspaces, ({ many, one }) => ({
  claimEvents: many(claimEvents),
  contextIndexEntries: many(contextIndexEntries),
  currentClaims: many(currentClaims),
  profile: one(workspaceProfiles),
  rawEvents: many(rawEvents),
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

export const claimEventRelations = relations(claimEvents, ({ one }) => ({
  rawEvent: one(rawEvents, {
    fields: [claimEvents.rawEventId],
    references: [rawEvents.id],
  }),
  workspace: one(workspaces, {
    fields: [claimEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const currentClaimRelations = relations(currentClaims, ({ one }) => ({
  latestEvent: one(claimEvents, {
    fields: [currentClaims.latestEventId],
    references: [claimEvents.id],
  }),
  workspace: one(workspaces, {
    fields: [currentClaims.workspaceId],
    references: [workspaces.id],
  }),
}));

export const contextIndexEntryRelations = relations(contextIndexEntries, ({ one }) => ({
  sourceBinding: one(sourceBindings, {
    fields: [contextIndexEntries.sourceBindingId],
    references: [sourceBindings.id],
  }),
  workspace: one(workspaces, {
    fields: [contextIndexEntries.workspaceId],
    references: [workspaces.id],
  }),
}));

export const schema = {
  claimEventRelations,
  claimEvents,
  contextIndexEntries,
  contextIndexEntryRelations,
  currentClaimRelations,
  currentClaims,
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
export type ClaimEvent = typeof claimEvents.$inferSelect;
export type NewClaimEvent = typeof claimEvents.$inferInsert;
export type CurrentClaim = typeof currentClaims.$inferSelect;
export type NewCurrentClaim = typeof currentClaims.$inferInsert;
export type ContextIndexEntry = typeof contextIndexEntries.$inferSelect;
export type NewContextIndexEntry = typeof contextIndexEntries.$inferInsert;
