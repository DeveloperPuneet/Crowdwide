// Stops NoSQL operator injection. Express parses JSON bodies and `a[b]=c`
// query strings into objects, so a request like {"token": {"$gt": ""}} would
// reach a MongoDB query as an operator and match any document. Keys that start
// with "$" or contain "." are removed from body, query and params before any
// route sees them.
const unsafeKey = (key) => key.startsWith('$') || key.includes('.');

function clean(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) { value.forEach((item) => clean(item, depth + 1)); return value; }
  for (const key of Object.keys(value)) {
    if (unsafeKey(key)) delete value[key];
    else clean(value[key], depth + 1);
  }
  return value;
}

function sanitizeInput(req, res, next) {
  clean(req.body);
  clean(req.query);
  clean(req.params);
  next();
}

module.exports = { sanitizeInput, clean };
