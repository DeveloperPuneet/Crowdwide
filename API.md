# Crowdwide public API

Crowdwide exposes a small, read-only public API for published posts, plus
RSS feeds. Both are unauthenticated and CORS-open - no API key, no login.

This is alpha software. The shape below is what exists today; it may
change without a version bump until Crowdwide reaches a stable release
(see `todo.txt`). If you're building something that depends on this,
expect to need to update it later.

## `GET /api/v1/posts`

Returns recently published posts, newest first.

### Query parameters

| Param       | Type                        | Default | Notes |
|-------------|-----------------------------|---------|-------|
| `limit`     | integer                     | `20`    | Clamped to 1-50. |
| `type`      | `post` \| `article` \| `poll` | (all) | Filters to one post type. |
| `community` | Mongo ObjectId              | (all)   | Restricts results to one community. A private community's ID always returns an empty page - see Privacy below. |
| `before`    | ISO 8601 date string        | (none)  | Returns posts created strictly before this timestamp - use it for pagination (see `nextCursor`). |

### Response

```json
{
  "data": [
    {
      "id": "abc",
      "url": "https://www.crowdwide.run.place/posts/66f1a2b3c4d5e6f7a8b9c0d1",
      "body": "Post text.",
      "type": "post",
      "author": { "_id": "...", "name": "...", "profilePicture": "..." },
      "community": { "_id": "...", "name": "...", "slug": "..." },
      "hashtags": ["example"],
      "media": [{ "url": "...", "kind": "image", "alt": "...", "caption": "..." }],
      "createdAt": "2026-09-15T03:00:00.000Z"
    }
  ],
  "nextCursor": "2026-09-14T18:22:00.000Z"
}
```

`community` is `null` for a post not in a community. `nextCursor` is the
`createdAt` of the last item in `data`, or `null` when there isn't a next
page (fewer results came back than `limit` asked for) - pass it as
`before` on your next request to page through results.

### Rate limit

120 requests per minute per client (`express-rate-limit`, standard
`RateLimit-*` response headers). Exceeding it returns `429` with
`{ "error": "Too many API requests. Try again shortly." }`.

### Privacy

Posts in a private community never appear here, for anyone, under any
`community` filter value - there's no way to authenticate this endpoint,
so it can't tell members from non-members and treats every private
community as fully off-limits. Passing a private community's ID returns
`{ "data": [], "nextCursor": null }`, not an error - the endpoint doesn't
reveal whether a given ID belongs to a private community, a nonexistent
community, or a community with no posts yet.

### Errors

A `500` with `{ "error": "Internal server error." }` means something
broke server-side (most often a database hiccup) - it does not mean your
request was malformed. Malformed query parameters are silently ignored
(e.g. an invalid `community` value is treated as "no filter") rather than
rejected with a `400`, so a typo in a param name or value just falls back
to the default rather than erroring.

## RSS feeds

Three RSS 2.0 feeds, all public, all read-only:

- **`GET /rss.xml`** - every published post site-wide.
- **`GET /u/:id/rss.xml`** - one person's public posts (`:id` is their
  Mongo ObjectId, visible in their profile URL).
- **`GET /communities/:slug/rss.xml`** - one community's posts. Returns
  `404` for a private community or a nonexistent slug - both look
  identical, for the same reason the JSON API doesn't distinguish them.

Each entry links to the post's page on Crowdwide rather than embedding
full rendered HTML.

## Also public, not really "the API"

- **`GET /sitemap.xml`** - static pages only, for search engines.
- **`GET /robots.txt`** - standard crawler directives.

These aren't meant for programmatic consumption of post data - use
`/api/v1/posts` or the RSS feeds for that.
