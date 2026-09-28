const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../src/utils/asyncErrors');
const express = require('express');
const request = require('supertest');

test('a rejected async route handler reaches the error middleware instead of hanging', async () => {
  const app = express();
  app.get('/boom', async () => { throw new Error('db down'); });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const response = await request(app).get('/boom').timeout(2000);
  assert.strictEqual(response.status, 500);
  assert.strictEqual(response.body.error, 'db down');
});

test('a successful async handler and error middleware still work normally', async () => {
  const app = express();
  app.get('/ok', async (req, res) => res.json({ ok: true }));
  const response = await request(app).get('/ok');
  assert.deepStrictEqual(response.body, { ok: true });
});

test('app shell children are forced to full width so layouts do not shrink to their content', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  assert.match(css, /\.dashboard-page > main[^{]*\{[^}]*width:\s*100%/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
});
