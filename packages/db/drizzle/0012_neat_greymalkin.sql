CREATE TABLE "lifecycle_settlement_queue" (
	"raw_event_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "lifecycle_settlement_queue_status_check" CHECK ("lifecycle_settlement_queue"."status" in ('pending', 'settled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "lifecycle_settlement_queue" ADD CONSTRAINT "lifecycle_settlement_queue_raw_event_id_raw_events_id_fk" FOREIGN KEY ("raw_event_id") REFERENCES "public"."raw_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_settlement_queue" ADD CONSTRAINT "lifecycle_settlement_queue_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_settlement_queue_pending_idx" ON "lifecycle_settlement_queue" USING btree ("enqueued_at") WHERE "lifecycle_settlement_queue"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "lifecycle_settlement_queue_failed_idx" ON "lifecycle_settlement_queue" USING btree ("raw_event_id") WHERE "lifecycle_settlement_queue"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "raw_session_records_derivation_queue_idx" ON "raw_session_records" USING btree ("created_at") WHERE "raw_session_records"."status" = 'captured' and "raw_session_records"."is_active" = true;--> statement-breakpoint
CREATE INDEX "raw_session_records_derivation_failed_idx" ON "raw_session_records" USING btree ("id") WHERE "raw_session_records"."status" = 'failed';--> statement-breakpoint
-- SGA-238 backfill: mark ALL captured history 'derived'. The extraction job has
-- never run before this migration, so every pre-existing raw_session_record was
-- derived synchronously by the CLI monolith (store+derive in one txn — a derive
-- failure rolled the whole record back, so no undived records exist). Marking all
-- captured history done is therefore correct and also closes the gap where a
-- legitimately-derived ZERO-turn historical record would otherwise be left
-- 'captured' and re-derived on first deploy. Idempotent: a re-run finds none.
UPDATE "raw_session_records" SET "status" = 'derived' WHERE "status" = 'captured';--> statement-breakpoint
-- SGA-238 backfill: enqueue pre-existing UNSETTLED lifecycle-boundary events (the
-- old absence condition) so in-flight boundaries are not stranded now that the
-- LIKE scan is gone. This set is narrower than the runtime enqueue (which mirrors
-- the CLI and enqueues every snapshot-less event): historical non-boundary events
-- were already reflected by the CLI's synchronous path and need no re-settlement;
-- only interval-boundary events could be left stranded. Idempotent via ON CONFLICT.
INSERT INTO "lifecycle_settlement_queue" ("raw_event_id", "workspace_id")
SELECT re."id", re."workspace_id" FROM "raw_events" re
WHERE re."event_type" IN ('claude.Stop', 'claude.SessionStart', 'codex.Stop', 'codex.SessionStart')
AND NOT EXISTS (
	SELECT 1 FROM "activity_intervals" ai
	WHERE ai."workspace_id" = re."workspace_id"
	AND (ai."settlement_trigger_raw_event_id" = re."id" OR ai."metadata" ->> 'triggerRawEventId' = re."id"::text)
)
ON CONFLICT ("raw_event_id") DO NOTHING;