require('./utils/asyncErrors');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const morgan = require('morgan');
const helmet = require('helmet');
const connectMongo = require('connect-mongo');
const webRoutes = require('./routes/web');
const authRoutes = require('./routes/auth');
const { csrfProtection, generateToken } = require('./middleware/security');
const { renderMentions, renderRichBody } = require('./services/mentions');
const { icon } = require('./utils/icons');
const { gifsEnabled } = require('./services/gif');
const logger = require('./services/logger');
const { stagingMiddleware } = require('./services/environment');
const { alertOnCriticalError } = require('./services/alerting');
const User = require('./models/User');

function createApp({ port = process.env.PORT || 3000 } = {}) {
  const app = express();
  const sessionDurationMs = 1000 * 60 * 60 * 24 * 75;
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.NODE_ENV === 'production' ? 1 : 0));

  // Render places one trusted reverse proxy in front of the application.
  app.set('trust proxy', trustProxyHops);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
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
  app.use(stagingMiddleware);
  app.use((req, res, next) => {
    if (req.path === '/community-map' || /^\/communities\/[^/]+\/manage$/.test(req.path)) {
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    next();
  });
  app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
  app.use('/vendor/prism', express.static(path.join(__dirname, '..', 'node_modules', 'prismjs')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
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
    ttl: Math.floor(sessionDurationMs / 1000)
  }) : undefined;
  app.locals.sessionStore = sessionStore;
  app.use(session({
    secret: process.env.SESSION_SECRET || 'crowdwide-development-secret',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { maxAge: sessionDurationMs, httpOnly: true, sameSite: 'lax' }
  }));
  app.use(csrfProtection);

  app.use(async (req, res, next) => {
    try {
      const sessionUser = req.session.user || null;
      let currentUser = sessionUser;
      if (sessionUser?.id) {
        const wallet = await User.findById(sessionUser.id).select('wavesBalance username adFreeUntil').lean();
        currentUser = { ...sessionUser, wavesBalance: Number(wallet?.wavesBalance || 0), username: wallet?.username || '', adFreeUntil: wallet?.adFreeUntil || null };
      }
      res.locals.currentUser = currentUser;
      res.locals.flash = req.session.flash || null;
      res.locals.csrfToken = generateToken(req);
      res.locals.appUrl = process.env.APP_URL || `http://localhost:${port}`;
      res.locals.renderMentions = renderMentions;
      res.locals.renderRichBody = renderRichBody;
      res.locals.icon = icon;
      res.locals.gifsEnabled = gifsEnabled();
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
