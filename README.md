# VitalSync-> SAKHI

VitalSync is a menstrual health tracking web app with account auth, cycle tracking, diary logging, PCOD risk assessment, export/delete controls, and an AI help assistant with a safe fallback mode.

## Production setup

This project now supports:

- `npm start` as the single canonical launch command
- `httpOnly` cookie-based sessions instead of browser-stored auth tokens
- MongoDB as the production database
- JSON file fallback only for local development when `MONGODB_URI` is not set
- security headers via `helmet`
- rate limiting on API and auth routes
- input validation for core health/account flows
- legal pages at `/privacy` and `/terms`
- health check endpoint at `/health`
- graceful shutdown for clean process exits

## Environment

Create a `.env` file from `.env.example`.

Required for production:

- `NODE_ENV=production`
- `JWT_SECRET`
- `MONGODB_URI`
- `APP_BASE_URL`
- `SUPPORT_EMAIL`

Optional:

- `PORT`
- `ANTHROPIC_API_KEY`
- `PUBLIC_ORIGIN`

Development-only fallback:

- `DATA_FILE`

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

To verify the server, run this after starting it:

```bash
npm run smoke
```

If `MONGODB_URI` is unset, the app uses the local JSON development fallback.

## Deploy

### Render

The repo includes `render.yaml`.

Set these environment variables in Render:

- `NODE_ENV=production`
- `JWT_SECRET`
- `MONGODB_URI`
- `APP_BASE_URL`
- `SUPPORT_EMAIL`
- `ANTHROPIC_API_KEY` if you want live AI replies

### Docker

The repo includes `Dockerfile`.

Example:

```bash
docker build -t vitalsync .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET=replace-me \
  -e MONGODB_URI=replace-me \
  -e APP_BASE_URL=https://your-domain.example \
  -e SUPPORT_EMAIL=support@your-domain.example \
  vitalsync
```

## Public launch checklist

- Use a real MongoDB deployment, such as MongoDB Atlas.
- Set a strong `JWT_SECRET`.
- Put the app behind HTTPS.
- Replace the support email with your real contact.
- Review the legal copy and medical disclaimer for your exact launch context.
- Add uptime monitoring and database backups.

## Current status

This repo is now structured to be deployable publicly.

The main remaining non-code work before a real public launch is operational and legal:

- production MongoDB credentials
- real support/legal identity details
- hosting setup
- backups and monitoring
