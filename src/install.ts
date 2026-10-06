import { Effect } from 'effect';
import { INTEGRATIONS_SOURCE, type Target } from '@nortuscc/profile-engine';
import {
  inspect, plan, SKILL_STEP, skillNamesOf,
  type InstallCategory, type MachineReport, type Observed, type Step,
} from '@nortuscc/machine';
import { domainsFor, forTargets, runPlan, type CliServices, type Opened } from './machine.ts';
import { confirm as realConfirm } from './prompt.ts';
import { formatRow, section } from './report.ts';
import { select as realSelect, type Choice } from './select.ts';

// The shared installation workflow behind `apply --install` and `setup`: offer the machine's
// integrations and skills, decide, review, confirm, then install through one plan. There is no
// `nortuscc install`: installing is something those commands do, not a mode of its own.
// Configuration is not offered here; the calling command has already applied it.

// What `--no-*` can decline. Configuration is not one: declining an agent's configuration is
// what `--target` is for.
export const CATEGORIES: ReadonlyArray<InstallCategory> = ['hooks', 'mcp', 'plugins', 'skills'];

const SKILLS_GROUP = 'shared skills';

export type InstallFlags = { yes: boolean; declined: InstallCategory[]; error: string | null; rest: string[] };

// Flags this workflow does not own are handed back in `rest`, never rejected: the same argv
// carries the calling command's own flags.
export function parseInstallFlags(args: string[]): InstallFlags {
  const out: InstallFlags = { yes: false, declined: [], error: null, rest: [] };
  for (const arg of args) {
    if (arg === '--yes') {
      out.yes = true;
    } else if (arg.startsWith('--no-')) {
      const category = arg.slice('--no-'.length) as InstallCategory;
      if (!CATEGORIES.includes(category)) {
        out.error = `unknown option ${arg} (expected one of ${CATEGORIES.map((c) => `--no-${c}`).join(', ')})`;
        return out;
      }
      if (!out.declined.includes(category)) out.declined.push(category);
    } else {
      out.rest.push(arg);
    }
  }
  return out;
}

// Integrations whatever their state, so "already installed" stays distinguishable from "not
// offered"; skills only when there is something to do. Installed, undeclared and local skills are
// left out, as are configuration items.
const offered = (item: Observed): boolean =>
  item.domain === 'integrations'
  || (item.domain === 'skills' && (item.state === 'missing' || item.state === 'unlinked' || item.disposition === 'blocked'));

// Only an item the plan would install starts ticked: a satisfied one has nothing to do, a
// blocked one cannot be made to work by ticking it, and an optional one waits to be chosen.
function toChoice(item: Observed): Choice {
  const note = item.disposition === 'in-sync'
    ? `already installed${item.note ? ` — ${item.note}` : ''}`
    : item.disposition === 'blocked'
      ? `blocked — ${item.note ?? 'a prerequisite is missing'}`
      : item.domain === 'skills' && item.note === 'optional'
        ? 'optional skill, select to install'
        : item.note ?? '';
  return {
    key: item.key,
    group: item.domain === 'skills' ? SKILLS_GROUP : item.group,
    label: item.label,
    note,
    checked: item.disposition === 'apply',
  };
}

// The picker's rows: integrations first, then skills.
export function installChoices(items: ReadonlyArray<Observed>): Choice[] {
  const rows = items.filter(offered);
  return [...rows.filter((i) => i.domain === 'integrations'), ...rows.filter((i) => i.domain === 'skills')].map(toChoice);
}

// The last thing between a user and a set of child processes. Each step's summary is the command
// or action it will run, as the domain wrote it, so whatever a domain redacted stays redacted.
export function reviewLines(steps: ReadonlyArray<Step>, report: MachineReport): string[] {
  if (steps.length === 0) return ['  nothing to do'];
  const lines: string[] = [];
  let group: string | null = null;
  for (const step of steps) {
    const item = report.items.find((i) => i.key === step.key);
    const heading = step.domain === 'skills' ? SKILLS_GROUP : item?.group ?? step.domain;
    const label = step.domain === 'skills' ? skillNamesOf(step).join(', ') : item?.label ?? step.key;
    if (heading !== group) {
      if (lines.length) lines.push('');
      lines.push(`  ${heading}`);
      group = heading;
    }
    lines.push(`    ${label}  ${step.summary}`);
  }
  return lines;
}

const INTEGRATION_CATEGORY: Record<string, InstallCategory> = { hook: 'hooks', mcp: 'mcp', marketplace: 'plugins', plugin: 'plugins' };

const NO_TERMINAL =
  '\nnortuscc: no terminal to choose on. Re-run with --yes to accept the defaults,\n' +
  '  or with --no-hooks / --no-mcp / --no-plugins / --no-skills to decline categories.';

