require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const morgan = require('morgan');
const helmet = require('helmet');
const connectMongo = require('connect-mongo');
const connectDatabase = require('./src/config/database');
const webRoutes = require('./src/routes/web');
const authRoutes = require('./src/routes/auth');
const { csrfProtection, generateToken } = require('./src/middleware/security');
const { renderMentions } = require('./src/services/mentions');

const app = express();
const port = process.env.PORT || 3000;
const sessionDurationMs = 1000 * 60 * 60 * 24 * 75;
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.NODE_ENV === 'production' ? 1 : 0));

// Render places one trusted reverse proxy in front of the application.
app.set('trust proxy', trustProxyHops);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
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
app.use(express.static(path.join(__dirname, 'public')));
app.use(morgan('dev'));
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

async function start() {
  await connectDatabase();
  app.listen(port, () => console.log(`Crowdwide is live at http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Unable to start Crowdwide:', error.message);
  process.exit(1);
});
