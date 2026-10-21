# Operations guide

This covers the pieces of running Crowdwide that aren't part of the app
itself: continuous integration, a staging environment, backups, upload
virus scanning, and error alerting.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

- **`unit-tests`** runs `npm test` - the DB-free suite (permission logic,
  upload validation, mailer resilience, link previews, spam detection,
  etc.). No services, no setup beyond `npm ci`.
- **`e2e-tests`** runs `npm run test:e2e` against a real `mongo:7` service
  container GitHub Actions spins up for the job. Because `MONGODB_URI` is
  already set to that container, `test/e2e/helpers.js` connects to it
  directly instead of trying to download a MongoDB binary via
  `mongodb-memory-server` - so, unlike this sandbox, CI should never hit
  that network restriction.

If you rename the default branch or add a `develop` branch you build
against, update the `branches:` lists in the workflow.

## Staging

Staging is a second deployed instance of the same app with its own
environment variables, kept separate from production. Set `APP_ENV=staging`
on that instance and the app switches to safe staging behaviour on its own:

- Every response carries `X-Robots-Tag: noindex, nofollow` and
  `/robots.txt` disallows everything, so the staging copy never shows up in
  search results.
- A visible "Staging environment" banner is shown on every page, so nobody
  mistakes it for the live site.
- Outbound email is restricted to `STAGING_MAIL_ALLOWLIST` - a
  comma-separated list of addresses and/or `@domain` entries (for example
  `qa@yourteam.com,@yourcompany.com`). Anything else is logged and skipped,
  so a staging copy can never email real users. With no allowlist set, no
  email is sent at all.
- The free-tier keep-alive ping stays off unless you set
  `KEEP_ALIVE_ENABLED=true`.

Setup:

1. Deploy a second instance from the same repo/branch (e.g. a second Render
   service).
2. Give it its own `MONGODB_URI` pointing at a separate database. Never
   point staging at the production database.
3. Give it its own `SESSION_SECRET`, and its own `VAPID_*` keys and
   `ADMIN_ALERT_EMAIL` if you use them, so staging traffic doesn't notify
   production users or whoever is on call.
4. Set `APP_ENV=staging` and, optionally, `STAGING_MAIL_ALLOWLIST`.

Production needs no extra setting: leave `APP_ENV` unset (or set it to
`production`) and none of the above applies.

## Meilisearch

