import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { WatchedSource } from './model.ts';

type Draft = { source: string; url: string; baseline?: string; exact: boolean; skills: string[]; checkout?: string };

// What a manifest source fetches: a URL as written, otherwise the GitHub shorthand the CLI
// falls back to.
export function sourceUrl(source: string): string {
  return source.includes('://') || source.startsWith('git@') ? source : `https://github.com/${source}.git`;
}

// The sources a resolved setup uses, one per manifest source in first-seen order. Every declared
// skill is included, installed on this machine or not. A source's pin is its baseline.
export function sourcesFrom(
  config: Pick<DesiredConfig, 'skills'>,
  options: { readonly checkouts?: Readonly<Record<string, string>> } = {},
): WatchedSource[] {
  const bySource = new Map<string, Draft>();
  for (const skill of config.skills) {
    let draft = bySource.get(skill.source);
    if (draft === undefined) {
      draft = { source: skill.source, url: sourceUrl(skill.source), exact: false, skills: [] };
      const checkouts = options.checkouts ?? {};
      if (Object.hasOwn(checkouts, skill.source)) draft.checkout = checkouts[skill.source]!;
      bySource.set(skill.source, draft);
    }
    draft.exact ||= skill.exact;
    if (draft.baseline === undefined && skill.pin !== undefined) draft.baseline = skill.pin.ref;
    if (!draft.skills.includes(skill.name)) draft.skills.push(skill.name);
  }
  return [...bySource.values()];
}
