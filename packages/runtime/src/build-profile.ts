/**
 * The build's profile. A CI release build replaces the `SAGA_BUILD_PROFILE`
 * identifier with `"production"` via `bun build --define` (see
 * .github/workflows/release.yml), so a compiled/installed binary is production
 * and a from-source or unit run leaves it undefined and is treated as dev. The
 * dev-by-default polarity is deliberate: a build missing the define is harmless.
 * `typeof` on the (possibly undeclared) identifier is the one safe read, mirroring
 * version.ts.
 *
 * IS_PRODUCTION is scoped narrowly to config precedence — it gates whether project
 * `.env` files are read (source-only). It is NOT the "what do I exec / which path"
 * signal; binary.ts (isCompiledBinary / stableBinPath) owns that. Two signals, two
 * questions: this one lives in packages/runtime because the config loader consumes
 * it and a package cannot import from an app.
 */
declare const SAGA_BUILD_PROFILE: string | undefined;

export const IS_PRODUCTION: boolean = typeof SAGA_BUILD_PROFILE !== 'undefined';
