// pgvector recall measurement harness (SGA-162).
//
// Gated: only runs when SAGA_BENCH=1 AND a Postgres URL is available. It seeds
// production-dimension (1536) embeddings at increasing row counts and reports:
//   - pure vector KNN cost (what an ANN index would directly accelerate),
//   - the real `vector_candidates` CTE cost (the same KNN joined to eligible
//     segments, as `searchSessionRecall` issues it),
//   - end-to-end `searchSessionRecall` latency, and
//   - the same measurements after migrating the column to a fixed-dimension
//     `vector(1536)` and building an HNSW index (the only way pgvector ANN
//     indexes can exist — the shipping column is a dimensionless `vector`).
//
// This is the replayable indexing/recall-validation harness SGA-153 reuses.
// Run: cd packages/db && SAGA_BENCH=1 SAGA_TEST_DATABASE_URL=postgres://saga:saga@localhost:55432/saga_test \
//        bunx vitest run src/session-recall-bench.postgres.test.ts

import { writeFileSync } from 'node:fs';

import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import { searchSessionRecall } from './session-recall.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const benchEnabled = process.env.SAGA_BENCH === '1' && databaseUrl !== undefined;
const describeBench = benchEnabled ? describe : describe.skip;

const DIMENSIONS = 1536;
const PROVIDER = 'openai';
const MODEL = 'text-embedding-3-small';
const SEGMENTS_PER_SESSION = 50;
// The recall target: a rare, trigram-distinct sentinel token seeded into segments where
// `j % TOPIC_BUCKETS === RECALL_MATCH_BUCKET` (~1/200 of the corpus) — realistic lexical
// selectivity. The letters z/q/x/j don't occur in the hex tokens around it, so the recall
// query's fuzzy trigram predicate does not spuriously match non-target rows.
const TOPIC_BUCKETS = 200;
const RECALL_MATCH_BUCKET = 7;
const RECALL_QUERY_TOKEN = 'zqxjneedle';
const RECALL_LIMIT = 10;
// normalizeVectorCandidateLimit(undefined, 10) => min(max(10*5, 10), 500) === 50
const CANDIDATE_LIMIT = 50;

// Deterministic fixed ids for the singleton workspace/user/binding.
const WS = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const SB = '00000000-0000-4000-8000-000000000003';

const SWEEP = (process.env.SAGA_BENCH_SWEEP ?? '1000,10000,50000,100000,250000')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const TIMING_RUNS = Number.parseInt(process.env.SAGA_BENCH_RUNS ?? '9', 10);
const INDEX_AT_TOP = process.env.SAGA_BENCH_INDEX !== '0';

type PlanMeasurement = {
  execMs: number;
  planningMs: number;
  topNode: string;
  usesVectorIndex: boolean;
};

type TimingMeasurement = {
  min: number;
  p50: number;
  p95: number;
  max: number;
};

function randomVector(dims: number): number[] {
  return Array.from({ length: dims }, () => Math.random());
}

function randomVectorLiteral(dims: number): string {
  const parts = Array.from({ length: dims }, () => Math.random().toFixed(6));
  return `[${parts.join(',')}]`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? Number.NaN;
}

function planText(node: Record<string, unknown>): string {
  return JSON.stringify(node);
}

