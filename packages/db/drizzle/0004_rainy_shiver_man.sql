CREATE TABLE "context_index_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"external_id" text NOT NULL,
	"saga_link" text NOT NULL,
	"importance" double precision DEFAULT 0.5 NOT NULL,
	"include_policy" text DEFAULT 'when_relevant' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_index_entries" ADD CONSTRAINT "context_index_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_index_entries" ADD CONSTRAINT "context_index_entries_source_binding_id_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_index_entries_workspace_include_idx" ON "context_index_entries" USING btree ("workspace_id","include_policy","importance");--> statement-breakpoint
CREATE INDEX "context_index_entries_source_idx" ON "context_index_entries" USING btree ("source_binding_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_index_entries_workspace_key_unique" ON "context_index_entries" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "context_index_entries_workspace_link_unique" ON "context_index_entries" USING btree ("workspace_id","saga_link");--> statement-breakpoint
CREATE UNIQUE INDEX "context_index_entries_workspace_source_external_unique" ON "context_index_entries" USING btree ("workspace_id","source_binding_id","external_id");