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
