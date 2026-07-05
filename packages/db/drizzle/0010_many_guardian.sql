CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	CONSTRAINT "job_runs_outcome_check" CHECK ("job_runs"."outcome" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "job_runs_job_name_finished_idx" ON "job_runs" USING btree ("job_name","finished_at");