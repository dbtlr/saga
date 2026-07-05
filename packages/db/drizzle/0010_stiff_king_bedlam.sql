CREATE TABLE "consolidation_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"from_finding_id" uuid NOT NULL,
	"to_finding_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_dispositions_kind_check" CHECK ("consolidation_dispositions"."kind" in ('builds_on', 'refutes')),
	CONSTRAINT "consolidation_dispositions_no_self_loop_check" CHECK ("consolidation_dispositions"."from_finding_id" <> "consolidation_dispositions"."to_finding_id")
);
--> statement-breakpoint
CREATE TABLE "consolidation_evidence_pointers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"pointer_session_id" uuid NOT NULL,
	"activity_interval_ordinal" integer,
	"turn_ordinal" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_evidence_pointers_interval_ordinal_check" CHECK ("consolidation_evidence_pointers"."activity_interval_ordinal" is null or "consolidation_evidence_pointers"."activity_interval_ordinal" >= 0),
	CONSTRAINT "consolidation_evidence_pointers_turn_ordinal_check" CHECK ("consolidation_evidence_pointers"."turn_ordinal" is null or "consolidation_evidence_pointers"."turn_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "consolidation_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"finding_type" text NOT NULL,
	"text" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_findings_ordinal_check" CHECK ("consolidation_findings"."ordinal" >= 0),
	CONSTRAINT "consolidation_findings_type_check" CHECK ("consolidation_findings"."finding_type" in ('decision', 'follow_up', 'deviation_or_correction', 'candidate_learning'))
);
--> statement-breakpoint
CREATE TABLE "consolidation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"activity_interval_id" uuid NOT NULL,
	"narrative" text NOT NULL,
	"model_id" text NOT NULL,
	"auth_path" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_record_id_consolidation_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."consolidation_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_from_finding_id_consolidation_findings_id_fk" FOREIGN KEY ("from_finding_id") REFERENCES "public"."consolidation_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_to_finding_id_consolidation_findings_id_fk" FOREIGN KEY ("to_finding_id") REFERENCES "public"."consolidation_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_record_workspace_fk" FOREIGN KEY ("record_id","workspace_id") REFERENCES "public"."consolidation_records"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_from_finding_workspace_fk" FOREIGN KEY ("from_finding_id","workspace_id") REFERENCES "public"."consolidation_findings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_dispositions" ADD CONSTRAINT "consolidation_dispositions_to_finding_workspace_fk" FOREIGN KEY ("to_finding_id","workspace_id") REFERENCES "public"."consolidation_findings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_evidence_pointers" ADD CONSTRAINT "consolidation_evidence_pointers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_evidence_pointers" ADD CONSTRAINT "consolidation_evidence_pointers_finding_id_consolidation_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."consolidation_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_evidence_pointers" ADD CONSTRAINT "consolidation_evidence_pointers_pointer_session_id_sessions_id_fk" FOREIGN KEY ("pointer_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_evidence_pointers" ADD CONSTRAINT "consolidation_evidence_pointers_finding_workspace_fk" FOREIGN KEY ("finding_id","workspace_id") REFERENCES "public"."consolidation_findings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_evidence_pointers" ADD CONSTRAINT "consolidation_evidence_pointers_pointer_session_workspace_fk" FOREIGN KEY ("pointer_session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_findings" ADD CONSTRAINT "consolidation_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_findings" ADD CONSTRAINT "consolidation_findings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_findings" ADD CONSTRAINT "consolidation_findings_record_id_consolidation_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."consolidation_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_findings" ADD CONSTRAINT "consolidation_findings_record_workspace_fk" FOREIGN KEY ("record_id","workspace_id") REFERENCES "public"."consolidation_records"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_findings" ADD CONSTRAINT "consolidation_findings_record_session_fk" FOREIGN KEY ("record_id","session_id") REFERENCES "public"."consolidation_records"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_findings" ADD CONSTRAINT "consolidation_findings_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_records" ADD CONSTRAINT "consolidation_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_records" ADD CONSTRAINT "consolidation_records_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_records" ADD CONSTRAINT "consolidation_records_activity_interval_id_activity_intervals_id_fk" FOREIGN KEY ("activity_interval_id") REFERENCES "public"."activity_intervals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_records" ADD CONSTRAINT "consolidation_records_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_records" ADD CONSTRAINT "consolidation_records_activity_interval_workspace_fk" FOREIGN KEY ("activity_interval_id","workspace_id") REFERENCES "public"."activity_intervals"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_records" ADD CONSTRAINT "consolidation_records_activity_interval_session_fk" FOREIGN KEY ("activity_interval_id","session_id") REFERENCES "public"."activity_intervals"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consolidation_dispositions_record_idx" ON "consolidation_dispositions" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "consolidation_dispositions_to_finding_idx" ON "consolidation_dispositions" USING btree ("to_finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_dispositions_edge_unique" ON "consolidation_dispositions" USING btree ("from_finding_id","to_finding_id","kind");--> statement-breakpoint
CREATE INDEX "consolidation_evidence_pointers_finding_idx" ON "consolidation_evidence_pointers" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "consolidation_evidence_pointers_pointer_session_idx" ON "consolidation_evidence_pointers" USING btree ("pointer_session_id");--> statement-breakpoint
CREATE INDEX "consolidation_findings_record_idx" ON "consolidation_findings" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_findings_id_workspace_unique" ON "consolidation_findings" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_findings_id_session_unique" ON "consolidation_findings" USING btree ("id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_findings_record_ordinal_unique" ON "consolidation_findings" USING btree ("record_id","ordinal");--> statement-breakpoint
CREATE INDEX "consolidation_records_session_idx" ON "consolidation_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "consolidation_records_workspace_created_idx" ON "consolidation_records" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_records_id_workspace_unique" ON "consolidation_records" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_records_id_session_unique" ON "consolidation_records" USING btree ("id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_records_activity_interval_unique" ON "consolidation_records" USING btree ("activity_interval_id");