import {
  deriveStoredSessionRecord,
  listLifecycleBoundaryEventsAwaitingSettlement,
  listRawSessionRecordsAwaitingDerivation,
  settleStoredLifecycleBoundaryEvent,
} from '@saga/db';
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

// SGA-238: the asynchronous extraction half of the write path (ADR-0039).
// Absence-based work discovery: derive active raw snapshots that have no turns
// yet, and settle stored lifecycle-boundary raw events that no interval yet
// references. Each unit is isolated (a failing record is logged and skipped, not
// allowed to abort the batch) and idempotent, so the job is safe under the
// runner's at-least-once scheduling.
export const extractionJobFactory: JobFactory = ({ database }) => {
  const run = Effect.gen(function* run() {
    const pendingDerivations = yield* listRawSessionRecordsAwaitingDerivation(database, {
      limit: EXTRACTION_BATCH_SIZE,
    });
    for (const rawSessionRecordId of pendingDerivations) {
      yield* deriveStoredSessionRecord(database, rawSessionRecordId).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            console.error(`extraction: derive ${rawSessionRecordId} failed`, cause);
          }),
        ),
      );
    }

    const pendingSettlements = yield* listLifecycleBoundaryEventsAwaitingSettlement(database, {
      limit: EXTRACTION_BATCH_SIZE,
    });
    for (const rawEventId of pendingSettlements) {
      yield* settleStoredLifecycleBoundaryEvent(database, rawEventId).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            console.error(`extraction: settle ${rawEventId} failed`, cause);
          }),
        ),
      );
    }

    if (
      pendingDerivations.length >= EXTRACTION_BATCH_SIZE ||
      pendingSettlements.length >= EXTRACTION_BATCH_SIZE
    ) {
      console.info(
        `extraction: batch full (derivations=${String(pendingDerivations.length)}, ` +
          `settlements=${String(pendingSettlements.length)}); more remain for the next tick`,
      );
    }
  });

  const job: Job = { interval: EXTRACTION_INTERVAL, name: EXTRACTION_JOB_NAME, run };
  return job;
};
