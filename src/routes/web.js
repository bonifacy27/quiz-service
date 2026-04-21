const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const QRCode = require("qrcode");
const config = require("../config");
const { get, all, run } = require("../db");
const { ensureGame } = require("../services/gameState");
const { ensureExtendedGameSchema } = require("../services/schemaGuard");

const router = express.Router();
const upload = multer({
  dest: config.uploadDir,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});
const uploadQuestionMedia = multer({
  dest: config.uploadDir,
  limits: {
    fileSize: 30 * 1024 * 1024,
  },
});

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    if (req.xhr || String(req.headers.accept || "").includes("application/json")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.status(401).render("admin-login", { error: "Сессия истекла. Войдите снова." });
  }
  next();
}

function getPublicBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  if (host) return `${protocol}://${host}`;
  return config.appUrl;
}

function buildQuestionPayload(type, body) {
  const timeLimitSec = Number(body.timeLimitSec || 0);
  const imageUrl = String(body.imageUrl || "").trim();
  const mediaUrl = String(body.mediaUrl || "").trim();
  const mediaTypeRaw = String(body.mediaType || "").trim();
  const mediaType = mediaTypeRaw === "audio" || mediaTypeRaw === "video" ? mediaTypeRaw : "";
  const hostComment = String(body.hostComment || "").trim().slice(0, 2000);

  if (type === "abcd") {
    const rawOptions = Array.isArray(body.options) ? body.options : [body.option1, body.option2, body.option3, body.option4];
    const options = rawOptions.map((value) => String(value || "").trim()).filter(Boolean);

    if (options.length < 2) {
      return { error: "Для типа abcd заполните минимум 2 варианта ответа" };
    }

    const correct = Number(body.correct ?? body.correctIndex);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
      return { error: "Для типа abcd выберите правильный ответ" };
    }

    return {
      payload: {
        options,
        correct,
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : 15,
        imageUrl,
        mediaUrl,
        mediaType,
        hostComment,
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
        imageUrl,
        hostComment,
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
        imageUrl,
        hostComment,
      },
    };
  }

  if (type === "buzz") {
    return {
      payload: {
        timeLimitSec: timeLimitSec > 0 ? timeLimitSec : 10,
        imageUrl,
        hostComment,
      },
    };
  }

  return { error: "Неподдерживаемый тип вопроса" };
}

router.post("/admin/uploads/question-image", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не загружен" });
  const filename = path.basename(req.file.filename);
  return res.json({ ok: true, url: `/uploads/${filename}` });
});

router.post("/admin/uploads/question-media", requireAdmin, uploadQuestionMedia.single("media"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не загружен" });
  const ext = String(path.extname(req.file.originalname || "").toLowerCase());
  const mediaType = ext === ".mp3" ? "audio" : (ext === ".mp4" ? "video" : "");
  if (!mediaType) return res.status(400).json({ error: "Разрешены только .mp3 и .mp4 файлы" });
  const filename = path.basename(req.file.filename);
  return res.json({ ok: true, url: `/uploads/${filename}`, mediaType });
});

function parseRoundSettings(body = {}) {
  const answerTime = String(body.answerTime || "30");
  const mode = String(body.mode || "normal");
  const customAnswerTimeSec = Number(body.customAnswerTimeSec || 30);

  return {
    description: String(body.description || "").trim().slice(0, 2000),
    hostComment: String(body.hostComment || "").trim().slice(0, 2000),
    answerTime: ["60", "30", "custom"].includes(answerTime) ? answerTime : "30",
    customAnswerTimeSec: Number.isFinite(customAnswerTimeSec) && customAnswerTimeSec > 0 ? customAnswerTimeSec : 30,
    mode: mode === "fastest" ? "fastest" : "normal",
    allowAnswerChange: body.allowAnswerChange === "on",
    excludeFromTotal: body.excludeFromTotal === "on",
  };
}

