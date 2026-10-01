require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataFile = path.resolve(process.env.DB_FILE || './data/work-diary.json');
const initialData = { users: [], sessions: [], entries: [], attendance: [], tasks: [] };
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }) : null;
let data = initialData;
function normalizeData(value) { const result = value && typeof value === 'object' ? value : {}; for (const key of Object.keys(initialData)) if (!Array.isArray(result[key])) result[key] = []; return result; }
async function loadData() {
	if (pool) {
		await pool.query('CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL)');
		const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
		if (result.rowCount) data = normalizeData(result.rows[0].data);
		else await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1::jsonb)', [JSON.stringify(initialData)]);
		return;
	}
	fs.mkdirSync(path.dirname(dataFile), { recursive: true });
	try { data = normalizeData(JSON.parse(fs.readFileSync(dataFile, 'utf8'))); } catch { data = normalizeData(initialData); }
}
async function persist() {
	if (pool) { await pool.query('UPDATE app_state SET data = $1::jsonb WHERE id = 1', [JSON.stringify(data)]); return; }
	const temporary = `${dataFile}.tmp`; fs.writeFileSync(temporary, JSON.stringify(data, null, 2)); fs.renameSync(temporary, dataFile);
}
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
if (!adminEmail || adminPassword.length < 12) { console.error('ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) are required.'); process.exit(1); }

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const publicUser = user => ({ id: user.id, name: user.name, role: user.role, active: user.active });
function cookieValue(req, name) { const item = String(req.headers.cookie || '').split(';').find(value => value.trim().startsWith(`${name}=`)); return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : ''; }
async function setSession(res, userId) { const token = id(); const days = Math.max(1, Number(process.env.SESSION_DAYS || 7)); data.sessions.push({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId, expiresAt: Date.now() + days * 86400000 }); await persist(); res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`); }
function currentUser(req) { const token = cookieValue(req, 'session'); const hash = crypto.createHash('sha256').update(token).digest('hex'); const session = data.sessions.find(item => item.tokenHash === hash && item.expiresAt > Date.now()); const user = session && data.users.find(item => item.id === session.userId && item.active); return user || null; }
function auth(req, res, next) { req.user = currentUser(req); if (!req.user) return res.status(401).json({ error: 'Please sign in.' }); next(); }
function adminOnly(req, res, next) { if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' }); next(); }
function validEntry(body) { const hours = Number(body.hours); const project = String(body.project || '').trim(); const work = String(body.work || '').trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) || !Number.isFinite(hours) || hours <= 0 || hours > 24 || !project || !work || project.length > 120 || work.length > 5000) return null; return { date: body.date, hours, project, work, notes: String(body.notes || '').trim().slice(0, 5000) }; }
function validTask(body) { const title = String(body.title || '').trim(); const description = String(body.description || '').trim(); const dueDate = String(body.dueDate || '').trim(); if (title.length < 2 || title.length > 160 || description.length > 5000 || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) return null; return { title, description, dueDate: dueDate || null }; }

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/public/members', (req, res) => res.json(data.users.filter(user => user.role === 'staff' && user.active).sort((a, b) => a.name.localeCompare(b.name)).map(user => ({ id: user.id, name: user.name }))));
app.post('/api/login', async (req, res) => { let user; if (req.body.mode === 'admin') { user = data.users.find(item => item.role === 'admin' && item.active && item.email === String(req.body.email || '').trim().toLowerCase()); if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.passwordHash)) return res.status(401).json({ error: 'Invalid administrator credentials.' }); } else { user = data.users.find(item => item.role === 'staff' && item.active && item.id === String(req.body.name || '')); if (!user || !bcrypt.compareSync(String(req.body.pin || ''), user.pinHash || '')) return res.status(401).json({ error: 'Invalid staff name or PIN.' }); } await setSession(res, user.id); res.json({ user: publicUser(user) }); });
app.post('/api/logout', async (req, res) => { const token = cookieValue(req, 'session'); const hash = crypto.createHash('sha256').update(token).digest('hex'); data.sessions = data.sessions.filter(item => item.tokenHash !== hash); await persist(); res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/entries', auth, (req, res) => res.json(data.entries.map(entry => ({ ...entry, submitted_by_name: data.users.find(user => user.id === entry.submittedBy)?.name || 'Unknown' })).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))));
app.post('/api/entries', auth, async (req, res) => { const entry = validEntry(req.body); if (!entry) return res.status(400).json({ error: 'Enter a valid date, hours, project, and work report.' }); const record = { id: id(), ...entry, submittedBy: req.user.id, createdAt: now() }; data.entries.push(record); await persist(); res.status(201).json({ id: record.id }); });
app.delete('/api/entries/:id', auth, async (req, res) => { const entry = data.entries.find(item => item.id === req.params.id); if (!entry) return res.status(404).json({ error: 'Entry not found.' }); if (req.user.role !== 'admin' && entry.submittedBy !== req.user.id) return res.status(403).json({ error: 'You can only remove your own entries.' }); data.entries = data.entries.filter(item => item.id !== req.params.id); await persist(); res.json({ ok: true }); });
app.get('/api/tasks', auth, async (req, res) => { const tasks = data.tasks.filter(task => req.user.role === 'admin' || task.assignedTo === req.user.id).map(task => ({ ...task, assignedToName: data.users.find(user => user.id === task.assignedTo)?.name || 'Unknown' })).sort((a, b) => String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31')) || b.createdAt.localeCompare(a.createdAt)); res.json(tasks); });
app.post('/api/tasks/bulk', auth, adminOnly, async (req, res) => { const task = validTask(req.body); if (!task) return res.status(400).json({ error: 'Enter a title, description, and a valid due date.' }); const activeStaff = data.users.filter(user => user.role === 'staff' && user.active); const createdAt = now(); const records = activeStaff.map(user => ({ id: id(), ...task, assignedTo: user.id, status: 'open', createdAt, createdBy: req.user.id })); data.tasks.push(...records); await persist(); res.status(201).json({ created: records.length }); });
app.patch('/api/tasks/:id', auth, async (req, res) => { const task = data.tasks.find(item => item.id === req.params.id); if (!task) return res.status(404).json({ error: 'Task not found.' }); if (req.user.role !== 'admin' && task.assignedTo !== req.user.id) return res.status(403).json({ error: 'You can only update your own tasks.' }); const status = String(req.body.status || ''); if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'Task status must be open or done.' }); task.status = status; task.updatedAt = now(); await persist(); res.json({ ok: true }); });
app.get('/api/members', auth, adminOnly, (req, res) => res.json(data.users.filter(user => user.role === 'staff').sort((a, b) => a.name.localeCompare(b.name)).map(user => ({ id: user.id, name: user.name, active: user.active, created_at: user.createdAt }))));
app.post('/api/members', auth, adminOnly, async (req, res) => { const name = String(req.body.name || '').trim(); const pin = String(req.body.pin || '').trim(); if (name.length < 2 || !/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'Use a name and a 4 to 8 digit PIN.' }); if (data.users.some(user => user.role === 'staff' && user.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'That staff name already exists.' }); const member = { id: id(), name, pinHash: bcrypt.hashSync(pin, 12), role: 'staff', active: true, createdAt: now() }; data.users.push(member); await persist(); res.status(201).json({ id: member.id }); });
app.patch('/api/members/:id', auth, adminOnly, async (req, res) => { const member = data.users.find(user => user.id === req.params.id && user.role === 'staff'); if (!member) return res.status(404).json({ error: 'Staff member not found.' }); member.active = !member.active; await persist(); res.json({ ok: true }); });
app.get('/api/dashboard', auth, adminOnly, (req, res) => res.json({ entries: { count: data.entries.length, hours: data.entries.reduce((sum, entry) => sum + Number(entry.hours), 0) }, staff: { count: data.users.filter(user => user.role === 'staff' && user.active).length }, checkedIn: data.attendance.filter(item => item.status === 'in').length }));
app.post('/api/attendance', auth, async (req, res) => { const status = req.body.status === 'out' ? 'out' : 'in'; const current = data.attendance.find(item => item.userId === req.user.id); if (current) { current.status = status; current.checkedAt = now(); } else data.attendance.push({ userId: req.user.id, status, checkedAt: now() }); await persist(); res.json({ ok: true, status }); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
async function start() {
	await loadData();
	const admin = data.users.find(user => user.role === 'admin');
	if (!admin) { data.users.push({ id: id(), name: 'Administrator', email: adminEmail, passwordHash: bcrypt.hashSync(adminPassword, 12), role: 'admin', active: true, createdAt: now() }); await persist(); }
	else if (admin.email !== adminEmail || !bcrypt.compareSync(adminPassword, admin.passwordHash || '')) { admin.email = adminEmail; admin.passwordHash = bcrypt.hashSync(adminPassword, 12); await persist(); }
	app.listen(port, '0.0.0.0', () => console.log(`Work Diary listening on http://localhost:${port}`));
}
start().catch(error => { console.error('Unable to initialize storage.', error); process.exit(1); });
