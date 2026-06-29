import { toolingConfig, vitestNode } from '@dbtlr/tooling';
import type { LintOverride } from '@dbtlr/tooling/vite-plus';

const sagaPackage = (name: string): string[] => [`@saga/${name}`, `@saga/${name}/*`];
const relativeLayer = (name: string): string[] => [`**/${name}`, `**/${name}/**`];
const uiPackages = ['react', 'react-dom', '@tanstack/*'];

const forbid = (files: string[], imports: string[], message: string): LintOverride => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: imports,
            message,
          },
        ],
      },
    ],
  },
});

const config = {
  ...toolingConfig({
    // node: builtins are allowed only on these globs (apps, shared packages, and
    // the smoke scripts all run on Node). control-plane is isomorphic, so it is
    // both a node and a react target.
    node: ['apps/**', 'packages/**', 'scripts/**'],
    react: ['apps/control-plane/**'],
    lint: {
      // routeTree.gen.ts and other generated files are generator-owned.
      ignores: ['**/*.generated.ts', '**/*.gen.ts'],
      rules: {
        // === SGA-170: rules deliberately kept off (more correct than fixing or
        // inline-disabling at every site). ===
        //  - reorders object literals -> changes Object.keys() order (load-bearing,
        //    e.g. CLI command order); 542 sites, behavior-risky, mostly noise.
        'sort-keys': 'off',
        //  - sequential awaits in DB/transaction loops, ordered imports, and a
        //    health-poll-with-delay are intentional; Promise.all would be wrong.
        'no-await-in-loop': 'off',
        //  - every site wraps a callback/event API (setTimeout, child 'exit',
        //    server.listen); `new Promise` is the required primitive here.
        'promise/avoid-new': 'off',
        //  - misfires on non-test entry points/scripts, and in real suites only
        //    flags the idiomatic describe-scope shared-connection pattern in
        //    DB-gated integration tests.
        'vitest/require-hook': 'off',
        // === Configured (not disabled) ===
        // new-cap fires on capitalized factory idioms that are correct without
        // `new`: Effect's Data.TaggedError / Context.GenericTag and our Effect
        // Layer constructors (e.g. DatabaseLive, RuntimeConfigLive). Exempt those
        // factory shapes rather than scatter per-line disables; genuine
        // missing-`new` constructor bugs are still flagged.
        'new-cap': [
          'warn',
          {
            capIsNewExceptions: ['Data.TaggedError', 'Context.GenericTag'],
            capIsNewExceptionPattern: 'Live$',
          },
        ],
      },
      overrides: [
        forbid(
          ['apps/cli/**'],
          [
            ...sagaPackage('service'),
            ...sagaPackage('control-plane'),
            ...relativeLayer('service'),
            ...relativeLayer('control-plane'),
          ],
          'App boundary: CLI orchestrates service/control-plane processes; it must not import their app trees.',
        ),
        forbid(
          ['apps/service/**'],
          [
            ...sagaPackage('cli'),
            ...sagaPackage('control-plane'),
            ...relativeLayer('cli'),
            ...relativeLayer('control-plane'),
          ],
          'App boundary: service owns runtime work and must not import CLI or control-plane app trees.',
        ),
        forbid(
          ['apps/control-plane/**'],
          [
            ...sagaPackage('cli'),
            ...sagaPackage('service'),
            ...relativeLayer('cli'),
            ...relativeLayer('service'),
          ],
          'App boundary: control-plane may call shared packages, not CLI or service app trees.',
        ),
        forbid(
          ['packages/**'],
          [
            ...sagaPackage('cli'),
            ...sagaPackage('service'),
            ...sagaPackage('control-plane'),
            ...relativeLayer('apps'),
          ],
          'Package boundary: shared packages must not import app trees.',
        ),
        forbid(
          ['apps/cli/**', 'apps/service/**', 'packages/**'],
          uiPackages,
          'UI isolation: React/TanStack client dependencies belong in the control-plane UI boundary.',
        ),
        {
          files: ['**/*.test.ts', '**/*.test.tsx'],
          rules: {
            'no-restricted-imports': 'off',
            // Casting mocks, fixtures, and partial objects to satisfy a
            // function signature is idiomatic and low-risk in tests; scope the
            // assertion-safety rule off here rather than litter suites with
            // per-line disables. Source files are still held to the rule.
            'typescript/no-unsafe-type-assertion': 'off',
          },
        },
      ],
    },
    fmt: {
      ignorePatterns: [
        'pnpm-lock.yaml',
        'bun.lock',
        'CHANGELOG.md',
        'dist/**',
        'build/**',
        'node_modules/**',
        'coverage/**',
        '.turbo/**',
        '.vite/**',
        // saga-specific: generator owns the route tree / generated files' style
        '**/*.generated.ts',
        '**/*.gen.ts',
      ],
    },
  }),
  // Monorepo layout: members run under the centralized root config, so test
  // discovery globs must reach each package's src (the helper's package-relative
  // default would match nothing here). toolingConfig omits the test block in
  // scoped/monorepo mode, so add it explicitly.
  ...vitestNode({ include: ['**/src/**/*.test.{ts,tsx}', '**/tests/**/*.test.{ts,tsx}'] }),
};

export default config;
