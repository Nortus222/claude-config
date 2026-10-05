// The watcher's vocabulary: what it is asked to watch and what it reports.

// One skill source as a setup uses it.
export type WatchedSource = {
  readonly source: string; // as the manifest writes it, e.g. 'mattpocock/skills'
  readonly url: string; // what is fetched
  readonly baseline?: string; // a ref: the pin, or whatever the caller compares against
  readonly exact: boolean; // an exact source does not report skills added upstream
  readonly skills: ReadonlyArray<string>; // the setup's skills from this source
  readonly checkout?: string; // absolute path of the author's local git checkout
};

export type Revision = { readonly sha: string; readonly date: string; readonly tags: ReadonlyArray<string> };
// Never carries an email.
export type Commit = { readonly sha: string; readonly subject: string; readonly author: string; readonly date: string };

export type SkillChange = {
  readonly name: string;
  readonly path?: string; // folder at latest, or at baseline when removed
  readonly status: 'unchanged' | 'changed' | 'removed' | 'missing';
  readonly commits: ReadonlyArray<string>; // shas that touched the folder, newest first
  readonly skillMd?: string; // unified diff of SKILL.md, baseline → latest
  readonly files: ReadonlyArray<string>; // other changed files in the folder, repo-relative
};

export type LocalSkill = { readonly name: string; readonly path: string; readonly skillMd?: string };
export type LocalReport = {
  readonly path: string;
  readonly status: 'clean' | 'edits' | 'no-upstream' | 'not-a-repo';
  readonly branch?: string;
  readonly unpushed: ReadonlyArray<Commit>; // @{u}..HEAD, newest first
  readonly uncommitted: ReadonlyArray<string>; // changed, staged or untracked paths, sorted
  readonly skills: ReadonlyArray<LocalSkill>; // skills with local edits, sorted by name
};

export type SourceStatus = 'up-to-date' | 'ahead' | 'diverged' | 'unpinned' | 'baseline-missing' | 'unreachable';
export type SourceReport = {
  readonly source: string;
  readonly url: string; // redacted
  readonly status: SourceStatus;
  readonly reason?: string; // redacted; for baseline-missing and unreachable
  readonly latest?: Revision;
  readonly baseline?: Revision & { readonly ref: string };
  readonly commits: ReadonlyArray<Commit>; // baseline..latest, newest first
  readonly skills: ReadonlyArray<SkillChange>; // one per declared skill, in declared order
  readonly added: ReadonlyArray<string>; // non-exact only: undeclared skills new since baseline
  readonly local?: LocalReport;
};
