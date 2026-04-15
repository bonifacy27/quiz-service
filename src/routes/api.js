const express = require("express");
const crypto = require("crypto");
const { run, get, all } = require("../db");
const { ensureGame, resetQuestionState, clearQuestionTimer } = require("../services/gameState");
const { ensureExtendedGameSchema } = require("../services/schemaGuard");

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
  await ensureExtendedGameSchema();
  const title = String(req.body.title || "").trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: "Title is required" });

  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const result = await run(
    "INSERT INTO games (title, code, status, created_by) VALUES (?, ?, 'draft', ?)",
    [title, code, req.session.user.id]
  );

  const gameId = result.lastID;
  const roundsInput = Array.isArray(req.body.rounds) ? req.body.rounds : [];

  const hasCustomRounds = roundsInput.some((round) => round && String(round.name || "").trim());

  if (hasCustomRounds) {
    for (let roundIndex = 0; roundIndex < roundsInput.length; roundIndex += 1) {
      const roundInput = roundsInput[roundIndex] || {};
      const roundName = String(roundInput.name || "").trim();
      if (!roundName) continue;

      const roundResult = await run(
        "INSERT INTO rounds (game_id, name, settings_json, sort_order) VALUES (?, ?, '{}', ?)",
        [gameId, roundName.slice(0, 120), roundIndex + 1]
      );

      const categories = Array.isArray(roundInput.categories) ? roundInput.categories : [];
      let categoryOrder = 1;
      for (const categoryNameRaw of categories) {
        const categoryName = String(categoryNameRaw || "").trim();
        if (!categoryName) continue;
        await run(
          "INSERT INTO categories (game_id, round_id, name, sort_order) VALUES (?, ?, ?, ?)",
          [gameId, roundResult.lastID, categoryName.slice(0, 120), categoryOrder]
        );
        categoryOrder += 1;
      }
    }
  } else {
    const roundResult = await run(
      "INSERT INTO rounds (game_id, name, settings_json, sort_order) VALUES (?, ?, '{}', 1)",
      [gameId, "Раунд 1"]
    );
    await run(
      "INSERT INTO categories (game_id, round_id, name, sort_order) VALUES (?, ?, ?, 1)",
      [gameId, roundResult.lastID, "Категория 1"]
    );
  }

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
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const io = req.app.get("io");
  closeCurrentQuestion(io, game.code, "next_question");

  const questions = await all(
    `SELECT q.*
     FROM questions q
     LEFT JOIN rounds r ON r.id = q.round_id
     LEFT JOIN categories c ON c.id = q.category_id
     WHERE q.game_id = ?
     ORDER BY COALESCE(r.sort_order, 0) ASC, COALESCE(c.sort_order, 0) ASC, q.sort_order ASC, q.id ASC`,
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
