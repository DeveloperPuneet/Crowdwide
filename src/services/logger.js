// A dependency-free structured logger. Each call writes one JSON line to
// stdout/stderr - the standard format almost every log aggregator (CloudWatch,
// Datadog, Render's own log viewer, etc.) can parse without extra config,
// which plain console.log("some string", error) cannot reliably give you:
// multi-line stack traces and unstructured text get mangled or split across
// log lines in most aggregators.
//
// This does NOT replace a real APM/error-tracking service (Sentry, Datadog,
// etc.) for a production deployment that needs searchable history, alerting
// integrations (PagerDuty, Slack), or trend dashboards - see Known Gaps in
// todo.txt. What it does give you: consistent, greppable, machine-parseable
// log output today, with no new dependency or account to set up.

function baseLine(level, message, meta) {
  const line = { level, message, time: new Date().toISOString() };
  if (meta && Object.keys(meta).length) line.meta = meta;
  return line;
}

function normalizeMeta(meta) {
  if (!meta) return {};
  if (meta instanceof Error) return { error: meta.message, stack: meta.stack };
  if (typeof meta === 'object') {
    const normalized = { ...meta };
    if (normalized.error instanceof Error) {
      normalized.error = normalized.error.message;
      normalized.stack = meta.error.stack;
    }
    return normalized;
  }
  return { detail: String(meta) };
}

function info(message, meta) {
  process.stdout.write(`${JSON.stringify(baseLine('info', message, normalizeMeta(meta)))}\n`);
}

function warn(message, meta) {
  process.stderr.write(`${JSON.stringify(baseLine('warn', message, normalizeMeta(meta)))}\n`);
}

function error(message, meta) {
  process.stderr.write(`${JSON.stringify(baseLine('error', message, normalizeMeta(meta)))}\n`);
}

module.exports = { info, warn, error };
