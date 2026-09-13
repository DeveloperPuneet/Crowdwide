// Shared helpers for the end-to-end suite (test/e2e/*.test.js).
//
// These tests spin up a real Express app (src/app.js) against a real
// MongoDB -- either an in-memory instance via mongodb-memory-server, or
// a MONGODB_URI you provide -- and drive it exactly like a browser would:
// real HTTP requests, real cookies, real CSRF tokens scraped out of the
// rendered HTML. They are NOT run by the default `npm test` (see
// test/upload-validation.test.js and test/permissions.test.js for the
// DB-free unit tests that are). Run this suite with `npm run test:e2e`.
//
// Requires network access the first time, to download the mongod binary
// that mongodb-memory-server uses (unless MONGODB_URI is already set to
// a reachable database, in which case no download happens).

const mongoose = require('mongoose');

async function startTestDatabase() {
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-secret';

  let stop = async () => {};
  if (!process.env.MONGODB_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongod.getUri();
    stop = () => mongod.stop();
  }

  await mongoose.connect(process.env.MONGODB_URI);
  return { stop };
}

async function stopTestDatabase(handle) {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await handle.stop();
}

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('Could not find a _csrf token in the rendered page.');
  return match[1];
}

function extractSessionCookie(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  return setCookie.map((cookie) => cookie.split(';')[0]).join('; ');
}

// A tiny stateful wrapper around supertest that carries the session cookie
// forward across requests (supertest itself is stateless per-call) and
// automatically attaches a fresh CSRF token scraped from whichever page
// was most recently rendered.
function createAgent(app) {
  const request = require('supertest');
  let cookie = null;

  async function get(path) {
    let req = request(app).get(path);
    if (cookie) req = req.set('Cookie', cookie);
    const res = await req;
    const newCookie = extractSessionCookie(res);
    if (newCookie) cookie = newCookie;
    return res;
  }

  async function post(path, fields = {}) {
    // Every form in the app renders a hidden _csrf input, so grab a fresh
    // token from the current page's session before posting.
    let req = request(app).post(path).type('form');
    if (cookie) req = req.set('Cookie', cookie);
    const res = await req.send(fields);
    const newCookie = extractSessionCookie(res);
    if (newCookie) cookie = newCookie;
    return res;
  }

  return { get, post, getCookie: () => cookie };
}

module.exports = { startTestDatabase, stopTestDatabase, extractCsrfToken, createAgent };
