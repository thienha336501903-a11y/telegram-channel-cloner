import fs from 'node:fs';
import path from 'node:path';

const roots = ['api', 'lib', 'server'];
const allowed = new Set(['lib/clone-config.js', 'scripts/check-domain-isolation.js']);
const forbidden = /(?:https?:\/\/)?(?:www\.)?(?:yeubep\.shop|hoc\.yeubep\.shop|reader\.yeubep\.shop|v4\.daubepnho\.store|daubepnho\.store|yeunauan\.live)/i;
const failures = [];
function walk(relative) {
  for (const entry of fs.readdirSync(relative, { withFileTypes: true })) {
    const file = path.join(relative, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name) && !allowed.has(file)) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (forbidden.test(line)) failures.push(`${file}:${index + 1}`);
      });
    }
  }
}
roots.filter(fs.existsSync).forEach(walk);
if (failures.length) {
  console.error('Runtime domain isolation failed; move clone-specific domains into lib/clone-config.js:');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}
console.log('Runtime domain isolation passed.');
