const { all, run } = require("../db");

let extendedSchemaReady = false;

async function ensureColumn(table, column, sql) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await run(sql);
  }
}

async function ensureExtendedGameSchema() {
  if (extendedSchemaReady) return;

  await run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      question_type TEXT NOT NULL DEFAULT 'abcd',
      question_count INTEGER NOT NULL DEFAULT 5,
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
    CREATE TABLE IF NOT EXISTS game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      session_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'live',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      FOREIGN KEY(game_id) REFERENCES games(id)
    )
  `);

  await ensureColumn("questions", "round_id", "ALTER TABLE questions ADD COLUMN round_id INTEGER");
  await ensureColumn("questions", "category_id", "ALTER TABLE questions ADD COLUMN category_id INTEGER");
  await ensureColumn("questions", "points", "ALTER TABLE questions ADD COLUMN points INTEGER NOT NULL DEFAULT 100");

  await ensureColumn("rounds", "question_type", "ALTER TABLE rounds ADD COLUMN question_type TEXT NOT NULL DEFAULT 'abcd'");
  await ensureColumn("rounds", "question_count", "ALTER TABLE rounds ADD COLUMN question_count INTEGER NOT NULL DEFAULT 5");

  await ensureColumn("games", "current_session_id", "ALTER TABLE games ADD COLUMN current_session_id INTEGER");

  await ensureColumn("players", "session_id", "ALTER TABLE players ADD COLUMN session_id INTEGER");
  await ensureColumn("player_answers", "session_id", "ALTER TABLE player_answers ADD COLUMN session_id INTEGER");

  extendedSchemaReady = true;
}

module.exports = {
  ensureExtendedGameSchema,
};
