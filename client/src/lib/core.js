// shared/core.js is one file for the browser and the server. Depending on how the bundler treats it, it either sets
// globalThis.Core (as a plain script) or exports itself (as CommonJS); take whichever happened.
import * as core from '@shared/core.js';

export const Core = globalThis.Core || core.default || core;
