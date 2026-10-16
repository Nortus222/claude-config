import React, { type Ref } from 'react';
import type { OperationChange, RunView as OperationRunView } from '@nortuscc/agent/operations';
import type { WireObserved } from '@nortuscc/agent/ipc/protocol';
import { MachineController, canCancel, type StepStatus, type ViewState } from './controller.ts';
const DOMAINS = [['config', 'Configuration'], ['integrations', 'Integrations'], ['skills', 'Skills']] as const;
const MARK: Record<StepStatus, string> = { pending: '·', running: '…', ok: '✓', failed: '✕', cancelled: '–' };
const provenance = (item: WireObserved) => (item.from ? `${item.from.layer} · ${item.from.source}` : '—');
function SkillAdditionResult({ run }: { run: OperationRunView }) {
  const skill = run.intent.skillAddition;
  if (!skill) return null;
  const installation = run.installation;
  const intent = run.intentState === 'needsInspection' ? 'needs inspection' : run.intentState ?? (run.intentSaved ? 'saved' : 'unknown');
  const status = installation?.state === 'needsInspection' ? 'needs inspection' : installation?.state ?? 'not verified';
  return <div className="pad">
    <h3>{skill.installedName}</h3>
    {run.actor ? <p>Requested via {run.actor}</p> : null}
    <p>Machine intent: {intent}</p>
    <p>Source: <code>{skill.source}</code> · <code>{skill.sourceDir}</code></p>
    <p>Required targets: {skill.declaration.targets.join(', ')}. Revision policy: {skill.policy}.</p>
    <details><summary>Accepted revision and declaration</summary><p><code>{skill.acceptedRevision}</code></p><pre>{JSON.stringify(skill.declaration, null, 2)}</pre></details>
    <p>Installation: {status}</p>
    {installation ? <p>{installation.message}</p> : null}
    <p>Codex also scans the shared skill store. Selected targets require usable exposure and do not make visibility exclusive.</p>
    {installation?.retainedDirectory ? <p>Verification directory retained for inspection: <code>{installation.retainedDirectory}</code></p> : null}
    {installation?.codex ? <p>Codex catalog: {installation.codex.verified ? <>verified, enabled · <code>{installation.codex.path}</code></> : installation.codex.reason}</p> : null}
    {installation?.claude ? <>
      <p>Claude catalog: {installation.claude.catalog.status}. Restrictions: {installation.claude.restrictions.status}.</p>
      {installation.claude.reason ? <p>Claude verification: {installation.claude.reason}</p> : null}
      <p>Claude catalog discovery does not attest the selected source or invocation authorization. Evidence covers only the requested environment. Managed startup remains active.</p>
    </> : null}
    {installation?.state === 'verified' && installation.nextActions.length ? <ul>{installation.nextActions.map(action => <li key={action.kind}>
      <p>{action.kind === 'share_with_my_machines' ? 'Do you want to share it with your other machines?' : 'Promote to profile'}</p>
      <p>Readiness: {action.capability.available ? 'ready' : 'blocked'}. Required destination: {action.requiredDestination}{action.destinationId ? ` (${action.destinationId})` : ''}.</p>
      {action.capability.reason ? <p>{action.capability.reason}</p> : null}
      <p>Requires a user request for this declaration.</p>
    </li>)}</ul> : null}
    {installation?.state !== 'verified' ? <p>To repair, ask your coding agent to resolve this skill again, review the machine addition and apply it. Inspect retained intent and installed files before retrying.</p> : null}
  </div>;
}