function normalizeRoundSettings(settingsJson) {
  let parsed = {};
  try {
    parsed = JSON.parse(settingsJson || "{}");
  } catch (_) {
    parsed = {};
  }
  return {
    description: String(parsed.description || ""),
    hostComment: String(parsed.hostComment || ""),
    answerTime: ["60", "30", "custom"].includes(parsed.answerTime) ? parsed.answerTime : "30",
    customAnswerTimeSec: Number(parsed.customAnswerTimeSec || 30) > 0 ? Number(parsed.customAnswerTimeSec) : 30,
    mode: parsed.mode === "fastest" ? "fastest" : "normal",
    allowAnswerChange: Boolean(parsed.allowAnswerChange),
    excludeFromTotal: Boolean(parsed.excludeFromTotal),
  };
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
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });
  if (!game.current_session_id) {
    return res.status(400).render("error", { message: "Игра еще не запущена ведущим" });
  }

  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).render("error", { message: "Введите имя игрока" });

  const sessionToken = crypto.randomUUID();
  const result = await run(
    "INSERT INTO players (game_id, session_id, name, session_token, connected) VALUES (?, ?, ?, ?, 1)",
    [game.id, game.current_session_id, name, sessionToken]
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
  await ensureExtendedGameSchema();
  if (!req.session.player || req.session.player.gameCode !== req.params.code) {
    return res.redirect(`/join/${req.params.code}`);
  }
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game.current_session_id) return res.status(400).render("error", { message: "Игра не активна" });
  const leaderboard = await all(
    "SELECT id, name, score FROM players WHERE game_id = ? AND session_id = ? ORDER BY score DESC, id ASC",
    [game.id, game.current_session_id]
  );
  res.render("player", { game, player: req.session.player, leaderboard });
});

