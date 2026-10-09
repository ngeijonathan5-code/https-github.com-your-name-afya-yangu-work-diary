import { pgTable, text, timestamp, boolean, real, date, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text(),
  passwordHash: text("password_hash"),
  pinHash: text("pin_hash"),
  role: text().notNull(),
  active: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const entries = pgTable("entries", {
  id: text().primaryKey(),
  date: date().notNull(),
  hours: real().notNull(),
  project: text().notNull(),
  work: text().notNull(),
  notes: text().notNull().default(""),
  submittedBy: text("submitted_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("entries_date_idx").on(table.date)]);

export const attendance = pgTable("attendance", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  status: text().notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: text().primaryKey(),
  title: text().notNull(),
  description: text().notNull().default(""),
  dueDate: date("due_date"),
  assignedTo: text("assigned_to").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text().notNull().default("open"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, table => [index("tasks_assigned_to_idx").on(table.assignedTo)]);
