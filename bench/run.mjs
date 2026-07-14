// bench/run.mjs — discover and run every scenario, print the report.
// Usage: node bench/run.mjs [name-filter]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const scenariosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenarios');
const filter = process.argv[2] || '';

const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.mjs')).sort();
let failures = 0;
const rows = [];

for (const file of files) {
  const mod = await import(pathToFileURL(path.join(scenariosDir, file)).href);
  if (filter && !mod.name.includes(filter)) continue;
  let result;
  try {
    result = await mod.run();
  } catch (err) {
    result = { pass: false, details: `scenario crashed: ${err?.stack || err}` };
  }
  rows.push({ name: mod.name, ...result });
  if (!result.pass) failures++;
}

console.log('\npolygraph bench report');
console.log('======================');
for (const row of rows) {
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${row.name}`);
  if (row.details) console.log(`      ${row.details.split('\n').join('\n      ')}`);
}
console.log(`\n${rows.length - failures}/${rows.length} scenarios passed`);
process.exitCode = failures === 0 ? 0 : 1;
