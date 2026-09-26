const express = require('express');
const path = require('path');
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
const { alertOnCriticalError } = require('./services/alerting');

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
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'"],
        // GIFs come from GIPHY's CDN; blob: lets upload previews render.
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.giphy.com', ...mediaOrigins]
      }
    }
  }));
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
  app.use(session({
    secret: process.env.SESSION_SECRET || 'crowdwide-development-secret',
    resave: false,
    saveUninitialized: false,
    store: process.env.MONGODB_URI ? connectMongo.create({
      mongoUrl: process.env.MONGODB_URI,
      ttl: Math.floor(sessionDurationMs / 1000)
    }) : undefined,
    cookie: { maxAge: sessionDurationMs, httpOnly: true, sameSite: 'lax' }
  }));
  app.use(csrfProtection);

  app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.flash = req.session.flash || null;
    res.locals.csrfToken = generateToken(req);
    res.locals.appUrl = process.env.APP_URL || `http://localhost:${port}`;
    res.locals.renderMentions = renderMentions;
    res.locals.renderRichBody = renderRichBody;
    res.locals.icon = icon;
    res.locals.gifsEnabled = gifsEnabled();
    delete req.session.flash;
    next();
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
