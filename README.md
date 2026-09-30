# Afya Yangu Work Diary

A shared, authenticated work diary for staff and administrators.

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` with at least 12 characters.
3. Install dependencies: `npm install`.
4. Start the app: `npm start`.
5. Open `http://localhost:3000`.

The shared data file is created in `data/work-diary.json`. The `data` directory is ignored by Git.

## Staff access

Sign in as administrator, create each staff member, and assign a 4 to 8 digit PIN. Staff then sign in with their name and PIN. Entries are stored centrally in SQLite and are shared across browsers.

## Deployment

`render.yaml` describes a Render deployment and includes a persistent disk for the data file. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` as secret environment variables in Render. Do not commit `.env` or data files.

For multiple app instances, replace the file store with a managed database before scaling horizontally.
