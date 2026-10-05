import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES, TARGETS } from '../src/index.ts';

// files.json is untyped data, so its shape is checked here instead of by the compiler.
test('every managed file is a well-formed entry keyed by its state-file id', () => {
  const ids = new Set<string>();
  for (const file of FILES) {
    assert.equal(file.id, `${file.target}:${file.dest}`);
    assert.ok((TARGETS as readonly string[]).includes(file.target), file.id);
    assert.ok(['claude', 'codex', 'codex-openrouter'].includes(file.home), file.id);
    assert.ok(file.mode === 'copy' || file.mode === 'merge-keys', file.id);
    assert.equal(typeof file.src, 'string');
    assert.equal(typeof file.preserveProjects, 'boolean');
    assert.equal(typeof file.capture, 'boolean');
    assert.ok(!ids.has(file.id), `duplicate ${file.id}`);
    ids.add(file.id);
  }
  assert.equal(FILES.length, 5);
});
