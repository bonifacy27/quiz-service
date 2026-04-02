const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const QRCode = require("qrcode");
const config = require("../config");
const { get, all, run } = require("../db");
const { ensureGame } = require("../services/gameState");

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/admin/login");
  next();
}

function buildQuestionPayload(type, body) {
  const timeLimitSec = Number(body.timeLimitSec || 0);

  if (type === "abcd") {
    const options = [
      String(body.option1 || "").trim(),
      String(body.option2 || "").trim(),
      String(body.option3 || "").trim(),
      String(body.option4 || "").trim(),
    ];

    if (options.some((opt) => !opt)) {
      return { error: "Для типа abcd заполните 4 варианта ответа" };
    }

    const correct = Number(body.correct);
    if (![0, 1, 2, 3].includes(correct)) {
      return { error: "Для типа abcd выберите правильный ответ" };
    }

    return {
      payload: {
        options,
        correct,
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : 15,
      },
    };
  }

  if (type === "text") {
    const correctText = String(body.correctText || "").trim();
    if (!correctText) return { error: "Для типа text заполните правильный текстовый ответ" };

    return {
      payload: {
        correctText,
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : 30,
      },
    };
  }

  if (type === "number") {
    const correctNumber = Number(body.correctNumber);
    if (!Number.isFinite(correctNumber)) {
      return { error: "Для типа number укажите корректное число" };
    }

    return {
      payload: {
        correctNumber,
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : 30,
      },
    };
  }

  if (type === "buzz") {
    return {
      payload: {
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : 10,
      },
    };
  }

  return { error: "Неподдерживаемый тип вопроса" };
}

router.get("/", async (req, res) => {
  const games = await all("SELECT * FROM games ORDER BY id DESC LIMIT 10");
  res.render("index", { games, user: req.session.user || null });
});

router.get("/join/:code", async (req, res) => {
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });
  res.render("join", { game });
});

router.post("/join/:code", async (req, res) => {
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).render("error", { message: "Введите имя игрока" });

  const sessionToken = crypto.randomUUID();
  const result = await run(
    "INSERT INTO players (game_id, name, session_token, connected) VALUES (?, ?, ?, 1)",
    [game.id, name, sessionToken]
  );

  req.session.player = {
    id: result.lastID,
    name,
    sessionToken,
    gameCode: game.code,
    gameId: game.id,
  };

  const liveGame = ensureGame(game.code);
  liveGame.players.set(result.lastID, { id: result.lastID, name });

  res.redirect(`/player/${game.code}`);
});

router.get("/player/:code", async (req, res) => {
  if (!req.session.player || req.session.player.gameCode !== req.params.code) {
    return res.redirect(`/join/${req.params.code}`);
  }
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  const leaderboard = await all(
    "SELECT id, name, score FROM players WHERE game_id = ? ORDER BY score DESC, id ASC",
    [game.id]
  );
  res.render("player", { game, player: req.session.player, leaderboard });
});

