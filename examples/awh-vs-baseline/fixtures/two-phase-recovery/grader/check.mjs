#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
function read(rel){return readFileSync(join(process.cwd(),rel),'utf8').trim();}
function exists(rel){return existsSync(join(process.cwd(),rel));}
function fail(msg){console.error(msg);process.exit(1);}
if(read('src/tasks/two-phase-recovery/phase1.txt')!=='done')fail('p1');if(read('src/tasks/two-phase-recovery/phase2.txt')!=='done')fail('p2');
process.exit(0);
