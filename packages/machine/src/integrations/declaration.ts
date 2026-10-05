import type { Integration, Target } from '@nortuscc/profile-engine';

export type IntegrationType = 'hook' | 'marketplace' | 'plugin' | 'mcp';

// One integrations.json entry as the engine validated it. Fields beyond the common five belong to one type.
export type Declaration = {
  readonly id: string;
  readonly label: string;
  readonly target: Target;
  readonly type: IntegrationType;
  readonly default: boolean;
  readonly plugin?: string;
  readonly marketplace?: string;
  readonly name?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly requiresEnv?: ReadonlyArray<string>;
  readonly prerequisite?: string;
  readonly event?: string;
  readonly file?: string;
};

// `unknown`: the agent's CLI could not say whether the item is installed.
export type IntegrationState = 'installed' | 'missing' | 'blocked' | 'unknown';
export type Inspected = { readonly state: IntegrationState; readonly note: string };
// An installer invocation: argv only, never a shell string.
export type Installer = { readonly cmd: string; readonly args: ReadonlyArray<string> };

// The engine refuses a document with any invalid entry, so a resolved declaration already has its type's fields.
export const asDeclaration = (integration: Integration): Declaration => integration as unknown as Declaration;

export const commandLine = (installer: Installer): string => [installer.cmd, ...installer.args].join(' ');
