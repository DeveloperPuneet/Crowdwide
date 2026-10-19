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
