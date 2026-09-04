import type {
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

interface DirectorySession extends IsolationSession {
  readonly logDir?: string;
}

export class DirectoryOnlyIsolationProvider implements IsolationProvider {
  doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult> {
    const observedCapabilities: IsolationCapabilities = {
      level: 'directory-only',
      filesystemEnforced: false,
      networkPolicyEnforced: false,
      processTreeEnforced: false,
      hiddenGraderProtected: false,
      externalArtifactsProtected: false,
    };

    const messages = [
      'directory-only isolation is synthetic-only and cannot satisfy live trust requirements',
    ];

    const requested = input.requestedCapabilities;
    const requiresLiveTrust =
      requested.filesystemEnforced === true ||
      requested.networkPolicyEnforced === true ||
      requested.processTreeEnforced === true ||
      requested.hiddenGraderProtected === true ||
      requested.externalArtifactsProtected === true;

    return Promise.resolve({
      supported: !requiresLiveTrust,
      observedCapabilities,
      messages,
    });
  }

  prepare(input: IsolationPrepareInput): Promise<IsolationSession> {
    const session: DirectorySession = {
      id: `${input.trialId}-directory-only`,
      ...(input.logDir !== undefined ? { logDir: input.logDir } : {}),
    };
    return Promise.resolve(session);
  }

  async run(session: IsolationSession, input: ProcessInvocation): Promise<ProcessResult> {
    const directorySession = toDirectorySession(session);
    const supervisor = new ProcessSupervisor(
      directorySession.logDir !== undefined ? { logDir: directorySession.logDir } : {},
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
    void toDirectorySession(session);
    return Promise.resolve();
  }
}

function toDirectorySession(session: IsolationSession): DirectorySession {
  const logDir =
    'logDir' in session && typeof session.logDir === 'string' ? session.logDir : undefined;
  return {
    id: session.id,
    ...(logDir !== undefined ? { logDir } : {}),
  };
}