const domainText = {
  reconcile: ['Reconcile selected items', 'Existing owner guards and selected targets apply.'],
  machineIntent: ['Machine intent', 'Reset reveals inherited intent. Disabling or removing a declaration does not physically remove content.'],
  capture: ['Capture configuration', 'Writes selected author documents. Commit and publication remain explicit CLI actions.'],
  uninstallConfig: ['Restore recorded configuration', 'Restores recorded documents through their owner; general backup restoration is unavailable.'],
  update: ['Update selected skills', 'Addition repair requires the verified addition workflow. Author manifest edits are separately selected.'],
  followProfile: ['Follow profile', 'Back up dropped choices and refetch for inspection only.'],
  setupApply: ['Apply incoming setup choices', 'Saves every reviewed choice and applies the selected machine plan in one run.'],
  syncDecision: ['Incoming configuration decision', 'Accepting may permit existing policy scheduling. Repository trust requires the app consent action.'],
  sourceDecision: ['Author source decision', 'Source-wide pins affect all declared skills. Author edits are separate from machine policy; ignore suppresses notifications.'],
  setPolicy: ['Automatic application policy', 'Manual policy changes scheduling. It does not create a user pause or grant repository trust.'],
  resume: ['Resume automatic application', 'Clears a failure pause without changing policy.'],
  signIn: ['Start device authorization', 'Device authorization initiation does not mean authentication completed.'],
  signOut: ['Sign out', 'Uses the existing account owner. Inspect account state after a partial outcome.'],
  syncAccount: ['Sync account', 'An empty local queue alone does not confirm persistence of a particular metadata patch.'],
  patchMachineMetadata: ['Machine account metadata', 'Changes use the existing local outbox.'],
  pruneBackups: ['Prune retained backups', 'Retention pruning does not back up the backups it removes. General restore remains unavailable.'],
  addSkill: ['Add a machine skill', 'Required targets verify usability; they do not promise exclusive visibility.'],
} as const satisfies Record<OperationChange['kind'], readonly [string, string]>;

function SemanticRunResult({ run, challengeCurrent }: { run: OperationRunView; challengeCurrent?: boolean }) {
  if (run.intent.change.kind === 'addSkill') return null;
  const change = run.intent.change;
  const [title, meaning] = domainText[change.kind];
  const accepted = run.intent.parity;
  const evidence = run.parity;
  const author = accepted && 'author' in accepted ? accepted.author : undefined;
  const signIn = evidence?.kind === 'signIn' ? evidence.signIn : undefined;
  const challenge = challengeCurrent !== false && signIn?.state === 'awaiting-user' && Date.parse(signIn.expiresAt) > Date.now() ? signIn : undefined;
  const keys = (label: string, values: readonly string[]) => <details><summary>{label}: {values.length}</summary><ul>{values.map(value => <li key={value}><code>{value}</code></li>)}</ul></details>;
  return <div className="pad">
    <h3>{title}</h3><p>{meaning}</p>
    {change.kind === 'machineIntent' ? <p>{change.patch.kind}: {'action' in change.patch ? change.patch.action : 'remove declaration'}{'id' in change.patch ? ` (${change.patch.id})` : ''}.</p> : null}
    {change.kind === 'sourceDecision' ? <p>{change.action}: <code>{change.sourceId}</code>{'revision' in change ? <> at <code>{change.revision}</code></> : null}.</p> : null}
    {change.kind === 'syncDecision' ? <p>{change.action}: <code>{change.itemId}</code> in setup <code>{change.setupId}</code>.</p> : null}
    {change.kind === 'setPolicy' ? <p>Selected policy: {change.policy}.</p> : null}
    {change.kind === 'update' ? <p>Author manifest: {change.authorManifest ? 'included in this request' : 'not selected'}.</p> : null}
    {run.actor ? <p>Requested via {run.actor}</p> : null}
    <p>Run: <code>{run.runId}</code>. Request: <code>{run.intent.requestId}</code>. Scope: {run.scope.kind}.</p>
    {author ? <p>Author destination: <code>{author.checkout}</code>. Revision: <code>{author.head}</code>.</p> : null}
    {evidence ? <>
      <p>Effects: {evidence.state === 'needsInspection' ? 'uncertain; inspect committed effects and backups before retrying' : evidence.state}.</p>
      {keys('Committed effects', evidence.committedKeys)}{keys('Remaining effects', evidence.remainingKeys)}{keys('Backups', evidence.backupIds)}
      {'metadata' in evidence && evidence.metadata === 'locally-queued' ? <p>Metadata is locally queued; hosted persistence is not confirmed.</p> : null}
      {evidence.kind === 'machineIntent' ? <p>Machine intent: {evidence.intentState}. Routing effects: {evidence.routingEffects.map(effect => `${effect.fileId}: ${effect.state === 'observed' ? effect.outcome : 'needs inspection'}`).join(', ') || 'none'}.</p> : null}
    </> : <p>Effects have not been observed yet.</p>}
    {accepted?.kind === 'pruneBackups' && accepted.retention.limited ? <p>This retention batch is limited. Review another preview for remaining eligible folders.</p> : null}
    {signIn ? <>
      <p>Device authorization: {signIn.state}. Display expires at {signIn.expiresAt}.</p>
      {challenge?.userCode && challenge.verificationUri ? <p>Complete authorization in your browser at <a href={challenge.verificationUri} target="_blank" rel="noreferrer">{challenge.verificationUri}</a> with code <code>{challenge.userCode}</code>.</p>
        : <p>Challenge unavailable. Inspect current account state before starting authorization again.</p>}
    </> : null}
  </div>;
}

