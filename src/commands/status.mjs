import { SYNC } from '../manifest.mjs';
import { parseTarget, entriesForTarget } from '../targets.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock } from '../lock.mjs';
import { inspectCopy } from '../copy.mjs';
import { inspectMerge } from '../merge-keys.mjs';
import { NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../state.mjs';
import { formatRow, section } from '../report.mjs';
import { readIntegrations } from '../integrations/manifest.mjs';
import { integrationPlan } from '../integrations/runner.mjs';
import { defaultAdapters } from '../integrations/adapters.mjs';
import { declaredIds, undeclared, manifestDefects } from '../inventory.mjs';
import { probe } from '../inventory-probe.mjs';
import {
  readSkillsManifest,
  readSkillLock,
  installedSkillNames,
  reconcile,
  skillExposure,
} from '../skills.mjs';
import { agentIdsFor } from '../skills-cli.mjs';
import { readLinkExposure } from '../skill-links.mjs';
import { parseConfigMode, SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE } from '../config-mode.mjs';
import { cliVersion } from '../cli-version.mjs';
import { confirm as realConfirm } from '../prompt.mjs';
import { run as realPull } from './pull.mjs';

// Read-only by construction: nothing here writes, including the lockfile.
export function configReport(entries = SYNC) {
  const lock = readLock();
  return entries.map((entry) => {
    const { src, dest, mode } = resolveEntry(entry);
    if (mode === 'copy') {
      // Keyed by target so Claude's CLAUDE.md and Codex's AGENTS.md can never
      // share one baseline; entry.dest stays the display name.
      const baseline = lock.files[`${entry.target}:${entry.dest}`]?.hash;
      return { dest: entry.dest, mode, state: inspectCopy(src, dest, baseline).state };
    } else if (mode === 'merge-keys') {
      // inspectMerge already rolls a document's per-key states up to one of
      // the same state names inspectCopy uses, so noteFor and the exit-code
      // logic below need no separate case for this mode.
      const state = inspectMerge(src, dest, `${entry.target}:${entry.dest}`, lock).state;
      return { dest: entry.dest, mode, state };
    } else {
      // Unknown mode: surface as a visible error rather than silently misdispatching
      return { dest: entry.dest, mode, state: 'unknown-mode' };
    }
  });
}

export async function run(args = [], deps = {}) {
  // Both probes are injected so tests can answer "what can each agent see?"
  // and "what does Codex have installed?" without reading the developer's own
  // agent directories or spawning the real `codex` CLI.
  const {
    inspectExposure = readLinkExposure,
    codexState,
    cliState = cliVersion,
    confirm = realConfirm,
    pull = realPull,
    isTTY = process.stdin.isTTY,
  } = deps;

  // Before --target, so a global flag never reaches the target parser as a
  // stray value.
  const { rest: modeArgs, manageConfig } = parseConfigMode(args);

  const { target, rest: statusArgs, error } = parseTarget(modeArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }

  // First, before anything else is read. Everything below is computed by the
  // code in this checkout and against the manifests in it, so a stale checkout
  // produces a stale report — and the report is what the user would act on.
  const cli = cliState();
  if (cli.state !== 'unmanaged' && cli.state !== 'current') {
    const row = cli.state === 'behind'
      ? formatRow('nortuscc', 'behind', `${cli.remote}/${cli.branch} is at ${cli.sha}`)
      : formatRow('nortuscc', 'unknown', cli.note ?? '');
    process.stdout.write('\n' + section('cli', [row]));
  }

  if (cli.state === 'behind') {
    // Only ever on an explicit yes, and never asked where nothing can answer:
    // a scheduled status must not block on a prompt. Without a terminal this
    // reports and exits non-zero, which is the same answer a decline gives.
    const update = isTTY ? await confirm('Update nortuscc now?', { isTTY }) : false;

    if (update) {
      const code = await pull(['--target', target], { codexState });
      if (code !== 0) return code;
      // Deliberately does not go on to report. Every line below would come
      // from the modules this process already loaded — the old ones — and a
      // report the user cannot trust is worse than one they have to re-run.
      process.stdout.write('\nnortuscc updated. Re-run `nortuscc status` to report on the new version.\n');
      return 0;
    }
  }

  // A skills-only machine reports the section as unmanaged rather than
  // omitting it: silence would read as "clean", which is the one thing it is
  // not — nothing here has looked at those files at all.
  const rows = manageConfig ? configReport(entriesForTarget(SYNC, target)) : [];
  const lines = manageConfig
    ? rows.map((r) => formatRow(r.dest, r.state, noteFor(r)))
    : [formatRow(SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE)];
  process.stdout.write('\n' + section('config', lines));

  // Read-only: integrationPlan inspects, it never installs. `nortuscc setup`
  // and `apply --install` are the only paths that act on this.
  const { integrations, allow, errors } = readIntegrations();
  const adapters = await defaultAdapters({ codexState });

  // Read-only, like everything else here: this walks the machine and compares
  // it against the manifest. Nothing is installed, removed or written.
  const selectedIntegrations = errors.length ? [] : entriesForTarget(integrations, target);
  const inventory = probe({ target, integrations: selectedIntegrations, codexState: adapters.state });

  const planned = errors.length ? [] : integrationPlan({ integrations, target, adapters });
  const pending = planned.filter((item) => item.state !== 'installed');

  // Versions are reported, never declared: `claude plugin install` has no
  // version flag, so a pin in integrations.json could not be honoured and
  // would manufacture permanent drift against auto-updating marketplaces.
  // Diffing two machines' output is what this is for.
  const showVersions = statusArgs.includes('--versions');
  const versionOf = new Map(inventory.pluginVersions);

  // --versions only swaps the note column for a version; it must never take
  // the place of the pending list or its repair hint, which is the one line
  // that tells a machine with a missing plugin how to fix it.
  const integrationNote = (item) =>
    showVersions && item.type === 'plugin' ? (versionOf.get(item.plugin) ?? 'unknown') : item.note;

  const integrationLines = errors.length
    ? errors.map((message) => formatRow('manifest', 'invalid', message))
    : planned.length === 0
      ? [formatRow('none declared', 'satisfied', '')]
      : pending.length === 0
        ? showVersions
          ? planned.map((item) => formatRow(item.label, item.state, integrationNote(item)))
          : [formatRow('all declared', 'installed', '')]
        : [
            // --versions lists every planned item (so an installed plugin's
            // version still prints), never just the pending ones; the hint
            // stays regardless, since something here still needs `apply`.
            ...(showVersions ? planned : pending).map((item) => formatRow(item.label, item.state, integrationNote(item))),
            '',
            '  nortuscc apply --install',
          ];
  process.stdout.write(section('integrations', integrationLines));

  const skills = reconcile({
    groups: readSkillsManifest(),
    lock: readSkillLock(),
    installedNames: installedSkillNames(),
  });
  const skillLines = [];
  if (skills.missing.length) {
    skillLines.push(formatRow('missing', String(skills.missing.length), skills.missing.map((m) => m.name).join(', ')));
  }
  if (skills.extra.length) {
    skillLines.push(formatRow('extra', String(skills.extra.length), skills.extra.join(', ')));
  }
  if (skills.local.length) {
    skillLines.push(formatRow('local', String(skills.local.length), skills.local.join(', ')));
  }
  // Canonical presence and agent exposure are different questions: a skill can
  // sit in the shared store and still be loadable by no selected agent. Read
  // each agent's own skills directory to tell the two apart.
  const agents = agentIdsFor(target);
  // Nothing canonical to ask about means nothing to ask: a bare machine should
  // not go looking through agent directories to be told it has no skills.
  const { list, errors: exposureErrors } =
    skills.ok.length > 0 ? await inspectExposure(agents) : { list: {}, errors: [] };
  const exposure = skillExposure({ names: skills.ok, agents, list });

  if (exposure.partial.length) {
    skillLines.push(
      formatRow(
        'partial',
        String(exposure.partial.length),
        exposure.partial.map((p) => `${p.name} (missing from ${p.missingAgents.join(', ')})`).join(', '),
      ),
    );
  }
  // Present in the store and loadable by none of the selected agents. Reported
  // apart from `missing` above, which is the store's own answer: these are
  // installed, so an install has nothing to add, and were silently dropped
  // from this report for as long as the probe above could not produce them.
  if (exposure.missing.length) {
    skillLines.push(formatRow('unlinked', String(exposure.missing.length), exposure.missing.join(', ')));
  }
  for (const message of exposureErrors) skillLines.push(formatRow('exposure', 'unknown', message));

  if (!skillLines.length) skillLines.push(formatRow('manifest', 'satisfied', ''));
  // Each gap names the command that can close it. `apply --install` installs
  // what the store lacks and would find nothing to do for a skill already in
  // it; re-placing that skill into an agent's directory is `update`'s job.
  const repairs = [];
  if (skills.missing.length) repairs.push('  nortuscc apply --install');
  if (exposure.partial.length || exposure.missing.length) repairs.push('  nortuscc update');
  if (repairs.length) skillLines.push('', ...repairs);
  process.stdout.write(section('skills', skillLines));

  const inventoryRows = [
    ...undeclared({
      observed: inventory.observed,
      declared: declaredIds(selectedIntegrations, inventory.hookCommands),
      allow,
    }),
    ...manifestDefects(selectedIntegrations),
  ];

  const undeclaredLines = [
    ...inventoryRows.map((row) => formatRow(row.category, row.label, row.note)),
    ...inventory.errors.map((err) => formatRow(err.category, 'unknown', err.message)),
  ];
  if (inventoryRows.length) {
    undeclaredLines.push(
      '',
      `  ${inventoryRows.length} finding(s). Declare them in integrations.json, or list them`,
      '  under "allow" to accept them. --strict makes this exit non-zero.',
    );
  } else if (!inventory.errors.length) {
    // Printed rather than omitted, for the reason the skills section already
    // gives: silence reads as "clean", which is the one thing it is not.
    undeclaredLines.push(formatRow('all categories', 'declared', ''));
  }
  process.stdout.write(section('undeclared', undeclaredLines));

  const inventoryDirty = inventoryRows.length > 0 || inventory.errors.length > 0;

  // For CI or a login hook that wants drift to be actionable. The default is
  // informational, so an inventory finding alone is reported and forgiven.
  const strict = statusArgs.includes('--strict');

  const actionable = rows.filter(
    (r) => NEEDS_APPLY.has(r.state) || NEEDS_CAPTURE.has(r.state) || BLOCKED.has(r.state),
  );

  // Reached only by declining the update, or by having no terminal to be asked
  // on — which is the same answer. `unknown` is deliberately not counted: an
  // unreachable remote is being offline, which is ordinary and offers the user
  // nothing to do, unlike an exposure read that failed against local files.
  const cliBehind = cli.state === 'behind';

  // A selected integration that is missing or blocked is as actionable as a
  // drifted file: the machine is not in agreement with what the repo declares.
  //
  // An undeclared item is not, on its own, a machine out of agreement with
  // what it declared — every condition below is. Default stays informational
  // so a scheduled run does not start failing the day this ships; --strict is
  // what makes it actionable.
  const otherDirty =
    cliBehind ||
    actionable.length > 0 ||
    errors.length > 0 ||
    pending.length > 0 ||
    skills.missing.length > 0 ||
    exposure.partial.length > 0 ||
    exposure.missing.length > 0 ||
    exposureErrors.length > 0;

  if (!otherDirty && !inventoryDirty) {
    process.stdout.write('\neverything is in agreement\n');
    return 0;
  }

  // suggestions() speaks only for the config rows. Skills and integrations
  // already printed their own advice in their own sections, so a run made
  // dirty by those alone has nothing to add here and prints nothing.
  const advice = [
    // Named even though the prompt just offered it: a declined prompt is gone,
    // and a run with no terminal was never asked in the first place.
    ...(cliBehind ? ['  nortuscc pull     update nortuscc itself'] : []),
    suggestions(actionable),
  ].filter(Boolean).join('\n');
  if (advice) process.stdout.write('\n' + advice + '\n');

  if (otherDirty) return 1;
  return strict ? 1 : 0;
}

function noteFor(row) {
  switch (row.state) {
    case 'conflict': return 'changed in the repo AND here';
    case 'local-ahead': return 'local edits not in the repo';
    case 'repo-ahead': return 'repo has newer content';
    case 'unmanaged': return 'never synced on this machine';
    case 'missing-repo': return 'listed in the manifest but absent from the repo';
    case 'unknown-mode': return 'manifest entry has an unrecognized mode';
    case 'unparseable-local': return 'the local file could not be parsed';
    default: return '';
  }
}

function suggestions(rows) {
  const out = [];
  if (rows.some((r) => NEEDS_APPLY.has(r.state))) out.push('  nortuscc apply     bring this machine up to date');
  if (rows.some((r) => NEEDS_CAPTURE.has(r.state))) out.push('  nortuscc push -m   share local edits');
  if (rows.some((r) => r.state === 'conflict')) {
    // Each command only understands the flag that matches its own direction —
    // `apply --take-local` is refused outright — so the suggestion has to name
    // the command that can actually perform each resolution.
    out.push('  conflicts need a decision:');
    out.push('    nortuscc apply --take-repo    discard the local version');
    out.push('    nortuscc capture --take-local keep the local version');
  }
  return out.join('\n');
}
