import {
  deriveStoredSessionRecord,
  listPendingLifecycleSettlements,
  listRawSessionRecordsAwaitingDerivation,
  settleStoredLifecycleBoundaryEvent,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import { Duration, Effect } from 'effect';

import type { Job, JobFactory } from './job-runner.js';

export const EXTRACTION_JOB_NAME = 'extraction';

// A fast tick: ingest STORES raw snapshots/events synchronously, and this job
// turns them into derived sessions/turns/segments shortly after. 5s keeps the
// derive latency low without busy-polling an idle database.
export const EXTRACTION_INTERVAL: Duration.Duration = Duration.seconds(5);

// Bounded work per tick so a large backlog can never fan one run into an
// unbounded transaction storm. If a full batch comes back, more remain — logged,
// never silently capped; the next tick drains the rest.
const EXTRACTION_BATCH_SIZE = 100;

// Drain one bounded batch: list the pending ids, then run `work` per id. Each unit
// is isolated (a failing item is logged and skipped, never aborting the batch);
// terminal-state bookkeeping (status='derived'/'settled'/'failed') lives inside
// the work Effect, so the loop only has to log-and-continue.
function drainBatch<E>(
  list: Effect.Effect<string[], E>,
  work: (id: string) => Effect.Effect<unknown, E>,
  label: string,
): Effect.Effect<number, E> {
  return Effect.gen(function* drain() {
    const ids = yield* list;
    for (const id of ids) {
      yield* work(id).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            console.error(`extraction: ${label} ${id} failed`, cause);
          }),
        ),
      );
    }
    return ids.length;
  });
}

// SGA-238: the asynchronous extraction half of the write path (ADR-0039).
// Recorded-done discovery: derive raw snapshots whose status is still 'captured',
// and settle lifecycle-boundary events still 'pending' in the settlement queue.
// Both work units are idempotent and own their terminal state, so the job is safe
// under the runner's at-least-once scheduling and can never livelock.
export const extractionJobFactory: JobFactory = ({ database }: { database: DatabaseService }) => {
  const run = Effect.gen(function* run() {
    const derived = yield* drainBatch(
      listRawSessionRecordsAwaitingDerivation(database, { limit: EXTRACTION_BATCH_SIZE }),
      (rawSessionRecordId) => deriveStoredSessionRecord(database, rawSessionRecordId),
      'derive',
    );
    const settled = yield* drainBatch(
      listPendingLifecycleSettlements(database, { limit: EXTRACTION_BATCH_SIZE }),
      (rawEventId) => settleStoredLifecycleBoundaryEvent(database, rawEventId),
      'settle',
    );

    if (derived >= EXTRACTION_BATCH_SIZE || settled >= EXTRACTION_BATCH_SIZE) {
      console.info(
        `extraction: batch full (derivations=${String(derived)}, ` +
          `settlements=${String(settled)}); more remain for the next tick`,
      );
    }
  });

  const job: Job = { interval: EXTRACTION_INTERVAL, name: EXTRACTION_JOB_NAME, run };
  return job;
};
