# Crowdwide

Crowdwide is a social discovery platform built with an Express MVC stack, EJS views, MongoDB, and session-based authentication.

## Run locally

1. Install Node.js 18+ and MongoDB.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and set `MONGODB_URI` and `SESSION_SECRET`.
4. Configure Google Cloud Gmail OAuth2 if you want verification emails delivered. Without mail settings, verification codes are printed in the server log for local development.
5. Start development mode: `npm run dev`
6. Open `http://localhost:3000`

## Structure

- `server.js` - application entry point and middleware
- `src/config` - database configuration
- `src/controllers` - request handlers
- `src/middleware` - authentication guards
- `src/models` - MongoDB models for users and posts/media
- `src/routes` - web and auth routes
- `src/services` - mail delivery abstraction
- `src/views` - EJS pages and partials
- `public` - static assets, styles, and browser scripts

## Auth flow

New accounts receive a six-digit verification code and cannot access `/dashboard` until verified. An unverified login generates a fresh code and redirects to verification. Password reset tokens are stored with an expiry on the user document.

## Google Cloud Gmail setup

1. In Google Cloud Console, create or select a project.
2. Enable the Gmail API for the project.
3. Configure the OAuth consent screen. Add the Gmail account that will send Crowdwide mail as a test user while the app is in testing mode.
4. Create an OAuth 2.0 Client ID for a Web/Desktop application and obtain a refresh token with the Gmail scope `https://mail.google.com/`.
5. Set `MAIL_PROVIDER=gmail`, `GMAIL_USER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` in `.env`.
6. Set `MAIL_FROM` to the same verified sender address as `GMAIL_USER`.

The mailer uses Gmail OAuth2 through Nodemailer, so no Gmail password or less-secure-app access is required. Keep the client secret and refresh token out of source control. For production, move them into your deployment platform's secret manager or Google Secret Manager.

## Routes

- `/` landing page
- `/auth/register` account creation
- `/auth/login` sign in
- `/auth/verify` email verification
- `/auth/forgot-password` password reset request
- `/auth/reset?token=...` password reset
- `/dashboard` protected app entry
