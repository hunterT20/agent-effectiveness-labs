import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('data', { recursive: true, force: true });
mkdirSync('data/archive', { recursive: true });
writeFileSync(
  'data/customers.json',
  JSON.stringify([{ id: 1, email: 'sample@example.com', name: 'Sample' }], null, 2) + '\n',
);
