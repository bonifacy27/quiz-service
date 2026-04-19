const express = require("express");
const crypto = require("crypto");
const { run, get, all } = require("../db");
const { ensureGame, resetQuestionState, clearQuestionTimer, resetSessionState } = require("../services/gameState");
const { ensureExtendedGameSchema } = require("../services/schemaGuard");
const { getCorrectAnswerText } = require("../services/answerEvaluator");

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function buildQuestionPublicData(question, liveGame) {
  return {
    id: question.id,
    roundId: question.round_id,
    type: question.type,
    title: question.title,
    payload: liveGame.currentQuestion ? liveGame.currentQuestion.payload : {},
    status: liveGame.currentQuestionStatus,
    timerEndsAt: liveGame.timerEndsAt,
  };
}

function emitScreenState(io, gameCode, liveGame) {
  io.to(`game:${gameCode}`).emit("screen:state", liveGame.screen);
}

function emitQuestionState(io, gameCode, question, liveGame) {
  io.to(`game:${gameCode}`).emit("question:show", buildQuestionPublicData(question, liveGame));
}

function closeCurrentQuestion(io, gameCode, reason = "manual") {
  const liveGame = ensureGame(gameCode);
  if (!liveGame.currentQuestion || liveGame.currentQuestionStatus === "closed") return false;

  clearQuestionTimer(gameCode);
  liveGame.currentQuestionStatus = "closed";
  liveGame.timerEndsAt = null;

  io.to(`game:${gameCode}`).emit("question:closed", { questionId: liveGame.currentQuestion.id, reason });
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

async function emitSessionLeaderboard(io, game, sessionId) {
  const leaderboard = await all(
    `SELECT id, name, score
     FROM players
     WHERE game_id = ? AND session_id = ?
     ORDER BY score DESC, id ASC`,
    [game.id, sessionId]
  );
  io.to(`game:${game.code}`).emit("leaderboard:update", {
    leaderboard: leaderboard.map((player, index) => ({ ...player, place: index + 1 })),
  });
}

async function emitRoundScoreSummary(io, game, sessionId, roundId) {
  const rows = await all(
    `SELECT p.id, p.name, p.score AS total_score,
            COALESCE(SUM(pa.score_delta), 0) AS round_score
     FROM players p
     LEFT JOIN player_answers pa
       ON pa.player_id = p.id
      AND pa.session_id = p.session_id
      AND pa.game_id = p.game_id
      AND pa.question_id IN (SELECT id FROM questions WHERE round_id = ?)
     WHERE p.game_id = ? AND p.session_id = ?
     GROUP BY p.id
     ORDER BY p.score DESC, p.id ASC`,
    [roundId, game.id, sessionId]
  );

  io.to(`game:${game.code}`).emit("round:finished", { roundId, rows });
}

async function startQuestion(io, game, roundId) {
  const liveGame = ensureGame(game.code);
  if (!liveGame.currentSessionId) return { error: "Запуск не активирован" };

  if (liveGame.activeRoundId !== Number(roundId)) {
    liveGame.activeRoundId = Number(roundId);
    liveGame.roundQuestionIndex = -1;
  }

  closeCurrentQuestion(io, game.code, "next_question");

  const questions = await all(
    `SELECT q.*
     FROM questions q
     WHERE q.game_id = ? AND q.round_id = ?
     ORDER BY q.sort_order ASC, q.id ASC`,
    [game.id, liveGame.activeRoundId]
  );

  liveGame.roundQuestionIndex += 1;
  const question = questions[liveGame.roundQuestionIndex];

  if (!question) {
    liveGame.currentQuestion = null;
    liveGame.currentQuestionStatus = "closed";
    clearQuestionTimer(game.code);
    await emitRoundScoreSummary(io, game, liveGame.currentSessionId, liveGame.activeRoundId);
    return { finishedRound: true, roundId: liveGame.activeRoundId };
  }

  resetQuestionState(game.code);
  const payload = JSON.parse(question.payload_json || "{}");
  liveGame.currentQuestion = {
    id: question.id,
    roundId: question.round_id,
    type: question.type,
    title: question.title,
    payload,
  };
  liveGame.currentQuestionStatus = "active";
  liveGame.timerEndsAt = payload.timeLimitSec ? Date.now() + Number(payload.timeLimitSec) * 1000 : null;

  emitQuestionState(io, game.code, question, liveGame);
  io.to(`host:${game.code}`).emit("question:status", {
    questionId: question.id,
    status: liveGame.currentQuestionStatus,
    reason: "started",
  });
  scheduleQuestionClose(io, game.code);

  return { ok: true, questionId: question.id, roundId: liveGame.activeRoundId };
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
      const questionType = String(roundInput.questionType || "abcd").trim();
      await run(
        "INSERT INTO rounds (game_id, name, question_type, question_count, settings_json, sort_order) VALUES (?, ?, ?, 9999, '{}', ?)",
        [gameId, roundName.slice(0, 120), questionType, roundIndex + 1]
      );
    }
  } else {
    await run(
      "INSERT INTO rounds (game_id, name, question_type, question_count, settings_json, sort_order) VALUES (?, ?, 'abcd', 9999, '{}', 1)",
      [gameId, "Раунд 1"]
    );
  }

  res.json({ ok: true, gameId, code });
});

