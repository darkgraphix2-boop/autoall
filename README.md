# Zalando Plus links — Railway source

Single-user Railway app that opens Zalando Plus in a temporary Playwright browser, submits email/password/OTP supplied in its private UI, and displays Duolingo and Spotify activation URLs. Credentials, links and cookies stay in memory only; the browser is closed after 10 minutes of inactivity or with End session.

## Deploy

1. Put these source files in a GitHub repository connected to Railway. A private repository is preferable; never commit credentials or the access key.
2. Create a Railway service from that repository. Railway detects the Dockerfile.
3. Set `ACCESS_KEY` to a random string of at least 24 characters. Do not reuse your Zalando password. Railway supplies `PORT`.
4. Generate a Railway HTTPS domain. Open it and enter the access key, then your own account email. Supply password and OTP only within the app.

This is a best-effort browser integration, not an official Zalando API. A CAPTCHA, bot protection, or layout change may stop it; it does not bypass those checks. Do not log request bodies or store credentials.
