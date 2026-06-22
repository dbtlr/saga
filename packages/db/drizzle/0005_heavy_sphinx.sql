CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "activity_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"settlement_reason" text,
	"settlement_trigger_raw_event_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_intervals_settlement_reason_check" CHECK ("activity_intervals"."settlement_reason" is null or "activity_intervals"."settlement_reason" in ('stop_event', 'idle_timeout', 'clear_context', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "raw_session_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"activity_interval_id" uuid,
	"redacted_from_raw_session_record_id" uuid,
	"snapshot_ordinal" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'captured' NOT NULL,
	"harness" text NOT NULL,
	"harness_session_id" text,
	"source_locator" text,
	"content_type" text NOT NULL,
	"body_text" text,
	"body_json" jsonb,
	"content_hash" text NOT NULL,
	"content_bytes" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_session_records_content_type_check" CHECK ("raw_session_records"."content_type" in ('jsonl', 'json', 'text'))
);
--> statement-breakpoint
CREATE TABLE "session_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"target_session_id" uuid NOT NULL,
	"source_turn_id" uuid,
	"relationship_type" text NOT NULL,
	"confidence" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_relationships_type_check" CHECK ("session_relationships"."relationship_type" in ('child', 'continuation')),
	CONSTRAINT "session_relationships_confidence_check" CHECK ("session_relationships"."confidence" in ('explicit', 'inferred'))
);
--> statement-breakpoint
CREATE TABLE "session_segment_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"raw_session_record_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"input_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_segment_embeddings_dimensions_check" CHECK (vector_dims("session_segment_embeddings"."embedding") = "session_segment_embeddings"."dimensions")
);
--> statement-breakpoint
CREATE TABLE "session_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"activity_interval_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"raw_session_record_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"segment_kind" text DEFAULT 'turn' NOT NULL,
	"search_text" text NOT NULL,
	"snippet" text,
	"token_start" integer,
	"token_end" integer,
	"char_start" integer,
	"char_end" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"activity_interval_id" uuid NOT NULL,
	"raw_session_record_id" uuid NOT NULL,
	"parent_turn_id" uuid,
	"ordinal" integer NOT NULL,
	"harness_turn_id" text,
	"role" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_label" text,
	"model" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"content_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_span" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_turns_role_check" CHECK ("session_turns"."role" in ('user', 'assistant', 'tool', 'system', 'subagent')),
	CONSTRAINT "session_turns_actor_kind_check" CHECK ("session_turns"."actor_kind" in ('host_user', 'agent', 'tool', 'harness', 'subagent'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"harness" text NOT NULL,
	"harness_session_id" text,
	"source_locator" text,
	"source_locator_hash" text,
	"title" text,
	"model" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"identity_source" text NOT NULL,
	"external_subject" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_intervals_id_workspace_unique" ON "activity_intervals" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_events_id_workspace_unique" ON "raw_events" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_session_records_id_workspace_unique" ON "raw_session_records" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_segments_id_workspace_unique" ON "session_segments" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_id_workspace_unique" ON "session_turns" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_id_workspace_unique" ON "sessions" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_bindings_id_workspace_unique" ON "source_bindings" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_id_workspace_unique" ON "users" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_settlement_trigger_raw_event_id_raw_events_id_fk" FOREIGN KEY ("settlement_trigger_raw_event_id") REFERENCES "public"."raw_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_intervals" ADD CONSTRAINT "activity_intervals_settlement_raw_event_workspace_fk" FOREIGN KEY ("settlement_trigger_raw_event_id","workspace_id") REFERENCES "public"."raw_events"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_source_binding_id_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_activity_interval_id_activity_intervals_id_fk" FOREIGN KEY ("activity_interval_id") REFERENCES "public"."activity_intervals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_redacted_from_raw_session_record_id_raw_session_records_id_fk" FOREIGN KEY ("redacted_from_raw_session_record_id") REFERENCES "public"."raw_session_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_source_binding_workspace_fk" FOREIGN KEY ("source_binding_id","workspace_id") REFERENCES "public"."source_bindings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_author_workspace_fk" FOREIGN KEY ("author_user_id","workspace_id") REFERENCES "public"."users"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_activity_interval_workspace_fk" FOREIGN KEY ("activity_interval_id","workspace_id") REFERENCES "public"."activity_intervals"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_session_records" ADD CONSTRAINT "raw_session_records_redacted_from_workspace_fk" FOREIGN KEY ("redacted_from_raw_session_record_id","workspace_id") REFERENCES "public"."raw_session_records"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_target_session_id_sessions_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_source_turn_id_session_turns_id_fk" FOREIGN KEY ("source_turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_source_session_workspace_fk" FOREIGN KEY ("source_session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_target_session_workspace_fk" FOREIGN KEY ("target_session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_relationships" ADD CONSTRAINT "session_relationships_source_turn_workspace_fk" FOREIGN KEY ("source_turn_id","workspace_id") REFERENCES "public"."session_turns"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segment_embeddings" ADD CONSTRAINT "session_segment_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segment_embeddings" ADD CONSTRAINT "session_segment_embeddings_segment_id_session_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."session_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segment_embeddings" ADD CONSTRAINT "session_segment_embeddings_raw_session_record_id_raw_session_records_id_fk" FOREIGN KEY ("raw_session_record_id") REFERENCES "public"."raw_session_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segment_embeddings" ADD CONSTRAINT "session_segment_embeddings_segment_workspace_fk" FOREIGN KEY ("segment_id","workspace_id") REFERENCES "public"."session_segments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segment_embeddings" ADD CONSTRAINT "session_segment_embeddings_raw_record_workspace_fk" FOREIGN KEY ("raw_session_record_id","workspace_id") REFERENCES "public"."raw_session_records"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_activity_interval_id_activity_intervals_id_fk" FOREIGN KEY ("activity_interval_id") REFERENCES "public"."activity_intervals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_turn_id_session_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."session_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_raw_session_record_id_raw_session_records_id_fk" FOREIGN KEY ("raw_session_record_id") REFERENCES "public"."raw_session_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_activity_interval_workspace_fk" FOREIGN KEY ("activity_interval_id","workspace_id") REFERENCES "public"."activity_intervals"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_turn_workspace_fk" FOREIGN KEY ("turn_id","workspace_id") REFERENCES "public"."session_turns"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_segments" ADD CONSTRAINT "session_segments_raw_record_workspace_fk" FOREIGN KEY ("raw_session_record_id","workspace_id") REFERENCES "public"."raw_session_records"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_activity_interval_id_activity_intervals_id_fk" FOREIGN KEY ("activity_interval_id") REFERENCES "public"."activity_intervals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_raw_session_record_id_raw_session_records_id_fk" FOREIGN KEY ("raw_session_record_id") REFERENCES "public"."raw_session_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_parent_turn_id_session_turns_id_fk" FOREIGN KEY ("parent_turn_id") REFERENCES "public"."session_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_activity_interval_workspace_fk" FOREIGN KEY ("activity_interval_id","workspace_id") REFERENCES "public"."activity_intervals"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_raw_record_workspace_fk" FOREIGN KEY ("raw_session_record_id","workspace_id") REFERENCES "public"."raw_session_records"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_parent_workspace_fk" FOREIGN KEY ("parent_turn_id","workspace_id") REFERENCES "public"."session_turns"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_binding_id_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_binding_workspace_fk" FOREIGN KEY ("source_binding_id","workspace_id") REFERENCES "public"."source_bindings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_author_workspace_fk" FOREIGN KEY ("author_user_id","workspace_id") REFERENCES "public"."users"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_intervals_workspace_started_idx" ON "activity_intervals" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "activity_intervals_session_status_idx" ON "activity_intervals" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_intervals_session_ordinal_unique" ON "activity_intervals" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "raw_session_records_workspace_captured_idx" ON "raw_session_records" USING btree ("workspace_id","captured_at");--> statement-breakpoint
CREATE INDEX "raw_session_records_session_idx" ON "raw_session_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "raw_session_records_source_idx" ON "raw_session_records" USING btree ("source_binding_id","harness_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_session_records_session_snapshot_unique" ON "raw_session_records" USING btree ("session_id","snapshot_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_session_records_session_content_hash_unique" ON "raw_session_records" USING btree ("session_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_session_records_one_active_per_session_idx" ON "raw_session_records" USING btree ("session_id") WHERE "raw_session_records"."is_active" = true;--> statement-breakpoint
CREATE INDEX "session_relationships_workspace_idx" ON "session_relationships" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "session_relationships_source_idx" ON "session_relationships" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "session_relationships_target_idx" ON "session_relationships" USING btree ("target_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_relationships_id_workspace_unique" ON "session_relationships" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_relationships_unique" ON "session_relationships" USING btree ("workspace_id","source_session_id","target_session_id","relationship_type");--> statement-breakpoint
CREATE INDEX "session_segment_embeddings_workspace_idx" ON "session_segment_embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "session_segment_embeddings_raw_record_idx" ON "session_segment_embeddings" USING btree ("raw_session_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_segment_embeddings_segment_model_unique" ON "session_segment_embeddings" USING btree ("segment_id","provider","model","dimensions");--> statement-breakpoint
CREATE INDEX "session_segments_session_ordinal_idx" ON "session_segments" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "session_segments_interval_ordinal_idx" ON "session_segments" USING btree ("activity_interval_id","ordinal");--> statement-breakpoint
CREATE INDEX "session_segments_turn_idx" ON "session_segments" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "session_segments_raw_record_idx" ON "session_segments" USING btree ("raw_session_record_id");--> statement-breakpoint
CREATE INDEX "session_segments_search_tsv_idx" ON "session_segments" USING gin (to_tsvector('english', "search_text"));--> statement-breakpoint
CREATE INDEX "session_segments_search_trgm_idx" ON "session_segments" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "session_segments_raw_record_ordinal_unique" ON "session_segments" USING btree ("raw_session_record_id","ordinal");--> statement-breakpoint
CREATE INDEX "session_turns_session_ordinal_idx" ON "session_turns" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "session_turns_interval_ordinal_idx" ON "session_turns" USING btree ("activity_interval_id","ordinal");--> statement-breakpoint
CREATE INDEX "session_turns_raw_record_idx" ON "session_turns" USING btree ("raw_session_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_raw_record_ordinal_unique" ON "session_turns" USING btree ("raw_session_record_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "session_turns_harness_turn_unique" ON "session_turns" USING btree ("session_id","harness_turn_id") WHERE "session_turns"."harness_turn_id" is not null;--> statement-breakpoint
CREATE INDEX "sessions_workspace_started_idx" ON "sessions" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_author_started_idx" ON "sessions" USING btree ("author_user_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_source_binding_idx" ON "sessions" USING btree ("source_binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_workspace_harness_session_unique" ON "sessions" USING btree ("workspace_id","harness","harness_session_id") WHERE "sessions"."harness_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_workspace_harness_locator_unique" ON "sessions" USING btree ("workspace_id","harness","source_locator_hash") WHERE "sessions"."harness_session_id" is null and "sessions"."source_locator_hash" is not null;--> statement-breakpoint
CREATE INDEX "users_workspace_id_idx" ON "users" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_workspace_identity_handle_unique" ON "users" USING btree ("workspace_id","identity_source","handle");--> statement-breakpoint
