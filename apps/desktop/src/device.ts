// How the app names the machine it runs on and its file manager. The Windows host declares
// `__NORTUSCC_PLATFORM__` before the page loads (src-tauri/src/main.rs); without it the wording is macOS's.
export type DeviceCopy = { readonly thisMachine: string; readonly ThisMachine: string; readonly THIS_MACHINE: string; readonly fileManager: string };

export const deviceCopy = (platform: unknown): DeviceCopy => platform === 'windows'
  ? { thisMachine: 'this PC', ThisMachine: 'This PC', THIS_MACHINE: 'THIS PC', fileManager: 'File Explorer' }
  : { thisMachine: 'this Mac', ThisMachine: 'This Mac', THIS_MACHINE: 'THIS MAC', fileManager: 'Finder' };

export const { thisMachine, ThisMachine, THIS_MACHINE, fileManager } = deviceCopy((globalThis as { __NORTUSCC_PLATFORM__?: unknown }).__NORTUSCC_PLATFORM__);
