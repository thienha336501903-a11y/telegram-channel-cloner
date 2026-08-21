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
  assert.match(html, /host==='yeunauan-lms-clone\.vercel\.app'/);
  assert.match(html, /host\.startsWith\('yeunauan-lms-clone-'\)/);
  assert.match(html, /host\.startsWith\('yeunauan-lms-git-'\)/);
  assert.match(html, /host\.endsWith\('\.vercel\.app'\)/);
  assert.match(html, /return u\.origin\+u\.pathname/);
});

test('raw returnTo is never assigned directly to location', () => {
  assert.doesNotMatch(html, /location\.(?:assign|replace)\(raw\)/);
});
