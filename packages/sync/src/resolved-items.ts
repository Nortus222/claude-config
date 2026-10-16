import type { DesiredConfig, MachineOverrides } from '@nortuscc/profile-engine';
import { canonical, contentHash } from '@nortuscc/machine';
import type { ItemValues } from './items.ts';
import type { Holds } from './store.ts';

// Compare profile values before machine choices. Origins do not change an item's value.
export const resolvedItemValues = (desired: DesiredConfig, documents: Readonly<Record<string, string>>): ItemValues => {
  const values = new Map<string, string>();
  for (const file of desired.files) {
    if (file.mode === 'copy') {
      const text = documents[file.src];
      if (!file.managed) values.set(`file:${file.id}`, canonical({ managed: false }));
      else if (text !== undefined) values.set(`file:${file.id}`, contentHash(file, text)!);
    } else {
      for (const [key, { value }] of Object.entries(file.keys ?? {})) values.set(`setting:${file.id}#${key}`, canonical(value));
    }
  }
  for (const skill of desired.skills) values.set(`skill:${skill.source}/${skill.name}`, canonical({
    exact: skill.exact, optional: skill.optional, install: skill.install, pin: skill.pin?.ref ?? null,
  }));
  for (const integration of desired.integrations) {
    const declaration = integration.declaration;
    values.set(`integration:${integration.id}`, canonical({ declaration, enabled: integration.enabled,
      ...(declaration.type === 'hook' && typeof declaration.file === 'string' ? { bytes: documents[declaration.file] ?? null } : {}),
    }));
  }
  return values;
};

// Existing choice formats are retained. Override entries use the paths accepted by overrideOf.
export const droppedOnSwitch = (input: { holds: Holds; overrides: MachineOverrides; to: DesiredConfig; staleHolds?: readonly string[] }): { holds: string[]; overrides: string[] } => {
  const ids = new Set<string>();
  for (const file of input.to.files) {
    if (file.mode === 'copy') ids.add(`file:${file.id}`);
    for (const key of Object.keys(file.keys ?? {})) ids.add(`setting:${file.id}#${key}`);
  }
  for (const skill of input.to.skills) ids.add(`skill:${skill.source}/${skill.name}`);
  for (const integration of input.to.integrations) ids.add(`integration:${integration.id}`);
  const overrides: string[] = [];
  for (const [fileId, keys] of Object.entries(input.overrides.settings ?? {}))
    for (const key of Object.keys(keys)) if (!ids.has(`setting:${fileId}#${key}`)) overrides.push(`settings.${fileId}.${key}`);
  for (const name of Object.keys(input.overrides.skills ?? {}))
    if (!input.to.skills.some(skill => skill.name === name)) overrides.push(`skills.${name}`);
  for (const id of Object.keys(input.overrides.integrations ?? {}))
    if (!ids.has(`integration:${id}`)) overrides.push(`integrations.${id}`);
  return { holds: Object.keys(input.holds).filter(id => !ids.has(id) || input.staleHolds?.includes(id)).sort(), overrides: overrides.sort() };
};
