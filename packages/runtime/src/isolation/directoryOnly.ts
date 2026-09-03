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

export class DirectoryOnlyIsolationProvider implements IsolationProvider {
  private readonly supervisor = new ProcessSupervisor();

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
    return Promise.resolve({ id: `${input.trialId}-directory-only` });
  }

  async run(session: IsolationSession, input: ProcessInvocation): Promise<ProcessResult> {
    void session;
    const result = await this.supervisor.run(input);
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    };
  }

  dispose(session: IsolationSession): Promise<void> {
    void session;
    return Promise.resolve();
  }
}
