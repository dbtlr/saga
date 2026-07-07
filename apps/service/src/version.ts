// The service build's version. The service runs from source (tsx/node) rather
// than a `bun build --define` compile, so there is no injected identifier to
// prefer — the package.json version is the single source. `/v1/info` reports it.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
