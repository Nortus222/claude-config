import { spawn } from 'node:child_process';
import { entriesForTarget } from '../targets.mjs';
import { TYPES } from './manifest.mjs';

// Prerequisites first: a marketplace has to exist before a plugin can come
// from it, and a hook is inert configuration that nothing else depends on, so
// it is cheapest to do first. Within a type the manifest's own order is kept,
// which is the only way an author can express an ordering this list does not.
export const TYPE_ORDER = ['hook', 'marketplace', 'plugin', 'mcp'];

// The four opt-out categories the CLI exposes. A marketplace is machinery for
// installing plugins, so --no-plugins drops it too: adding a marketplace for
// plugins the user just declined is work nobody asked for.
const CATEGORY = { hook: 'hooks', marketplace: 'plugins', plugin: 'plugins', mcp: 'mcp' };

export function categoryOf(type) {
  return CATEGORY[type] ?? type;
}

export const GROUP_LABEL = {
  hook: 'Claude hooks',
  marketplace: 'Claude plugins',
  plugin: 'plugins',
  mcp: 'Codex MCP',
};

// Argument arrays only, never a shell string: marketplace names, plugin names
// and MCP commands all come from a manifest, and a shell would make quoting
// the only thing between that file and arbitrary execution.
export function spawnCommand({ cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve({ ok: code === 0, note: code === 0 ? '' : `exited ${code}` }));
    // The child never launching at all is silent otherwise: inherited stdio
    // has nothing to show when there is no child.
    child.on('error', (err) => resolve({ ok: false, note: `could not launch \`${cmd}\`: ${err.message}` }));
  });
}

// Inspect every selected declaration and put the survivors in run order. This
// does no installing and no writing — status uses the same plan to report.
export function integrationPlan({ integrations, target, disabled = new Set(), adapters }) {
  const selected = entriesForTarget(integrations, target).filter(
    (item) => !disabled.has(categoryOf(item.type)),
  );

  return selected
    .map((item, index) => {
      const adapter = adapters[item.type];
      const inspected = adapter ? adapter.inspect(item) : { state: 'blocked', note: `no adapter for ${item.type}` };
      return {
        ...item,
        index,
        group: GROUP_LABEL[item.type] ?? item.type,
        state: inspected.state,
        note: inspected.note ?? '',
      };
    })
    .sort((a, b) => {
      const byType = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
      return byType !== 0 ? byType : a.index - b.index;
    });
}

// Each item's failure is its own. An installer that fails, or an adapter that
// throws outright, becomes a result rather than an exception, so the items
// after it still get their turn.
export async function runIntegrations(plan, adapters) {
  const results = [];

  for (const item of plan) {
    if (item.state === 'installed') {
      results.push({ id: item.id, label: item.label, ok: true, skipped: true, note: 'already installed' });
      continue;
    }

    const adapter = adapters[item.type];
    if (!adapter) {
      results.push({ id: item.id, label: item.label, ok: false, note: `no adapter for ${item.type}` });
      continue;
    }

    try {
      const outcome = await adapter.install(item);
      results.push({ id: item.id, label: item.label, ok: Boolean(outcome?.ok), note: outcome?.note ?? '' });
    } catch (err) {
      results.push({ id: item.id, label: item.label, ok: false, note: err.message });
    }
  }

  return results;
}

export { TYPES };
