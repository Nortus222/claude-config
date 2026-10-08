import { registerHooks } from 'node:module';

const main = new URL('../../src/main.ts', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  // Node 24.0/24.1 have no import.meta.main. Exercise that boundary on the installed runtime.
  return url === main ? { ...loaded, source: `delete import.meta.main;\n${loaded.source}` } : loaded;
} });