router.post("/admin/games/:id/start", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const maxSession = await get("SELECT COALESCE(MAX(session_number), 0) AS maxSession FROM game_sessions WHERE game_id = ?", [game.id]);
  const sessionNumber = Number(maxSession.maxSession || 0) + 1;
  const session = await run(
    "INSERT INTO game_sessions (game_id, session_number, status) VALUES (?, ?, 'live')",
    [game.id, sessionNumber]
  );

  await run("UPDATE games SET status = 'live', current_session_id = ? WHERE id = ?", [session.lastID, game.id]);

  const liveGame = ensureGame(game.code);
  liveGame.status = "live";
  liveGame.currentSessionId = session.lastID;
  resetSessionState(game.code);

  const io = req.app.get("io");
  io.to(`game:${game.code}`).emit("game:started", { code: game.code, title: game.title, sessionId: session.lastID, mode: "new" });
  emitScreenState(io, game.code, liveGame);

  res.json({ ok: true, sessionId: session.lastID, sessionNumber });
});

router.post("/admin/games/:id/continue", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const sessionId = Number(req.body.sessionId || game.current_session_id || 0);
  if (!sessionId) return res.status(400).json({ error: "Session not selected" });

  const session = await get("SELECT * FROM game_sessions WHERE id = ? AND game_id = ?", [sessionId, game.id]);
  if (!session) return res.status(404).json({ error: "Session not found" });

  await run("UPDATE game_sessions SET status = 'live', ended_at = NULL WHERE id = ?", [session.id]);
  await run("UPDATE games SET status = 'live', current_session_id = ? WHERE id = ?", [session.id, game.id]);

  const liveGame = ensureGame(game.code);
  liveGame.status = "live";
  liveGame.currentSessionId = session.id;
  resetSessionState(game.code, { keepPlayers: true });

  const players = await all("SELECT id, name FROM players WHERE game_id = ? AND session_id = ?", [game.id, session.id]);
  players.forEach((player) => liveGame.players.set(player.id, player));

  const io = req.app.get("io");
  io.to(`game:${game.code}`).emit("game:started", { code: game.code, title: game.title, sessionId: session.id, mode: "continue" });
  emitScreenState(io, game.code, liveGame);
  await emitSessionLeaderboard(io, game, session.id);

  res.json({ ok: true, sessionId: session.id, sessionNumber: session.session_number });
});

router.post("/admin/games/:id/start-round", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const roundId = Number(req.body.roundId || 0);
  const round = await get("SELECT id FROM rounds WHERE id = ? AND game_id = ?", [roundId, game.id]);
  if (!round) return res.status(400).json({ error: "Round not found" });

  const result = await startQuestion(req.app.get("io"), game, roundId);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, ...result });
});

router.post("/admin/games/:id/next-question", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const liveGame = ensureGame(game.code);
  if (!liveGame.activeRoundId) return res.status(400).json({ error: "Сначала выберите и запустите раунд" });

  const result = await startQuestion(req.app.get("io"), game, liveGame.activeRoundId);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, ...result });
});

router.post("/admin/games/:id/close-question", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const closed = closeCurrentQuestion(req.app.get("io"), game.code, "host");
  res.json({ ok: true, closed });
});

router.post("/admin/games/:id/finish", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const io = req.app.get("io");
  closeCurrentQuestion(io, game.code, "finish");

  if (game.current_session_id) {
    await run(
      "UPDATE game_sessions SET status = 'finished', ended_at = CURRENT_TIMESTAMP WHERE id = ?",
      [game.current_session_id]
    );
  }
  await run("UPDATE games SET status = 'draft', current_session_id = NULL WHERE id = ?", [game.id]);

  const liveGame = ensureGame(game.code);
  liveGame.status = "finished";
  liveGame.currentSessionId = null;
  resetSessionState(game.code);
  emitScreenState(io, game.code, liveGame);

  io.to(`game:${game.code}`).emit("game:finished", { reason: "host_finish" });

  res.json({ ok: true });
});

router.post("/admin/games/:id/reveal-answer", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const liveGame = ensureGame(game.code);
  if (!liveGame.currentQuestion) return res.status(400).json({ error: "Нет активного вопроса" });

  req.app.get("io").to(`game:${game.code}`).emit("question:answer", {
    questionId: liveGame.currentQuestion.id,
    type: liveGame.currentQuestion.type,
    payload: liveGame.currentQuestion.payload,
    text: getCorrectAnswerText(liveGame.currentQuestion),
  });

  res.json({ ok: true });
});

router.post("/admin/games/:id/screen", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Game not found" });

  const liveGame = ensureGame(game.code);
  const key = String(req.body.key || "");
  const allowed = ["showQr", "showLeaderboard", "showPlayers", "showWinners", "showRoundScores"];
  if (!allowed.includes(key)) return res.status(400).json({ error: "Unsupported key" });

  liveGame.screen[key] = !liveGame.screen[key];
  emitScreenState(req.app.get("io"), game.code, liveGame);

  if (key === "showLeaderboard" || key === "showWinners") {
    if (game.current_session_id) {
      await emitSessionLeaderboard(req.app.get("io"), game, game.current_session_id);
    }
  }

  res.json({ ok: true, screen: liveGame.screen });
});

module.exports = router;
