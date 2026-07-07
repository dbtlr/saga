// Re-export the relocated output infra (SGA-239) from @saga/client-cli so
// apps/cli's './output.js' importers keep working after the move. Scoped to the
// output module's public symbols rather than `export * from '@saga/client-cli'`
// (symmetry with render.ts): the whole-barrel star also re-exposes the client
// command/doctor exports, whose names collide with apps/cli's own same-named
// modules if this shim is ever pulled through the index barrel.
export { formatCommandOutput } from '@saga/client-cli';
export type { CommandOutput } from '@saga/client-cli';