router.get("/game/:code", async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const qrUrl = `${getPublicBaseUrl(req)}/join/${game.code}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl);
  const leaderboard = await all(
    "SELECT id, name, score FROM players WHERE game_id = ? AND session_id = ? ORDER BY score DESC, id ASC",
    [game.id, game.current_session_id || 0]
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
  await ensureExtendedGameSchema();
  const game = await get("SELECT id FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  await run("DELETE FROM player_answers WHERE game_id = ?", [game.id]);
  await run("DELETE FROM players WHERE game_id = ?", [game.id]);
  await run("DELETE FROM questions WHERE game_id = ?", [game.id]);
  await run("DELETE FROM rounds WHERE game_id = ?", [game.id]);
  await run("DELETE FROM games WHERE id = ?", [game.id]);

  res.redirect("/admin/dashboard");
});

router.post("/admin/games/:id/questions", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const type = String(req.body.type || "").trim();
  const title = String(req.body.title || "").trim().slice(0, 200);
  if (!title) return res.status(400).render("error", { message: "Введите заголовок вопроса" });

  const roundId = Number(req.body.roundId);
  const points = Number(req.body.points || 100);
  const round = await get("SELECT * FROM rounds WHERE id = ? AND game_id = ?", [roundId, game.id]);
  if (!round) return res.status(400).render("error", { message: "Выберите раунд" });

  if (type !== round.question_type) {
    return res.status(400).render("error", {
      message: `В раунде "${round.name}" разрешены только вопросы типа ${round.question_type}`,
    });
  }

  const { payload, error } = buildQuestionPayload(round.question_type, req.body);
  if (error) return res.status(400).render("error", { message: error });

  const order = await get("SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM questions WHERE game_id = ? AND round_id = ?", [
    game.id,
    round.id,
  ]);
  await run(
    `INSERT INTO questions
      (game_id, round_id, type, title, payload_json, points, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [game.id, roundId, round.question_type, title, JSON.stringify(payload), points > 0 ? points : 100, Number(order.maxOrder || 0) + 1]
  );

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/questions/create", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Игра не найдена" });

  const type = String(req.body.type || "").trim();
  const title = String(req.body.title || "").trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: "Введите заголовок вопроса" });

  const roundId = Number(req.body.roundId);
  const points = Number(req.body.points || 100);
  const round = await get("SELECT * FROM rounds WHERE id = ? AND game_id = ?", [roundId, game.id]);
  if (!round) return res.status(400).json({ error: "Выберите раунд" });
  if (type !== round.question_type) {
    return res.status(400).json({ error: `В раунде "${round.name}" разрешены только вопросы типа ${round.question_type}` });
  }

  const { payload, error } = buildQuestionPayload(round.question_type, req.body);
  if (error) return res.status(400).json({ error });

  const order = await get("SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM questions WHERE game_id = ? AND round_id = ?", [
    game.id,
    round.id,
  ]);
  const result = await run(
    `INSERT INTO questions
      (game_id, round_id, type, title, payload_json, points, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [game.id, roundId, round.question_type, title, JSON.stringify(payload), points > 0 ? points : 100, Number(order.maxOrder || 0) + 1]
  );

  return res.json({
    ok: true,
    question: {
      id: result.lastID,
      title,
      type: round.question_type,
      points: points > 0 ? points : 100,
      payload,
    },
  });
});

router.post("/admin/games/:id/questions/reorder", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Игра не найдена" });

  const roundId = Number(req.body.roundId);
  const orderedQuestionIds = Array.isArray(req.body.orderedQuestionIds) ? req.body.orderedQuestionIds.map(Number) : [];
  if (!roundId || !orderedQuestionIds.length) return res.status(400).json({ error: "Некорректные данные сортировки" });

  await run("BEGIN");
  try {
    for (let index = 0; index < orderedQuestionIds.length; index += 1) {
      const questionId = orderedQuestionIds[index];
      await run(
        "UPDATE questions SET sort_order = ? WHERE id = ? AND game_id = ? AND round_id = ?",
        [index + 1, questionId, game.id, roundId]
      );
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }

  res.json({ ok: true });
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

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/questions/:questionId/compact-edit", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });
  const question = await get("SELECT * FROM questions WHERE id = ? AND game_id = ?", [req.params.questionId, game.id]);
  if (!question) return res.status(404).render("error", { message: "Вопрос не найден" });

  const title = String(req.body.title || "").trim().slice(0, 200);
  const points = Number(req.body.points || 100);
  if (!title) return res.status(400).render("error", { message: "Введите заголовок вопроса" });

  const { payload, error } = buildQuestionPayload(question.type, req.body);
  if (error) return res.status(400).render("error", { message: error });

  await run("UPDATE questions SET title = ?, payload_json = ?, points = ? WHERE id = ? AND game_id = ?", [
    title,
    JSON.stringify(payload),
    points > 0 ? points : 100,
    question.id,
    game.id,
  ]);

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/questions/:questionId/delete", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const question = await get("SELECT id FROM questions WHERE id = ? AND game_id = ?", [req.params.questionId, game.id]);
  if (!question) return res.status(404).render("error", { message: "Вопрос не найден" });

  await run("DELETE FROM player_answers WHERE question_id = ?", [question.id]);
  await run("DELETE FROM questions WHERE id = ? AND game_id = ?", [question.id, game.id]);

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/questions/:questionId/copy", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const question = await get("SELECT * FROM questions WHERE id = ? AND game_id = ?", [req.params.questionId, game.id]);
  if (!question) return res.status(404).render("error", { message: "Вопрос не найден" });

  const order = await get(
    "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM questions WHERE game_id = ? AND round_id = ?",
    [game.id, question.round_id]
  );
  await run(
    `INSERT INTO questions
      (game_id, round_id, type, title, payload_json, points, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      game.id,
      question.round_id,
      question.type,
      `${question.title} (копия)`.slice(0, 200),
      question.payload_json,
      question.points,
      Number(order.maxOrder || 0) + 1,
    ]
  );

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/rounds", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const nextRoundOrder = await get("SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM rounds WHERE game_id = ?", [game.id]);
  const defaultRoundName = `Раунд ${Number(nextRoundOrder.maxOrder || 0) + 1}`;
  const name = String(req.body.name || "").trim().slice(0, 120) || defaultRoundName;
  const questionType = String(req.body.questionType || "abcd").trim();
  const settings = parseRoundSettings(req.body);
  if (!["abcd", "text", "number", "buzz"].includes(questionType)) {
    return res.status(400).render("error", { message: "Выберите корректный тип вопросов раунда" });
  }

  const roundResult = await run(
    "INSERT INTO rounds (game_id, name, question_type, question_count, settings_json, sort_order) VALUES (?, ?, ?, 9999, ?, ?)",
    [
    game.id,
    name,
    questionType,
    JSON.stringify(settings),
    Number(nextRoundOrder.maxOrder || 0) + 1,
    ]
  );

  res.redirect(`/admin/games/${game.id}/build?editRound=${roundResult.lastID}`);
});

