// Express 4 does not catch rejected promises from async route handlers, so a
// thrown error (e.g. a database hiccup) left the request hanging forever with
// no response - only the global unhandledRejection logger noticed. Patching
// Layer#handle_request once forwards those rejections to the normal error
// middleware, so users get an error page instead of an endless spinner.
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncErrorsPatched) {
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const handler = this.handle;
    if (handler.length > 3) return next();
    try {
      const result = handler(req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (error) {
      next(error);
    }
  };
  Layer.prototype.__asyncErrorsPatched = original;
}
