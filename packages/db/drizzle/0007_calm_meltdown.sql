WITH nullable_user_duplicates AS (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "workspace_id", "identity_source", "handle"
			ORDER BY "created_at", "id"
		) AS "canonical_id"
	FROM "users"
	WHERE "external_subject" IS NULL
)
UPDATE "sessions"
SET "author_user_id" = nullable_user_duplicates."canonical_id"
FROM nullable_user_duplicates
WHERE "sessions"."author_user_id" = nullable_user_duplicates."id"
	AND nullable_user_duplicates."id" <> nullable_user_duplicates."canonical_id";--> statement-breakpoint
WITH nullable_user_duplicates AS (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "workspace_id", "identity_source", "handle"
			ORDER BY "created_at", "id"
		) AS "canonical_id"
	FROM "users"
	WHERE "external_subject" IS NULL
)
UPDATE "raw_session_records"
SET "author_user_id" = nullable_user_duplicates."canonical_id"
FROM nullable_user_duplicates
WHERE "raw_session_records"."author_user_id" = nullable_user_duplicates."id"
	AND nullable_user_duplicates."id" <> nullable_user_duplicates."canonical_id";--> statement-breakpoint
WITH nullable_user_duplicates AS (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "workspace_id", "identity_source", "handle"
			ORDER BY "created_at", "id"
		) AS "canonical_id"
	FROM "users"
	WHERE "external_subject" IS NULL
)
DELETE FROM "users"
USING nullable_user_duplicates
WHERE "users"."id" = nullable_user_duplicates."id"
	AND nullable_user_duplicates."id" <> nullable_user_duplicates."canonical_id";--> statement-breakpoint
DROP INDEX "users_workspace_identity_handle_external_unique";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_identity_handle_external_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","identity_source","handle","external_subject");