export function ReviewView({ controller, state, reviewTarget }: { controller: MachineController; state: ViewState; reviewTarget?: Ref<HTMLHeadingElement> }) {
  const running = state.run?.outcome === 'running';
  const applying = running || state.status?.applying === true;
  const ready = state.connection === 'connected' && !state.pending && !applying;
  const inspection = state.inspection;
  const excluded = new Set(state.excluded);
  const groups = DOMAINS.map(([domain, title]) => ({ domain, title, items: inspection?.items.filter((i) => i.domain === domain) ?? [] }))
    .filter((group) => group.items.length > 0);
  const steps = state.preview?.plan.steps ?? [];
  const skipped = state.preview?.plan.skipped ?? [];
  return (
    <div className="review-view">
      <header>
        <div>
          <p className="eyebrow">THIS MACHINE</p>
          <h1 ref={reviewTarget} tabIndex={-1}>Review &amp; apply</h1>
          <p className="intro">Inspect this machine, preview the changes, then apply them with backups.</p>
        </div>
        <span className={`connection ${state.connection}`}>
          <i />
          {state.connection === 'browser' ? 'Browser preview' : state.connection}
        </span>
      </header>
      <div className="layout">
        <aside>
          <p className="eyebrow">PROFILE</p>
          {inspection ? (
            <dl className="profile">
              <dt>Repository</dt>
              <dd><code>{inspection.profile.repo}</code></dd>
              <dt>Revision</dt>
              <dd><code>{inspection.profile.revision?.slice(0, 12) ?? 'unknown'}</code></dd>
              <dt>Overrides</dt>
              <dd><code>{inspection.profile.overrides}</code></dd>
            </dl>
          ) : (
            <p className="muted">Not inspected</p>
          )}
          {inspection?.profile.issues.length ? (
            <div className="problems">
              <strong>Profile issues</strong>
              <ul>{inspection.profile.issues.map((issue, n) => <li key={n}>{issue.source}: {issue.path} — {issue.message}</li>)}</ul>
            </div>
          ) : null}
          {inspection?.probeErrors.length ? (
            <div className="problems">
              <strong>Probe failures</strong>
              <ul>{inspection.probeErrors.map((error, n) => <li key={n}>{error}</li>)}</ul>
            </div>
          ) : null}
          {state.hello ? <p className="muted">Agent {state.hello.agentVersion} · protocol {state.hello.protocol}</p> : null}
          {state.status ? (
            <div className="agent-status">
              <p>Policy: {state.status.policy}</p>
              <p>{state.status.trusted ? 'Trusted machine' : 'Machine not trusted'}</p>
              <p>{state.status.counts.pending} pending · {state.status.counts.held} held · {state.status.counts.ready} ready · {state.status.counts.drift} drift</p>
              {state.status.applying ? <p role="status">The agent is applying changes</p> : null}
              {state.status.paused ? <p role="status">Automatic apply paused: {state.status.paused.reason}. You can still review and apply changes here.</p> : null}
              {state.status.error ? <p role="alert">{state.status.error}: {state.status.detail}</p> : null}
              {state.status.probeErrors.length ? <ul>{state.status.probeErrors.map((error, n) => <li key={n}>{error}</li>)}</ul> : null}
            </div>
          ) : null}
          <button className="restart" disabled={state.connection === 'browser' || state.pending || (state.connection === 'connected' && applying)} onClick={() => void controller.restart()}>
            Restart / reinstall agent
          </button>
        </aside>
        <div className="content">
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">INSPECT</p>
                <h2>What this machine has</h2>
              </div>
              <button disabled={state.connection !== 'connected' || state.pending || running} onClick={() => void controller.inspect()}>Inspect again</button>
            </div>
            {inspection === null ? (
              <p className="muted pad">{state.detail}</p>
            ) : groups.length === 0 ? (
              <p className="muted pad">No domain reported any items.</p>
            ) : (
              groups.map((group) => (
                <div className="table-wrap" key={group.domain}>
                  <table>
                    <caption>{group.title}</caption>
                    <thead>
                      <tr><th aria-label="Include" /><th>Item</th><th>State</th><th>Disposition</th><th>From</th></tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => (
                        <tr key={item.key}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Include ${item.label}`}
                              disabled={!ready || item.disposition !== 'apply'}
                              checked={item.disposition === 'apply' && !excluded.has(item.key)}
                              onChange={() => controller.toggle(item.key)}
                            />
                          </td>
                          <td>
                            <strong>{item.label}</strong>
                            <small>{item.group}{item.target === undefined ? '' : ` · ${item.target}`}</small>
                            {item.note ? <small>{item.note}</small> : null}
                          </td>
                          <td>{item.state}</td>
                          <td><span className={`disposition ${item.disposition}`}>{item.disposition}</span></td>
                          <td className="muted">{provenance(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </section>
          <section>
            <div className="section-head">
              <div>
                <p className="eyebrow">PREVIEW</p>
                <h2>{state.preview ? `${steps.length} steps` : 'Not previewed'}</h2>
              </div>
              <button disabled={!ready || !inspection} onClick={() => void controller.previewPlan()}>Preview changes</button>
            </div>
            {state.preview ? (
              <>
                {steps.length ? (
                  <ol className="steps">
                    {steps.map((step, n) => (
                      <li key={`${n}:${step.key}`}>
                        <span>{step.summary}</span>
                        <small>{step.domain} · {step.action}</small>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted pad">Nothing to apply.</p>
                )}
                {skipped.length ? (
                  <details>
                    <summary>{skipped.length} skipped</summary>
                    <ul className="skipped">{skipped.map((s, n) => <li key={`${n}:${s.key}`}><code>{s.key}</code> — {s.reason}</li>)}</ul>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="muted pad">Preview to see exactly what Apply will change.</p>
            )}
          </section>
          <section className="operation">
            <div className="section-head">
              <div>
                <p className="eyebrow">APPLY</p>
                <h2 className="status">{state.connection === 'disconnected' ? 'Disconnected' : state.run?.outcome ?? 'Ready'}</h2>
              </div>
            </div>
            {state.run ? (
              <ol className="progress-steps">
                {state.run.steps.map((step, n) => (
                  <li key={`${n}:${step.key}`} className={step.status}>
                    <span aria-hidden="true">{MARK[step.status]}</span>
                    <span>{step.summary}</span>
                    {step.note ? <small>{step.note}</small> : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {state.run?.receipt ? <><SkillAdditionResult run={state.run.receipt} /><SemanticRunResult run={state.run.receipt} challengeCurrent={state.run.challengeCurrent} /></> : null}
            {state.run?.backups ? <p className="pad">Backups: <code>{state.run.backups}</code></p> : null}
            <p className="detail" role="status" aria-live="polite">{state.detail}</p>
            <div className="actions">
              <button className="primary" disabled={!ready || steps.length === 0} onClick={() => void controller.apply()}>
                Apply {steps.length} steps
              </button>
              <button disabled={!canCancel(state)} onClick={() => void controller.cancel()}>Cancel</button>
            </div>
          </section>
        </div>
      </div>
      <footer>Replaced files are backed up before changes. Retention pruning does not back up removed backups.</footer>
    </div>
  );
}
