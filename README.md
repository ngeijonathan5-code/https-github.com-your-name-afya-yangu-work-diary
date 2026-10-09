# Afya Yangu Work Diary

A shared, authenticated work diary for staff and administrators.

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` with at least 12 characters.
3. Install dependencies: `npm install`.
4. For PostgreSQL-backed storage, set `DATABASE_URL`; without it, the app uses the local JSON fallback.
5. Start the app: `npm start`.
6. Open `http://localhost:3000`.

The shared data file is created in `data/work-diary.json` only when `DATABASE_URL` is not set. The `data` directory is ignored by Git.

## Staff access

Sign in as administrator, create each staff member, and assign a 4 to 8 digit PIN. Staff then sign in with their name and PIN. Entries, attendance, and tasks are stored centrally in PostgreSQL when `DATABASE_URL` is configured, or in the local JSON fallback, and are shared across browsers.

## Task assignment

Administrators can create a task from the Team administration panel. Each task is assigned automatically to every active staff member at the time it is created. Staff can view their assigned tasks and mark them done or reopen them.

## Deployment

### Netlify

`netlify.toml` sets the base directory to the repository root, disables the build command because the frontend is already static, and publishes only `public`. These file-based settings override the site's saved base directory and build command, preventing invalid values such as `/opt/build`, `work`, or `ran` from blocking deployment. No frontend build step is required.

This configuration deploys the static frontend only. The Express server in `server.js` is not deployed by this configuration, so sign-in and diary API requests will not work on Netlify until the backend is adapted to Netlify Functions with persistent storage. Do not use `npm start` as a Netlify build command: it starts a long-running server rather than producing deployment files.

### Render and Railway

`render.yaml` describes a Render deployment and includes a persistent disk for the file fallback. For the Railway deployment, set `DATABASE_URL` to the managed PostgreSQL service reference along with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Do not commit `.env` or data files.

For multiple app instances, use the managed PostgreSQL store before scaling horizontally. The JSON file fallback is intended for a single app instance.
