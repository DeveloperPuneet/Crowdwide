# Crowdwide

**Status: Alpha.** Crowdwide is live and usable, but still early - expect
rough edges, features that are still being hardened, and the occasional
bug that hasn't surfaced yet. If something breaks, that's useful
information, not an inconvenience.

**Live:** the deployed instance runs at the URL set in `APP_URL` (see
`.env.example`) - typically something like `https://crowdwide.onrender.com`.
If you're reading this from the repo and aren't sure what the current
live URL is, check your hosting dashboard; this file doesn't hardcode it
so it can't go stale.

Crowdwide is a social platform built with an Express MVC stack, EJS
views, and MongoDB: posts, articles, and polls; communities (open and
private); direct messages and group chat; follows and a personalized
feed; moderation tools including reports, appeals, suspensions, and
temporary posting restrictions; browser push notifications; and a small
public read-only API. Session-based auth, with optional TOTP two-factor
and email verification via a Google Cloud Gmail OAuth2 setup (not a raw
app password).

## Run locally

1. Install Node.js 22+ and MongoDB.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill it in - see **Environment
   variables** below for what each one does and where to get it.
4. Start development mode: `npm run dev`
5. Open `http://localhost:3000`

Without mail configured, verification codes and security emails print to
the server log instead of sending - fine for local development, not for
anything real users will hit.

For Render (or a similar platform), set `NODE_ENV=production` and
`TRUST_PROXY_HOPS=1`. Crowdwide trusts one reverse-proxy hop so Express
and `express-rate-limit` can safely read the platform's `X-Forwarded-For`
header. Don't set the Express trust-proxy value to `true` unless you
fully control the deployment topology - see `DEPLOYMENT.md` for the rest
of what a real deployment needs (CI, backups, virus scanning, alerting).

## Environment variables

Every variable Crowdwide reads is listed in `.env.example` with a
one-line comment. Grouped by what breaks if you skip them:

