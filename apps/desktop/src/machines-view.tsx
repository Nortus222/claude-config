import React, { useState } from 'react';
import type { ViewState } from './controller.ts';
import { gridRows, perMachine, revisionError, type Cell, type Column, type GridRow, type MachinesController, type MachinesViewState, type RemoteAccess } from './machines-controller.ts';
import { CELL_WORDS, MACHINES_WORDS as W, TAILSCALE_PROBLEMS, UNKNOWN_SOURCE, machineUnreachable, relativeTime, unownedCopy } from './copy.ts';
import { thisMachine } from './device.ts';

const online = (column: Column) => column.reach === 'ok' && column.skills !== null;
const lacks = (cell: Cell | undefined) => cell === 'absent' || cell === 'profile';
const has = (cell: Cell | undefined) => cell === 'installed' || cell === 'undeclared';
const cellText = (cell: Cell) => typeof cell === 'string' ? CELL_WORDS[cell] : cell.failed;

// The checks that stand between this machine and remote access, in the order they're met.
const CHECKS = ['not-installed', 'not-running', 'logged-out', 'needs-admin'] as const;
function ConnectSection({ access, switching, disabled, controller }: { access: RemoteAccess; switching: boolean; disabled: boolean; controller: MachinesController }) {
  const failing = CHECKS.indexOf(access.tailscale as typeof CHECKS[number]);
  const rows = CHECKS.filter(check => check !== 'needs-admin' || access.tailscale === 'needs-admin').map(check => {
    const at = CHECKS.indexOf(check), ok = failing === -1 || at < failing;
    const text = at === failing ? TAILSCALE_PROBLEMS[check] : !ok ? W.checkWaiting
      : check === 'logged-out' && access.self ? W.signedInAs(access.self.login) : W.checkDone;
    return <li key={check} className={ok ? 'check-ok' : 'check-problem'}><strong>{W.checks[check]}</strong> <span>{text}</span></li>;
  });
  const canTurnOn = access.tailscale === 'ready';
  return <section className="card machines-connect">
    <h2>{W.connect}</h2>
    <p className="muted">{W.connectIntro}</p>
    <ul>{rows}
      <li className={access.enabled ? 'check-ok' : 'check-problem'}><strong>{W.remoteAccess}</strong> <span>{access.enabled ? W.remoteOn : W.remoteOff}</span>{' '}
        <button disabled={disabled || switching || (!access.enabled && !canTurnOn)} title={!access.enabled && !canTurnOn ? W.tailscaleFirst : undefined}
          onClick={() => void controller.setRemoteAccess(!access.enabled)}>{access.enabled ? W.turnOff : W.turnOn}</button></li>
    </ul>
  </section>;
}

