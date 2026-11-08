require('./utils/asyncErrors');
const express = require('express');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const morgan = require('morgan');
const helmet = require('helmet');
const connectMongo = require('connect-mongo');
const webRoutes = require('./routes/web');
const authRoutes = require('./routes/auth');
const { csrfProtection, generateToken } = require('./middleware/security');
const { renderMentions, renderRichBody, renderInlineText } = require('./services/mentions');
const { plainText, preview } = require('./utils/textPreview');
const { icon } = require('./utils/icons');
const { gifsEnabled } = require('./services/gif');
const logger = require('./services/logger');
const { presenceMiddleware } = require('./services/keepAlive');
const botGuard = require('./middleware/botGuard');
const { sanitizeInput } = require('./middleware/sanitize');
const { sessionSecret } = require('./utils/secrets');
const { badgeMedal } = require('./utils/badges');
const { stagingMiddleware } = require('./services/environment');
const { alertOnCriticalError } = require('./services/alerting');
const User = require('./models/User');
const { getVisiblePartners } = require('./services/partnerships');
const assets = require('./services/assets');

function createApp({ port = process.env.PORT || 3000 } = {}) {
  const app = express();
  const sessionDurationMs = 1000 * 60 * 60 * 24 * 75;
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.NODE_ENV === 'production' ? 1 : 0));

  // Render places one trusted reverse proxy in front of the application.
  app.set('trust proxy', trustProxyHops);
  // A blocked address (see middleware/botGuard.js) gets a 403 before anything else runs.
  app.use(botGuard.gate);
  // gzip/brotli for HTML, CSS, JS and JSON (media is already compressed and is skipped automatically).
  app.use(compression());

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  // Strip MongoDB operator keys ($gt, a.b ...) from everything a visitor can send.
  app.use(sanitizeInput);
  // Profile pictures, banners, and post media can live on a configured CDN
  // or Google Cloud Storage bucket instead of being served from this app
  // ('self') - without allowing that origin here, the browser's CSP silently
  // blocks every one of those images (they just never appear, no console
  // hint to an end user) even though the <img> tag and URL are both correct.
  const mediaOrigins = new Set();
  if (process.env.MEDIA_CDN_URL) {
    try { mediaOrigins.add(new URL(process.env.MEDIA_CDN_URL).origin); } catch (error) { /* invalid URL - ignore */ }
  }
  if (process.env.GCS_BUCKET) mediaOrigins.add('https://storage.googleapis.com');
  // Cloudflare Turnstile (optional managed CAPTCHA) needs its script, iframe
  // and verification origin allowed - only when it is actually configured.
  const turnstileOrigins = process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY ? ['https://challenges.cloudflare.com'] : [];
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://www.googletagmanager.com', (req, res) => `'nonce-${res.locals.cspNonce}'`, ...turnstileOrigins],
        frameSrc: ["'self'", ...turnstileOrigins],
        connectSrc: ["'self'", 'https://api.maptiler.com', 'https://www.google-analytics.com', 'https://analytics.google.com', ...turnstileOrigins],
        mediaSrc: ["'self'", ...mediaOrigins],
        // GIFs come from GIPHY's CDN; blob: lets upload previews render.
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.giphy.com', 'https://tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com', 'https://api.maptiler.com', 'https://www.google-analytics.com', ...mediaOrigins]
      }
    }
  }));
  // The browser features this site does not use are switched off for it (and for anything embedded in it).
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self), interest-cohort=()');
    next();
  });
  app.use(stagingMiddleware);
  app.use((req, res, next) => {
    if (req.path === '/community-map' || /^\/communities\/[^/]+\/manage$/.test(req.path)) {
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    next();
  });
  app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
  app.use('/vendor/prism', express.static(path.join(__dirname, '..', 'node_modules', 'prismjs')));
  app.use(assets.serveBundle);
  app.use(assets.cacheHeaders);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Real visits pause the keep-alive ping (see services/keepAlive.js).
  app.use(presenceMiddleware);
  // Pages and JSON are personal and change constantly: never let a browser or a
  // shared cache show a stale copy (or another visitor's copy) of them. "no-cache"
  // still allows the back/forward cache, so Back stays instant.
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/media/')) {
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
      res.vary('Cookie');
    }
    next();
  });
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
  const sessionStore = process.env.MONGODB_URI ? connectMongo.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: Math.floor(sessionDurationMs / 1000),
    // Without this every page view rewrote the session document; now it is refreshed at most once a day.
    touchAfter: 24 * 60 * 60
  }) : undefined;
  app.locals.sessionStore = sessionStore;
  app.use(session({
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    // 'auto' = Secure whenever the visit is over HTTPS (also behind the host's proxy); COOKIE_SECURE=off only for odd local setups.
    cookie: { maxAge: sessionDurationMs, httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'off' ? false : 'auto' }
  }));
  // Counts requests per address and blocks floods, scanners and rate-limit abuse for 24 hours.
  app.use(botGuard.track);
  app.use(csrfProtection);

  app.use(async (req, res, next) => {
    try {
      const sessionUser = req.session.user || null;
      let currentUser = sessionUser;
      if (sessionUser?.id) {
        const wallet = await User.findById(sessionUser.id).select('wavesBalance username adFreeUntil timezone role passwordSet').lean();
        currentUser = { ...sessionUser, wavesBalance: Number(wallet?.wavesBalance || 0), username: wallet?.username || '', adFreeUntil: wallet?.adFreeUntil || null, timezone: wallet?.timezone || '', role: wallet?.role || sessionUser.role, needsPanelPassword: ['admin', 'moderator'].includes(wallet?.role) && wallet?.passwordSet === false };
      }
      res.locals.currentUser = currentUser;
      res.locals.flash = req.session.flash || null;
      res.locals.csrfToken = generateToken(req);
      res.locals.appUrl = process.env.APP_URL || `http://localhost:${port}`;
      res.locals.renderMentions = renderMentions;
      res.locals.renderInlineText = renderInlineText;
      res.locals.plainText = plainText;
      res.locals.preview = preview;
      res.locals.renderRichBody = renderRichBody;
      res.locals.icon = icon;
      res.locals.badgeMedal = badgeMedal;
      res.locals.asset = assets.asset;
      res.locals.cssBundles = assets.cssBundleUrls();
      res.locals.gifsEnabled = gifsEnabled();
      // Approved partners for the footer / landing strips (cached for a minute; never throws).
      res.locals.partners = req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/media/') ? await getVisiblePartners() : [];
      delete req.session.flash;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use('/', webRoutes);
  app.use('/auth', authRoutes);
  app.use((req, res) => res.status(404).render('pages/not-found', { title: 'Page not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    logger.error('Unhandled request error', { error, route: req.path, status });
    if (status >= 500) alertOnCriticalError(error, { route: req.path }).catch(() => {});
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: status === 500 ? 'Internal server error.' : error.message });
    return res.status(status).render('pages/not-found', { title: status === 404 ? 'Page not found' : 'Crowdwide is having trouble' });
  });

  return app;
}

module.exports = createApp;
