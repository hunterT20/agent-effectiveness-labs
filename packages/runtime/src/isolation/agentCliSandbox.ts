import { mkdir } from 'node:fs/promises';
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
import { probeCursorSandbox } from '../adapters/cursorSupport.js';

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

export class AgentCliSandboxIsolationProvider implements IsolationProvider {
  private readonly command: string;

  constructor(private readonly options: AgentCliSandboxOptions) {
    this.command = options.command ?? 'cursor-agent';
  }

  async doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult> {
    const messages: string[] = [];
    if (process.env.AEL_SKIP_SANDBOX_PROBE === '1') {
      messages.push('sandbox probe skipped (AEL_SKIP_SANDBOX_PROBE=1)');
      return {
        supported: true,
        observedCapabilities: {
          level: 'agent-cli-sandbox',
          filesystemEnforced: false,
          networkPolicyEnforced: false,
          processTreeEnforced: false,
          hiddenGraderProtected: false,
          externalArtifactsProtected: false,
        },
        messages,
      };
    }

    const workspaceRoot = join(process.cwd(), '.ael-sandbox-probe');
    await mkdir(workspaceRoot, { recursive: true });

    const probe = await probeCursorSandbox({
      command: this.command,
      workspaceRoot,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      timeoutMs: this.options.probeTimeoutMs ?? 60_000,
    });
    for (const message of probe.messages) {
      messages.push(message);
    }

    const observedCapabilities: IsolationCapabilities = {
      level: 'agent-cli-sandbox',
      filesystemEnforced: probe.readHomeBlocked && probe.writeOutsideWorkspaceBlocked,
      networkPolicyEnforced: probe.networkBlocked,
      processTreeEnforced: false,
      hiddenGraderProtected: false,
      externalArtifactsProtected: false,
    };

    if (!observedCapabilities.filesystemEnforced) {
      messages.push(
        'agent-cli-sandbox: filesystem enforcement not observed; never trust --sandbox flag alone',
      );
    }

    const requested = input.requestedCapabilities;
    let supported = true;
    if (requested.filesystemEnforced === true && !observedCapabilities.filesystemEnforced) {
      supported = false;
      messages.push('requested filesystem enforcement not observed by sandbox probe');
    }
    if (requested.networkPolicyEnforced === true && !observedCapabilities.networkPolicyEnforced) {
      supported = false;
      messages.push('requested network policy enforcement not observed by sandbox probe');
    }
    if (requested.processTreeEnforced === true && !observedCapabilities.processTreeEnforced) {
      supported = false;
      messages.push('process tree enforcement not available in agent-cli-sandbox');
    }

    return { supported, observedCapabilities, messages };
  }

  async prepare(input: IsolationPrepareInput): Promise<IsolationSession> {
    const isolatedHomeRoot = join(input.workspaceRoot, '.ael', 'isolated-home', input.trialId);
    await mkdir(isolatedHomeRoot, { recursive: true });
    const session: AgentCliSandboxSession = {
      id: `${input.trialId}-agent-cli-sandbox`,
      workspaceRoot: input.workspaceRoot,
      isolatedHomeRoot,
      ...(input.logDir !== undefined ? { logDir: input.logDir } : {}),
    };
    return session;
  }

  async run(session: IsolationSession, input: ProcessInvocation): Promise<ProcessResult> {
    const sandboxSession = session as AgentCliSandboxSession;
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

  dispose(session: IsolationSession): Promise<void> {
    void session;
    return Promise.resolve();
  }
}
