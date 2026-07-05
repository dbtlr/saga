import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIGRATIONS_FOLDER,
  expectedMigrationHashes,
  readExpectedMigrationHashes,
} from './database.js';
import { embeddedJournal, embeddedSql } from './embedded-migrations.js';

const drizzleDir = fileURLToPath(new URL('../drizzle', import.meta.url));

// Drift lock: the embedded migration literals are a generated copy of
// packages/db/drizzle. A compiled single-binary migrates and hash-checks from
// the literals alone, so a stale embedded set must never pass CI. Regenerate
// with `node scripts/gen-embedded-migrations.mjs` after changing a migration.
describe('embedded migrations drift lock', () => {
  it('embeds the journal byte-identically', () => {
    const diskJournal: unknown = JSON.parse(
      readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
    );

    expect(embeddedJournal).toStrictEqual(diskJournal);
  });

  it('embeds exactly the on-disk migration set', () => {
    const diskTags = readdirSync(drizzleDir)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => file.replace(/\.sql$/, ''))
      .toSorted();

    expect(Object.keys(embeddedSql).toSorted()).toStrictEqual(diskTags);
  });

  it('embeds every migration byte-identically', () => {
    for (const [tag, sql] of Object.entries(embeddedSql)) {
      expect(sql, `embedded sql for ${tag} drifted from packages/db/drizzle`).toBe(
        readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8'),
      );
    }
  });

  it('derives migration hashes from the literals identical to the on-disk set', () => {
    expect(expectedMigrationHashes()).toStrictEqual(
      readExpectedMigrationHashes(DEFAULT_MIGRATIONS_FOLDER),
    );
  });
});
