export { createCustomCommandAdapter, type CustomCommandAdapterOptions } from './customCommand.js';
export {
  createCursorAdapter,
  CURSOR_MAX_PROMPT_BYTES,
  type CursorAdapterOptions,
} from './cursor.js';
export {
  parseCursorAgentVersion,
  readCursorAgentVersion,
  TESTED_CURSOR_VERSION_RANGES,
} from './cursor.js';
export {
  buildCursorChildEnv,
  buildIsolatedHomeEnv,
  CURSOR_ENV_ALLOWLIST,
  CURSOR_PROBE_LIVE_GATE_MESSAGE,
  CURSOR_VERSION_TIMEOUT_MS,
  evaluateProbeEvidence,
  probeCursorSandbox,
  probeToObservedCapabilities,
  redactCursorArgv,
  resetCursorSandboxProbeCache,
  type CursorProbeStatus,
  type CursorSandboxProbeInput,
  type CursorSandboxProbeResult,
  type CursorVersionInfo,
} from './cursorSupport.js';
export { getAdapter, listAdapters, registerAdapter } from './registry.js';