async function explainKnn(
  service: DatabaseService,
  vectorLiteral: string,
  { joined, tiebreak = true }: { joined: boolean; tiebreak?: boolean },
): Promise<PlanMeasurement> {
  const eligibleCte = `
    with eligible_segments as (
      select ss.id, ss.workspace_id
      from session_segments ss
      inner join sessions s
        on s.id = ss.session_id and s.workspace_id = ss.workspace_id
      inner join source_bindings sb
        on sb.id = s.source_binding_id and sb.workspace_id = s.workspace_id and sb.enabled = true
      inner join raw_session_records r
        on r.id = ss.raw_session_record_id and r.workspace_id = ss.workspace_id and r.is_active = true
      where ss.workspace_id = '${WS}'
    )`;
  const joinClause = joined
    ? `inner join eligible_segments es on es.id = e.segment_id and es.workspace_id = e.workspace_id`
    : '';
  const query = `
    explain (analyze, buffers, format json)
    ${joined ? eligibleCte : ''}
    select e.segment_id as id,
      (1 - (e.embedding <=> '${vectorLiteral}'::vector)) as vector_score
    from session_segment_embeddings e
    ${joinClause}
    where e.provider = '${PROVIDER}' and e.model = '${MODEL}' and e.dimensions = ${DIMENSIONS}
    -- tiebreak=true replicates the shipping vector_candidates ORDER BY
    -- (session-recall.ts): the trailing segment_id sort key forces a full sort and
    -- defeats any HNSW/IVFFlat index. tiebreak=false is the restructured
    -- distance-only shape an ANN index can actually accelerate.
    order by e.embedding <=> '${vectorLiteral}'::vector${tiebreak ? ', e.segment_id asc' : ''}
    limit ${CANDIDATE_LIMIT}
  `;
  const rows = (await service.sql.unsafe(query)) as unknown as Record<string, unknown>[];
  const queryPlan = (rows[0]?.['QUERY PLAN'] ?? []) as Record<string, unknown>[];
  const plan = queryPlan[0] ?? {};
  const rootPlan = (plan.Plan ?? {}) as Record<string, unknown>;
  const text = planText(rootPlan);
  return {
    execMs: Number(plan['Execution Time']),
    planningMs: Number(plan['Planning Time']),
    topNode: String(rootPlan['Node Type']),
    usesVectorIndex:
      text.includes('hnsw') || text.includes('ivfflat') || text.includes('bench_hnsw'),
  };
}

async function timeFullRecall(service: DatabaseService, runs: number): Promise<TimingMeasurement> {
  const durations: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const queryEmbedding = {
      dimensions: DIMENSIONS,
      model: MODEL,
      provider: PROVIDER,
      vector: randomVector(DIMENSIONS),
    };
    const start = performance.now();
    // eslint-disable-next-line no-await-in-loop -- sequential timing samples are intentional
    await Effect.runPromise(
      searchSessionRecall(service, {
        limit: RECALL_LIMIT,
        query: RECALL_QUERY_TOKEN,
        queryEmbedding,
        workspaceId: WS,
      }),
    );
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  return {
    max: durations.at(-1) ?? Number.NaN,
    min: durations[0] ?? Number.NaN,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
  };
}

async function seedBase(service: DatabaseService): Promise<void> {
  await service.sql.unsafe(`
    insert into workspaces (id, handle, display_name)
      values ('${WS}', 'bench-ws', 'Bench Workspace') on conflict do nothing;
    insert into users (id, workspace_id, handle, identity_source)
      values ('${USER}', '${WS}', 'bench-user', 'host_username') on conflict do nothing;
    insert into source_bindings (id, workspace_id, source_type, source_uri, enabled)
      values ('${SB}', '${WS}', 'codex', 'codex://bench', true) on conflict do nothing;
  `);
}