router.post("/admin/games/:id/rounds/reorder", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).json({ error: "Игра не найдена" });

  const orderedRoundIds = Array.isArray(req.body.orderedRoundIds) ? req.body.orderedRoundIds.map(Number) : [];
  if (!orderedRoundIds.length) return res.status(400).json({ error: "Некорректные данные сортировки" });

  await run("BEGIN");
  try {
    for (let index = 0; index < orderedRoundIds.length; index += 1) {
      const roundId = orderedRoundIds[index];
      await run("UPDATE rounds SET sort_order = ? WHERE id = ? AND game_id = ?", [index + 1, roundId, game.id]);
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }

  res.json({ ok: true });
});

router.post("/admin/games/:id/rounds/:roundId/update", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const round = await get("SELECT * FROM rounds WHERE id = ? AND game_id = ?", [req.params.roundId, game.id]);
  if (!round) return res.status(404).render("error", { message: "Раунд не найден" });

  const name = String(req.body.name || "").trim().slice(0, 120);
  const questionType = String(req.body.questionType || "").trim();
  const settings = parseRoundSettings(req.body);
  if (!name) return res.status(400).render("error", { message: "Введите название раунда" });
  if (!["abcd", "text", "number", "buzz"].includes(questionType)) {
    return res.status(400).render("error", { message: "Выберите корректный тип вопросов раунда" });
  }

  await run("UPDATE rounds SET name = ?, question_type = ?, settings_json = ? WHERE id = ? AND game_id = ?", [
    name,
    questionType,
    JSON.stringify(settings),
    round.id,
    game.id,
  ]);

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/rounds/:roundId/delete", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const round = await get("SELECT * FROM rounds WHERE id = ? AND game_id = ?", [req.params.roundId, game.id]);
  if (!round) return res.status(404).render("error", { message: "Раунд не найден" });

  const questionIds = await all("SELECT id FROM questions WHERE game_id = ? AND round_id = ?", [game.id, round.id]);
  for (const row of questionIds) {
    await run("DELETE FROM player_answers WHERE question_id = ?", [row.id]);
  }
  await run("DELETE FROM questions WHERE game_id = ? AND round_id = ?", [game.id, round.id]);
  await run("DELETE FROM rounds WHERE id = ? AND game_id = ?", [round.id, game.id]);

  res.redirect(`/admin/games/${game.id}/build`);
});

