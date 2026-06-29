import { vitestNode } from "@dbtlr/tooling/vitest";
import { defineConfig } from "vite-plus";
import type { OxlintConfig } from "oxlint";

type Override = NonNullable<OxlintConfig["overrides"]>[number];

const sagaPackage = (name: string): string[] => [`@saga/${name}`, `@saga/${name}/*`];
const relativeLayer = (name: string): string[] => [`**/${name}`, `**/${name}/**`];
const uiPackages = ["react", "react-dom", "@tanstack/*"];

const forbid = (files: string[], imports: string[], message: string): Override => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
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

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "coverage/**", "**/*.generated.ts", "**/*.gen.ts"],
  },
  lint: {
    ignorePatterns: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "**/*.generated.ts",
      "**/*.gen.ts",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      maxWarnings: 0,
    },
    overrides: [
      forbid(
        ["apps/cli/**"],
        [
          ...sagaPackage("service"),
          ...sagaPackage("control-plane"),
          ...relativeLayer("service"),
          ...relativeLayer("control-plane"),
        ],
        "App boundary: CLI orchestrates service/control-plane processes; it must not import their app trees.",
      ),
      forbid(
        ["apps/service/**"],
        [
          ...sagaPackage("cli"),
          ...sagaPackage("control-plane"),
          ...relativeLayer("cli"),
          ...relativeLayer("control-plane"),
        ],
        "App boundary: service owns runtime work and must not import CLI or control-plane app trees.",
      ),
      forbid(
        ["apps/control-plane/**"],
        [
          ...sagaPackage("cli"),
          ...sagaPackage("service"),
          ...relativeLayer("cli"),
          ...relativeLayer("service"),
        ],
        "App boundary: control-plane may call shared packages, not CLI or service app trees.",
      ),
      forbid(
        ["packages/**"],
        [
          ...sagaPackage("cli"),
          ...sagaPackage("service"),
          ...sagaPackage("control-plane"),
          ...relativeLayer("apps"),
        ],
        "Package boundary: shared packages must not import app trees.",
      ),
      forbid(
        ["apps/cli/**", "apps/service/**", "packages/**"],
        uiPackages,
        "UI isolation: React/TanStack client dependencies belong in the control-plane UI boundary.",
      ),
      { files: ["**/*.test.ts", "**/*.test.tsx"], rules: { "no-restricted-imports": "off" } },
    ],
  },
  // Monorepo layout: members run under the centralized root config, so test
  // discovery globs must reach each package's src (the helper's package-relative
  // default would match nothing here).
  ...vitestNode({ include: ["**/src/**/*.test.ts", "**/tests/**/*.test.ts"] }),
});