Crowdwide can use a self-hosted [Meilisearch](https://www.meilisearch.com/)
instance to make post search typo-tolerant and relevance-ranked. Run
Meilisearch as a separate private service; do not expose its admin key or
unauthenticated API publicly. Set `MEILISEARCH_URL` to its internal base URL
and `MEILISEARCH_API_KEY` to a key that can create/read the index, update its
settings, search, add/delete documents, and read task status. The index
contains published post text, including private-community posts, so keep the
service private and trusted. Crowdwide loads result content from MongoDB and
rechecks membership, visibility and selected filters before rendering.
The app creates/configures the `posts` index and indexes existing published
posts after MongoDB connects. New, edited, published and deleted posts are
kept in sync.

If the service is not configured or becomes unavailable, search falls back
to the built-in MongoDB search. Search indexing failures are logged and do
not prevent posting or editing.

## Backups

`npm run backup` wraps `mongodump` to produce a timestamped, gzipped
archive in `./backups` (override with `BACKUP_DIR`), and deletes archives
older than `BACKUP_RETENTION_DAYS` (default 14). It requires the
[MongoDB Database Tools](https://www.mongodb.com/docs/database-tools/)
to be installed wherever it runs - they're a separate download from the
`mongodb`/`mongoose` npm packages.

Schedule it however your host supports scheduled jobs - a daily cron
entry is the simplest:

```
0 3 * * * cd /path/to/crowdwide && npm run backup >> /var/log/crowdwide-backup.log 2>&1
```

**A backup you've never restored is a backup you don't actually have.**
`npm run backup:verify -- ./backups/crowdwide-2026-09-15T03-00-00-000Z.archive.gz`
restores that archive into a throwaway scratch database (never touching
the real one), checks it has a `users` collection and a few others with
a plausible document count, then drops the scratch database. Wire this
into a weekly scheduled job too, and alert if it ever exits non-zero -
mongodump succeeding is not the same guarantee as the archive actually
being restorable.

## Resetting Waves balances

To reset every user's Waves balance, earned total and spent total, and clear
the Waves transaction ledger, first back up the database and stop the app so
transactions cannot be added during the reset. Then, with `MONGODB_URI`
pointing to the intended database, run:

```
npm run reset:waves -- --confirm-reset-waves
```

The confirmation flag is required. The reset runs in a MongoDB transaction;
the database must support transactions (for example, a replica set). If the
transaction fails, no partial reset is committed. This does not change
campaign/community records, reward settings, or account restrictions.

## Upload virus scanning

Uploads (post media, profile pictures, community banners, report
evidence) are scanned through a [ClamAV](https://www.clamav.net/) daemon
if one is configured - `src/services/virusScan.js` speaks clamd's
`INSTREAM` protocol directly, no paid API required. ClamAV is free
software, but the daemon needs a separate host with enough memory and disk
for signature updates. Render's Node build shell does not provide a Docker
daemon; do not put `docker run` in the app's build or start command. Run
ClamAV on a separate host/service reachable over a private network.
clamd's TCP protocol has no authentication, so never expose port 3310
publicly.

Set `CLAMAV_HOST` to the private hostname and `CLAMAV_PORT` (default
`3310`), or set `CLAMAV_SOCKET` when the app and daemon share a host.
Set `CLAMAV_REQUIRED=true` to reject uploads if scanning is not configured.
When scanning is configured, an outage blocks uploads by default;
`CLAMAV_FAIL_OPEN=true` explicitly opts into allowing unscanned uploads.
For production, keep fail-open disabled and required scanning enabled.

When available, confirm the daemon with the standard, harmless
[EICAR test file](https://www.eicar.org/download-anti-malware-testfile/)
- the protocol implementation is unit-tested against a mocked socket in
`test/virus-scan.test.js`.

## Translation

Translation works out of the box, free, with no key or extra service: it uses
free public endpoints (Google's web-translate endpoint, then MyMemory as a
backup). Those are unofficial/rate-limited, so for heavy traffic add the
optional providers below. Set `TRANSLATE_FREE_FALLBACK=off` to disable the built-in ones.

Posts and comments have a "Translate" button, backed by
`src/services/translate.js`. With no provider configured it just tells
the viewer translation isn't available - nothing else breaks. Two
providers are supported:

- **[LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)
  (free, self-hosted)** - open-source, no API key, no per-character
  billing. It still needs compute and memory, so run it as a separate
  service; do not launch it from the app's Render build/start command.
  Set `LIBRETRANSLATE_URL` to the LibreTranslate service's reachable base
  URL, not Crowdwide's `APP_URL` or public website URL; the app appends
  `/translate`. For services on Render, use the LibreTranslate service's
  private hostname and port when private networking is available.
  Configure `LIBRETRANSLATE_API_KEY` if the instance requires one. Avoid an
  unauthenticated public endpoint, which can be abused for resource
  exhaustion.

- **Google Cloud Translation API v2 (paid)** - set
  `GOOGLE_TRANSLATE_API_KEY` if you'd rather use Google's engine. Billed
  per character by Google; not free.

When both are set, LibreTranslate is tried first and Google is used if
LibreTranslate fails. Google is billed per character. See
`test/translate.test.js` for the provider logic and `.env.example` for
the exact variable names.

## Google and GitHub sign-in

Members can sign in or create an account with "Continue with Google" or
"Continue with GitHub". Each button only appears when its two variables are
set, so you can enable one, both, or neither. `APP_URL` must be your real
public address (for example `https://www.crowdwide.run.place`) because the
callback URLs are built from it.

| Variable | Where it comes from |
| --- | --- |
| `GOOGLE_AUTH_CLIENT_ID`, `GOOGLE_AUTH_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com/) > APIs & Services > Credentials > Create credentials > OAuth client ID > "Web application". Add `{APP_URL}/auth/google/callback` under Authorized redirect URIs. First configure the OAuth consent screen (app name, support email; scopes `openid`, `email`, `profile`) and click Publish app so people outside your test list can sign in. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | [github.com/settings/developers](https://github.com/settings/developers) > OAuth Apps > New OAuth App. Homepage URL: `{APP_URL}`. Authorization callback URL: `{APP_URL}/auth/github/callback`. After creating it, copy the Client ID and click "Generate a new client secret". |

How it behaves:

- Only an email the provider has verified is trusted. A GitHub account with no
  verified email cannot be used.
- If the verified email already belongs to a Crowdwide account, that account
  is signed in and the provider is linked to it (the owner is emailed a
  security alert). Two-factor authentication, suspensions and `ADMIN_EMAIL`
  all still apply.
- If a password sign-up with that email was never verified, the unverified
  password is discarded when the real owner signs in with a provider.
- Brand-new people confirm their name and accept the Terms before the account
  is created. Accounts made this way have no password until the member uses
  "Forgot password" to set one.
- Only the provider's account id, the verified email and the display name are
  stored. No access tokens are kept and no profile picture is copied.

To test locally, register `http://localhost:3000/auth/google/callback` and
`http://localhost:3000/auth/github/callback` (a second OAuth App for GitHub,
since each one has a single callback URL) and set `APP_URL=http://localhost:3000`.

## Weekly newsletter timing

The newsletter goes out every Sunday at 10:30 on each member's own clock. The
browser reports its time zone (saved as `timezone` on the user); members who
have not reported one yet use `NEWSLETTER_TIMEZONE` (default `Asia/Kolkata`).
Your server's own clock does not matter, so there is no need to set `TZ`.

- The worker checks every 15 minutes and also once a minute after each start,
  so if the host was asleep at 10:30 the email still goes out later that Sunday
  (until 22:30 local).
- A member gets at most one per six days, and none if there is nothing new to
  recommend (the run is logged as "skipped").
- To send a missed one by hand: `npm run newsletter:send`.

## Come-back reminders

Members who go quiet get up to three gentle reminders, then nothing until they
have visited again:

| After | Reminder |
| --- | --- |
| 24 hours | A community question to answer (or today's Question of the Day if none is open) |
| 3 days | A discussion that is genuinely active, plus what is new on Crowdwide |
| 7 days | A last "what you missed" note: replies, likes, followers, top posts |

Each goes by email, as a web push if the member enabled push, and as a
notification waiting in the app. Rules built in: only during the member's local
daytime (10:00-21:00), at most one every 40 hours, never to suspended members,
a one-click unsubscribe link plus `List-Unsubscribe` headers, and a "Come-back
reminders" switch in Settings > Notifications. Nothing is sent when there is
nothing worth saying.

- `REENGAGEMENT_ENABLED=off` turns it off from the environment; admins can also
  untick it in Admin > Site settings (which also shows how many reminders
  brought members back).
- `REENGAGEMENT_DAILY_LIMIT` (default 150) caps reminders per rolling 24 hours,
  to stay inside your mail provider's daily limit.
- On first start, existing members get a starting "last active" time from their
  newest sign-in session (or "now" if they have none), so nobody receives a
  surprise burst the day this ships.
- Check without sending: `npm run reminders:run -- --dry`. Send what is due
  right now: `npm run reminders:run` (add `--anytime` to ignore the daytime rule).
- The public page `/question` shows today's Question of the Day and its
  answers (answers are normal public posts tagged `#qotd`).

## Welcome series, first-reply email, streaks, badges and the weekly top page

- **First-reply email**: the first time anyone replies to a member's post, that
  member (if their account is under 30 days old) gets one email with the reply
  and a button to answer. Sent once per member; everyone also gets the
  "Conversation starter" badge.
- **Welcome series**: four short emails in the first week (about 2 hours, day 2,
  day 4 and day 6 after sign-up), only during the member's local daytime. They
  adapt to what the member has done: steps already done are marked, "say hello"
  is skipped if they have posted, "communities for you" is skipped if they have
  joined three or more. Members in their first week are not sent come-back
  reminders. Admins can switch the series off in Admin > Site settings; members
  can switch off "Welcome emails and tips" in Settings > Notifications. Each email
  has its own one-click unsubscribe (`/unsubscribe/welcome/...`).
- **Streaks and badges**: a streak is consecutive days with a post or comment on
  the member's own clock. Ten badges (first post, first comment, conversation
  starter, question answerer, 3/7/30-day streaks, 10/50 posts, 25 comments) are
  awarded automatically, announced with a notification and shown on the profile
  (the owner also sees what is still to earn). Members with push enabled and a
  streak of 3+ days get one "save your streak" push on the evening it is at risk.
- **Weekly top page**: `/top` is a public, shareable page (with Open Graph tags,
  copy/WhatsApp/X/LinkedIn share buttons and a sitemap entry) with the week's top
  posts, most-discussed posts, articles, creators and communities. It only uses
  content that is already public and is cached for 10 minutes.
- All welcome, first-reply and reminder emails share the daily cap
  `REENGAGEMENT_DAILY_LIMIT` and the `REENGAGEMENT_ENABLED=off` switch.
- Check without sending: the welcome series runs from the same 30-minute worker
  as the streak savers; there is no new environment variable to set.

## Advertising, private profiles, live moderation and WideWaves

**Advertiser dashboard.** Every ad now has its own *brand name* and *logo*, so a new ad no longer
shows the previous ad's name. Approved advertisers can edit their business profile (website,
description, logo, banner) from the dashboard (`POST /advertising/profile`).

**Keep-alive pauses while people are on the site.** Real page visits are tracked in memory;
while someone has been seen within `KEEP_ALIVE_PRESENCE_SECONDS` (default 120, `0` turns this off)
the keep-alive tick is skipped, and it resumes once everyone has left. Health checks and the
keep-alive's own pings never count as visitors.

**Private profiles.** "Private (approve followers)" in Settings now really hides a profile. Everyone
still sees name, picture, bio and the post, follower and following *counts*. Posts, activity, likes,
comments, communities, badges and the follower/following lists are for approved followers, the owner
and staff only. Following a private profile sends a request (`/follow-requests`, Notification type
`follow_request`); private authors are also filtered out of feeds, search, public lists, the open API,
RSS and the sitemap.

**Survey Waves.** Signed-in members earn Waves for completing a survey (once per survey round). The
range is `Survey participation reward` in Admin -> Settings (default 2-5) and respects the daily
earning limit. Answers stay anonymous: the ledger only records that the member took part.

**Live moderation.** Review buttons in the moderator console and the community "Posts awaiting
review" list submit in the background (`public/js/live-review.js`), remove the card at once and show
a toast. The community queue also polls `/communities/:id/review-queue` every 15 s so posts another
moderator handled disappear and new ones are announced. Without JavaScript the forms still work.

**Panel password for Google/GitHub staff.** Admins and moderators who have no password see a blocking
prompt on every page until they set one (`POST /account/panel-password`). It becomes their account
password and therefore their panel password.

**Ad algorithm and community ads.** Ads are scored by relevance (keywords and the community's topic),
smoothed click-through rate, budget pacing (total, daily cap, days left) and freshness, with a
fatigue penalty for ads the viewer just saw, one ad per advertiser and weighted-random selection
(`src/services/adRanker.js`). New *smart placement* campaigns (with optional keywords) show in any
public community: monetized communities with ads on earn their revenue share; other public
communities show them every 4th post with no share. Communities that opted out and private
communities never show ads.

**Community page and feed fixes.** The public community page shows full formatted post cards with
like, comment and share. Avatars in infinite-scroll feed pages, comments and chat now load. "Reply
with a post" notifies the original author (type `post_reply`) and opens the reply.

### WideWaves

Open topic spaces written `ww/name`. Anyone can read them, post to them and engage like with normal
posts, no joining or following.

- **Names** are unique, lowercase, 3-30 letters/numbers/underscores. Reserved words are blocked.
- **Posting:** the composer has a *WideWave* button (popup with trending WideWaves and search). A post
  goes to a community *or* a WideWave. Pages: `/widewaves` (For you, Top posts, Newest, search),
  `/ww/:name`, `/widewaves/leaderboard` (week, month, year, all time), `/widewaves/new`.
- **Creators** may only edit the description and hashtags, or delete the WideWave. Deleting keeps all
  posts as normal posts. Limits: 3 creations a day, 15 active per member.
- **Moderation** is only by official moderators/admins (moderator console -> WideWaves tab): remove a
  WideWave (posts become normal posts, the name stays blocked) or move a single post out of one.
- **Recommendations** use the member's interest profile plus the WideWaves they post in or like.
  Trending = posts in the last 7 days (weighted with likes and comments).
- **Emails:** the weekly newsletter (personalised), come-back reminders and welcome emails include a
  short "WideWaves worth a look" block.
- **Admin switch:** Admin -> Settings -> "Enable WideWaves".

Scheduled or draft posts attached to a WideWave are counted once published; `postsCount` is a cache
used for ordering search results, while trending and leaderboards are computed live.

## Render commands

For the Crowdwide app service, select the Node runtime and use:

- **Build Command:** `npm ci`
- **Start Command:** `npm start`

Remove any `docker run ...` command from Render's Build Command. Build
commands prepare the app; they are not a place to start long-running
sidecar daemons. Configure ClamAV and LibreTranslate as separate services
on hosts/network plans that support them, then add their connection
details as Render environment variables. Use private networking for
ClamAV; if your Render plan cannot privately reach a scanner, host the
app and scanner on a network that can. The software is free, but reliable
production hosting for these resource-heavy services may not be.

## Error alerting

Set `ADMIN_ALERT_EMAIL` and unhandled 5xx errors (anything that reaches
the global error handler in `src/app.js`) email that address, rate-limited
to one email per distinct error message + route per 15 minutes so a
recurring failure doesn't flood an inbox. This is a baseline safety net,
not a replacement for a real error-tracking service (Sentry, Datadog,
etc.) if you need searchable history, trend dashboards, or paging
integrations beyond email.

All structured log output (see `src/services/logger.js`) is JSON lines on
stdout (`info`) or stderr (`warn`/`error`), which most log aggregators
(CloudWatch, Render's own log viewer, Datadog, etc.) can parse without
extra configuration.

## Crowdwide | WideWave layout and the bot guard

**Two spaces.** The top bar has a Crowdwide | WideWave switch, and phones get a WideWave tab in the bottom bar (Communities moved into the menu there). WideWave pages (`/widewaves`, `/ww/name`) use a Threads-style single column with a quick composer; the Crowdwide home shows a "Trending in WideWave" strip of topic bubbles. Posting from a WideWave page sends people back to that page.

**Bot guard** (`src/middleware/botGuard.js`). An IP is blocked for 24 hours (`BOT_BLOCK_HOURS`) when it floods requests, hits scanner paths such as `/.env` or `/wp-login.php` twice, uses a known scanner User-Agent, keeps going after rate-limit replies, floods 404s, or floods unsigned-in form posts. Signed-in users and search crawlers get higher limits. Private/loopback addresses, `/health` and `/media/` are never counted, and `BOT_GUARD_ALLOWLIST` (comma separated) exempts addresses. Blocks are stored in the `blockedips` collection and expire on their own, so a restart does not free a bot. Admins can review and unblock at `/admin/blocked-ips`. Set `BOT_GUARD=off` to disable.

Make sure `TRUST_PROXY_HOPS` matches your host (1 on Render). If it is wrong, every visitor looks like the proxy address; the guard never blocks private proxy addresses, but it cannot tell your visitors apart either.
