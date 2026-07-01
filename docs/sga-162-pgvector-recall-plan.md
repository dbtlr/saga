# SGA-162 pgvector Recall Plan and ANN Index Threshold

Date: 2026-07-01
Branch: `SGA-162-pgvector-recall-plan`
Base: `bb46e3d`

Measures vector-recall query cost on seeded production-dimension (1536) embeddings,
documents the current scan behavior, and sets the threshold for when an approximate
(HNSW/IVFFlat) index becomes worthwhile. ANN indexing is explicitly **not** a Phase 1.5
gate; the goal is to measure first and defer the index behind a precise trigger.

## Decision

**Do not add an ANN index in Phase 1.5.** At local, single-workspace corpus sizes the
exact (sequential-scan) vector search is well within an interactive budget, and — more
importantly — an ANN index **cannot be used by the recall query as currently written**
and would require a schema migration plus a query restructure to have any effect. The
vector scan is also not the dominant recall cost.

Two precise follow-ups are filed instead (see **Follow-ups**): enable HNSW behind a
row-count trigger (the real ANN task), and address the lexical scan that actually
dominates recall latency.

## Method

- Harness: `packages/db/src/session-recall-bench.postgres.test.ts`, gated by `SAGA_BENCH=1`
  (skipped otherwise; not part of the CI suite). Reuses `makeDatabase`/`runMigrations`,
  seeds a single workspace with distinct random 1536-d vectors via `generate_series`, and
  measures with `EXPLAIN (ANALYZE, BUFFERS)`. This is the replayable indexing/recall
  harness `SGA-153` reuses.
- Environment: `pgvector/pgvector:pg16` (`packages/db/docker-compose.test.yml`, port
  `55432`), single connection, `maintenance_work_mem=1GB` for the index build.
- Query shapes measured:
  - **pure KNN** — `ORDER BY embedding <=> q, segment_id LIMIT 50` on the embeddings table
    (the shipping `vector_candidates` shape, isolated).
  - **vector_candidates** — the same, joined to the `eligible_segments` CTE, exactly as
    `searchSessionRecall` issues it (`packages/db/src/session-recall.ts`).
  - **full recall** — end-to-end `searchSessionRecall` with an injected query embedding.
  - Post-index, each KNN shape is measured both **as-is** (with the `segment_id`
    tiebreaker) and **distance-only** (restructured).
- Distance metric: cosine (`<=>`), matching `DEFAULT_OPENAI_EMBEDDING_PROVIDER`
  (`text-embedding-3-small`, 1536-d).

## Results

Sequential-scan baseline (no vector index — current production state):

| corpus (embeddings) | pure KNN | vector_candidates | full recall p50 |
| ------------------- | -------- | ----------------- | --------------- |
| 1,000               | 2.9 ms   | 4.3 ms            | 40 ms           |
| 10,000              | 28 ms    | 45 ms             | 260 ms          |
| 50,000              | 190 ms   | 300 ms            | 1,024 ms        |
| 100,000             | 302 ms   | 622 ms            | 1,961 ms        |

After migrating the column to `vector(1536)` and building HNSW (`vector_cosine_ops`) at
100,000 rows (build ≈ 8 s):

| KNN shape                         | exec   | index used |
| --------------------------------- | ------ | ---------- |
| as-is (distance + `segment_id`)   | 287 ms | no         |
| distance-only, joined to eligible | 574 ms | no         |
| distance-only, embeddings table   | 0.5 ms | **yes**    |

The bench asserts these last two verdicts (shipping shape cannot use HNSW; restructured
distance-only shape can) as regression guards.

## Findings

1. **The exact vector scan scales linearly** and crosses a ~150 ms interactive budget at
   roughly **40,000–50,000 embeddings per workspace** (28 ms at 10k, 190 ms at 50k). Below
   ~10k it is single-digit-to-tens of milliseconds.

