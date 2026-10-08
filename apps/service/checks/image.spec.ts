import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
test('image directly launches Node as a non-root runtime with locked production dependencies', () => {
  const file = read('Dockerfile');
  assert.match(file, /FROM node:24\.[0-9]+\.[0-9]+-bookworm-slim@sha256:[a-f0-9]{64} AS dependencies/);
  assert.match(file, /npm ci --omit=dev --workspace=apps\/service --workspace=packages\/hosted-protocol --ignore-scripts/);
  assert.match(file, /USER node/);
  assert.match(file, /ENTRYPOINT \["node", "apps\/service\/src\/main.ts"\]/);
  assert.doesNotMatch(file, /COPY \. |npm start|ENTRYPOINT.*sh|--build/);
  assert.match(file, /COPY --from=dependencies \/app\/node_modules/);
});
test('root build context allows only lockfiles and hosted runtime sources', () => {
  assert.deepEqual(read('Dockerfile.dockerignore').trim().split('\n'), [
    '**', '!package.json', '!package-lock.json', '!apps/', '!apps/service/',
    '!apps/service/package.json', '!apps/service/src/', '!apps/service/src/**',
    '!packages/', '!packages/hosted-protocol/', '!packages/hosted-protocol/package.json',
    '!packages/hosted-protocol/src/', '!packages/hosted-protocol/src/**',
  ]);
});
