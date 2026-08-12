import { SYNC } from './manifest.mjs';
import { entriesForTarget } from './targets.mjs';
import { resolveEntry } from './resolve.mjs';
import { readLock, writeLock } from './lock.mjs';
import { inspectCopy, applyCopy } from './copy.mjs';
import { readIntegrations } from './integrations/manifest.mjs';
import { integrationPlan, runIntegrations } from './integrations/runner.mjs';
import { defaultAdapters } from './integrations/adapters.mjs';
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile, installArgs } from './skills.mjs';
import { installGroups, agentIdsFor } from './skills-cli.mjs';

// The real wiring behind the three sections runInstall drives. Kept apart from
// the workflow itself so the workflow stays testable without a filesystem, a
// child process, or a terminal.

function configSection(target, { force = false } = {}) {
  const entries = entriesForTarget(SYNC, target);

  return {
    items: () =>
      entries.map((entry) => {
        const { src, dest } = resolveEntry(entry);
        const lock = readLock();
        const state = inspectCopy(src, dest, lock.files[`${entry.target}:${entry.dest}`]?.hash).state;
        return {
          id: `config:${entry.target}`,
          label: entry.dest,
          // 'clean' is this section's "already installed"; every other state
          // is something apply would act on.
          state: state === 'clean' ? 'installed' : 'missing',
          default: true,
          describe: dest,
          note: state === 'clean' ? '' : state,
          entry,
        };
      }),

    install: async (items) => {
      const lock = readLock();
      const before = JSON.stringify(lock);
      const results = items.map((item) => {
        const { src, dest } = resolveEntry(item.entry);
        const res = applyCopy(src, dest, `${item.entry.target}:${item.entry.dest}`, lock, {
          force,
          relative: item.entry.dest,
          agent: item.entry.target,
        });
        return {
          id: item.id,
          label: item.label,
          ok: res.action !== 'refused',
          note: res.action === 'refused' ? 'conflict — nothing changed' : res.action,
        };
      });
      if (JSON.stringify(lock) !== before) writeLock(lock);
      return results;
    },
  };
}

function integrationSection(target, adapters) {
  const { integrations, errors } = readIntegrations();

  return {
    errors,
    items: () =>
      errors.length
        ? []
        : integrationPlan({ integrations, target, adapters }).map((item) => ({
            id: `${item.type}:${item.id}`,
            type: item.type,
            group: item.group,
            label: item.label,
            state: item.state,
            note: item.note,
            default: item.default,
            describe: adapters[item.type]?.describe(item) ?? '',
            item,
          })),

    install: async (items) => {
      const results = await runIntegrations(items.map((i) => i.item), adapters);
      return results.map((result, index) => ({ ...result, id: items[index].id, label: items[index].label }));
    },
  };
}

function skillSection(target) {
  const agents = agentIdsFor(target);
  const missing = reconcile({
    groups: readSkillsManifest(),
    lock: readSkillLock(),
    installedNames: installedSkillNames(),
  }).missing;

  return {
    items: () =>
      missing.map((skill) => ({
        id: `skill:${skill.name}`,
        category: 'skills',
        label: skill.name,
        state: 'missing',
        default: true,
        source: skill.source,
        describe: `npx skills add ${skill.source} --skill ${skill.name} --agent ${agents.join(' ')}`,
      })),

    install: async (items) => {
      const groups = installArgs(items.map((i) => ({ name: i.label, source: i.source })));
      const results = await installGroups(groups, { agents });
      const okSources = new Set(results.filter((r) => r.ok).map((r) => r.source));
      return items.map((item) => ({
        id: item.id,
        label: item.label,
        ok: okSources.has(item.source),
        note: okSources.has(item.source) ? '' : `${item.source} — install failed, see output above`,
      }));
    },
  };
}

export function defaultInstallDeps(target, { force = false, adapters = defaultAdapters() } = {}) {
  const integrations = integrationSection(target, adapters);
  return {
    integrationErrors: integrations.errors,
    sections: {
      config: configSection(target, { force }),
      integrations,
      skills: skillSection(target),
    },
  };
}
