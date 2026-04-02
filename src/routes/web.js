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
  res.render("player", { game, player: req.session.player });
});

router.get("/game/:code", async (req, res) => {
  const game = await get("SELECT * FROM games WHERE code = ?", [req.params.code]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const qrUrl = `${config.appUrl}/join/${game.code}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl);
  res.render("screen", { game, qrUrl, qrDataUrl });
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

router.get("/admin/games/:id/control", requireAdmin, async (req, res) => {
  const game = await get("SELECT * FROM games WHERE id = ?", [req.params.id]);
  if (!game) return res.status(404).render("error", { message: "Игра не найдена" });

  const questions = await all(
    "SELECT * FROM questions WHERE game_id = ? ORDER BY sort_order ASC, id ASC",
    [game.id]
  );

  res.render("admin-game-control", { game, questions, user: req.session.user });
});

module.exports = router;