2. **An HNSW index is highly effective — sub-millisecond at 100k (0.5 ms, ~600× the seq
   scan) — but only for a distance-only KNN on the embeddings table.** Three properties of
   the current query each independently prevent index use:
   - **Column type.** The shipping `embedding` column is a dimensionless `vector`
     (`schema.ts`, migration `0005`). HNSW/IVFFlat require a fixed-dimension `vector(1536)`;
     the index cannot be created until the column is migrated.
   - **Tiebreaker sort key.** `vector_candidates` orders by `embedding <=> q, segment_id asc`
     (`session-recall.ts`). The trailing `segment_id` key forces a full sort over all rows,
     so even with the index present the planner falls back to a sequential scan (453 ms vs
     0.7 ms in isolation at 100k).
   - **Join before the limit.** The ANN ordering is computed on `vector_candidates` joined
     to the multi-join `eligible_segments` CTE (materialize/hash-join). Even distance-only,
     that specific shape keeps the index unused (574 ms at 100k). A simple indexed join
     preserves index use via a nested loop over the ordered HNSW scan — it is the
     multi-join CTE materialization that defeats it. The remedy: take the ANN top-k on the
     bare embeddings table first (its `workspace_id`/`provider`/`model`/`dimensions` are
     index-compatible WHERE filters), then join eligibility and apply the `segment_id`
     tiebreaker in an outer step.

3. **The vector scan is not the dominant recall cost.** At 100k (realistic lexical
   selectivity — the query token matches ~0.5% of segments), `vector_candidates` is ~622 ms
   of a ~1,961 ms full recall (~32%); the aggregate lexical path is the remaining ~68%.
   That lexical cost is two independent O(N) predicates that `eligible_segments` evaluates
   over every workspace segment, neither of which the GIN indexes can serve because they run
   on CTE rows as projected/`OR`-ed predicates: `to_tsvector(search_text) @@ ts_query`
   (~221–419 ms at 100k in isolation) and the fuzzy trigram `search_text % query`. Even a
   perfect ANN index (622 ms → ~0.5 ms) would only cut full recall from ~1.96 s to ~1.34 s
   at 100k — the lexical predicates are the larger lever.

   (An earlier revision of this harness shared a word stem across all seed segments, which
   made the fuzzy trigram predicate match the whole corpus and inflated full recall to
   ~3.4 s; the numbers above use a diverse corpus with a rare, trigram-distinct query token.)

## Threshold

Revisit ANN indexing when a single workspace approaches **~40,000 embeddings** (where the
exact vector scan alone approaches the ~150 ms budget). Phase 1/1.5 local corpora are far
below this; at Phase-1 dogfood scale recall is tens of milliseconds. The trigger is a
per-workspace row count, not a hard Phase-1.5 gate.

The threshold is per-workspace. Measurements are on a single-workspace table, so
per-workspace equals whole-table here; in a multi-workspace install the exact scan reads
the whole embeddings table but the distance work is effectively per-workspace after the
eligibility join, so the per-workspace framing still roughly holds.

Because enabling HNSW requires the column migration **and** the query restructure above,
"add the index" is a scoped change, not a one-line addition — another reason to defer it
until the trigger is real.

## Follow-ups

- **Enable HNSW ANN index for vector recall** (`SGA-174`, deferred, row-count triggered): migrate
  `embedding` to `vector(1536)`; restructure `vector_candidates` to take the ANN top-k on
  the embeddings table (distance-only, over-fetched) before joining eligibility and
  applying the `segment_id` tiebreaker; add the HNSW `vector_cosine_ops` index; validate
  with this harness that the index is used and recall stays correct.
- **Reduce the O(N) lexical `eligible_segments` cost in recall** (`SGA-175`, the larger latency lever
  at scale): `eligible_segments` evaluates both `to_tsvector(search_text) @@ ts_query` and
  the fuzzy trigram `search_text % query` per row rather than through the GIN indexes.
  Investigate a stored/generated tsvector column and driving the candidate set through the
  GIN/trgm indexes instead of a full projected scan.

Neither follow-up gates `SGA-148`: at Phase-1/1.5 local scale, recall latency is
acceptable and the ANN index is not yet needed.
