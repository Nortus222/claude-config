import type { BaseProfile, Issue, Settings } from './model.ts';
import { FILES } from './files.ts';
import { parseSettingsKeys } from './settings.ts';
import { parseSkillsManifest } from './skills.ts';
import { parseIntegrations } from './integrations.ts';

// The repository's documents as text; undefined means the file is absent. `settings` is keyed by
// the merge-keys file id that owns the document.
export type BaseTexts = {
  readonly skillsManifest?: string;
  readonly integrations?: string;
  readonly settings?: Readonly<Record<string, string | undefined>>;
};

// Reads every base-profile document. Each one validates on its own, so a refused document
// contributes nothing while the rest still resolve, as in the CLI.
export function buildBaseProfile(texts: BaseTexts, hookFileExists: (file: string) => boolean): BaseProfile {
  const issues: Issue[] = [];
  const settings: Record<string, Settings | undefined> = {};
  for (const file of FILES) {
    if (file.mode !== 'merge-keys') continue;
    const parsed = parseSettingsKeys(texts.settings?.[file.id], file.src);
    settings[file.id] = parsed.value;
    issues.push(...parsed.issues);
  }
  const integrations = parseIntegrations(texts.integrations, hookFileExists);
  issues.push(...integrations.issues);

  return {
    files: FILES,
    settings,
    skills: parseSkillsManifest(texts.skillsManifest),
    integrations: integrations.integrations,
    allow: integrations.allow,
    issues,
  };
}
