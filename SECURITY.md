# Security Policy

## Supported Versions

All released versions of Crowdwide are currently supported and receive security updates when necessary.

| Version      | Supported          |
| ------------ | ------------------ |
| All versions | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Crowdwide, please report it privately to the project maintainers rather than publicly disclosing it.

When reporting a vulnerability, please include:

* A clear description of the issue
* Steps to reproduce it
* Any relevant screenshots, logs, or proof of concept
* The potential impact of the vulnerability

We will review valid reports and provide an update as soon as reasonably possible. Security fixes will be released when necessary.

## How Crowdwide protects accounts

* **Sign-in**: passwords are bcrypt-hashed; unknown emails cost the same time as wrong passwords; five wrong passwords pause sign-in for 15 minutes (and the owner is emailed); a suspension reason is only shown to someone who knows the password; every sign-in gets a brand-new session id (no session fixation).
* **Email verification**: 6-digit codes are compared in constant time and die after 5 wrong guesses; reminder emails carry a one-click link whose token is stored only as a SHA-256 hash, expires after 7 days and works once.
* **Password reset**: the emailed token is stored only as a hash; a successful reset signs out every device. Changing a password signs out the other devices. Deleting an account asks for the current password.
* **Password rules**: 8-128 characters, no common passwords, no email name inside it.
* **Input**: MongoDB operator keys (`$gt`, `a.b`, ...) are stripped from every body, query string and URL parameter before routes run, so JSON or `a[$gt]=` tricks cannot turn a field into a query operator.
* **Mail-bombing**: verification and reset emails are limited to 5 per hour per address, on top of per-IP limits.
* **Cookies and headers**: session cookies are `HttpOnly`, `SameSite=Lax` and `Secure` over HTTPS; CSP with per-request nonces, HSTS, frame and MIME protections from Helmet, and a Permissions-Policy that turns off camera, microphone and payment APIs.
* **Secrets**: in production a missing `SESSION_SECRET` no longer falls back to a value that is public in the source - a random one is used for the process and an error is logged.
