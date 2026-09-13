const express = require('express');
const path = require('path');
const session = require('express-session');
const morgan = require('morgan');
const helmet = require('helmet');
const connectMongo = require('connect-mongo');
const webRoutes = require('./routes/web');
const authRoutes = require('./routes/auth');
const { csrfProtection, generateToken } = require('./middleware/security');
const { renderMentions } = require('./services/mentions');

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
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net']
      }
    }
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
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
    delete req.session.flash;
    next();
  });

  app.use('/', webRoutes);
  app.use('/auth', authRoutes);
  app.use((req, res) => res.status(404).render('pages/not-found', { title: 'Page not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Unhandled request error:', error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: status === 500 ? 'Internal server error.' : error.message });
    return res.status(status).render('pages/not-found', { title: status === 404 ? 'Page not found' : 'Crowdwide is having trouble' });
  });

  return app;
}

module.exports = createApp;
