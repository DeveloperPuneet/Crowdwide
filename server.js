require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const morgan = require('morgan');
const connectMongo = require('connect-mongo');
const connectDatabase = require('./src/config/database');
const webRoutes = require('./src/routes/web');
const authRoutes = require('./src/routes/auth');

const app = express();
const port = process.env.PORT || 3000;
const sessionDurationMs = 1000 * 60 * 60 * 24 * 75;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
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
