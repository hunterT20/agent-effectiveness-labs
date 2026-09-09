import { z } from 'zod';

export const CandidateFileEntrySchema = z
  .object({
    path: z.string().min(1),
    changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
    oldPath: z.string().min(1).optional(),
  })
  .strict();

export type CandidateFileEntry = z.infer<typeof CandidateFileEntrySchema>;

export const CandidateSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseFingerprint: z.string(),
    finalFingerprint: z.string(),
    patchSha256: z.string(),
    fileManifestSha256: z.string(),
    changedFiles: z.array(CandidateFileEntrySchema),
    patchArtifact: z.string(),
    untrackedArchiveArtifact: z.string().nullable(),
    overlayIntegrity: z.enum(['unchanged', 'tampered']),
  })
  .strict();

export type CandidateSnapshot = z.infer<typeof CandidateSnapshotSchema>;
