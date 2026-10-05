import { Effect } from 'effect';
import type { DesiredConfig, ResolvedIntegration } from '@nortuscc/profile-engine';
import type { Backups } from '../backups.ts';
import type { Fs } from '../fs.ts';
import type { Disposition, Domain, InstallCategory, Observed, Skipped, Step } from '../model.ts';
import type { MachinePathsValue } from '../paths.ts';
import type { Processes } from '../processes.ts';
import { asDeclaration, commandLine, type Declaration, type Inspected, type IntegrationType } from './declaration.ts';
import { describeHook, hookPaths, inspectHook } from './hooks.ts';
import { describeMcp, inspectMcp, type Env } from './mcp.ts';
import { claudePluginState, EMPTY_PLUGIN_STATE, inspectPlugin, installCommand, readCodexState } from './plugins.ts';

// Prerequisites first: a marketplace before its plugins; hooks are inert, so cheapest first.
// Within a type the manifest's order holds, which is how an author expresses any other dependency.
export const TYPE_ORDER: ReadonlyArray<IntegrationType> = ['hook', 'marketplace', 'plugin', 'mcp'];

// A marketplace is machinery for plugins, so --no-plugins drops it too.
export const categoryOf = (type: IntegrationType): InstallCategory =>
  type === 'hook' ? 'hooks' : type === 'mcp' ? 'mcp' : 'plugins';

// Grouped by the agent that owns the work, so two agents' same-named rows stay distinguishable.
export const groupLabel = (d: Declaration): string => {
  const agent = d.target === 'codex' ? 'Codex' : 'Claude';
  return d.type === 'hook' ? `${agent} hooks` : d.type === 'mcp' ? `${agent} MCP` : `${agent} plugins`;
};

export const integrationKey = (id: string): string => `integration:${id}`;

export type IntegrationsOptions = {
  readonly paths: Pick<MachinePathsValue, 'repo' | 'claude'>;
  // The environment MCP prerequisites are checked against; only variable names are ever reported.
  readonly env: Env;
  // 'capture' keeps installer stdout off the caller's stdout, which is the desktop backend's protocol channel.
  readonly installerOutput?: 'inherit' | 'capture';
};

export type IntegrationsServices = Fs | Processes | Backups;

const isPluginType = (d: Declaration) => d.type === 'plugin' || d.type === 'marketplace';

const dispositionOf = (state: Inspected['state'], enabled: boolean): Disposition =>
  state === 'installed' ? 'in-sync' : state === 'missing' ? (enabled ? 'apply' : 'excluded') : 'blocked';

const ordered = (integrations: ReadonlyArray<ResolvedIntegration>) =>
  integrations
    .map((resolved, index) => ({ resolved, d: asDeclaration(resolved.declaration), index }))
    .sort((a, b) => TYPE_ORDER.indexOf(a.d.type) - TYPE_ORDER.indexOf(b.d.type) || a.index - b.index);

// Hooks, marketplaces, plugins and MCP for Claude and Codex, from the engine's declarations.
export const integrationsDomain = (options: IntegrationsOptions): Domain<IntegrationsServices> => {
  const { paths, env } = options;

  const summaryOf = (d: Declaration): string =>
    d.type === 'hook' ? describeHook(paths.claude, d) : d.type === 'mcp' ? describeMcp(d, env) : commandLine(installCommand(d));

  const stepFor = (d: Declaration): Step => {
    const hook = d.type === 'hook' ? hookPaths(paths.claude, d) : undefined;
    return {
      key: integrationKey(d.id),
      domain: 'integrations',
      action: 'install-integration',
      summary: summaryOf(d),
      touches: hook ? [hook.settings, hook.installed] : [],
      // A hook edit is a file step and always completes; an installer can be cancelled.
      interruptible: d.type !== 'hook',
    };
  };

  return {
    name: 'integrations',

    inspect: (desired) =>
      Effect.gen(function* () {
        const entries = ordered(desired.integrations);
        const wants = (target: Declaration['target']) => entries.some(({ d }) => d.target === target && isPluginType(d));
        const claude = wants('claude') ? yield* claudePluginState(paths.claude) : EMPTY_PLUGIN_STATE;
        const codex = wants('codex') ? yield* readCodexState : EMPTY_PLUGIN_STATE;

        const items: Observed[] = [];
        for (const { resolved, d } of entries) {
          const inspected = d.type === 'hook'
            ? yield* inspectHook(paths.claude, d)
            : d.type === 'mcp'
              ? inspectMcp(d, env)
              : inspectPlugin(d, d.target === 'codex' ? codex : claude);
          items.push({
            key: integrationKey(d.id),
            domain: 'integrations',
            target: d.target,
            label: d.label,
            group: groupLabel(d),
            state: inspected.state,
            disposition: dispositionOf(inspected.state, resolved.enabled),
            ...(inspected.note ? { note: inspected.note } : {}),
            from: resolved.from,
          });
        }
        const probeErrors = [codex.pluginError, codex.marketplaceError].filter((e): e is string => Boolean(e));
        return { items, probeErrors };
      }),

    steps: (items, selection, kind, desired: DesiredConfig) => {
      if (kind !== 'apply') return { steps: [], skipped: [] };
      const declared = new Map(desired.integrations.map((r) => [integrationKey(r.id), asDeclaration(r.declaration)]));
      const steps: Step[] = [];
      const skipped: Skipped[] = [];
      const skip = (key: string, reason: string) => skipped.push({ key, reason });
      for (const item of items) {
        const d = declared.get(item.key);
        if (!d) skip(item.key, 'no longer declared');
        else if (item.disposition === 'in-sync') continue;
        else if (!selection.targets.includes(item.target)) skip(item.key, 'target not selected');
        else if (selection.declined.includes(categoryOf(d.type))) skip(item.key, `declined (--no-${categoryOf(d.type)})`);
        else if (item.disposition === 'blocked') skip(item.key, item.note ?? item.state);
        else if (item.disposition === 'apply' || selection.only?.includes(item.key)) steps.push(stepFor(d));
        else skip(item.key, 'not enabled on this machine');
      }
      return { steps, skipped };
    },

    run: (step) => Effect.succeed({ ok: false, note: `not yet implemented: ${step.key}` }),
  };
};
