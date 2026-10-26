import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(path) { return readdirSync(path,{withFileTypes:true}).flatMap(item=>item.isDirectory()?files(join(path,item.name)):item.name.endsWith('.js')?[join(path,item.name)]:[]); }
for (const file of [...files('server'),...files('public'),...files('test')]) {
  const result = spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if (result.status !== 0) { process.stderr.write(result.stderr || result.error?.message || `Syntax check failed: ${file}`);process.exit(1); }
}
console.log('All JavaScript syntax checks passed.');
