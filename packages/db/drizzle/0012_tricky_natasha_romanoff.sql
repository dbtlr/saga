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
CREATE INDEX "raw_session_records_derivation_queue_idx" ON "raw_session_records" USING btree ("created_at") WHERE "raw_session_records"."status" = 'captured';