CREATE TABLE "source_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_uri" text NOT NULL,
	"display_name" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_profiles" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_profiles" ADD CONSTRAINT "workspace_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_bindings_workspace_id_idx" ON "source_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_bindings_workspace_source_unique" ON "source_bindings" USING btree ("workspace_id","source_type","source_uri");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_handle_unique" ON "workspaces" USING btree ("handle");