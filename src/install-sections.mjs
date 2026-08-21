import { SYNC } from './manifest.mjs';
import { entriesForTarget } from './targets.mjs';
import { resolveEntry } from './resolve.mjs';
import { readLock, writeLock } from './lock.mjs';
import { inspectCopy, applyCopy } from './copy.mjs';
import { inspectMerge, applyMerge } from './merge-keys.mjs';
import { readIntegrations } from './integrations/manifest.mjs';
import { integrationPlan, runIntegrations } from './integrations/runner.mjs';
import { defaultAdapters } from './integrations/adapters.mjs';
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile, installArgs } from './skills.mjs';
import { installGroups, agentIdsFor } from './skills-cli.mjs';

// The real wiring behind the three sections runInstall drives. Kept apart from
// the workflow itself so the workflow stays testable without a filesystem, a
// child process, or a terminal.

function configSection(target, { force = false, manageConfig = true } = {}) {
  // A skills-only machine offers no instruction files to install, so the
  // section is empty rather than absent — runInstall counts items, and an
  // empty section is already the "nothing to do here" it understands.
  const entries = manageConfig ? entriesForTarget(SYNC, target) : [];

  return {
    items: () =>
      entries.map((entry) => {
        const { src, dest, mode } = resolveEntry(entry);
        const lock = readLock();
        const key = `${entry.target}:${entry.dest}`;
        const state =
          mode === 'merge-keys'
            ? inspectMerge(src, dest, key, lock).state
            : inspectCopy(src, dest, lock.files[key]?.hash).state;
        return {
          // Keyed by target AND dest: Claude now owns two entries (its
          // instruction file and its settings keys), and a target-only id
          // would make the picker select or skip both together.
          id: `config:${key}`,
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
        const { src, dest, mode } = resolveEntry(item.entry);
        const key = `${item.entry.target}:${item.entry.dest}`;
        const opts = { force, relative: item.entry.dest, agent: item.entry.target };
        const res = mode === 'merge-keys' ? applyMerge(src, dest, key, lock, opts) : applyCopy(src, dest, key, lock, opts);
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

export async function defaultInstallDeps(target, { force = false, adapters, codexState, manageConfig = true } = {}) {
  const resolved = adapters ?? (await defaultAdapters({ codexState }));
  const integrations = integrationSection(target, resolved);
  return {
    // A manifest that will not validate and Codex state that could not be read
    // are both reasons to stop before installing anything.
    integrationErrors: [...integrations.errors, ...(resolved.errors ?? [])],
    sections: {
      config: configSection(target, { force, manageConfig }),
      integrations,
      skills: skillSection(target),
    },
  };
}
