#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
function read(rel){return readFileSync(join(process.cwd(),rel),'utf8').trim();}
function exists(rel){return existsSync(join(process.cwd(),rel));}
function fail(msg){console.error(msg);process.exit(1);}
if(read('src/tasks/regression-trap/status.txt')!=='fixed')fail('status');if(read('tests/guard.txt')!=='ok')fail('trap');
process.exit(0);
