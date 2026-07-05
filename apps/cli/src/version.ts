/**
 * The build's version. In a CI release build the release workflow replaces the
 * `SAGA_BUILD_VERSION` identifier with the git tag via `bun build --define`
 * (see .github/workflows/release.yml), so `saga --version` reports the exact
 * tag the binary was built from (SGA-180). From-source and unit runs leave it
 * undefined and fall back to package.json. `typeof` on the (possibly
 * undeclared) identifier is the one safe read.
 */
import pkg from '../package.json';

declare const SAGA_BUILD_VERSION: string | undefined;

export const VERSION: string =
  typeof SAGA_BUILD_VERSION !== 'undefined' ? SAGA_BUILD_VERSION : pkg.version;
