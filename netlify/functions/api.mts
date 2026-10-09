import type { Config, Context } from "@netlify/functions";
import bcrypt from "bcryptjs";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { attendance, entries, sessions, tasks, users } from "../../db/schema.js";

type User = typeof users.$inferSelect;
type Handler = (req: Request, params: Record<string, string>, user: User | null) => Promise<Response>;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers });
const fail = (status: number, error: string) => json({ error }, status);
const newId = () => crypto.randomUUID();
const sha256 = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const publicUser = (user: User) => ({ id: user.id, name: user.name, role: user.role, active: user.active });
const sessionDays = () => Math.max(1, Number(Netlify.env.get("SESSION_DAYS") || 7));
const toIso = (value: Date | null) => (value ? value.toISOString() : null);

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { const body = await req.json(); return body && typeof body === "object" ? body : {}; } catch { return {}; }
}

function cookieValue(req: Request, name: string) {
  const item = (req.headers.get("cookie") || "").split(";").find(value => value.trim().startsWith(`${name}=`));
  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : "";
}

async function createSession(userId: string) {
  const token = newId();
  const days = sessionDays();
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({ tokenHash: await sha256(token), userId, expiresAt: new Date(Date.now() + days * 86400000) });
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}; Secure`;
}

async function currentUser(req: Request) {
  const token = cookieValue(req, "session");
  if (!token) return null;
  const [row] = await db.select({ user: users }).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, await sha256(token)), gt(sessions.expiresAt, new Date()), eq(users.active, true))).limit(1);
  return row?.user ?? null;
}

// Keeps the administrator account in sync with ADMIN_EMAIL / ADMIN_PASSWORD when they are configured.
async function syncAdminFromEnv() {
  const email = String(Netlify.env.get("ADMIN_EMAIL") || "").trim().toLowerCase();
  const password = String(Netlify.env.get("ADMIN_PASSWORD") || "");
  if (!email || password.length < 12) return;
  const [admin] = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
  if (!admin) await db.insert(users).values({ id: newId(), name: "Administrator", email, passwordHash: bcrypt.hashSync(password, 12), role: "admin" });
  else if (admin.email !== email || !bcrypt.compareSync(password, admin.passwordHash || "")) await db.update(users).set({ email, passwordHash: bcrypt.hashSync(password, 12) }).where(eq(users.id, admin.id));
}

async function adminExists() {
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  return Boolean(admin);
}

function validEntry(body: Record<string, unknown>) {
  const hours = Number(body.hours); const project = String(body.project || "").trim(); const work = String(body.work || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) || !Number.isFinite(hours) || hours <= 0 || hours > 24 || !project || !work || project.length > 120 || work.length > 5000) return null;
  return { date: String(body.date), hours, project, work, notes: String(body.notes || "").trim().slice(0, 5000) };
}

function validTask(body: Record<string, unknown>) {
  const title = String(body.title || "").trim(); const description = String(body.description || "").trim(); const dueDate = String(body.dueDate || "").trim();
  if (title.length < 2 || title.length > 160 || description.length > 5000 || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) return null;
  return { title, description, dueDate: dueDate || null };
}

const requireUser = (handler: (req: Request, params: Record<string, string>, user: User) => Promise<Response>): Handler =>
  async (req, params, user) => (user ? handler(req, params, user) : fail(401, "Please sign in."));
const requireAdmin = (handler: (req: Request, params: Record<string, string>, user: User) => Promise<Response>): Handler =>
  requireUser(async (req, params, user) => (user.role === "admin" ? handler(req, params, user) : fail(403, "Administrator access required.")));

const routes: [string, string, Handler][] = [
  ["GET", "/api/health", async () => json({ ok: true })],

  ["GET", "/api/public/status", async () => { await syncAdminFromEnv(); return json({ needsSetup: !(await adminExists()) }); }],

  ["GET", "/api/public/members", async () => json(await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, "staff"), eq(users.active, true))).orderBy(asc(users.name)))],

  // First-run setup: creates the administrator when none exists and no ADMIN_* variables are configured.
  ["POST", "/api/setup", async req => {
    await syncAdminFromEnv();
    if (await adminExists()) return fail(409, "An administrator already exists.");
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase(); const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) return fail(400, "Use a valid email and a password of at least 12 characters.");
    const admin = { id: newId(), name: "Administrator", email, passwordHash: bcrypt.hashSync(password, 12), role: "admin" };
    await db.insert(users).values(admin);
    return json({ user: { id: admin.id, name: admin.name, role: admin.role, active: true } }, 201, { "Set-Cookie": await createSession(admin.id) });
  }],

  ["POST", "/api/login", async req => {
    const body = await readBody(req);
    let user: User | undefined;
    if (body.mode === "admin") {
      await syncAdminFromEnv();
      [user] = await db.select().from(users).where(and(eq(users.role, "admin"), eq(users.active, true), eq(users.email, String(body.email || "").trim().toLowerCase()))).limit(1);
      if (!user || !bcrypt.compareSync(String(body.password || ""), user.passwordHash || "")) return fail(401, "Invalid administrator credentials.");
    } else {
      [user] = await db.select().from(users).where(and(eq(users.role, "staff"), eq(users.active, true), eq(users.id, String(body.name || "")))).limit(1);
      if (!user || !bcrypt.compareSync(String(body.pin || ""), user.pinHash || "")) return fail(401, "Invalid staff name or PIN.");
    }
    return json({ user: publicUser(user) }, 200, { "Set-Cookie": await createSession(user.id) });
  }],

  ["POST", "/api/logout", async req => {
    const token = cookieValue(req, "session");
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, await sha256(token)));
    return json({ ok: true }, 200, { "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure" });
  }],

  ["GET", "/api/me", requireUser(async (_req, _params, user) => json({ user: publicUser(user) }))],

  ["GET", "/api/entries", requireUser(async () => {
    const rows = await db.select({ entry: entries, name: users.name }).from(entries).leftJoin(users, eq(entries.submittedBy, users.id))
      .orderBy(desc(entries.date), desc(entries.createdAt));
    return json(rows.map(({ entry, name }) => ({ ...entry, createdAt: toIso(entry.createdAt), submitted_by_name: name || "Unknown" })));
  })],

  ["POST", "/api/entries", requireUser(async (req, _params, user) => {
    const entry = validEntry(await readBody(req));
    if (!entry) return fail(400, "Enter a valid date, hours, project, and work report.");
    const id = newId();
    await db.insert(entries).values({ id, ...entry, submittedBy: user.id });
    return json({ id }, 201);
  })],

  ["DELETE", "/api/entries/:id", requireUser(async (_req, params, user) => {
    const [entry] = await db.select().from(entries).where(eq(entries.id, params.id)).limit(1);
    if (!entry) return fail(404, "Entry not found.");
    if (user.role !== "admin" && entry.submittedBy !== user.id) return fail(403, "You can only remove your own entries.");
    await db.delete(entries).where(eq(entries.id, params.id));
    return json({ ok: true });
  })],

  ["GET", "/api/tasks", requireUser(async (_req, _params, user) => {
    const rows = await db.select({ task: tasks, name: users.name }).from(tasks).leftJoin(users, eq(tasks.assignedTo, users.id))
      .where(user.role === "admin" ? undefined : eq(tasks.assignedTo, user.id))
      .orderBy(sql`coalesce(${tasks.dueDate}, '9999-12-31')`, desc(tasks.createdAt));
    return json(rows.map(({ task, name }) => ({ ...task, createdAt: toIso(task.createdAt), updatedAt: toIso(task.updatedAt), assignedToName: name || "Unknown" })));
  })],

  ["POST", "/api/tasks/bulk", requireAdmin(async (req, _params, user) => {
    const task = validTask(await readBody(req));
    if (!task) return fail(400, "Enter a title, description, and a valid due date.");
    const staff = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "staff"), eq(users.active, true)));
    const createdAt = new Date();
    if (staff.length) await db.insert(tasks).values(staff.map(member => ({ id: newId(), ...task, assignedTo: member.id, status: "open", createdAt, createdBy: user.id })));
    return json({ created: staff.length }, 201);
  })],

  ["PATCH", "/api/tasks/:id", requireUser(async (req, params, user) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, params.id)).limit(1);
    if (!task) return fail(404, "Task not found.");
    if (user.role !== "admin" && task.assignedTo !== user.id) return fail(403, "You can only update your own tasks.");
    const status = String((await readBody(req)).status || "");
    if (!["open", "done"].includes(status)) return fail(400, "Task status must be open or done.");
    await db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, params.id));
    return json({ ok: true });
  })],

  ["GET", "/api/members", requireAdmin(async () => {
    const rows = await db.select().from(users).where(eq(users.role, "staff")).orderBy(asc(users.name));
    return json(rows.map(member => ({ id: member.id, name: member.name, active: member.active, created_at: toIso(member.createdAt) })));
  })],

  ["POST", "/api/members", requireAdmin(async req => {
    const body = await readBody(req);
    const name = String(body.name || "").trim(); const pin = String(body.pin || "").trim();
    if (name.length < 2 || !/^\d{4,8}$/.test(pin)) return fail(400, "Use a name and a 4 to 8 digit PIN.");
    const [existing] = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "staff"), sql`lower(${users.name}) = ${name.toLowerCase()}`)).limit(1);
    if (existing) return fail(409, "That staff name already exists.");
    const id = newId();
    await db.insert(users).values({ id, name, pinHash: bcrypt.hashSync(pin, 12), role: "staff" });
    return json({ id }, 201);
  })],

  ["PATCH", "/api/members/:id", requireAdmin(async (_req, params) => {
    const [member] = await db.select().from(users).where(and(eq(users.id, params.id), eq(users.role, "staff"))).limit(1);
    if (!member) return fail(404, "Staff member not found.");
    await db.update(users).set({ active: !member.active }).where(eq(users.id, member.id));
    return json({ ok: true });
  })],

  ["GET", "/api/dashboard", requireAdmin(async () => {
    const [[entryStats], [staffStats], [checkedIn]] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int`, hours: sql<number>`coalesce(sum(${entries.hours}), 0)::float` }).from(entries),
      db.select({ count: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "staff"), eq(users.active, true))),
      db.select({ count: sql<number>`count(*)::int` }).from(attendance).where(eq(attendance.status, "in")),
    ]);
    return json({ entries: { count: entryStats.count, hours: entryStats.hours }, staff: { count: staffStats.count }, checkedIn: checkedIn.count });
  })],

  ["POST", "/api/attendance", requireUser(async (req, _params, user) => {
    const status = (await readBody(req)).status === "out" ? "out" : "in";
    const checkedAt = new Date();
    await db.insert(attendance).values({ userId: user.id, status, checkedAt }).onConflictDoUpdate({ target: attendance.userId, set: { status, checkedAt } });
    return json({ ok: true, status });
  })],
];

function match(pattern: string, pathname: string) {
  const a = pattern.split("/"); const b = pathname.replace(/\/+$/, "").split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export default async (req: Request, _context: Context) => {
  const { pathname } = new URL(req.url);
  let pathMatched = false;
  for (const [method, pattern, handler] of routes) {
    const params = match(pattern, pathname);
    if (!params) continue;
    pathMatched = true;
    if (method !== req.method) continue;
    try {
      const user = pattern.startsWith("/api/public") || pattern === "/api/health" ? null : await currentUser(req);
      return await handler(req, params, user);
    } catch (error) {
      console.error("Request failed", error);
      return fail(500, "Something went wrong. Please try again.");
    }
  }
  return pathMatched ? fail(405, "Method not allowed.") : fail(404, "Not found.");
};

export const config: Config = {
  path: "/api/*",
};