router.get("/game/:code", async (req, res) => {
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const qrUrl = `${config.appUrl}/join/${game.code}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl);
  const leaderboard = await all(
    "SELECT id, name, score FROM players WHERE game_id = ? ORDER BY score DESC, id ASC",
    [game.id]
  );
  res.render("screen", { game, qrUrl, qrDataUrl, leaderboard });
});

router.get("/admin/login", (req, res) => {
  res.render("admin-login", { error: null });
});

router.post("/admin/login", async (req, res) => {
  const login = String(req.body.login || "");
  const password = String(req.body.password || "");

  const user = await get("SELECT * FROM users WHERE login = ?", [login]);
  if (!user) return res.render("admin-login", { error: "Неверный логин или пароль" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render("admin-login", { error: "Неверный логин или пароль" });

  req.session.user = { id: user.id, login: user.login, role: user.role };
  res.redirect("/admin/dashboard");
});

router.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

router.get("/admin/dashboard", requireAdmin, async (req, res) => {
  const games = await all("SELECT * FROM games ORDER BY id DESC");
  res.render("admin-dashboard", { games, user: req.session.user });
});

router.get("/admin/games/new", requireAdmin, (req, res) => {
  res.render("admin-game-new", { user: req.session.user });
});

router.get("/admin/games/:id/edit", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  res.render("admin-game-edit", {
    game,
    user: req.session.user,
    error: null,
  });
});

router.post("/admin/games/:id/edit", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const title = String(req.body.title || "").trim().slice(0, 100);
  if (!title) {
    return res.status(400).render("admin-game-edit", {
      game,
      user: req.session.user,
      error: "Введите название игры",
    });
  }

  await run("UPDATE games SET title = ? WHERE id = ?", [title, game.id]);
  res.redirect("/admin/dashboard");
});

router.post("/admin/games/:id/delete", requireAdmin, async (req, res) => {
  const game = await get("SELECT id FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  await run("DELETE FROM player_answers WHERE game_id = ?", [game.id]);
  await run("DELETE FROM players WHERE game_id = ?", [game.id]);
  await run("DELETE FROM questions WHERE game_id = ?", [game.id]);
  await run("DELETE FROM games WHERE id = ?", [game.id]);

  res.redirect("/admin/dashboard");
});

router.post("/admin/games/:id/questions", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const type = String(req.body.type || "").trim();
  const title = String(req.body.title || "").trim().slice(0, 200);
  if (!title) return res.status(400).render("error", { message: "Введите заголовок вопроса" });

  const { payload, error } = buildQuestionPayload(type, req.body);
  if (error) return res.status(400).render("error", { message: error });

  const order = await get("SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM questions WHERE game_id = ?", [game.id]);
  await run(
    "INSERT INTO questions (game_id, type, title, payload_json, sort_order) VALUES (?, ?, ?, ?, ?)",
    [game.id, type, title, JSON.stringify(payload), Number(order.maxOrder || 0) + 1]
  );

  res.redirect(`/admin/games/${game.id}/control`);
});

router.get("/admin/games/:id/questions/:questionId/edit", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const question = await get("SELECT * FROM questions WHERE id = ? AND game_id = ?", [req.params.questionId, game.id]);
  if (!question) return res.status(404).render("error", { message: "Вопрос не найден" });

  let payload = {};
  try {
    payload = JSON.parse(question.payload_json);
  } catch (_) {
    payload = {};
  }

  res.render("admin-question-edit", {
    game,
    question,
    payload,
    payloadText: JSON.stringify(payload, null, 2),
    user: req.session.user,
    error: null,
  });
});

router.post("/admin/games/:id/questions/:questionId/edit", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const question = await get("SELECT * FROM questions WHERE id = ? AND game_id = ?", [req.params.questionId, game.id]);
  if (!question) return res.status(404).render("error", { message: "Вопрос не найден" });

  const type = String(req.body.type || "").trim();
  const title = String(req.body.title || "").trim().slice(0, 200);
  const payloadText = String(req.body.payload_json || "").trim();

  if (!title) {
    return res.status(400).render("admin-question-edit", {
      game,
      question: { ...question, title, type },
      payload: {},
      payloadText,
      user: req.session.user,
      error: "Введите заголовок вопроса",
    });
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (_) {
    return res.status(400).render("admin-question-edit", {
      game,
      question: { ...question, title, type },
      payload: {},
      payloadText,
      user: req.session.user,
      error: "payload_json должен быть корректным JSON",
    });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).render("admin-question-edit", {
      game,
      question: { ...question, title, type },
      payload: {},
      payloadText,
      user: req.session.user,
      error: "payload_json должен быть JSON-объектом",
    });
  }

  await run("UPDATE questions SET type = ?, title = ?, payload_json = ? WHERE id = ? AND game_id = ?", [
    type,
    title,
    JSON.stringify(payload),
    question.id,
    game.id,
  ]);

  res.redirect(`/admin/games/${game.id}/control`);
});

router.post("/admin/games/:id/questions/:questionId/delete", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const question = await get("SELECT id FROM questions WHERE id = ? AND game_id = ?", [req.params.questionId, game.id]);
  if (!question) return res.status(404).render("error", { message: "Вопрос не найден" });

  await run("DELETE FROM player_answers WHERE question_id = ?", [question.id]);
  await run("DELETE FROM questions WHERE id = ? AND game_id = ?", [question.id, game.id]);

  res.redirect(`/admin/games/${game.id}/control`);
});

router.get("/admin/games/:id/control", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const questions = await all(
    "SELECT * FROM questions WHERE game_id = ? ORDER BY sort_order ASC, id ASC",
    [game.id]
  );
  const leaderboard = await all(
    "SELECT id, name, score FROM players WHERE game_id = ? ORDER BY score DESC, id ASC",
    [game.id]
  );

  res.render("admin-game-control", { game, questions, leaderboard, user: req.session.user });
});

module.exports = router;
