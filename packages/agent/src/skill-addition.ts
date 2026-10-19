import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { Backups, canonical, Fs, HistoryStore, MachinePaths, OverridesStore, runInstaller, skillLockPath, verifyAcceptedSkill,
  verifyClaudeSkill, verifyCodexSkill, SkillCandidateCleanupFailed, type Command, type Plan, type Step, type ProcessDialogue } from '@nortuscc/machine';
import type { AcceptedSkillPlan } from './skill-operations.ts';
import type { RunLifecycle } from './runs.ts';
import type { RunView } from './operations/index.ts';
import type { AgentDomain } from './layer.ts';
import type { JobInspection } from './job.ts';
import { describe, redact, safeMessage } from './operations/safety.ts';

const REPAIR = 'preview the skill again to repair it. Backups are in ~/.config/nortuscc/backups';

export interface AdditionInvocation { readonly command: Command; readonly lockText: string | undefined }

type Accepted = NonNullable<RunView['intent']['skillAddition']>;
type Installation = NonNullable<RunView['installation']>;
export const acceptedSkillTuple = (plan: AcceptedSkillPlan): Accepted => {
  const preview = plan.preview.skillAddition!;
  const c = plan.candidate;
  return { source: c.source, acceptedRevision: c.revision, sourceDir: c.sourceDir, selectorName: c.selectorName,
    installedName: c.installedName, blob: c.blob, tree: c.tree, internal: c.internal,
    targets: [...preview.declaration.after.targets], declaration: preview.declaration.after, policy: preview.pinImpact.policy };
};
export const additionRunPlan = (plan: Plan, name: string): Plan => {
  const step = (key: string, summary: string, touches: string[], interruptible: boolean): Step => ({ key, domain: 'skills', action: 'install-skills', summary, touches, interruptible });
  return { ...plan, steps: [step(`skill-intent:${name}`, 'save machine skill declaration', ['overrides.json'], false),
    ...plan.steps, step(`skill-verify:${name}`, 'verify accepted content and selected native catalogs', [`skills/${name}`], true)] };
};

