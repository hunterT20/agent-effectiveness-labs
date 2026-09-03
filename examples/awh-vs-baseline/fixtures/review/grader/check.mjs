#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
function read(rel){return readFileSync(join(process.cwd(),rel),'utf8').trim();}
function exists(rel){return existsSync(join(process.cwd(),rel));}
function fail(msg){console.error(msg);process.exit(1);}
if(read('src/tasks/review/status.txt')!=='fixed')fail('status');if(read('src/tasks/review/review-notes.txt').length<8)fail('review');
process.exit(0);
