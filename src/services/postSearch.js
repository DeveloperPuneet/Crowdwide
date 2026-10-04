const logger = require('./logger');

const INDEX_UID = 'posts';
const OPEN_COMMUNITY = 'open';
const FILTERABLE_ATTRIBUTES = ['author', 'community', 'type', 'hashtags', 'hasMedia', 'commentsCount', 'createdAt'];
const SORTABLE_ATTRIBUTES = ['createdAt', 'likesCount', 'commentsCount'];
let indexReady;
let rebuilding = false;

function baseUrl() {
  const configured = String(process.env.MEILISEARCH_URL || '').trim();
  if (!configured) return null;
  return new URL(configured);
}

function isConfigured() {
  return Boolean(String(process.env.MEILISEARCH_URL || '').trim());
}

async function request(path, options = {}) {
  const url = baseUrl();
  if (!url) throw new Error('MEILISEARCH_URL is not configured.');
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}${path}`;
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  if (process.env.MEILISEARCH_API_KEY) headers.Authorization = `Bearer ${process.env.MEILISEARCH_API_KEY}`;
  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.text();
  let result;
  try { result = body ? JSON.parse(body) : {}; } catch { result = { message: body }; }
  if (!response.ok) {
    const error = new Error(`Meilisearch returned ${response.status}: ${result.message || result.code || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function waitForTask(taskUid) {
  if (!taskUid) return;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = await request(`/tasks/${taskUid}`);
    if (task.status === 'succeeded') return;
    if (task.status === 'failed' || task.status === 'canceled') {
      throw new Error(`Meilisearch task ${taskUid} ${task.status}: ${task.error?.message || 'unknown error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Meilisearch task ${taskUid} did not finish within 15 seconds.`);
}

async function enqueueAndWait(path, method, body) {
  const task = await request(path, { method, body: JSON.stringify(body) });
  await waitForTask(task.taskUid);
}

async function ensureIndex() {
  if (indexReady) return indexReady;
  indexReady = (async () => {
    try {
      await request(`/indexes/${INDEX_UID}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      await enqueueAndWait('/indexes', 'POST', { uid: INDEX_UID, primaryKey: 'id' });
    }
    await enqueueAndWait(`/indexes/${INDEX_UID}/settings/filterable-attributes`, 'PUT', FILTERABLE_ATTRIBUTES);
    await enqueueAndWait(`/indexes/${INDEX_UID}/settings/sortable-attributes`, 'PUT', SORTABLE_ATTRIBUTES);
  })().catch((error) => {
    indexReady = null;
    throw error;
  });
  return indexReady;
}

function toSearchDocument(post) {
  return {
    id: String(post._id || post.id),
    body: post.body || '',
    hashtags: post.hashtags || [],
    author: String(post.author?._id || post.author),
    community: post.community ? String(post.community?._id || post.community) : OPEN_COMMUNITY,
    type: post.type || 'post',
    createdAt: Math.floor(new Date(post.createdAt || Date.now()).getTime() / 1000),
    commentsCount: post.commentsCount || 0,
    likesCount: post.likes?.length || 0,
    hasMedia: Boolean(post.media?.length)
  };
}

function buildSearchRequest({ query, limit = 1000, filters = {} }) {
  const filter = [];
  const quoted = (value) => JSON.stringify(String(value));
  const excludeAuthors = [...new Set([...(filters.blockedAuthors || []), ...(filters.mutedAuthors || [])].map(String))];
  const excludeCommunities = [...new Set((filters.restrictedCommunities || []).map(String))];
  if (excludeAuthors.length) filter.push(`author NOT IN [${excludeAuthors.map(quoted).join(', ')}]`);
  if (excludeCommunities.length) filter.push(`community NOT IN [${excludeCommunities.map(quoted).join(', ')}]`);
  if (filters.tag) filter.push(`hashtags = ${quoted(filters.tag)}`);
  if (filters.type) filter.push(`type = ${quoted(filters.type)}`);
  if (filters.community) filter.push(`community = ${quoted(filters.community)}`);
  if (filters.media) filter.push('hasMedia = true');
  if (filters.unanswered) filter.push('commentsCount = 0');
  if (filters.from) filter.push(`createdAt >= ${Math.floor(new Date(filters.from).getTime() / 1000)}`);
  if (filters.to) filter.push(`createdAt <= ${Math.floor(new Date(filters.to).getTime() / 1000)}`);

  const sort = filters.sort === 'oldest'
    ? ['createdAt:asc']
    : filters.sort === 'popular'
      ? ['likesCount:desc', 'commentsCount:desc', 'createdAt:desc']
      : filters.sort === 'newest'
        ? ['createdAt:desc']
        : undefined;

  return {
    q: query || '',
    limit,
    ...(filter.length ? { filter } : {}),
    ...(sort ? { sort } : {})
  };
}

async function searchPublishedPosts(options) {
  try {
    if (!isConfigured()) return null;
    if (rebuilding) return null;
    await ensureIndex();
    const result = await request(`/indexes/${INDEX_UID}/search`, {
      method: 'POST',
      body: JSON.stringify(buildSearchRequest(options))
    });
    return (result.hits || []).map((hit) => String(hit.id));
  } catch (error) {
    logger.warn('Meilisearch post search failed; using MongoDB search instead', error);
    return null;
  }
}

async function sendPost(post) {
  if (!isConfigured()) return;
  await ensureIndex();
  if (post.status !== 'published') {
    await request(`/indexes/${INDEX_UID}/documents/${encodeURIComponent(String(post._id))}`, { method: 'DELETE' });
    return;
  }
  await request(`/indexes/${INDEX_UID}/documents?primaryKey=id`, {
    method: 'POST',
    body: JSON.stringify([toSearchDocument(post)])
  });
}

function queuePostIndex(post) {
  sendPost(post).catch((error) => logger.warn('Could not update Meilisearch post index', error));
}

async function removePostIds(ids) {
  if (!isConfigured() || !ids.length) return;
  await ensureIndex();
  await request(`/indexes/${INDEX_UID}/documents/delete-batch`, {
    method: 'POST',
    body: JSON.stringify(ids.map(String))
  });
}

function queuePostRemoval(ids) {
  removePostIds(Array.isArray(ids) ? ids : [ids])
    .catch((error) => logger.warn('Could not remove deleted posts from Meilisearch', error));
}

async function rebuildPostIndex() {
  if (!baseUrl()) return;
  await ensureIndex();
  const Post = require('../models/Post');
  const cursor = Post.find({ status: 'published' })
    .select('_id body hashtags author community type createdAt commentsCount likes media status')
    .lean()
    .cursor();
  let batch = [];
  for await (const post of cursor) {
    batch.push(toSearchDocument(post));
    if (batch.length === 500) {
      await enqueueAndWait(`/indexes/${INDEX_UID}/documents?primaryKey=id`, 'POST', batch);
      batch = [];
    }
  }
  if (batch.length) await enqueueAndWait(`/indexes/${INDEX_UID}/documents?primaryKey=id`, 'POST', batch);
}

function startPostSearchIndexing() {
  if (!isConfigured()) return;
  rebuilding = true;
  rebuildPostIndex()
    .catch((error) => logger.warn('Meilisearch startup indexing failed', error))
    .finally(() => { rebuilding = false; });
}

module.exports = {
  buildSearchRequest,
  queuePostIndex,
  queuePostRemoval,
  searchPublishedPosts,
  startPostSearchIndexing,
  toSearchDocument
};
