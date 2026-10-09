# Afya Yangu Work Diary

A shared, authenticated work diary for staff and administrators.

## Running locally

1. Install dependencies: `npm install`.
2. Start the app with Netlify emulation: `npm run dev` (runs `netlify dev`).

Data is stored in Netlify Database (managed Postgres). The schema lives in `db/schema.ts`, and migrations in `netlify/database/migrations/` are applied automatically on deploy.

## Administrator account

On first visit, if no administrator exists, the Administrator tab offers a one-time setup to choose the admin email and password (12+ characters). Alternatively, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` as Netlify environment variables and the admin account is created or kept in sync with them.

## Staff access

Sign in as administrator, create each staff member, and assign a 4 to 8 digit PIN. Staff then sign in with their name and PIN. Entries, attendance, and tasks are stored centrally in PostgreSQL when `DATABASE_URL` is configured, or in the local JSON fallback, and are shared across browsers.

## Task assignment

Administrators can create a task from the Team administration panel. Each task is assigned automatically to every active staff member at the time it is created. Staff can view their assigned tasks and mark them done or reopen them.

## Deployment

The app deploys on Netlify: static files are served from `public/`, and the API runs as a Netlify Function at `/api/*` (`netlify/functions/api.mts`). Do not commit `.env` files.