// Runs inside the session's existing lock and executor. No second intent or recovery store.
export const makeAdditionDriver = (accepted: AcceptedSkillPlan, lifecycle: RunLifecycle,
  refresh: Effect.Effect<JobInspection, unknown>, readers: {
    readonly content?: typeof verifyAcceptedSkill; readonly claude?: typeof verifyClaudeSkill; readonly codex?: typeof verifyCodexSkill;
  } = {}, invocation?: AdditionInvocation) => Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const fs = yield* Fs;
  const overrides = yield* OverridesStore;
  const history = yield* HistoryStore;
  const context = yield* Effect.context<ProcessDialogue>();
  const tuple = acceptedSkillTuple(accepted);
  let persistenceUncertain = false;
  let saved = false;
  let intentState: RunView['intentState'] = 'pending';
  let prepared = false;
  let installed = accepted.plan.steps.length === 0;
  let installerNote = '';
  let installation: Installation | undefined;
  let retainedDirectory: string | undefined;
  const update = () => Effect.gen(function* () {
    const receipt = yield* Effect.exit(lifecycle.addition({ intentSaved: saved, intentState, ...(installation ? { installation } : {}) }));
    yield* history.append({ kind: 'skill-addition', actor: lifecycle.actor, runId: lifecycle.runId,
      operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId,
      intentSaved: saved, intentState: intentState!, ...(installation ? { installationState: installation.state } : {}),
      message: installation?.message ?? (saved ? 'Machine declaration saved' : 'Saving the machine declaration has not finished') });
    if (Exit.isFailure(receipt)) return yield* Effect.failCause(receipt.cause);
  }).pipe(Effect.onExit(exit => Effect.sync(() => { if (Exit.isFailure(exit)) persistenceUncertain = true; })));
  const result = (state: Installation['state'], message: string, evidence: Pick<Installation, 'claude' | 'codex'> = {}): Installation => ({
    state, message: [...message].slice(0, 500).join(''), ...(retainedDirectory ? { retainedDirectory: [...retainedDirectory].slice(0, 4096).join('') } : {}), sharedStore: { codexScans: true, visibility: 'shared' }, ...evidence,
    nextActions: state === 'verified' ? [
      { kind: 'share_with_my_machines', capability: { available: false, reason: 'Sharing requires the personal sharing workflow and a user destination.' }, requiredDestination: 'user' },
      { kind: 'promote_to_profile', capability: { available: false, reason: 'Promotion requires the profile publication workflow and an owned profile destination.' }, requiredDestination: 'profile' },
    ] : [],
  });
  const domain: AgentDomain = {
    name: 'skills', inspect: () => Effect.succeed({ items: [], probeErrors: [] }), steps: () => ({ steps: [], skipped: [] }),
    run: step => Effect.gen(function* () {
      if (step.key.startsWith('skill-intent:')) {
        const current = yield* overrides.read;
        if (current.issues.length || canonical(current.value) !== canonical(accepted.priorOverrides.value))
          return { ok: false, note: 'Machine declaration changed after acceptance; preview again' };
        if (accepted.preview.skillAddition!.declaration.changed || accepted.preview.skillAddition!.enablement) {
          intentState = 'needsInspection';
          yield* update();
          yield* overrides.write(accepted.overrides.value, accepted.priorOverrides.value);
        }
        saved = true; intentState = 'saved';
        yield* update();
        const fresh = yield* refresh;
        const persisted = yield* overrides.read;
        if (persisted.issues.length || canonical(persisted.value) !== canonical(accepted.overrides.value))
          return { ok: false, note: 'The machine declaration changed after saving; preview the skill again' };
        const resolved = { ...fresh.desired, skills: fresh.desired.skills.map(s => s.name === tuple.installedName && s.source === tuple.source ? { ...s, exact: true } : s) };
        if (canonical(resolved) !== canonical(accepted.desired))
          return { ok: false, note: 'The saved declaration does not resolve to the accepted skill; preview the skill again' };
        prepared = true;
        return { ok: true, note: 'Machine declaration saved; shared store is also scanned by Codex' };
      }
      if (!saved || !prepared) return { ok: false, note: 'The machine declaration was not confirmed saved; preview the skill again' };
      if (!step.key.startsWith('skill-verify:')) {
        if (!invocation || (yield* fs.readText(skillLockPath(paths))) !== invocation.lockText)
          return { ok: false, note: 'Native skill lock changed after acceptance; preview again' };
        const backups = yield* Backups;
        yield* backups.preserve(join(paths.agentsSkills, tuple.installedName), join('skills', tuple.installedName));
        yield* backups.preserve(skillLockPath(paths), 'skill-lock.json');
        for (const target of tuple.targets) yield* backups.preserve(join(paths[target], 'skills', tuple.installedName), join(target, 'skills', tuple.installedName));
        if ((yield* fs.readText(skillLockPath(paths))) !== invocation.lockText)
          return { ok: false, note: 'Native skill lock changed during backup; preview again' };
        const ran = yield* runInstaller(invocation.command, tuple.source);
        installed = ran.ok; installerNote = ran.note ?? '';
        return ran;
      }
      const content = yield* (readers.content ?? verifyAcceptedSkill)(accepted.candidate).pipe(Effect.onExit(exit => Effect.gen(function* () {
        // Record owned cleanup evidence before the executor settles the step, preserving the full cause.
        if (Exit.isFailure(exit)) for (const reason of exit.cause.reasons) {
          if (Cause.isDieReason(reason) && reason.defect instanceof SkillCandidateCleanupFailed) {
            retainedDirectory = reason.defect.temporaryDirectory;
            installation = result('needsInspection', 'Accepted source cleanup was not confirmed; temporary source ownership is unresolved');
            yield* update();
            break;
          }
        }
      })));
      if (content.cleanup) {
        retainedDirectory = content.cleanup.retainedDirectory;
        installation = result('needsInspection', 'Accepted source cleanup was not confirmed; temporary source ownership is unresolved');
        yield* update();
        return { ok: false, note: installation.message };
      }
      if (!installed || !content.verified) {
        installation = result('failed', !installed ? safeMessage(`The skills installer failed${installerNote ? ` (${redact(installerNote)})` : ''}; ${REPAIR}`) : content.problems.join('; '));
        yield* update();
        return { ok: false, note: installation.message };
      }
      const cwd = join(paths.stateRoot, 'tmp', `skill-catalog-${randomUUID()}`);
      retainedDirectory = cwd;
      installation = result('needsInspection', 'Native catalog verification is incomplete');
      yield* update();
      yield* fs.writeTextAtomic(join(cwd, '.prepare'), '');
      yield* fs.remove(join(cwd, '.prepare'));
      const evidence: { claude?: Installation['claude']; codex?: Installation['codex'] } = {};
      const native = Effect.gen(function* () {
        const skillPath = join(paths.agentsSkills, tuple.installedName, 'SKILL.md');
        if (tuple.targets.includes('claude')) {
          evidence.claude = yield* (readers.claude ?? verifyClaudeSkill)({ skillPath, selectorName: tuple.selectorName, installedName: tuple.installedName, cwd });
          installation = result('needsInspection', 'Native catalog verification is incomplete', evidence);
          yield* update();
        }
        if (tuple.targets.includes('codex') && evidence.claude?.reason !== 'cleanup-failed') {
          evidence.codex = yield* (readers.codex ?? verifyCodexSkill)({ skillPath, cwd });
          installation = result('needsInspection', 'Native catalog verification is incomplete', evidence);
          yield* update();
        }
      }).pipe(Effect.provideContext(context));
      // Failed cleanup leaves an owned neutral directory and cannot produce verified success.
      yield* native;
      if (evidence.claude?.reason === 'cleanup-failed' || (evidence.codex?.verified === false && evidence.codex.reason === 'cleanup-failed')) {
        installation = result('needsInspection', 'Native process cleanup was not confirmed; neutral directory ownership is unresolved', evidence);
        yield* update();
        return { ok: false, note: installation.message };
      }
      yield* fs.remove(cwd).pipe(Effect.timeout(2000));
      retainedDirectory = undefined;
      const verified = tuple.targets.every(t => evidence[t]?.verified === true);
      installation = result(verified ? 'verified' : 'failed', verified
        ? 'Installed content matches the accepted revision and was detected in every selected native model catalog'
        : 'Installed content verified; selected native catalog availability remains unverified', evidence);
      yield* update();
      return { ok: verified, note: installation.message };
    }).pipe(Effect.catch(error => Effect.succeed({ ok: false, note: safeMessage(`The skill addition stopped: ${describe(error)}`) }))),
  };
  const finish = (state: 'failed' | 'cancelled' | 'needsInspection') => Effect.gen(function* () {
    if (persistenceUncertain || intentState === 'needsInspection' || installation?.state === 'needsInspection') state = 'needsInspection';
    if (installation?.state === state) return;
    if (installation?.state === 'verified') state = 'needsInspection';
    installation = result(state, state === 'cancelled' ? 'Installation cancelled; saved intent is retained' : `The skill installation did not finish; ${REPAIR}`, { ...(installation?.claude ? { claude: installation.claude } : {}), ...(installation?.codex ? { codex: installation.codex } : {}) });
    yield* update();
  });
  return { domain, finish };
});
