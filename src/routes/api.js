const express = require("express");
const crypto = require("crypto");
const { run, get, all } = require("../db");
const { ensureGame, resetQuestionState, clearQuestionTimer } = require("../services/gameState");

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function buildQuestionPublicData(question, liveGame) {
  return {
    id: question.id,
    type: question.type,
    title: question.title,
    payload: liveGame.currentQuestion ? liveGame.currentQuestion.payload : {},
    status: liveGame.currentQuestionStatus,
    timerEndsAt: liveGame.timerEndsAt,
  };
}

function emitQuestionState(io, gameCode, question, liveGame) {
  io.to(`game:${gameCode}`).emit("question:show", buildQuestionPublicData(question, liveGame));
}

function closeCurrentQuestion(io, gameCode, reason = "manual") {
  const liveGame = ensureGame(gameCode);
  if (!liveGame.currentQuestion || liveGame.currentQuestionStatus === "closed") {
    return false;
  }

  clearQuestionTimer(gameCode);
  liveGame.currentQuestionStatus = "closed";
  liveGame.timerEndsAt = null;

  io.to(`game:${gameCode}`).emit("question:closed", {
    questionId: liveGame.currentQuestion.id,
    reason,
  });

  io.to(`host:${gameCode}`).emit("question:status", {
    questionId: liveGame.currentQuestion.id,
    status: "closed",
    reason,
  });

  return true;
}

function scheduleQuestionClose(io, gameCode) {
  const liveGame = ensureGame(gameCode);
  clearQuestionTimer(gameCode);

  if (!liveGame.timerEndsAt || liveGame.currentQuestionStatus !== "active") return;

  const delayMs = Math.max(0, liveGame.timerEndsAt - Date.now());
  liveGame.timerTimeout = setTimeout(() => {
    closeCurrentQuestion(io, gameCode, "timer");
  }, delayMs);
}

router.post("/admin/games", requireAdmin, async (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: "Title is required" });

  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const result = await run(
    "INSERT INTO games (title, code, status, created_by) VALUES (?, ?, 'draft', ?)",
    [title, code, req.session.user.id]
  );

  const gameId = result.lastID;

  // demo questions
  await run(
    "INSERT INTO questions (game_id, type, title, payload_json, sort_order) VALUES (?, ?, ?, ?, ?)",
    [gameId, "abcd", "Столица Франции?", JSON.stringify({
      options: ["Берлин", "Мадрид", "Париж", "Рим"],
      correct: 2,
      timeLimitSec: 15
    }), 1]
  );

  await run(
    "INSERT INTO questions (game_id, type, title, payload_json, sort_order) VALUES (?, ?, ?, ?, ?)",
    [gameId, "buzz", "Кто быстрее нажмет кнопку?", JSON.stringify({
      timeLimitSec: 10
    }), 2]
  );

  res.json({ ok: true, gameId, code });
});

router.post("/admin/games/:id/start", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  await run("UPDATE games SET status = 'live' WHERE id = ?", [game.id]);
  const liveGame = ensureGame(game.code);
  liveGame.status = "live";

  req.app.get("io").to(`game:${game.code}`).emit("game:started", {
    code: game.code,
    title: game.title,
  });
  const leaderboard = await all(
    "SELECT id, name, score FROM players WHERE game_id = ? ORDER BY score DESC, id ASC",
    [game.id]
  );
  req.app.get("io").to(`game:${game.code}`).emit("leaderboard:update", {
    leaderboard: leaderboard.map((player, index) => ({ ...player, place: index + 1 })),
  });

  res.json({ ok: true });
});

router.post("/admin/games/:id/next-question", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const io = req.app.get("io");
  closeCurrentQuestion(io, game.code, "next_question");

  const questions = await all(
    "SELECT * FROM questions WHERE game_id = ? ORDER BY sort_order ASC, id ASC",
    [game.id]
  );

  const liveGame = ensureGame(game.code);
  liveGame.currentQuestionIndex += 1;
  const question = questions[liveGame.currentQuestionIndex];

  if (!question) {
    liveGame.currentQuestion = null;
    clearQuestionTimer(game.code);
    liveGame.currentQuestionStatus = "closed";

    io.to(`game:${game.code}`).emit("game:finished");
    return res.json({ ok: true, finished: true });
  }

  resetQuestionState(game.code);
  const payload = JSON.parse(question.payload_json);
  liveGame.currentQuestion = {
    id: question.id,
    type: question.type,
    title: question.title,
    payload,
  };
  liveGame.currentQuestionStatus = "active";
  liveGame.timerEndsAt = payload.timeLimitSec
    ? Date.now() + payload.timeLimitSec * 1000
    : null;

  emitQuestionState(io, game.code, question, liveGame);
  io.to(`host:${game.code}`).emit("question:status", {
    questionId: question.id,
    status: liveGame.currentQuestionStatus,
    reason: "started",
  });

  scheduleQuestionClose(io, game.code);

  res.json({ ok: true, questionId: question.id });
});

router.post("/admin/games/:id/close-question", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const closed = closeCurrentQuestion(req.app.get("io"), game.code, "host");
  return res.json({ ok: true, closed });
});

module.exports = router;
