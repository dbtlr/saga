// Re-export the relocated render infra (SGA-239) from @saga/client-cli so
// apps/cli's './render.js' importers keep working after the move. Scoped to the
// render module's public symbols rather than `export * from '@saga/client-cli'`:
// the whole-barrel star also drags in the client command/doctor exports, whose
// names collide with apps/cli's own same-named modules (doctor.ts) when both are
// re-exported through the index barrel. The client-cli symbols apps/cli
// deliberately re-exposes are re-exported explicitly elsewhere (init.ts, cli.ts).
export {
  countLine,
  errorLine,
  glyph,
  noteLine,
  recordBlock,
  renderOptionsFromGlobals,
  separator,
  severityLine,
  shouldColor,
  style,
} from '@saga/client-cli';
export type { FieldRow, RenderOptions, Severity } from '@saga/client-cli';
