#!/usr/bin/env node

// Client-tier boundary guard (ADR-0048). The client tier runs from a bare binary
// and must never pull in the database tier: the protected packages
// (@saga/client-cli, SGA-237; @saga/api-client, SGA-238) may not depend on
// @saga/db — directly, through the transitive workspace-dep closure, or via a
// source import (bare specifier or a relative path into packages/db).
//
// The static-import ban is ALSO enforced structurally by the vite.config.ts
// forbid() override for each protected package. This script covers the two things
// lint cannot express: the package.json dependency closure (an install-shape
// property, not a source property), and quoted-specifier import forms lint's
// no-restricted-imports does not flag (dynamic import(...), side-effect
// import '...', require(...), export ... from). It fails loud (non-zero exit,
// named offenders) so a future edit that reaches for @saga/db is caught here
// rather than bloating the client binary.
//
// Usage: node scripts/check-client-boundary.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = '@saga/db';
const CLIENT_PACKAGES = ['@saga/client-cli', '@saga/api-client'];

const failures = [];

// --- Build a name -> package.json path map across every workspace package. ---
const workspacePackages = new Map();
for (const group of ['apps', 'packages']) {
  const groupDir = join(repoRoot, group);
  if (!existsSync(groupDir)) {
    continue;
  }
  for (const entry of readdirSync(groupDir)) {
    const manifestPath = join(groupDir, entry, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name === 'string') {
      workspacePackages.set(manifest.name, { dir: join(groupDir, entry), manifest });
    }
  }
}

// --- Transitive workspace-dep closure must not include @saga/db. ---
function workspaceDeps(manifest) {
  // dependencies + optionalDependencies + peerDependencies all ship with the
  // package; devDependencies do not, so they are deliberately excluded.
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }).filter((name) => workspacePackages.has(name));
}

function closureFor(rootName) {
  const visited = new Set();
  const closure = new Set();
  function walk(name) {
    if (visited.has(name)) {
      return;
    }
    visited.add(name);
    const entry = workspacePackages.get(name);
    if (entry === undefined) {
      return;
    }
    for (const dep of workspaceDeps(entry.manifest)) {
      closure.add(dep);
      walk(dep);
    }
  }
  walk(rootName);
  return closure;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// A quoted specifier of the db package: '@saga/db, "@saga/db, or `@saga/db.
const forbiddenPackageSpecifier = /['"`]@saga\/db/;
// A quoted relative specifier that walks up into packages/db: '../db/, '../../db/, …
const forbiddenRelativeSpecifier = /['"`]\.\.\/(?:\.\.\/)*db\//;

function sourceFiles(dir) {
  const files = [];
  if (!existsSync(dir)) {
    return files;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

for (const clientPackage of CLIENT_PACKAGES) {
  const clientEntry = workspacePackages.get(clientPackage);
  if (clientEntry === undefined) {
    console.error(`check-client-boundary: cannot find ${clientPackage} in the workspace`);
    process.exit(1);
  }

  // --- 1. Transitive workspace-dep closure must not include @saga/db. ---
  const closure = closureFor(clientPackage);
  if (closure.has(FORBIDDEN)) {
    if (workspaceDeps(clientEntry.manifest).includes(FORBIDDEN)) {
      failures.push(
        `${clientPackage}'s package.json declares a forbidden dependency: ${FORBIDDEN}`,
      );
    } else {
      failures.push(
        `${clientPackage} reaches ${FORBIDDEN} through its transitive workspace-dependency closure`,
      );
    }
  }

  // --- 2. No source file under the package's src may reference @saga/db, nor a ---
  // ---    relative path into packages/db, in ANY import form.                 ---
  // A quoted-prefix substring match catches every form (static, dynamic import(),
  // side-effect import '...', require, export ... from) with no per-form regex to
  // maintain. The static-import subset is also caught structurally by lint; this
  // covers the dynamic/side-effect/require forms lint's no-restricted-imports
  // leaves unflagged, plus quoted relative specifiers into packages/db.
  for (const file of sourceFiles(join(clientEntry.dir, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(repoRoot, file);
    if (forbiddenPackageSpecifier.test(source)) {
      failures.push(`${rel} references ${FORBIDDEN} in a quoted specifier`);
    }
    if (forbiddenRelativeSpecifier.test(source)) {
      failures.push(`${rel} references a relative path into packages/db in a quoted specifier`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `check-client-boundary: ${CLIENT_PACKAGES.join(', ')} must never depend on ${FORBIDDEN} (ADR-0048)`,
  );
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`check-client-boundary: ok — ${CLIENT_PACKAGES.join(', ')} are clear of ${FORBIDDEN}`);
