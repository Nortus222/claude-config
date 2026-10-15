import React from 'react';
import type { ConnectionsController, ConnectionsViewState } from './mcp-connections-controller.ts';
const labels = { configured: 'Configured', absent: 'Not configured', 'repair-needed': 'Repair needed', conflict: 'Needs review', unavailable: 'Unavailable' };
const guidance = {
  installed: 'App guidance is installed in the managed instruction file.',
  missing: 'App guidance is missing from the managed instruction file.',
  released: 'This app no longer maintains its instruction guidance.',
  absent: 'No app guidance is installed.',
  unmanaged: 'This instruction file is managed elsewhere. Copy the guidance below to add it yourself.',
  conflict: 'Instruction guidance was edited or has a conflict. Existing text is preserved; review it before making changes.',
  unavailable: 'Instruction guidance could not be checked. Check again when the instruction file is available.',
};
export function ConnectionsView({ state, controller }: { state: ConnectionsViewState; controller: ConnectionsController }) {
  const checking = state.operation?.action === 'inspect';
  return <section className="mcp-connections" aria-label="Coding agent connections" aria-busy={state.pending}>
    <div className="mcp-connections-head">
      <div><h2>Coding agent connections</h2><p>Use Nortuscc from Codex or Claude Code through MCP.</p></div>
      <button disabled={!state.available || state.pending} onClick={() => void controller.refresh()}>{checking ? 'Checking…' : 'Refresh'}</button>
    </div>
    {!state.available ? <p className="mcp-connections-notice" role="status">Connect the local app agent to check and manage connections.</p> : null}
    {state.detail ? <div className="mcp-connections-error" role="alert"><p>{state.detail}</p>
      <button disabled={!state.available || state.pending} onClick={() => void controller.refresh()}>Check again</button>
    </div> : null}
    {(['codex', 'claude'] as const).map(target => {
      const name = target === 'codex' ? 'Codex' : 'Claude Code';
      const connection = state.connections.find(c => c.target === target);
      const routing = connection?.routing;
      const cleanup = connection?.registration === 'absent' && (routing?.intent === 'active'
        && (routing.blockStatus === 'present' || routing.blockStatus === 'absent')
        || routing?.intent === 'released' && routing.blockStatus === 'present');
      const unverified = !!connection && state.unverified.includes(target);
      const disabled = !state.available || state.pending || !connection || unverified;
      const unavailable = connection?.registration === 'unavailable';
      const conflict = connection?.registration === 'conflict';
      const repair = connection?.registration === 'repair-needed' || connection?.registration === 'configured' && routing?.status === 'missing';
      const busy = state.operation?.target === target ? state.operation.action : null;
      const status = checking ? 'Checking…' : !state.available ? 'Unavailable' : unverified ? 'Unverified'
        : cleanup ? 'Cleanup needed' : repair ? 'Repair needed' : connection ? labels[connection.registration] : 'Not checked';
      const summary = checking ? 'Reading local configuration.' : !state.available ? 'The local app agent is unavailable.'
        : unverified ? 'Last checked status. Check again before making changes.'
        : !connection ? 'Check local configuration before connecting.'
        : cleanup ? 'Registration is removed. App guidance still needs cleanup.'
        : conflict ? 'Registration was changed or is not owned by this app. Review the details.'
        : unavailable ? 'The host CLI or its configuration could not be checked.'
        : repair ? 'Local configuration needs repair.'
        : connection.registration === 'configured' && routing?.status === 'conflict' ? 'App tools are configured. Instruction guidance was edited; review the details.'
        : connection.registration === 'configured' && routing?.status === 'unavailable' ? 'App tools are configured. Instruction guidance could not be checked.'
        : connection.registration === 'configured' ? 'App tools are configured. A chat session has not been verified.'
        : `Add this app’s tools to ${name}.`;
      const primaryAction = cleanup || connection?.registration === 'configured' && !repair ? 'disconnect' : 'connect';
      const primaryLabel = !connection ? 'Check status' : cleanup ? 'Retry cleanup' : unavailable ? 'Unavailable' : repair ? 'Repair' : primaryAction === 'disconnect' ? 'Disconnect' : 'Connect';
      return <article className="mcp-connections-host" aria-label={name} key={target}>
        <span className="mcp-connections-mark" aria-hidden="true">{target === 'codex' ? 'C' : '✳'}</span>
        <div className="mcp-connections-copy"><div className="mcp-connections-name"><h3>{name}</h3>
          <span role="status" className={`mcp-connections-badge ${status === 'Configured' ? 'is-configured' : cleanup || conflict || repair || unverified ? 'needs-attention' : ''}`}>{status}</span>
        </div><p>{summary}</p></div>
        {conflict ? null : <button className={`mcp-connections-action ${primaryAction === 'connect' && !unavailable ? 'is-primary' : ''}`}
          disabled={connection ? disabled || unavailable : !state.available || state.pending}
          onClick={() => void (!connection ? controller.refresh() : controller[primaryAction](target))}>
          {busy === 'connect' ? repair ? 'Repairing…' : 'Connecting…' : busy === 'disconnect' ? cleanup ? 'Cleaning up…' : 'Disconnecting…' : primaryLabel}
        </button>}
        {connection ? <details className="mcp-connections-details">
          <summary>{conflict ? 'Review connection details' : 'Connection details'}</summary>
          <p>Observed from local registration. Host session: not observed.</p>
          {connection.reload === 'recommended' ? <p>Reload needed for existing sessions. Start a new chat or reload your coding host to discover configuration changes. This app cannot confirm that a chat has reloaded.</p> : null}
          <p>{guidance[connection.routing.status]}</p>
          {connection.routing.intent === 'invalid' || connection.routing.intent === 'unknown' ? <p>App guidance ownership could not be verified. Existing instructions are preserved.</p> : null}
          {connection.routing.blockStatus === 'conflict' && connection.routing.status !== 'conflict' ? <p>The instruction block was changed. Existing text is preserved.</p> : null}
          {connection.note ? <p>{connection.note}</p> : null}
          {cleanup ? <p role="status">Instruction cleanup is incomplete. Retry cleanup to {connection.routing.blockStatus === 'present' ? 'remove the retained app guidance' : 'stop maintaining app guidance'}.</p> : null}
          {connection.routing.status === 'unmanaged' ? <div className="mcp-connections-guidance">
            <textarea readOnly aria-label={`${target} instruction guidance`} value={connection.routing.offeredText} rows={5} />
            <button onClick={() => void navigator.clipboard.writeText(connection.routing.offeredText).catch(() => {})}>Copy guidance</button>
          </div> : null}
          {conflict ? <p>Disconnect stops maintaining app guidance where it can be safely removed. Edited or foreign registration is preserved.</p> : null}
          {conflict || repair ? <button disabled={disabled || unavailable} onClick={() => void controller.disconnect(target)}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button> : null}
        </details> : null}
      </article>;
    })}
    <p className="mcp-connections-foot">Connections are configured on this Mac. The background agent keeps working when this window is closed.</p>
  </section>;
}
