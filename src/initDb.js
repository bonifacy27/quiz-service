const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const config = require("./config");
const { run, get, all } = require("./db");

async function init() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      round_id INTEGER,
      category_id INTEGER,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 100,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(game_id) REFERENCES games(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(game_id) REFERENCES games(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      round_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(game_id) REFERENCES games(id),
      FOREIGN KEY(round_id) REFERENCES rounds(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL DEFAULT 0,
      connected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(game_id) REFERENCES games(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS player_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      answer_json TEXT NOT NULL,
      is_correct INTEGER,
      score_delta INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(game_id) REFERENCES games(id),
      FOREIGN KEY(question_id) REFERENCES questions(id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);

  const questionColumns = await all("PRAGMA table_info(questions)");
  const hasRoundId = questionColumns.some((column) => column.name === "round_id");
  if (!hasRoundId) {
    await run("ALTER TABLE questions ADD COLUMN round_id INTEGER");
  }

  const hasCategoryId = questionColumns.some((column) => column.name === "category_id");
  if (!hasCategoryId) {
    await run("ALTER TABLE questions ADD COLUMN category_id INTEGER");
  }

  const hasPoints = questionColumns.some((column) => column.name === "points");
  if (!hasPoints) {
    await run("ALTER TABLE questions ADD COLUMN points INTEGER NOT NULL DEFAULT 100");
  }

  const existingAdmin = await get("SELECT id FROM users WHERE login = ?", [config.adminLogin]);
  if (!existingAdmin) {
    const hash = await bcrypt.hash(config.adminPassword, 10);
    await run(
      "INSERT INTO users (login, password_hash, role) VALUES (?, ?, 'admin')",
      [config.adminLogin, hash]
    );
    console.log(`Admin user created: ${config.adminLogin}`);
  } else {
    console.log("Admin user already exists");
  }

  console.log("Database initialized:", config.dbPath);
}

init().catch((err) => {
  console.error(err);
  process.exit(1);
});
