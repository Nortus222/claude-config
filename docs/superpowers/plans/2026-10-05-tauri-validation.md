# Tauri validation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Answer whether Tauri 2 can package and manage a local TypeScript/Effect backend for this agent configuration manager.

**Architecture:** An isolated experimental desktop package contains a React dashboard, a Rust process owner and an Effect backend. A versioned JSON-lines protocol connects Rust to the backend. Bundled Node and JavaScript resources avoid dependence on an installed Node runtime.

**Tech stack:** Tauri 2, React, TypeScript, Vite, Effect 4, Node, Rust, node:test.

**Spec:** `docs/superpowers/specs/2026-10-05-tauri-validation-design.md`

## Global constraints

- Keep the zero-dependency Node 18+ CLI unchanged.
- Put the experiment in `apps/desktop`, with an independent package manifest and lockfile.
- Protocol version is 1; requests have IDs; diagnostics go to stderr.
- No real agent homes, external installers, credentials or Git operations.
- Only one fixture operation runs at a time; cleanup happens on cancel, EOF and shutdown.
- Renderer cannot select paths, executables or arbitrary commands.
- Pin dependencies; commit npm and Cargo lockfiles; ignore generated binaries.
- Feature PR targets `main`. Never merge it.
- Treat this as an experimental feasibility app. Do not promise untested platforms.

## Review focus

- Invalid or oversized IPC records must fail without a side effect or hung request.
- Cancel and shutdown during work must stop the child and clean temporary resources.
- Backend crashes must reject pending requests and allow an explicit fresh restart.
- Packaged resource paths must work without Node on PATH and from a different directory.
- Renderer subscriptions must precede operations and stale events must not corrupt the current operation.

### Task 1: Implement the complete experimental fixture workflow

**Files:**
- Create: `apps/desktop/package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`.
- Create: `apps/desktop/backend/` for fixture model, protocol and Effect operation runtime.
- Create: `apps/desktop/src/` for the renderer and typed desktop bridge.
- Create: `apps/desktop/src-tauri/` for the Rust host, Tauri config and Cargo lockfile.
- Create: `apps/desktop/scripts/` for bundling resources and packaged smoke checks.
- Create: `apps/desktop/test/` for fixture and sidecar integration tests.
- Modify: `.gitignore`, `README.md` only to document the isolated experiment.

**Interfaces:**
- Rust owns the persistent backend process and exposes inspect, start fixture, cancel, restart and optional crash probe commands.
- Backend exports fixture inspection and a scoped cancellable operation, independent of Tauri.
- Protocol request `{ version: 1, id: string, command: string }` with named command arguments as needed. All messages are Schema-validated.
- Response `{ version: 1, id: string, ok: boolean, result?: unknown, error?: { code: string, message: string } }`.
- Progress `{ version: 1, event: 'progress', operationId: string, ... }`; define the exact state/percent contract in one shared TypeScript module and mirror the Rust validation.

- [ ] Write failing fixture tests proving override resolution and before/after diff, plus rejection of unknown commands and bad protocol versions.
- [ ] Run them and record the expected failures before implementation.
- [ ] Implement the fixture model and boundary Schema decoding.
- [ ] Write failing live backend tests proving progress, cancellation, busy rejection, EOF shutdown, no orphan subprocess and temporary cleanup. Include malformed/oversized input and packaged runtime path tests.
- [ ] Implement the Effect operation lifetime and JSON-lines backend; run targeted tests to green.
- [ ] Implement the Rust owner and narrow commands with request correlation, bounded input, timeout, crash notification, explicit restart, and graceful then forced shutdown. Add focused host tests for applicable behavior.
- [ ] Implement the dashboard with profile provenance, preview, apply/cancel, terminal states, disconnect and restart. Keep the screen clearly labelled as fixture-only.
- [ ] Add build scripts bundling the backend and copying the Node executable into target-specific Tauri resources. Use no runtime downloads or PATH lookup in the installed app.
- [ ] Add documentation for development, release build and platform prerequisites; document experimental limits and verification commands.
- [ ] Run targeted TypeScript/Node and Rust tests. Run the legacy suite, recording all failures by name. Do not run a full release build here; the controller owns the single end-of-batch build.
- [ ] Self-review `git diff HEAD` plus untracked files, then commit only task files using a conventional commit.

### Verification and handoff

- [ ] Controller runs the single complete local release build and packaged smoke tests, including a stripped PATH.
- [ ] Record complete app size and idle/process cleanup observations; report any platform or GUI limitations.
- [ ] Independent reviewer checks spec compliance and quality across the complete branch. Fix concrete findings, rerun covering tests and re-review fixes.
- [ ] Push `feat/tauri-validation`, open and link a PR targeting `main`, with final attribution `Model: gpt-6.1-sol · Harness: Codex`.
