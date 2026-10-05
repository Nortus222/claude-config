// The shared vocabulary of a profile: what each layer declares and what resolution produces.

export const TARGETS = ['claude', 'codex'] as const;
export type Target = (typeof TARGETS)[number];
// The agent home a file lands in. Usually its target; the OpenRouter Codex home is separate.
export type Home = Target | 'codex-openrouter';

// The categories an `allow` list may name, matching the CLI's OBSERVED_CATEGORIES.
export const CATEGORIES = ['agents', 'plugins', 'marketplaces', 'hooks', 'skills'] as const;
export type Category = (typeof CATEGORIES)[number];

export type LayerName = 'base' | 'pin' | 'machine';
// Which layer decided a value, and the document (or 'built-in' table) it came from.
export type Origin = { readonly layer: LayerName; readonly source: string };
export type Issue = {
  readonly layer: LayerName;
  readonly source: string;
  readonly path: string;
  readonly message: string;
};
// A decoded layer input together with where it came from and what was wrong with it.
export type Input<T> = { readonly value: T; readonly source: string; readonly issues: ReadonlyArray<Issue> };

export type FileEntry = {
  readonly id: string;
  readonly target: Target;
  readonly home: Home;
  readonly src: string;
  readonly dest: string;
  readonly mode: 'copy' | 'merge-keys';
  readonly preserveProjects: boolean;
  readonly capture: boolean;
};
export type SkillGroup = { source: string; skills: string[]; exact: boolean; optional: boolean };
export type Integration = { readonly id: string; readonly default: boolean; readonly [field: string]: unknown };
export type Allow = Partial<Record<Category, ReadonlyArray<string>>>;
export type Settings = Readonly<Record<string, unknown>>;

export type BaseProfile = {
  readonly files: ReadonlyArray<FileEntry>;
  // Owned keys per merge-keys file id; undefined when the document is absent or refused.
  readonly settings: Readonly<Record<string, Settings | undefined>>;
  readonly skills: ReadonlyArray<SkillGroup>;
  readonly integrations: ReadonlyArray<Integration>;
  readonly allow: Allow;
  readonly issues: ReadonlyArray<Issue>;
};

// Approved revision per skill source.
export type Pins = Readonly<Record<string, string>>;

export type MachineOverrides = {
  readonly manageConfig?: boolean;
  readonly configTargets?: ReadonlyArray<Target>;
  readonly settings?: Readonly<Record<string, Settings>>;
  readonly skills?: Readonly<Record<string, boolean>>;
  readonly integrations?: Readonly<Record<string, boolean>>;
};

export type ResolvedFile = FileEntry & {
  readonly managed: boolean;
  readonly from: Origin;
  readonly keys?: Readonly<Record<string, { readonly value: unknown; readonly from: Origin }>>;
};
export type ResolvedSkill = {
  readonly name: string;
  readonly source: string;
  readonly exact: boolean;
  readonly optional: boolean;
  readonly install: boolean;
  readonly from: Origin;
  readonly pin?: { readonly ref: string; readonly from: Origin };
};
export type ResolvedIntegration = {
  readonly id: string;
  readonly declaration: Integration;
  readonly enabled: boolean;
  readonly from: Origin;
};
export type DesiredConfig = {
  readonly files: ReadonlyArray<ResolvedFile>;
  readonly skills: ReadonlyArray<ResolvedSkill>;
  readonly integrations: ReadonlyArray<ResolvedIntegration>;
  readonly allow: Allow;
  readonly issues: ReadonlyArray<Issue>;
};
