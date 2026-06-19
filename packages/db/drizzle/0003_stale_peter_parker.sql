CREATE TABLE "claim_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"raw_event_id" uuid NOT NULL,
	"claim_key" text NOT NULL,
	"event_type" text NOT NULL,
	"claim_kind" text NOT NULL,
	"claim_text" text NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "current_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"latest_event_id" uuid NOT NULL,
	"claim_key" text NOT NULL,
	"claim_kind" text NOT NULL,
	"claim_text" text NOT NULL,
	"confidence" double precision NOT NULL,
	"state" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_raw_event_id_raw_events_id_fk" FOREIGN KEY ("raw_event_id") REFERENCES "public"."raw_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_claims" ADD CONSTRAINT "current_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_claims" ADD CONSTRAINT "current_claims_latest_event_id_claim_events_id_fk" FOREIGN KEY ("latest_event_id") REFERENCES "public"."claim_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_events_workspace_occurred_idx" ON "claim_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "claim_events_claim_key_idx" ON "claim_events" USING btree ("workspace_id","claim_key");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_events_raw_event_unique" ON "claim_events" USING btree ("workspace_id","event_type","claim_key","raw_event_id");--> statement-breakpoint
CREATE INDEX "current_claims_workspace_state_idx" ON "current_claims" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "current_claims_workspace_key_unique" ON "current_claims" USING btree ("workspace_id","claim_key");