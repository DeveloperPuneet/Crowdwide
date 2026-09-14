// Fetches and unfurls a lightweight Open Graph preview (title/description/
// image) for the first link in a post body. This is a best-effort side
// effect, never a blocking step of posting: callers should fire this and
// move on (see createPost in webController.js), the same way push
// notifications and security emails are fire-and-forget elsewhere in this
// app - a slow or hanging external site must never make "create a post"
// hang, which was exactly the class of bug fixed elsewhere this session.

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;
const MAX_BYTES = 200 * 1024; // plenty for a page's <head>; we never need the body
const FETCH_TIMEOUT_MS = 5000;

const HTML_ENTITY_DECODE = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

// Basic SSRF guard: refuses to fetch obviously-private/loopback/link-local
// hosts. This is a string-based check on the hostname/IP literal as
// written in the URL, not a DNS-resolution-based check, so it does not
// defend against DNS rebinding (a hostname that resolves to a private IP
// at fetch time). Treat this as a baseline guard, not a complete one.
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /\.local$/i,
  /^\[?::1\]?$/,
  /^\[?fe80:/i
];

function isBlockedHost(hostname) {
  return BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname));
}

function extractFirstUrl(text = '') {
  const match = String(text).match(URL_PATTERN);
  if (!match) return null;
  // Trim common trailing punctuation that isn't actually part of the URL,
  // e.g. "check this out: https://example.com." at the end of a sentence.
  return match[0].replace(/[.,!?)\]'"]+$/, '');
}

function decodeEntities(text = '') {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return HTML_ENTITY_DECODE[entity.toLowerCase()] || whole;
  });
}

function extractMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : null;
}

async function readCapped(response, maxBytes) {
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function fetchLinkPreview(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || isBlockedHost(parsed.hostname)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'CrowdwideLinkPreview/1.0 (+https://crowdwide.onrender.com)' }
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await readCapped(response, MAX_BYTES);
    const title = extractMetaContent(html, 'og:title') || extractTitleTag(html);
    if (!title) return null;

    const description = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description') || '';
    const rawImage = extractMetaContent(html, 'og:image') || '';
    let image = '';
    if (rawImage) {
      try {
        image = new URL(rawImage, parsed).toString();
      } catch {
        image = '';
      }
    }
    const siteName = extractMetaContent(html, 'og:site_name') || parsed.hostname;

    return {
      url: parsed.toString(),
      title: decodeEntities(title).trim().slice(0, 200),
      description: decodeEntities(description).trim().slice(0, 300),
      image,
      siteName: decodeEntities(siteName).trim().slice(0, 100)
    };
  } catch (error) {
    console.error(`Link preview fetch failed for ${rawUrl}:`, error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { extractFirstUrl, fetchLinkPreview, isBlockedHost, extractMetaContent, extractTitleTag, decodeEntities };
