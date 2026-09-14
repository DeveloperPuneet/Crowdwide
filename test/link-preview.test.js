const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractFirstUrl,
  isBlockedHost,
  fetchLinkPreview,
  extractMetaContent,
  extractTitleTag,
  decodeEntities
} = require('../src/services/linkPreview');

// --- extractFirstUrl -------------------------------------------------

test('extractFirstUrl finds a URL embedded in ordinary text', () => {
  assert.equal(extractFirstUrl('Check this out: https://example.com/article about stuff'), 'https://example.com/article');
});

test('extractFirstUrl trims trailing sentence punctuation that is not part of the URL', () => {
  assert.equal(extractFirstUrl('Great read: https://example.com/post.'), 'https://example.com/post');
  assert.equal(extractFirstUrl('(see https://example.com/x)'), 'https://example.com/x');
});

test('extractFirstUrl returns null when there is no URL', () => {
  assert.equal(extractFirstUrl('just a normal post with no links'), null);
});

test('extractFirstUrl ignores non-http(s) schemes', () => {
  assert.equal(extractFirstUrl('mailto:someone@example.com'), null);
});

// --- isBlockedHost (SSRF guard) --------------------------------------

test('isBlockedHost blocks localhost, loopback, and private ranges', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', 'printer.local']) {
    assert.equal(isBlockedHost(host), true, `expected ${host} to be blocked`);
  }
});

test('isBlockedHost allows ordinary public hostnames', () => {
  for (const host of ['example.com', 'www.nytimes.com', 'sub.example.co.uk']) {
    assert.equal(isBlockedHost(host), false, `expected ${host} to be allowed`);
  }
});

test('isBlockedHost does not false-positive on a public IP that merely starts similarly to a private range', () => {
  // 172.32.x.x and above is public (private range is only 172.16.0.0-172.31.255.255)
  assert.equal(isBlockedHost('172.32.0.1'), false);
});

// --- HTML parsing helpers ---------------------------------------------

test('extractMetaContent finds an og:-prefixed meta tag regardless of attribute order', () => {
  const htmlPropertyFirst = '<meta property="og:title" content="Hello World">';
  const htmlContentFirst = '<meta content="Hello World" property="og:title">';
  assert.equal(extractMetaContent(htmlPropertyFirst, 'og:title'), 'Hello World');
  assert.equal(extractMetaContent(htmlContentFirst, 'og:title'), 'Hello World');
});

test('extractTitleTag reads the plain <title> tag', () => {
  assert.equal(extractTitleTag('<html><head><title>  My Page  </title></head></html>'), 'My Page');
});

test('decodeEntities decodes common named and numeric HTML entities', () => {
  assert.equal(decodeEntities('Fish &amp; Chips'), 'Fish & Chips');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('caf&#233;'), 'café');
});

// --- fetchLinkPreview (mocked fetch, no real network) ------------------

function mockFetch(t, { status = 200, contentType = 'text/html', html = '' } = {}) {
  return t.mock.method(global, 'fetch', () => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(html),
    body: null // exercises the response.text() fallback path in readCapped
  }));
}

test('fetchLinkPreview never calls fetch for a blocked/private host (SSRF guard short-circuits first)', async (t) => {
  const fetchCalls = t.mock.method(global, 'fetch', () => { throw new Error('fetch should not have been called'); });
  const result = await fetchLinkPreview('http://169.254.169.254/latest/meta-data/');
  assert.equal(result, null);
  assert.equal(fetchCalls.mock.callCount(), 0);
});

test('fetchLinkPreview never calls fetch for a non-http(s) URL', async (t) => {
  const fetchCalls = t.mock.method(global, 'fetch', () => { throw new Error('fetch should not have been called'); });
  const result = await fetchLinkPreview('ftp://example.com/file');
  assert.equal(result, null);
  assert.equal(fetchCalls.mock.callCount(), 0);
});

test('fetchLinkPreview returns null for an invalid URL string', async (t) => {
  const result = await fetchLinkPreview('not a url at all');
  assert.equal(result, null);
});

test('fetchLinkPreview returns null when the response is not ok', async (t) => {
  mockFetch(t, { status: 404 });
  const result = await fetchLinkPreview('https://example.com/missing');
  assert.equal(result, null);
});

test('fetchLinkPreview returns null for a non-HTML content type', async (t) => {
  mockFetch(t, { contentType: 'application/pdf' });
  const result = await fetchLinkPreview('https://example.com/file.pdf');
  assert.equal(result, null);
});

test('fetchLinkPreview returns null when the page has no title at all', async (t) => {
  mockFetch(t, { html: '<html><head></head><body>no title</body></html>' });
  const result = await fetchLinkPreview('https://example.com/no-title');
  assert.equal(result, null);
});

test('fetchLinkPreview prefers Open Graph tags, falls back to <title> and <meta name="description">', async (t) => {
  mockFetch(t, {
    html: `<html><head>
      <title>Fallback Title</title>
      <meta name="description" content="Fallback description.">
    </head></html>`
  });
  const result = await fetchLinkPreview('https://example.com/fallback');
  assert.equal(result.title, 'Fallback Title');
  assert.equal(result.description, 'Fallback description.');
  assert.equal(result.siteName, 'example.com');
});

test('fetchLinkPreview parses a full Open Graph card and resolves a relative image URL against the page URL', async (t) => {
  mockFetch(t, {
    html: `<html><head>
      <meta property="og:title" content="Great Article &amp; More">
      <meta property="og:description" content="An article about things.">
      <meta property="og:image" content="/images/cover.jpg">
      <meta property="og:site_name" content="Example News">
    </head></html>`
  });
  const result = await fetchLinkPreview('https://news.example.com/articles/1');
  assert.deepEqual(result, {
    url: 'https://news.example.com/articles/1',
    title: 'Great Article & More',
    description: 'An article about things.',
    image: 'https://news.example.com/images/cover.jpg',
    siteName: 'Example News'
  });
});
