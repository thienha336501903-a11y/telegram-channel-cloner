import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('Cloner exposes an opt-in return control for the LMS Wizard', () => {
  assert.match(html, /id="returnToWizard"/);
  assert.match(html, /← Quay lại LMS Wizard/);
  assert.match(html, /safeWizardReturn/);
});

test('returnTo is restricted to the LMS Wizard on approved Vercel hosts', () => {
  assert.match(html, /u\.protocol!=='https:'/);
  assert.match(html, /u\.pathname!=='\/v4-course-wizard\.html'/);
  assert.match(html, /runtimeConfig\.lmsPublicUrl/);
  assert.match(html, /u\.origin===lms\.origin/);
  assert.match(html, /vercel\\\.app/);
  assert.match(html, /u\.hostname\.includes\('lms'\)/);
  assert.match(html, /return u\.origin\+u\.pathname/);
});

test('raw returnTo is never assigned directly to location', () => {
  assert.doesNotMatch(html, /location\.(?:assign|replace)\(raw\)/);
});
