CREATE TABLE "raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"session_id" text,
	"trace_id" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trust_level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_source_binding_id_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "raw_events_workspace_occurred_idx" ON "raw_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "raw_events_source_session_idx" ON "raw_events" USING btree ("source_type","source_id","session_id");