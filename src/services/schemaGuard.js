const { all, run } = require("../db");

let extendedSchemaReady = false;

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

  const roundColumns = await all("PRAGMA table_info(rounds)");
  const hasRoundType = roundColumns.some((column) => column.name === "question_type");
  if (!hasRoundType) {
    await run("ALTER TABLE rounds ADD COLUMN question_type TEXT NOT NULL DEFAULT 'abcd'");
  }

  const hasRoundCount = roundColumns.some((column) => column.name === "question_count");
  if (!hasRoundCount) {
    await run("ALTER TABLE rounds ADD COLUMN question_count INTEGER NOT NULL DEFAULT 5");
  }

  extendedSchemaReady = true;
}

module.exports = {
  ensureExtendedGameSchema,
};
