export { FILES } from './files.ts';

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isProfileName = (name: string): boolean => PROFILE_NAME.test(name);
// Supported installer source identity. URLs may spell the same public GitHub repository.
export function normalizeSkillSource(source: string): string | undefined {
  const match = /^(?:https:\/\/github\.com\/)?([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(source);
  if (!match || match[2] === '.' || match[2] === '..') return undefined;
  // A residual suffix would change repository identity on the next normalization.
  if (match[2]!.toLowerCase().endsWith('.git')) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

// Native selector labels may differ; persisted names must already be canonical install names.
export const isSkillAdditionName = (name: string): boolean =>
  /^[a-z0-9_](?:[a-z0-9._-]{0,253}[a-z0-9_])?$/.test(name) && !name.includes('--');
