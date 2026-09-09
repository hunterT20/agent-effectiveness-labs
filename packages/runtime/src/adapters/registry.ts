import type { AgentAdapter } from '@ael/core';

const adapters = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(adapterId: string): AgentAdapter {
  const adapter = adapters.get(adapterId);
  if (adapter === undefined) {
    throw new Error(`unknown agent adapter: ${adapterId}`);
  }
  return adapter;
}

export function listAdapters(): readonly string[] {
  return [...adapters.keys()];
}