async function seedSegments(service: DatabaseService, from: number, to: number): Promise<void> {
  const fromSession = Math.floor(from / SEGMENTS_PER_SESSION);
  const toSession = Math.floor((to - 1) / SEGMENTS_PER_SESSION);
  await service.sql.unsafe(`
    insert into sessions (id, workspace_id, source_binding_id, author_user_id, harness, harness_session_id, status, started_at, last_activity_at)
      select md5('sess-'||i)::uuid, '${WS}', '${SB}', '${USER}', 'codex', 'bench-'||i, 'active', now(), now()
      from generate_series(${fromSession}, ${toSession}) i
      on conflict (id) do nothing;
    insert into activity_intervals (id, workspace_id, session_id, ordinal, status, started_at)
      select md5('int-'||i)::uuid, '${WS}', md5('sess-'||i)::uuid, 0, 'active', now()
      from generate_series(${fromSession}, ${toSession}) i
      on conflict (id) do nothing;
    insert into raw_session_records (id, workspace_id, session_id, source_binding_id, author_user_id, activity_interval_id, snapshot_ordinal, is_active, status, harness, content_type, content_hash, captured_at)
      select md5('rec-'||i)::uuid, '${WS}', md5('sess-'||i)::uuid, '${SB}', '${USER}', md5('int-'||i)::uuid, 0, true, 'captured', 'codex', 'text', 'ch-'||i, now()
      from generate_series(${fromSession}, ${toSession}) i
      on conflict (id) do nothing;
    insert into session_turns (id, workspace_id, session_id, activity_interval_id, raw_session_record_id, ordinal, role, actor_kind)
      select md5('turn-'||i)::uuid, '${WS}', md5('sess-'||i)::uuid, md5('int-'||i)::uuid, md5('rec-'||i)::uuid, 0, 'assistant', 'agent'
      from generate_series(${fromSession}, ${toSession}) i
      on conflict (id) do nothing;
    insert into session_segments (id, workspace_id, session_id, activity_interval_id, turn_id, raw_session_record_id, ordinal, segment_kind, search_text)
      select md5('seg-'||j)::uuid, '${WS}',
        md5('sess-'||(j/${SEGMENTS_PER_SESSION}))::uuid,
        md5('int-'||(j/${SEGMENTS_PER_SESSION}))::uuid,
        md5('turn-'||(j/${SEGMENTS_PER_SESSION}))::uuid,
        md5('rec-'||(j/${SEGMENTS_PER_SESSION}))::uuid,
        (j % ${SEGMENTS_PER_SESSION}), 'turn',
        -- Diverse per-segment text (hex tokens) so trigram/tsvector selectivity is realistic;
        -- a rare, trigram-distinct sentinel token in ~1/${TOPIC_BUCKETS} of rows is the recall
        -- target. A shared word stem would make the recall query's fuzzy trigram predicate
        -- (search_text % query) match the whole corpus and inflate full-recall timing.
        'seg '||j||' '||md5(j::text)||' '||md5((j*3+1)::text)||
          (case when j % ${TOPIC_BUCKETS} = ${RECALL_MATCH_BUCKET} then ' ${RECALL_QUERY_TOKEN}' else '' end)
      from generate_series(${from}, ${to - 1}) j;
    insert into session_segment_embeddings (workspace_id, segment_id, raw_session_record_id, provider, model, dimensions, embedding, input_hash)
      select '${WS}', md5('seg-'||j)::uuid, md5('rec-'||(j/${SEGMENTS_PER_SESSION}))::uuid,
        '${PROVIDER}', '${MODEL}', ${DIMENSIONS},
        -- Distinct per-row random vectors: a pool of near-duplicate vectors degrades the
        -- HNSW graph and makes the indexed comparison meaningless.
        (select ('[' || string_agg(random()::text, ',') || ']')::vector
         from generate_series(1, ${DIMENSIONS})),
        'ih-'||j
      from generate_series(${from}, ${to - 1}) j;
  `);
}

function formatPlan(label: string, plan: PlanMeasurement): string {
  return `    ${label.padEnd(18)} exec=${plan.execMs.toFixed(1)}ms plan=${plan.planningMs.toFixed(1)}ms node=${plan.topNode} index=${String(plan.usesVectorIndex)}`;
}

function formatTiming(label: string, timing: TimingMeasurement): string {
  return `    ${label.padEnd(18)} p50=${timing.p50.toFixed(1)}ms p95=${timing.p95.toFixed(1)}ms min=${timing.min.toFixed(1)}ms max=${timing.max.toFixed(1)}ms`;
}

