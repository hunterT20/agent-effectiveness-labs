import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentAdapter,
  IsolationCapabilities,
  IsolationDoctorInput,
  IsolationDoctorResult,
  IsolationPrepareInput,
  IsolationProvider,
  IsolationSession,
  ProcessInvocation,
  ProcessResult,
} from '@ael/core';

import { ProcessSupervisor } from '../process/supervisor.js';
import { probeCursorSandbox, probeToObservedCapabilities } from '../adapters/cursorSupport.js';

export interface AgentCliSandboxOptions {
  readonly adapter: AgentAdapter;
  readonly command?: string;
  readonly model?: string;
  readonly probeTimeoutMs?: number;
}

interface AgentCliSandboxSession extends IsolationSession {
  readonly workspaceRoot: string;
  readonly isolatedHomeRoot: string;
  readonly logDir?: string;
}

const UNVERIFIED: IsolationCapabilities = {
  level: 'agent-cli-sandbox',
  filesystemEnforced: false,
  networkPolicyEnforced: false,
  processTreeEnforced: false,
  hiddenGraderProtected: false,
  externalArtifactsProtected: false,
};

function checkRequested(
  requested: Partial<IsolationCapabilities>,
  observed: IsolationCapabilities,
  messages: string[],
): boolean {
  let supported = true;
  if (requested.filesystemEnforced === true && !observed.filesystemEnforced) {
    supported = false;
    messages.push('requested filesystem enforcement not observed by sandbox probe');
  }
  if (requested.networkPolicyEnforced === true && !observed.networkPolicyEnforced) {
    supported = false;
    messages.push('requested network policy enforcement not observed by sandbox probe');
  }
  if (requested.processTreeEnforced === true && !observed.processTreeEnforced) {
    supported = false;
    messages.push('process tree enforcement not available in agent-cli-sandbox');
  }
  if (requested.hiddenGraderProtected === true && !observed.hiddenGraderProtected) {
    supported = false;
    messages.push('hidden grader protection not available in agent-cli-sandbox');
  }
  if (requested.externalArtifactsProtected === true && !observed.externalArtifactsProtected) {
    supported = false;
    messages.push('external artifact protection not available in agent-cli-sandbox');
  }
  return supported;
}

/**
 * Isolation backed only by the agent CLI's own `--sandbox enabled` mode. Capabilities are
 * reported exclusively from the live probe's filesystem evidence; the flag itself proves nothing.
 */
export class AgentCliSandboxIsolationProvider implements IsolationProvider {
  private readonly command: string;

  constructor(private readonly options: AgentCliSandboxOptions) {
    this.command = options.command ?? 'cursor-agent';
    void this.options.adapter;
  }

  async doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult> {
    const messages: string[] = [];
    if (process.env.AEL_SKIP_SANDBOX_PROBE === '1') {
      messages.push(
        'sandbox probe skipped (AEL_SKIP_SANDBOX_PROBE=1); observed capabilities are unverified',
      );
      const supported = checkRequested(input.requestedCapabilities, UNVERIFIED, messages);
      return { supported, observedCapabilities: UNVERIFIED, messages };
    }

    // The probe creates its own mkdtemp workspace under os.tmpdir() and is memoized per process,
    // so the adapter doctor and this doctor share a single (paid) observation.
    const probe = await probeCursorSandbox({
      command: this.command,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      timeoutMs: this.options.probeTimeoutMs ?? 60_000,
    });
    for (const message of probe.messages) {
      messages.push(message);
    }

    const observedCapabilities = probeToObservedCapabilities(probe);
    if (!observedCapabilities.filesystemEnforced) {
      messages.push(
        'agent-cli-sandbox: filesystem enforcement not observed; never trust --sandbox flag alone',
      );
    }

    const supported = checkRequested(input.requestedCapabilities, observedCapabilities, messages);
    return { supported, observedCapabilities, messages };
  }

  async prepare(input: IsolationPrepareInput): Promise<IsolationSession> {
    const isolatedHomeRoot = await mkdtemp(join(tmpdir(), 'ael-agent-cli-home-'));
    const session: AgentCliSandboxSession = {
      id: `${input.trialId}-agent-cli-sandbox`,
      workspaceRoot: input.workspaceRoot,
      isolatedHomeRoot,
      ...(input.logDir !== undefined ? { logDir: input.logDir } : {}),
    };
    return session;
  }

  async run(session: IsolationSession, input: ProcessInvocation): Promise<ProcessResult> {
    const sandboxSession = toSandboxSession(session);
    const supervisor = new ProcessSupervisor(
      sandboxSession.logDir !== undefined ? { logDir: sandboxSession.logDir } : {},
    );
    const result = await supervisor.run(input);
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
    };
  }

  async dispose(session: IsolationSession): Promise<void> {
    const sandboxSession = toSandboxSession(session);
    if (sandboxSession.isolatedHomeRoot.startsWith(tmpdir())) {
      await rm(sandboxSession.isolatedHomeRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function toSandboxSession(session: IsolationSession): AgentCliSandboxSession {
  if (
    'workspaceRoot' in session &&
    typeof session.workspaceRoot === 'string' &&
    'isolatedHomeRoot' in session &&
    typeof session.isolatedHomeRoot === 'string'
  ) {
    const logDir =
      'logDir' in session && typeof session.logDir === 'string' ? session.logDir : undefined;
    return {
      id: session.id,
      workspaceRoot: session.workspaceRoot,
      isolatedHomeRoot: session.isolatedHomeRoot,
      ...(logDir !== undefined ? { logDir } : {}),
    };
  }
  throw new Error(`session ${session.id} was not created by AgentCliSandboxIsolationProvider`);
}