router.post("/admin/games/:id/rounds/:roundId/copy", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const round = await get("SELECT * FROM rounds WHERE id = ? AND game_id = ?", [req.params.roundId, game.id]);
  if (!round) return res.status(404).render("error", { message: "Раунд не найден" });

  const order = await get("SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM rounds WHERE game_id = ?", [game.id]);
  const roundResult = await run(
    "INSERT INTO rounds (game_id, name, question_type, question_count, settings_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    [
      game.id,
      `${round.name} (копия)`.slice(0, 120),
      round.question_type,
      round.question_count,
      round.settings_json || "{}",
      Number(order.maxOrder || 0) + 1,
    ]
  );

  const copiedRoundId = roundResult.lastID;
  const sourceQuestions = await all(
    "SELECT * FROM questions WHERE game_id = ? AND round_id = ? ORDER BY sort_order ASC, id ASC",
    [game.id, round.id]
  );
  for (const sourceQuestion of sourceQuestions) {
    await run(
      `INSERT INTO questions
        (game_id, round_id, type, title, payload_json, points, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        game.id,
        copiedRoundId,
        sourceQuestion.type,
        sourceQuestion.title,
        sourceQuestion.payload_json,
        sourceQuestion.points,
        sourceQuestion.sort_order,
      ]
    );
  }

  res.redirect(`/admin/games/${game.id}/build`);
});


router.get("/admin/games/:id/build", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  let rounds = await all("SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order ASC, id ASC", [game.id]);

  const questions = await all(
    `SELECT q.*, r.name AS round_name, r.question_type AS round_question_type
     FROM questions q
     LEFT JOIN rounds r ON r.id = q.round_id
     WHERE q.game_id = ?
     ORDER BY COALESCE(r.sort_order, 0) ASC, q.sort_order ASC, q.id ASC`,
    [game.id]
  );
  const questionsWithPayload = questions.map((question) => {
    let payload = {};
    try {
      payload = JSON.parse(question.payload_json || "{}");
    } catch (_) {
      payload = {};
    }
    return { ...question, payload };
  });
  const roundsWithSettings = rounds.map((round) => ({
    ...round,
    settings: normalizeRoundSettings(round.settings_json),
  }));
  const editRoundId = Number(req.query.editRound || 0);

  res.render("admin-game-build", {
    game,
    rounds: roundsWithSettings,
    questions: questionsWithPayload,
    editRoundId,
    user: req.session.user,
  });
});

router.get("/admin/games/:id/control", requireAdmin, async (req, res) => {
  await ensureExtendedGameSchema();
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  let rounds = await all("SELECT * FROM rounds WHERE game_id = ? ORDER BY sort_order ASC, id ASC", [game.id]);
  const questions = await all(
    "SELECT * FROM questions WHERE game_id = ? ORDER BY round_id ASC, sort_order ASC, id ASC",
    [game.id]
  );
  const sessions = await all(
    "SELECT * FROM game_sessions WHERE game_id = ? ORDER BY session_number DESC, id DESC",
    [game.id]
  );
  const currentSessionId = game.current_session_id || null;
  const players = currentSessionId
    ? await all(
      "SELECT id, name, score, connected FROM players WHERE game_id = ? AND session_id = ? ORDER BY score DESC, id ASC",
      [game.id, currentSessionId]
    )
    : [];
  const roundScoresRaw = await all(
    `SELECT pa.player_id, q.round_id, COALESCE(SUM(pa.score_delta), 0) AS score
     FROM player_answers pa
     JOIN questions q ON q.id = pa.question_id
     WHERE pa.game_id = ? AND pa.session_id = ?
     GROUP BY pa.player_id, q.round_id`,
    [game.id, currentSessionId || 0]
  );
  const roundScoresMap = new Map();
  roundScoresRaw.forEach((row) => {
    roundScoresMap.set(`${row.player_id}:${row.round_id}`, Number(row.score || 0));
  });
  const roundScoreTable = players.map((player) => ({
    playerId: player.id,
    name: player.name,
    total: player.score,
    byRound: rounds.map((round) => ({
      roundId: round.id,
      score: roundScoresMap.get(`${player.id}:${round.id}`) || 0,
    })),
  }));
  const joinUrl = `${getPublicBaseUrl(req)}/join/${game.code}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl);
  const questionsByRound = rounds.reduce((acc, round) => {
    acc[round.id] = questions
      .filter((question) => question.round_id === round.id)
      .map((question) => {
        let payload = {};
        try {
          payload = JSON.parse(question.payload_json || "{}");
        } catch (_) {
          payload = {};
        }
        return {
          id: question.id,
          roundId: question.round_id,
          sortOrder: question.sort_order,
          type: question.type,
          title: question.title,
          payload,
        };
      });
    return acc;
  }, {});

  res.render("admin-game-control", {
    game,
    rounds,
    sessions,
    currentSessionId,
    players,
    roundScoreTable,
    questionsByRound,
    joinUrl,
    qrDataUrl,
    user: req.session.user,
  });
});

module.exports = router;