describeBench('pgvector recall bench (SGA-162)', () => {
  const databaseName = `saga_recall_bench_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let service: DatabaseService | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const testDatabaseUrl = new URL(databaseUrl ?? '');
    testDatabaseUrl.pathname = `/${databaseName}`;
    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: testDatabaseUrl.toString(),
          databaseUrlSource: 'environment',
          environment: 'test',
          logLevel: 'info',
          secrets: { openaiApiKey: undefined },
          service: { host: '127.0.0.1', port: 4766 },
        },
        // Single connection so session GUCs (maintenance_work_mem) reliably apply
        // to the same session that builds the index.
        { postgres: { max: 1 } },
      ),
    );
    await Effect.runPromise(runMigrations(service));
    await seedBase(service);
  }, 120_000);

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test(
    'sweeps recall cost across corpus sizes',
    async () => {
      if (service === undefined) {
        throw new Error('database service was not initialized');
      }
      const active = service;
      const lines: string[] = [
        '',
        `pgvector recall bench — dims=${DIMENSIONS} candidateLimit=${CANDIDATE_LIMIT} runs=${TIMING_RUNS}`,
      ];
      let seeded = 0;
      // Guard values default to the expected verdicts, so a run with the index step
      // disabled (SAGA_BENCH_INDEX=0) still passes; the index step overwrites them
      // with measured reality.
      let shippingShapeUsesIndex = false;
      let restructuredShapeUsesIndex = true;
      for (const n of SWEEP) {
        // eslint-disable-next-line no-await-in-loop -- sequential sweep by corpus size
        await seedSegments(active, seeded, n);
        seeded = n;
        // eslint-disable-next-line no-await-in-loop
        await active.sql.unsafe('analyze session_segments; analyze session_segment_embeddings;');
        const literal = randomVectorLiteral(DIMENSIONS);
        // eslint-disable-next-line no-await-in-loop
        const pureKnn = await explainKnn(active, literal, { joined: false });
        // eslint-disable-next-line no-await-in-loop
        const cteKnn = await explainKnn(active, literal, { joined: true });
        // eslint-disable-next-line no-await-in-loop
        const full = await timeFullRecall(active, TIMING_RUNS);
        lines.push(
          `  N=${n} (seq scan baseline)`,
          formatPlan('pure KNN', pureKnn),
          formatPlan('vector_candidates', cteKnn),
          formatTiming('full recall', full),
        );
        // eslint-disable-next-line no-console -- bench report output
        console.log(lines.slice(-4).join('\n'));
      }

      if (INDEX_AT_TOP) {
        lines.push(
          `  --- migrating to vector(${DIMENSIONS}) + building HNSW index at N=${seeded} ---`,
        );
        await active.sql.unsafe(`set maintenance_work_mem = '1GB'`);
        await active.sql.unsafe(
          `alter table session_segment_embeddings alter column embedding type vector(${DIMENSIONS}) using embedding::vector(${DIMENSIONS})`,
        );
        const buildStart = performance.now();
        await active.sql.unsafe(
          `create index bench_hnsw on session_segment_embeddings using hnsw (embedding vector_cosine_ops)`,
        );
        const buildMs = performance.now() - buildStart;
        await active.sql.unsafe('analyze session_segment_embeddings;');
        const literal = randomVectorLiteral(DIMENSIONS);
        // Faithful shipping shape (segment_id tiebreaker) — HNSW stays unused.
        const asIs = await explainKnn(active, literal, { joined: false });
        const asIsCte = await explainKnn(active, literal, { joined: true });
        // Restructured distance-only shape — what the HNSW index can accelerate.
        const restructured = await explainKnn(active, literal, { joined: false, tiebreak: false });
        const restructuredCte = await explainKnn(active, literal, {
          joined: true,
          tiebreak: false,
        });
        const full = await timeFullRecall(active, TIMING_RUNS);
        lines.push(
          `  N=${seeded} (HNSW index built, build=${(buildMs / 1000).toFixed(1)}s)`,
          formatPlan('pure KNN as-is', asIs),
          formatPlan('vec_cand as-is', asIsCte),
          formatPlan('pure KNN distonly', restructured),
          formatPlan('vec_cand distonly', restructuredCte),
          formatTiming('full recall as-is', full),
        );
        // eslint-disable-next-line no-console -- bench report output
        console.log(lines.slice(-6).join('\n'));
        shippingShapeUsesIndex = asIs.usesVectorIndex;
        // Only enforce "distance-only uses the index" once the corpus is large enough that
        // HNSW is unambiguously cheaper than a seq scan; below that the planner may cost-choose
        // a scan, which is fine and not a regression.
        restructuredShapeUsesIndex = seeded >= 20_000 ? restructured.usesVectorIndex : true;
      }
      expect(lines.length).toBeGreaterThan(SWEEP.length);
      // Regression guards for the ANN-index decision (SGA-162): the shipping ORDER BY
      // (distance + segment_id tiebreaker) cannot use HNSW, while the restructured
      // distance-only shape can. If either flips, the recall-plan analysis and its
      // follow-up (enable-hnsw task) need revisiting.
      expect(shippingShapeUsesIndex).toBe(false);
      expect(restructuredShapeUsesIndex).toBe(true);

      const report = `${lines.join('\n')}\n`;
      // eslint-disable-next-line no-console -- final consolidated report
      console.log(report);
      const outPath = process.env.SAGA_BENCH_OUT;
      if (outPath !== undefined && outPath !== '') {
        writeFileSync(outPath, report, 'utf8');
      }
    },
    30 * 60 * 1000,
  );
});
