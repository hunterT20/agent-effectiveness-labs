import { computeTreeFingerprint } from '../git/index.js';

export interface CommonPreparationInput {
  readonly workspaceRoot: string;
}

export interface CommonPreparationResult {
  readonly preparedFingerprint: string;
}

export async function runCommonPreparation(
  input: CommonPreparationInput,
): Promise<CommonPreparationResult> {
  const preparedFingerprint = await computeTreeFingerprint(input.workspaceRoot);
  return { preparedFingerprint };
}
