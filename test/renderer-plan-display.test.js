const assert = require('node:assert/strict');
const fs = require('node:fs');

const appJs = fs.readFileSync('src/renderer/app.js', 'utf8');
const html = fs.readFileSync('src/renderer/index.html', 'utf8');

assert.match(appJs, /claudePlan:\s*null/);
assert.match(appJs, /codexPlan:\s*null/);
assert.doesNotMatch(appJs, /claudePlan\s*=\s*claude\s*&&\s*claude\.plan\s*\?\s*claude\.plan\s*:\s*DEFAULTS\.claudePlan/);
assert.doesNotMatch(appJs, /codexPlan\s*=\s*codex\s*&&\s*codex\.plan\s*\?\s*codex\.plan\s*:\s*DEFAULTS\.codexPlan/);
assert.doesNotMatch(html, /<div class="svc-plan">(PRO|MAX)<\/div>/);

console.log('renderer plan display assertions passed');
