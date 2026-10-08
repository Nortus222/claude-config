import assert from 'node:assert/strict';
import { decodeHosted, SetupRecordSchema, RevisionRecordSchema } from '@nortuscc/hosted-protocol';
import type { fixture } from './service.ts';
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const item = { id:'file:claude:CLAUDE.md',kind:'file' as const,change:'added' as const };
export const publication = (number: number) => ({ number,commitSha:'a'.repeat(40),tag:`v${number}`,changelog:'Published',items:[item],requiredEnv:[] as string[] });
export async function setup(f: Fixture, token: string) {
  const response = await f.call('POST','/v1/setups',{ name:'Config',repoUrl:'https://github.com/a/b' },token);
  assert.equal(response.status,201); return decodeHosted(SetupRecordSchema,await response.json());
}
export async function publish(f: Fixture, token: string, setupId: string, number: number) {
  f.clock.now += 60000;
  const response = await f.call('POST',`/v1/setups/${setupId}/revisions`,publication(number),token);
  assert.equal(response.status,201); return decodeHosted(RevisionRecordSchema,await response.json());
}
