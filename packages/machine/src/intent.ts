import { Effect } from 'effect';
import { intentValueProblem, normalizeSkillSource, settingsComplaints, type DesiredConfig, type MachineOverrides, type Target } from '@nortuscc/profile-engine';
import { OverridesStore } from './overrides.ts';

export type MachineIntentPatch =
  | { readonly kind: 'setting'; readonly fileId: string; readonly key: string; readonly action: 'set'; readonly value: unknown }
  | { readonly kind: 'setting'; readonly fileId: string; readonly key: string; readonly action: 'reset' }
  | { readonly kind: 'manageConfig'; readonly action: 'set'; readonly value: boolean }
  | { readonly kind: 'manageConfig'; readonly action: 'reset' }
  | { readonly kind: 'configTargets'; readonly action: 'set'; readonly value: readonly Target[] }
  | { readonly kind: 'configTargets'; readonly action: 'reset' }
  | { readonly kind: 'skill'; readonly source: string; readonly name: string; readonly action: 'enable' | 'disable' | 'reset' }
  | { readonly kind: 'integration'; readonly id: string; readonly action: 'enable' | 'disable' | 'reset' }
  | { readonly kind: 'removeSkillDeclaration'; readonly source: string; readonly name: string };

export class IntentInvalid extends Error {
  readonly reason: 'unknown' | 'collision' | 'secret' | 'invalid-json' | 'limit';
  readonly limit?: 'bytes' | 'depth' | 'nodes';
  constructor(reason: IntentInvalid['reason'], limit?: IntentInvalid['limit']) {
    super('Machine intent is invalid'); this.reason = reason; this.limit = limit;
  }
}
const sourceId = (value: string) => normalizeSkillSource(value) ?? value;
const without = <T>(record: Readonly<Record<string, T>> | undefined, key: string) => Object.fromEntries(Object.entries(record ?? {}).filter(([k]) => k !== key));

// Changes only explicit machine choices. Resolution of inherited layers remains the profile owner.
export const proposeMachineIntent = (desired: DesiredConfig, current: MachineOverrides, patch: MachineIntentPatch): Effect.Effect<MachineOverrides, IntentInvalid> => Effect.gen(function* () {
  const next = structuredClone(current);
  switch (patch.kind) {
    case 'manageConfig':
      return patch.action === 'reset' ? without(next, 'manageConfig') as MachineOverrides : { ...next, manageConfig: patch.value };
    case 'configTargets':
      return patch.action === 'reset' ? without(next, 'configTargets') as MachineOverrides : { ...next, configTargets: [...new Set(patch.value)] };
    case 'setting': {
      const file = desired.files.find(f => f.id === patch.fileId && f.mode === 'merge-keys');
      if (!file?.keys || !Object.hasOwn(file.keys, patch.key)) return yield* Effect.fail(new IntentInvalid('unknown'));
      if (patch.action === 'set') {
        const problem = intentValueProblem(patch.value);
        if (problem) return yield* Effect.fail(new IntentInvalid(problem === 'invalid-json' ? problem : 'limit', problem === 'invalid-json' ? undefined : problem));
        if (settingsComplaints({ [patch.key]: patch.value }).length) return yield* Effect.fail(new IntentInvalid('secret'));
      }
      const values = patch.action === 'reset' ? without(next.settings?.[patch.fileId], patch.key) : { ...next.settings?.[patch.fileId], [patch.key]: patch.value };
      const settings = Object.keys(values).length ? { ...next.settings, [patch.fileId]: values } : without(next.settings, patch.fileId);
      return { ...next, settings };
    }
    case 'integration': {
      if (!desired.integrations.some(i => i.id === patch.id)) return yield* Effect.fail(new IntentInvalid('unknown'));
      return { ...next, integrations: patch.action === 'reset' ? without(next.integrations, patch.id) : { ...next.integrations, [patch.id]: patch.action === 'enable' } };
    }
    case 'skill':
    case 'removeSkillDeclaration': {
      const matches = desired.skills.filter(s => s.name === patch.name);
      if (!matches.length || !matches.some(s => sourceId(s.source) === sourceId(patch.source))) return yield* Effect.fail(new IntentInvalid('unknown'));
      if (matches.some(s => sourceId(s.source) !== sourceId(patch.source))) return yield* Effect.fail(new IntentInvalid('collision'));
      if (patch.kind === 'skill') return { ...next, skills: patch.action === 'reset' ? without(next.skills, patch.name) : { ...next.skills, [patch.name]: patch.action === 'enable' } };
      const additions = next.skillAdditions ?? [];
      if (!additions.some(a => a.name === patch.name && sourceId(a.source) === sourceId(patch.source))) return yield* Effect.fail(new IntentInvalid('unknown'));
      const inherited = matches.some(s => s.declaredFrom?.layer === 'base');
      return { ...next, skillAdditions: additions.filter(a => !(a.name === patch.name && sourceId(a.source) === sourceId(patch.source))),
        ...(!inherited ? { skills: without(next.skills, patch.name) } : {}) };
    }
  }
});

export const persistMachineIntent = (next: MachineOverrides, expected: MachineOverrides) => OverridesStore.use(store => store.write(next, expected));
