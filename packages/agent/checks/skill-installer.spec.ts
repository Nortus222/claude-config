import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { AgentSkillInstaller, agentSkillInstaller } from '../src/skill-installer.ts';
const paths = { repo: '/checkout', claude: '/custom/claude', codex: '/custom/codex', codexOpenRouter: '/custom/glm', agentsSkills: '/selected/.agents/skills', stateRoot: '/state', backups: '/backups' };
const input = { source: 'owner/repo', revision: 'a'.repeat(40), selectorName: 'Design Review', targets: ['claude', 'codex'] as const };
test('installer invocation uses explicit home and custom native roots without replaying ambient environment', async () => {
  const command = await Effect.runPromise(AgentSkillInstaller.use(s => s.prepare(paths, input)).pipe(Effect.provide(agentSkillInstaller({ home: '/selected' }))));
  assert.deepEqual(command.env, { HOME: '/selected', USERPROFILE: '/selected', CLAUDE_CONFIG_DIR: '/custom/claude', CODEX_HOME: '/custom/codex', XDG_STATE_HOME: '' });
  assert.deepEqual(command.envAllow, ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']);
});
test('unsupported shared-store and XDG lock mappings refuse before constructing an invocation', async () => {
  for (const [locations, options] of [[{ ...paths, agentsSkills: '/custom/skills' }, { home: '/selected' }], [paths, { home: '/selected', xdgStateHome: '/other-state' }]] as const) {
    const result = await Effect.runPromise(Effect.result(AgentSkillInstaller.use(s => s.prepare(locations, input))).pipe(Effect.provide(agentSkillInstaller(options))));
    assert.equal(result._tag, 'Failure');
  }
});

test('missing explicit home refuses and default native roots are supported', async () => {
  assert.equal((await Effect.runPromise(Effect.result(AgentSkillInstaller.use(s => s.prepare(paths, input))).pipe(Effect.provide(agentSkillInstaller()))))._tag, 'Failure');
  const command = await Effect.runPromise(AgentSkillInstaller.use(s => s.prepare({ ...paths, claude: '/selected/.claude', codex: '/selected/.codex' }, input)).pipe(Effect.provide(agentSkillInstaller({ home: '/selected' }))));
  assert.equal(command.env?.CLAUDE_CONFIG_DIR, '/selected/.claude'); assert.equal(command.env?.XDG_STATE_HOME, '');
});
