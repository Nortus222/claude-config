import type { DesiredConfig } from '@nortuscc/profile-engine';

// The setup item an observed key stands for, or undefined for a key that is no setup item
// (machine-local fixes, undeclared extras, anything unrecognised). A key without an id is never
// pending, so it is never auto-applied. #51's hosted-protocol takes this function over.
export const itemIdOf = (key: string, desired: DesiredConfig): string | undefined => {
  if (key.startsWith('config:')) {
    const rest = key.slice('config:'.length);
    const at = rest.indexOf('#');
    const file = desired.files.find((f) => f.id === (at === -1 ? rest : rest.slice(0, at)));
    if (!file) return undefined;
    if (at === -1) return file.mode === 'copy' ? `file:${file.id}` : undefined;
    const settingsKey = rest.slice(at + 1);
    return file.mode === 'merge-keys' && settingsKey !== '' ? `setting:${file.id}#${settingsKey}` : undefined;
  }
  if (key.startsWith('skill:')) {
    const name = key.slice('skill:'.length);
    const skill = desired.skills.find((s) => s.name === name);
    return skill ? `skill:${skill.source}/${skill.name}` : undefined;
  }
  if (key.startsWith('integration:')) {
    const id = key.slice('integration:'.length);
    return desired.integrations.some((i) => i.id === id) ? `integration:${id}` : undefined;
  }
  return undefined;
};