// Gathers, decides, reviews and installs. Nothing is written before the plan runs, so every
// refusal leaves the machine as it was. Returns 0 when everything chosen installed, 1 when
// something failed or the run was cancelled, 2 for a usage error or an invalid integrations.json.
export function runInstall(opened: Opened, input: {
  targets: Target[]; flags: InstallFlags; isTTY: boolean; signal: AbortSignal;
  select?: typeof realSelect; confirm?: typeof realConfirm;
}): Effect.Effect<number, unknown, CliServices> {
  const { targets, flags, isTTY, signal, select = realSelect, confirm = realConfirm } = input;
  return Effect.gen(function* () {
    if (flags.error) {
      console.error(`nortuscc: ${flags.error}`);
      return 2;
    }
    const invalid = opened.desired.issues.filter((i) => i.source === INTEGRATIONS_SOURCE);
    if (invalid.length > 0) {
      for (const issue of invalid) console.error(`nortuscc: ${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
      console.error('nortuscc: integrations.json is invalid; nothing was installed.');
      return 2;
    }

    // A declined category or an unselected agent is never inspected, so its CLI is never probed.
    const scoped = forTargets(opened.desired, targets);
    const desired = {
      ...scoped,
      integrations: scoped.integrations.filter((i) => !flags.declined.includes(INTEGRATION_CATEGORY[String(i.declaration.type)]!)),
    };
    const { integrations, skills } = domainsFor(opened.paths);
    const domains = [integrations, skills] as const;
    const inspected = yield* inspect(desired, domains);
    for (const error of inspected.probeErrors) console.error(`nortuscc: ${error}`);

    const items = inspected.items.filter((i) =>
      (i.target === undefined || targets.includes(i.target)) && !(i.domain === 'skills' && flags.declined.includes('skills')));
    const choices = installChoices(items);
    if (!items.some((i) => offered(i) && i.disposition !== 'in-sync')) {
      process.stdout.write('\nnothing to install; everything selected is already in place\n');
      return 0;
    }

    let keys: string[];
    if (flags.yes) {
      keys = choices.filter((c) => c.checked).map((c) => c.key);
    } else if (!isTTY) {
      console.error(NO_TERMINAL);
      return 2;
    } else {
      const picked = yield* Effect.promise(() => select(choices, { title: 'choose what to install', isTTY }));
      // A cancellation asks for nothing to happen, not for an empty subset to be confirmed.
      if (picked === null) {
        process.stdout.write('\ncancelled; nothing was installed\n');
        return 0;
      }
      keys = picked;
    }

    // An optional skill the user ticked is wanted on this run, though not by default.
    const chosen = new Set(keys);
    const report: MachineReport = {
      ...inspected,
      items: inspected.items.map((i) =>
        i.domain === 'skills' && chosen.has(i.key) && i.state === 'missing' && i.disposition === 'excluded'
          ? { ...i, disposition: 'apply' } : i),
    };
    const planned = plan('apply', report, { targets, declined: flags.declined, only: [...chosen], exclude: [], force: false }, domains);
    if (planned.steps.length === 0) {
      process.stdout.write('\nnothing selected\n');
      return 0;
    }

    if (!flags.yes) {
      process.stdout.write('\n' + section('about to install', reviewLines(planned.steps, report)));
      if (!(yield* Effect.promise(() => confirm('Install these items?', { isTTY })))) {
        process.stdout.write('\ndeclined; nothing was installed\n');
        return 0;
      }
    }

    const ran = yield* runPlan(planned, report, domains, {
      signal,
      onStarted: (step) => {
        if (step.key.startsWith(SKILL_STEP.install)) process.stdout.write(`\n${step.summary}\n`);
      },
    });

    const rows: string[] = [];
    let failed = 0;
    for (const { step, outcome, note } of ran.results) {
      const state = outcome === 'ok' ? 'installed' : outcome;
      if (outcome === 'failed') failed += step.domain === 'skills' ? skillNamesOf(step).length : 1;
      if (step.domain === 'skills') {
        const source = step.key.slice(SKILL_STEP.install.length);
        for (const name of skillNamesOf(step)) rows.push(formatRow(name, state, outcome === 'ok' ? '' : `${source} — ${note}`));
      } else {
        rows.push(formatRow(report.items.find((i) => i.key === step.key)?.label ?? step.key, state, outcome === 'ok' ? '' : note));
      }
    }
    process.stdout.write('\n' + section('install', rows));

    if (failed > 0) {
      process.stdout.write(`\n${failed} item(s) failed. See the output above for details.\n`);
      return 1;
    }
    if (ran.cancelled) {
      process.stdout.write('\ncancelled; the remaining items were not installed\n');
      return 1;
    }
    return 0;
  });
}