**Required to run at all**
- `MONGODB_URI` - a MongoDB connection string. [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
  has a free tier; or run `mongod` locally for development.
- `SESSION_SECRET` - any long random string, used to sign session cookies.
  Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `APP_URL` - the public HTTPS URL of the deployment (or
  `http://localhost:3000` locally). Used for canonical links, Open Graph
  tags, the sitemap, RSS feed links, and API response URLs.

**Required for real email delivery** (without these, codes/alerts just
log to the console - see **Email via Google Cloud / Gmail API** below
for the full walkthrough)
- `MAIL_PROVIDER=gmail`
- `GMAIL_USER` - the Gmail address that will send mail.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - from a Google Cloud OAuth
  2.0 Client ID.
- `GOOGLE_REFRESH_TOKEN` - obtained via a one-time OAuth authorization
  (walkthrough below).
- `MAIL_FROM` - same address as `GMAIL_USER`.

**Optional - each feature degrades gracefully to "off" without it**
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` - browser push
  notifications. Generate a pair with `npx web-push generate-vapid-keys`.
- `ADMIN_ALERT_EMAIL` - unhandled server errors email this address
  (rate-limited). Any address you actually check.
- `CLAMAV_HOST`/`CLAMAV_PORT` or `CLAMAV_SOCKET` - upload virus scanning
  against a ClamAV daemon. See `DEPLOYMENT.md`.
- `GCS_PROJECT_ID`, `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `MEDIA_CDN_URL` - direct-to-cloud media uploads via Google Cloud
  Storage, instead of (or alongside) MongoDB GridFS. See **Extended
  media storage** below.
- `MONGO_DB_URL_0`, `MONGO_DB_URL_1`, ... - additional MongoDB clusters
  to spread media storage across. See **Extended media storage** below.
- `TRUST_PROXY_HOPS` - see **Run locally** above.
- `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` - see `DEPLOYMENT.md`.

Nothing in `.env.example` needs a paid service to get a working local
setup - MongoDB Atlas, Google Cloud, and web-push key generation are all
free. Mail, push, alerting, virus scanning, and extended storage are all
independently optional; the app runs and every core feature works
without any of them configured.

## Email via Google Cloud / Gmail API

Crowdwide sends mail through the **Gmail API via OAuth2 against a Google
Cloud project** - not a raw Gmail address/app-password combination, and
not a third-party transactional email service. If you're setting this up
for the first time:

1. In [Google Cloud Console](https://console.cloud.google.com/), create
   or select a project.
2. **APIs & Services > Library** - enable the **Gmail API** for that
   project.
3. **APIs & Services > OAuth consent screen** - configure it (External
   is fine for a small deployment). While the app is in "Testing" mode,
   add the Gmail address that will send mail as a test user - Google
   won't let an unverified app send as an account that isn't listed
   here.
4. **APIs & Services > Credentials > Create Credentials > OAuth client
   ID** - type "Web application" (or "Desktop app" if you're doing the
   OAuth flow locally). Add `https://developers.google.com/oauthplayground`
   as an authorized redirect URI - that's the easiest way to complete
   step 5 without writing a callback handler yourself.
5. Get a refresh token - the fiddly one-time step:
   - Go to [Google OAuth Playground](https://developers.google.com/oauthplayground/).
   - Click the gear icon (top right) -> check **"Use your own OAuth
     credentials"** -> paste in the Client ID and Client Secret from step 4.
   - In the left panel, find **Gmail API v1** and select the
     `https://mail.google.com/` scope.
   - Click **Authorize APIs**, sign in with the Gmail address from step
     3, and accept.
   - Click **Exchange authorization code for tokens**. The **Refresh
     token** field is what you need - it doesn't expire until you
     revoke it.
6. Set in `.env`:
   ```
   MAIL_PROVIDER=gmail
   GMAIL_USER=your-sending-address@gmail.com
   GOOGLE_CLIENT_ID=...           # from step 4
   GOOGLE_CLIENT_SECRET=...       # from step 4
   GOOGLE_REFRESH_TOKEN=...       # from step 5
   MAIL_FROM=your-sending-address@gmail.com
   ```

No Gmail password and no "less secure app access" toggle involved -
that's the whole point of doing it this way. Keep the client secret and
refresh token out of source control; in production, put them in your
host's secret manager (Render's environment groups, Google Secret
Manager, etc.), not in a committed `.env` file.

If mail is unconfigured, verification codes, password reset links, and
security alerts just print to the server log (`[Crowdwide mail preview]
...`) instead of sending - useful for local development, not something
to leave on in production, since real users won't see their verification
code anywhere.

## Structure

- `server.js` - process entry point (env loading, DB connect, listen)
- `src/app.js` - the Express app itself, separated out so tests can
  import it without binding a port
- `src/config` - database configuration
- `src/controllers` - request handlers
- `src/middleware` - auth guards, upload handling, security (CSRF, rate
  limits, virus scanning hook)
- `src/models` - MongoDB/Mongoose schemas
- `src/routes` - web and auth route definitions
- `src/services` - mail, push notifications, link previews, structured
  logging, error alerting, virus scanning, publication scheduling
- `src/utils` - small shared helpers (hashtags, spam detection, posting
  restrictions, private-community visibility)
- `src/views` - EJS pages and partials
- `public` - static assets, styles, service worker, and browser scripts
- `test` - DB-free unit tests (`npm test`) and end-to-end tests requiring
  MongoDB (`npm run test:e2e`) - see **Testing** below
- `scripts` - operational scripts (backup, restore verification)

## Public pages and SEO

`/about`, `/about/developer`, `/privacy`, `/terms`, `/community-guidelines`,
`/accessibility`, `/premium`, and `/contact`. Every page gets a title,
description, canonical URL, Open Graph and Twitter metadata, favicon, and
responsive layout. The homepage emits WebSite JSON-LD; `/robots.txt` and
`/sitemap.xml` are generated by the application.

`/premium` is a placeholder, not a product: it explains that monetization
is intentionally deferred until the safety/moderation systems have real
usage behind them, reliability holds up under real traffic, and there's
an actual community using Crowdwide day to day - and that the core
experience won't go behind a paywall regardless of what comes later.

Homepage member, post, and community totals are queried from MongoDB on
each request; if the database is empty or briefly unavailable, the
homepage shows an honest starter/degraded state rather than inventing
numbers.

## Dashboard feed

The authenticated dashboard has two feed modes. The normal feed mixes
posts from people you follow, a second-degree "extended network" (people
your follows follow, and people who follow your followers), new voices
and recently-active communities, posts from the largest communities, and
viral content ranked by likes - so growing accounts aren't permanently
buried under popularity. The personalized feed returns posts from
communities you've joined plus posts sharing hashtags you've liked. Both
modes correctly exclude posts from private communities you haven't
joined (see **Private communities** below).

The dashboard supports publishing posts, articles, or polls; attaching
up to two media files with alt text, a caption, and (for audio/video) a
transcript; assigning a post to a community; saving drafts and scheduling
future publication; and basic rich formatting in the post body
(`**bold**`, `*italic*`, `# headings`, `- lists`, paragraph breaks). A
link-only post automatically gets an Open Graph preview card fetched in
the background. Repeat-posting the same text within ten minutes is
blocked as spam.

Posts are limited to 5,000 characters (120 words for a plain post, 550
for an article); media is limited to images under 1.5MB, video under
4MB, and audio under 2MB.

## Community discovery and moderation

`/explore` is a discovery hub: a searchable, category- and
hashtag-filterable community grid, plus viral posts, popular people, and
newly joined members. Communities have hashtags, an optional banner
(under 2MB) and profile picture (under 1.5MB), and public guidelines
shown on their `/communities/:slug` page along with a member list
(owner/moderator/member roles visible to everyone) - unless the
community is private, in which case none of that is visible to
non-members (see below).

Communities can be open or private. Open communities accept members
immediately; private communities create a join request an owner or
moderator must approve. Owners can edit details/hashtags/guidelines,
maintain a banned-word list, require posts to be reviewed before they
appear, add moderators, and remove members.

### Private communities

**A private community's posts, member list, and RSS feed are visible
only to its members** - not to other logged-in users, and never to
anonymous visitors. This is enforced consistently everywhere a post
could otherwise surface: the community page, direct post links, the
dashboard feed (all modes and tabs), search, profile pages, the public
`/api/v1/posts` API, and every RSS feed. Interacting with a post you
can't see (liking, commenting, reacting, replying, quoting, sharing,
voting, reporting) is blocked the same way. This is covered by unit
tests (`test/can-access-post.test.js`, `test/community-privacy.test.js`)
and an end-to-end regression test
(`test/e2e/private-community-privacy.test.js`) that proves the leak
paths are closed while confirming actual members still see everything
normally.

## Moderation and safety

- **Reports** on posts, optionally with an evidence screenshot (2MB
  limit), reviewed by moderators/admins.
- **Warnings**, **temporary posting restrictions** (a moderator-imposed,
  time-limited block on creating new posts/comments - distinct from a
  full suspension and from the separate personal "muted users"
  preference), and **suspensions** (blocks login entirely, with its own
  field so it can't be accidentally shortened by unrelated failed-login
  lockout logic).
- **Appeals**: a suspended user (who can't log in to reach Settings)
  appeals from a public page linked off the login screen; a
  restricted/warned user appeals from Settings > Moderation. Admins
  review appeals in a dedicated tab; approving automatically lifts the
  underlying action.
- **Spam detection**: blocks posting the exact same text twice within
  ten minutes.
- **Registration CAPTCHA**: a lightweight built-in arithmetic challenge
  (not a managed service - see `DEPLOYMENT.md`/`todo.txt` for the
  trade-off) to deter naive scripted signups.
- **Account history**: every security-relevant self-event (logins,
  password/2FA changes, suspensions and restrictions applied or lifted,
  warnings, appeals) is logged to a per-user timeline in Settings >
  History.
- Admins have a full console at `/admin` (users, communities, posts,
  reports, appeals, audit log, site settings); moderators have a lighter
  review surface at `/moderator`.

## Social interactions, messaging, and notifications

Likes, bookmarks, nested/threaded comments, reactions, share counts,
hashtags, and follows/blocks are all standard. `/search?q=` searches
people, communities, hashtags, and post text, saves recent searches per
user (clearable in Settings), and respects private-community visibility.
Direct messages (`/messages`) and group chat (`/groups`, up to 20
members) both notify the recipient(s) in-app and via push when a message
arrives, gated by the same per-user notification preferences as likes/
comments/follows/security alerts.

**Browser push notifications** are opt-in per device (nothing is sent
until a user explicitly enables it in Settings > Notifications) and
degrade to a no-op if `VAPID_*` isn't configured. **Security emails**
(new sign-in, password changed, 2FA enabled/disabled, recovery codes
regenerated, suspension/restriction outcomes) are sent through the same
Gmail/Google Cloud setup as verification codes, and are never allowed to
block or hang the action that triggered them - a mail-provider hiccup
degrades to "the email didn't send," never to "login doesn't work."

## Auth and account security

Email verification (six-digit code), password reset, five-attempt login
lockouts (separate from suspensions, see above), 75-day device/session
records, and TOTP two-factor authentication with eight downloadable
one-time recovery codes are all built in. Every auth handler - login,
register, verify, forgot/reset password, 2FA - has its own error
handling, so a database or mail hiccup shows an error message instead of
hanging the request indefinitely.

## Extended media storage (multi-cluster MongoDB)

Uploaded post media, generated image thumbnails, and profile pictures
are stored in MongoDB GridFS and served through `/media/:cluster/:id`.
By default everything lives on the primary `MONGODB_URI` cluster
("cluster 0") - no extra setup required.

To scale storage horizontally, add any number of extra MongoDB clusters
as `MONGO_DB_URL_0`, `MONGO_DB_URL_1`, `MONGO_DB_URL_2`, ... in `.env`.
Every configured cluster gets its own GridFS bucket, and uploads
distribute across all of them round-robin
(`src/services/storageCluster.js`). `GET /media/status` (authenticated)
reports which clusters are currently connected.

Set `GCS_PROJECT_ID`, `GCS_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`, and
optionally `MEDIA_CDN_URL` to enable `/media/signed-upload` for
direct-to-cloud uploads via Google Cloud Storage, as an alternative or
addition to GridFS. The endpoint returns a V4 signed upload URL that
expires after 15 minutes.

If `CLAMAV_HOST`/`CLAMAV_PORT` or `CLAMAV_SOCKET` is set, every upload
(post media, profile pictures, community banners, report evidence) is
scanned through a ClamAV daemon before it's accepted - see
`DEPLOYMENT.md` for setup and the fail-open trade-off.

## Testing

- `npm test` - the DB-free unit suite (permission logic, upload
  validation, mailer/alerting resilience, link previews, spam detection,
  CAPTCHA, the private-community access gate, and more). No setup beyond
  `npm install`.
- `npm run test:e2e` - full route-level and end-to-end tests (signup
  through posting, admin permissions, the suspension-bypass regression,
  the full appeal lifecycle, the private-community privacy regression)
  against a real MongoDB - either a `MONGODB_URI` you provide, or an
  auto-downloaded in-memory instance via `mongodb-memory-server`.
- CI runs both automatically on every push/PR - see
  `.github/workflows/ci.yml` and `DEPLOYMENT.md`.

## Routes

- `/` landing page
- `/auth/register`, `/auth/login`, `/auth/verify`,
  `/auth/forgot-password`, `/auth/reset?token=...`, `/auth/appeal`
  (public suspension-appeal form), `/auth/2fa`
- `/dashboard` (`/dashboard/feed/more` powers lazy-loaded scrolling)
- `/explore` discovery hub
- `/communities/:slug` community detail (members-only content if
  private); `/communities/:id/manage` owner/moderator controls;
  `/communities/:slug/rss.xml`
- `/u/:id` public profile; `/u/:id/followers`, `/u/:id/following`;
  `/u/:id/rss.xml`
- `/search?q=`
- `/posts/:id` post detail with nested threaded comments
- `/messages`, `/messages/:id`; `/groups`, `/groups/:id`
- `/notifications`
- `/settings/:section` - `profile`, `security` (including
  `/settings/security/2fa`, `/settings/security/2fa/recovery-codes`),
  `privacy`, `notifications`, `moderation` (only shown if relevant),
  `history`, `account`
- `/admin` (admin console), `/moderator` (moderator review)
- `/rss.xml`; `/api/v1/posts` (see `API.md`)
- `/guide` tips for growing a profile, a community, and staying secure
- `/premium`
- `/about`, `/about/developer`, `/privacy`, `/terms`,
  `/community-guidelines`, `/accessibility`, `/contact`

## Operations

CI, staging, backups/restore verification, upload virus scanning, and
error alerting are covered in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Public API

`/api/v1/posts` and the RSS feeds are documented in [`API.md`](./API.md).

## Project status

`todo.txt` is the running log of what's been built, what's been audited
and fixed, and what's known to still be missing or unverified - it's
worth reading before assuming a feature works exactly as described here,
since `todo.txt`'s Known Gaps section tracks exactly what hasn't been
proven against real infrastructure or a real browser yet.
