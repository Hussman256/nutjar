// Make the embeddable bundle pure ASCII so it renders correctly on host pages with any charset.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'dist/cashu-boost.js';
const src = readFileSync(file, 'utf8');
let count = 0;
// charCodeAt works per UTF-16 unit, so emoji become valid surrogate-pair escapes (🥜).
const out = src.replace(/[^\x00-\x7f]/g, (c) => {
  count++;
  return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
});
writeFileSync(file, out);
console.log(`${file}: escaped ${count} non-ASCII code units`);
