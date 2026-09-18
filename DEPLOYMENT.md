# Operations guide

This covers the pieces of running Crowdwide that aren't part of the app
itself: continuous integration, a staging environment, backups, upload
virus scanning, and error alerting. None of this was exercised against
live infrastructure while building it (this development environment has
no internet access beyond a small allowlist of package registries, no
Docker, and no MongoDB server reachable from outside the sandbox) - treat
everything below as correct-by-review, not confirmed-by-running, until
you've tried it yourself. See `todo.txt`'s Known Gaps for specifics.

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

There's no staging-specific code - "staging" here means a second deployed
instance with its own environment variables, kept separate from
production:

1. Deploy a second instance of the same app (e.g. a second Render service,
   or a second app on whatever host you use) from the same repo/branch.
2. Give it its own `MONGODB_URI` pointing at a separate database (never
   point staging at the production database - a bug in a staging-only
   test could delete real user data).
3. Give it its own `SESSION_SECRET`, and if you use them, its own
   `VAPID_*` keys and `ADMIN_ALERT_EMAIL` (you don't want staging traffic
   paging whoever's on call for production).
4. Optionally set `NODE_ENV=staging` if you want to branch behavior on it
   later (nothing currently does; `NODE_ENV=production` and
   `NODE_ENV=test` are the two values the app currently checks for).

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
`INSTREAM` protocol directly, no paid API required. Set either:

- `CLAMAV_HOST` + `CLAMAV_PORT` (defaults to `3310`) for a TCP-reachable
  clamd, or
- `CLAMAV_SOCKET` for a Unix socket path (takes priority if both are set).

Leave both unset and scanning is skipped entirely - uploads work exactly
as before. If scanning is configured but the scan itself fails (clamd is
down, times out, etc.), the upload is **allowed through** rather than
blocked - a scanner outage degrades to "not scanned," not "nobody can
upload anything." If you'd rather fail closed, that's a one-line change
in `scanUploadsForViruses` in `src/middleware/uploads.js` (the catch
block that currently calls `next()` on scan failure).

Test it against a real clamd with the standard, harmless
[EICAR test file](https://www.eicar.org/download-anti-malware-testfile/)
before relying on it - the protocol implementation is unit-tested against
a mocked socket in `test/virus-scan.test.js`, but that's not the same as
having scanned a real infected (test) file through a real daemon.

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