export function InstallDialog({ columns, disabled, controller, onClose, initial = {} }: {
  columns: readonly Column[]; disabled: boolean; controller: MachinesController; onClose: () => void; initial?: { readonly revision?: string };
}) {
  const [source, setSource] = useState(''), [name, setName] = useState(''), [revision, setRevision] = useState(initial.revision ?? '');
  const [all, setAll] = useState(false), [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const choices = columns.filter(online), invalid = revisionError(revision);
  const ready = source.trim() && name.trim() && !invalid && (all || picked.size > 0);
  return <section className="card form-section" aria-label={W.installTitle}>
    <h2>{W.installTitle}</h2>
    <label>{W.source} <input value={source} placeholder="owner/repo" onChange={event => setSource(event.target.value)} /></label>
    <label>{W.skillName} <input value={name} onChange={event => setName(event.target.value)} /></label>
    <label>{W.revision} <input value={revision} aria-invalid={invalid ? true : undefined} onChange={event => setRevision(event.target.value)} /></label>
    {invalid ? <p className="feedback" role="alert">{invalid}</p> : null}
    <fieldset disabled={disabled}>
      <legend>{W.machines}</legend>
      <label className="choice"><input type="checkbox" checked={all} onChange={() => setAll(!all)} /><span>{W.allOnline}</span></label>
      {choices.map(column => <label className="choice" key={column.ref}>
        <input type="checkbox" disabled={all} checked={all || picked.has(column.ref)}
          onChange={() => { const next = new Set(picked); if (!next.delete(column.ref)) next.add(column.ref); setPicked(next); }} /><span>{column.name}</span>
      </label>)}
    </fieldset>
    <div className="form-actions">
      <button className="primary" disabled={disabled || !ready} onClick={() => { void controller.install(source, name, all ? 'all' : [...picked], revision); onClose(); }}>{W.install}</button>
      <button onClick={onClose}>{W.cancel}</button>
    </div>
  </section>;
}

function CellView({ row, column, cell, columns, disabled, controller }: { row: GridRow; column: Column; cell: Cell; columns: readonly Column[]; disabled: boolean; controller: MachinesController }) {
  if (!online(column)) return <td className="muted">{CELL_WORDS.offline}</td>;
  const text = cellText(cell), busy = cell === 'working' || disabled;
  const targets = columns.filter(other => other.ref !== column.ref && online(other) && lacks(row.cells[other.ref]));
  let actions: React.ReactNode = null;
  if (cell === 'undeclared') actions = <small>{unownedCopy(column.name)}</small>;
  else if (row.source === null) actions = null;
  else if (cell === 'installed') actions = <>
    <button disabled={busy} aria-label={W.removeLabel(row.name, column.name)} onClick={() => void controller.setCell(row, column.ref, false)}>{W.remove}</button>
    {targets.length ? <select disabled={busy} aria-label={W.moveLabel(row.name, column.name)} value="" onChange={event => void controller.move(row, column.ref, event.target.value)}>
      <option value="">{W.moveTo}</option>
      {targets.map(target => <option key={target.ref} value={target.ref}>{target.name}</option>)}
    </select> : null}
  </>;
  else if (cell !== 'working') actions = <button disabled={busy} aria-label={W.installLabel(row.name, column.name)} onClick={() => void controller.setCell(row, column.ref, true)}>{W.install}</button>;
  return <td aria-busy={cell === 'working' ? true : undefined}>
    {cell === 'working' ? <span role="status"><span className="spinner" aria-hidden="true" /> {text}</span> : <span className={typeof cell === 'string' ? undefined : 'feedback'}>{text}</span>}
    {actions ? <div className="row-actions">{actions}</div> : null}
  </td>;
}

function ColumnHeader({ column, disabled, controller }: { column: Column; disabled: boolean; controller: MachinesController }) {
  const problem = column.reach !== 'ok' ? machineUnreachable(column.reach, column.name, column.lastReachedAt) : column.error;
  const checked = column.inspectedAt ? relativeTime(column.inspectedAt) : '';
  return <th scope="col">
    <strong>{column.name}</strong>{column.self ? <small>{thisMachine}</small> : null}
    {column.os ? <small>{column.os}</small> : null}
    {problem ? <small role="note">{problem}</small> : null}
    {column.reach !== 'ok' ? null
      : column.loading ? <small><span className="spinner" aria-hidden="true" /> {W.checking}</small>
      : checked ? <small>{column.busy ? W.busy(checked) : W.checked(checked)}</small> : null}
    {column.reach === 'ok' ? <button disabled={disabled || column.loading} aria-label={W.refreshLabel(column.name)} onClick={() => void controller.refresh(column.ref)}>{W.refresh}</button> : null}
  </th>;
}

export function MachinesView({ state, machine, controller, installing = false }: {
  state: MachinesViewState; machine: ViewState; controller: MachinesController; installing?: boolean;
}) {
  const [dialog, setDialog] = useState(installing);
  const disabled = machine.connection !== 'connected';
  const rows = gridRows(perMachine(state)), access = state.access;
  const connected = access?.enabled === true && access.tailscale === 'ready';
  return <div className="machines-view">
    <header className="page-header"><div><h1>{W.title}</h1><p className="intro">{W.intro}</p></div>
      {state.native ? <div className="header-actions">
        <button disabled={disabled || state.loading} onClick={() => void controller.refresh()}>{W.refreshAll}</button>
        <button className="primary" disabled={disabled} onClick={() => setDialog(true)}>{W.installTitle}</button>
      </div> : null}
    </header>
    {!state.native ? <section className="card"><h2>{W.browser}</h2><p className="muted">{W.browserDetail}</p></section> : <>
      {state.error ? <p className="alert" role="alert">{state.error}</p> : null}
      {state.notices.length ? <div role="status">{state.notices.map(notice => <p className="feedback" key={notice}>{notice}</p>)}</div> : null}
      {access && !connected ? <ConnectSection access={access} switching={state.switching} disabled={disabled} controller={controller} /> : null}
      {access && connected ? <p className="muted">{W.remoteIsOn} <button disabled={disabled || state.switching} onClick={() => void controller.setRemoteAccess(false)}>{W.turnOff}</button></p> : null}
      {access && connected && !access.listening ? <p className="alert" role="note">{W.notListening}</p> : null}
      {state.notSetUp.length ? <ul className="muted">{state.notSetUp.map(machine => <li key={machine.nodeId}>{W.notSetUp(machine.name)}</li>)}</ul> : null}
      {dialog ? <InstallDialog columns={state.columns} disabled={disabled} controller={controller} onClose={() => setDialog(false)} /> : null}
      {state.columns.length ? <div className="table-wrap"><table className="machines-grid">
        <thead><tr><th scope="col">{W.skill}</th>{state.columns.map(column => <ColumnHeader key={column.ref} column={column} disabled={disabled} controller={controller} />)}</tr></thead>
        <tbody>{rows.map(row => {
          const lacking = state.columns.filter(column => online(column) && lacks(row.cells[column.ref]));
          const copyable = row.source !== null && lacking.length > 0 && state.columns.some(column => has(row.cells[column.ref]));
          return <tr key={JSON.stringify([row.source, row.name])}>
            <th scope="row"><strong>{row.name}</strong><small>{row.source ?? W.outside}</small>
              {row.source === null ? <><button disabled title={UNKNOWN_SOURCE}>{W.copy}</button><small>{UNKNOWN_SOURCE}</small></>
                : copyable ? <button disabled={disabled} onClick={() => void controller.copy(row, lacking.map(column => column.ref))}>{W.copy}</button> : null}
            </th>
            {state.columns.map(column => <CellView key={column.ref} row={row} column={column} cell={row.cells[column.ref]!} columns={state.columns} disabled={disabled} controller={controller} />)}
          </tr>;
        })}</tbody>
      </table></div> : state.loading ? <p role="status"><span className="spinner" aria-hidden="true" /> {W.reading}</p> : null}
    </>}
  </div>;
}
