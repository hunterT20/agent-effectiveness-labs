import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export class EventLog {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly eventsPath: string) {}

  append(event: unknown): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.eventsPath), { recursive: true });
      const handle = await open(this.eventsPath, 'a');
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
