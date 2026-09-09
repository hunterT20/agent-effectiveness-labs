import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactError, resolveArtifactPath, validateOutputRoot } from '@ael/runtime';

describe('artifact paths', () => {
  it('resolves contained paths within the output root', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-artifact-root-'));
    const resolvedOutputRoot = realpathSync(outputRoot);
    const resolved = resolveArtifactPath(outputRoot, 'attempts/trial-1/attempt-1/state.json');

    expect(resolved.startsWith(resolvedOutputRoot)).toBe(true);
    expect(resolved).toContain('attempts/trial-1/attempt-1/state.json');
  });

  it('rejects artifact paths that escape the output root', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-artifact-root-'));

    expect(() => resolveArtifactPath(outputRoot, '../outside.json')).toThrow(ArtifactError);
    expect(() => resolveArtifactPath(outputRoot, 'attempts/../../outside.json')).toThrow(
      ArtifactError,
    );
  });

  it('rejects symlink escapes outside the output root', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-artifact-root-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'ael-outside-'));
    const linkPath = join(outputRoot, 'escape-link');
    writeFileSync(join(outsideDir, 'secret.json'), '{}');
    symlinkSync(outsideDir, linkPath, 'dir');

    expect(() => resolveArtifactPath(outputRoot, 'escape-link/secret.json')).toThrow(ArtifactError);
  });

  it('rejects a live output root inside forbidden roots', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'ael-source-'));
    const outputRoot = join(sourceRoot, 'artifacts', 'output');
    mkdirSync(outputRoot, { recursive: true });

    expect(() =>
      validateOutputRoot(outputRoot, {
        sourceRoot,
        fixtureRoots: [],
        candidateRoots: [],
        agentVisibleRoots: [],
      }),
    ).toThrow(ArtifactError);
  });

  it('rejects a live output root inside fixture, candidate, or agent-visible roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'ael-forbidden-'));
    const fixtureRoot = join(base, 'fixtures');
    const candidateRoot = join(base, 'candidates');
    const agentRoot = join(base, 'agent-visible');
    mkdirSync(fixtureRoot, { recursive: true });
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(agentRoot, { recursive: true });

    const outputInFixture = join(fixtureRoot, 'out');
    const outputInCandidate = join(candidateRoot, 'out');
    const outputInAgent = join(agentRoot, 'out');
    mkdirSync(outputInFixture, { recursive: true });
    mkdirSync(outputInCandidate, { recursive: true });
    mkdirSync(outputInAgent, { recursive: true });

    const forbidden = {
      sourceRoot: join(base, 'source'),
      fixtureRoots: [fixtureRoot],
      candidateRoots: [candidateRoot],
      agentVisibleRoots: [agentRoot],
    };
    mkdirSync(forbidden.sourceRoot, { recursive: true });

    expect(() => validateOutputRoot(outputInFixture, forbidden)).toThrow(ArtifactError);
    expect(() => validateOutputRoot(outputInCandidate, forbidden)).toThrow(ArtifactError);
    expect(() => validateOutputRoot(outputInAgent, forbidden)).toThrow(ArtifactError);
  });
});
