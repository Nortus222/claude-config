import { SYNC } from '../manifest.mjs';
import { parseTarget, entriesForTarget } from '../targets.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock } from '../lock.mjs';
import { inspectCopy } from '../copy.mjs';
import { NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../state.mjs';
import { formatRow, section } from '../report.mjs';
import { readIntegrations } from '../integrations/manifest.mjs';
import { integrationPlan } from '../integrations/runner.mjs';
import { defaultAdapters } from '../integrations/adapters.mjs';
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

  const { target, error } = parseTarget(modeArgs);
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
  const { integrations, errors } = readIntegrations();
  const adapters = await defaultAdapters({ codexState });
  const planned = errors.length ? [] : integrationPlan({ integrations, target, adapters });
  const pending = planned.filter((item) => item.state !== 'installed');

  const integrationLines = errors.length
    ? errors.map((message) => formatRow('manifest', 'invalid', message))
    : planned.length === 0
      ? [formatRow('none declared', 'satisfied', '')]
      : pending.length === 0
        ? [formatRow('all declared', 'installed', '')]
        : [
            ...pending.map((item) => formatRow(item.label, item.state, item.note)),
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
  if (
    cliBehind === false &&
    actionable.length === 0 &&
    errors.length === 0 &&
    pending.length === 0 &&
    skills.missing.length === 0 &&
    exposure.partial.length === 0 &&
    exposure.missing.length === 0 &&
    exposureErrors.length === 0
  ) {
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
  return 1;
}

function noteFor(row) {
  switch (row.state) {
    case 'conflict': return 'changed in the repo AND here';
    case 'local-ahead': return 'local edits not in the repo';
    case 'repo-ahead': return 'repo has newer content';
    case 'unmanaged': return 'never synced on this machine';
    case 'missing-repo': return 'listed in the manifest but absent from the repo';
    case 'unknown-mode': return 'manifest entry has an unrecognized mode';
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
