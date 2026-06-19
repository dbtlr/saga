import { defineConfig } from "vite-plus";
import type { OxlintConfig } from "oxlint";

type Override = NonNullable<OxlintConfig["overrides"]>[number];

const forbid = (files: string[], layers: string[]): Override => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: layers.flatMap((layer) => [`**/${layer}`, `**/${layer}/**`]),
            message: `Layer boundary: ${files[0]} may not import from ${layers.join(", ")}.`,
          },
        ],
      },
    ],
  },
});

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "coverage/**", "**/*.generated.ts"],
  },
  lint: {
    ignorePatterns: ["dist/**", "coverage/**", "node_modules/**", "**/*.generated.ts"],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      maxWarnings: 0,
    },
    overrides: [
      forbid(["apps/cli/**"], ["control-plane"]),
      forbid(["apps/service/**"], ["control-plane"]),
      forbid(["packages/**"], ["apps"]),
      { files: ["**/*.test.ts", "**/*.test.tsx"], rules: { "no-restricted-imports": "off" } },
    ],
  },
  test: {
    environment: "node",
  },
});
