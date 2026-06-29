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

export default {
  ...toolingConfig({
    // node: builtins are allowed only on these globs (apps, shared packages, and
    // the smoke scripts all run on Node). control-plane is isomorphic, so it is
    // both a node and a react target.
    node: ['apps/**', 'packages/**', 'scripts/**'],
    react: {
      files: ['apps/control-plane/**'],
      // react-perf rules are active only inside this scoped override, so they
      // must be tuned here (a top-level rules disable wouldn't reach them).
      // SGA-170: off pending evaluation in the rule loop.
      rules: {
        'react-perf/jsx-no-new-function-as-prop': 'off',
        'react-perf/jsx-no-new-array-as-prop': 'off',
      },
    },
    lint: {
      // routeTree.gen.ts and other generated files are generator-owned.
      ignores: ['**/*.generated.ts', '**/*.gen.ts'],
      // SGA-170: rules disabled pending case-by-case enablement. Each is
      // re-enabled, evaluated, and either fixed or justified in its own commit.
      rules: {
        // --- Disabled at adoption; re-enabled one at a time below (SGA-170). ---
        // Behavior-changing autofixers (reverted; handle manually):
        //  - rewrites test()->it() without fixing the vitest import.
        'vitest/consistent-test-it': 'off',
        //  - alphabetizes object literals -> changes Object.keys() order
        //    (load-bearing for e.g. CLI command order).
        'sort-keys': 'off',
        // Not auto-fixed; pending evaluation:
        'typescript/no-unsafe-type-assertion': 'off',
        'no-await-in-loop': 'off',
        'no-shadow': 'off',
        'new-cap': 'off',
        'promise/avoid-new': 'off',
        'vitest/no-conditional-expect': 'off',
        'vitest/require-to-throw-message': 'off',
        'vitest/require-hook': 'off',
        'vitest/valid-expect': 'off',
        'typescript/no-unnecessary-type-conversion': 'off',
        'typescript/method-signature-style': 'off',
        'typescript/parameter-properties': 'off',
        'typescript/consistent-return': 'off',
        'typescript/no-misused-spread': 'off',
        'promise/prefer-await-to-callbacks': 'off',
        'promise/prefer-await-to-then': 'off',
        'promise/param-names': 'off',
        'promise/no-multiple-resolved': 'off',
        'no-nested-ternary': 'off',
        'unicorn/no-nested-ternary': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'unicorn/no-useless-spread': 'off',
        'unicorn/custom-error-definition': 'off',
        'unicorn/prefer-structured-clone': 'off',
        'unicorn/prefer-response-static-json': 'off',
        'unicorn/no-array-method-this-argument': 'off',
        'oxc/no-map-spread': 'off',
        'no-underscore-dangle': 'off',
        'func-names': 'off',
        'no-new': 'off',
        'no-duplicate-imports': 'off',
        'import/no-duplicates': 'off',
        'import/no-anonymous-default-export': 'off',
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
        { files: ['**/*.test.ts', '**/*.test.tsx'], rules: { 'no-restricted-imports': 'off' } },
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
  ...vitestNode({ include: ['**/src/**/*.test.ts', '**/tests/**/*.test.ts'] }),
};
