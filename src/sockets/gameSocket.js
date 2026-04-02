const { run, get, all } = require("../db");
const { ensureGame } = require("../services/gameState");
const { evaluateAnswer } = require("../services/answerEvaluator");

async function getLeaderboard(gameId) {
  const rows = await runLeaderboardQuery(gameId);
  return rows.map((row, index) => ({
    place: index + 1,
    playerId: row.id,
    name: row.name,
    score: row.score,
  }));
}

async function runLeaderboardQuery(gameId) {
  return all(
    "SELECT id, name, score FROM players WHERE game_id = ? ORDER BY score DESC, id ASC",
    [gameId]
  );
}

async function emitLeaderboard(io, gameCode, gameId) {
  const leaderboard = await getLeaderboard(gameId);
  io.to(`game:${gameCode}`).emit("leaderboard:update", { leaderboard });
}

async function emitLeaderboardToSocket(socket, gameCode) {
  const game = await get("SELECT id FROM games WHERE code = ?", [gameCode]);
  if (!game) return;
  const leaderboard = await getLeaderboard(game.id);
  socket.emit("leaderboard:update", { leaderboard });
}

function registerGameSocket(io) {
  io.on("connection", (socket) => {
    socket.on("host:join", async ({ gameCode }) => {
      socket.join(`game:${gameCode}`);
      socket.join(`host:${gameCode}`);
      await emitLeaderboardToSocket(socket, gameCode);
      socket.emit("host:joined", { ok: true });
    });

    socket.on("screen:join", async ({ gameCode }) => {
      socket.join(`game:${gameCode}`);
      socket.join(`screen:${gameCode}`);
      await emitLeaderboardToSocket(socket, gameCode);
      socket.emit("screen:joined", { ok: true });
    });

    socket.on("player:join", async ({ gameCode, playerId, sessionToken }) => {
      const player = await get(
        `SELECT p.*, g.code AS game_code
         FROM players p
         JOIN games g ON g.id = p.game_id
         WHERE p.id = ? AND p.session_token = ?`,
        [playerId, sessionToken]
      );
      if (!player || player.game_code !== gameCode) {
        socket.emit("error:message", { message: "Игрок не найден" });
        return;
      }

      socket.join(`game:${gameCode}`);
      socket.join(`player:${playerId}`);
      socket.data.playerId = player.id;
      socket.data.gameCode = gameCode;

      const liveGame = ensureGame(gameCode);
      liveGame.players.set(player.id, { id: player.id, name: player.name });

      await run("UPDATE players SET connected = 1 WHERE id = ?", [player.id]);

      io.to(`game:${gameCode}`).emit("player:list", {
        players: Array.from(liveGame.players.values()),
      });
      await emitLeaderboard(io, gameCode, player.game_id);

      socket.emit("player:joined", { ok: true, player: { id: player.id, name: player.name } });
    });

    socket.on("answer:submit", async ({ gameCode, playerId, answer }) => {
      const liveGame = ensureGame(gameCode);
      if (!liveGame.currentQuestion) return;
      if (liveGame.currentQuestion.type === "buzz") return;
      if (!socket.data.playerId || socket.data.playerId !== playerId) return;
      if (socket.data.gameCode !== gameCode) return;

      const answerKey = `${liveGame.currentQuestion.id}:${playerId}`;
      if (liveGame.answers.has(answerKey)) return;
      liveGame.answers.set(answerKey, { pending: true });

      const game = await get("SELECT id FROM games WHERE code = ?", [gameCode]);
      if (!game) {
        liveGame.answers.delete(answerKey);
        return;
      }

      const result = evaluateAnswer(liveGame.currentQuestion, answer);
      liveGame.answers.set(answerKey, {
        answer,
        isCorrect: result.isCorrect,
        scoreDelta: result.scoreDelta,
      });

      if (result.scoreDelta > 0) {
        await run("UPDATE players SET score = score + ? WHERE id = ? AND game_id = ?", [
          result.scoreDelta,
          playerId,
          game.id,
        ]);
      }

      await run(
        `INSERT INTO player_answers
          (game_id, question_id, player_id, answer_json, is_correct, score_delta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          game.id,
          liveGame.currentQuestion.id,
          playerId,
          JSON.stringify(answer || {}),
          result.isCorrect ? 1 : 0,
          result.scoreDelta,
        ]
      );

      io.to(`host:${gameCode}`).emit("answer:received", {
        playerId,
        answer,
        questionId: liveGame.currentQuestion.id,
        isCorrect: result.isCorrect,
        scoreDelta: result.scoreDelta,
      });
      io.to(`player:${playerId}`).emit("answer:result", {
        questionId: liveGame.currentQuestion.id,
        isCorrect: result.isCorrect,
        scoreDelta: result.scoreDelta,
      });
      await emitLeaderboard(io, gameCode, game.id);
    });

    socket.on("buzz:press", async ({ gameCode, playerId }) => {
      const liveGame = ensureGame(gameCode);
      if (!liveGame.currentQuestion || liveGame.currentQuestion.type !== "buzz") return;
      if (liveGame.buzzWinnerPlayerId) return;
      if (!socket.data.playerId || socket.data.playerId !== playerId) return;
      if (socket.data.gameCode !== gameCode) return;

      liveGame.buzzWinnerPlayerId = playerId;

      const game = await get("SELECT id FROM games WHERE code = ?", [gameCode]);
      if (!game) {
        liveGame.buzzWinnerPlayerId = null;
        return;
      }

      const answerKey = `${liveGame.currentQuestion.id}:${playerId}`;
      liveGame.answers.set(answerKey, { answer: { buzz: true }, isCorrect: true, scoreDelta: 100 });

      await run("UPDATE players SET score = score + 100 WHERE id = ? AND game_id = ?", [
        playerId,
        game.id,
      ]);
      await run(
        `INSERT INTO player_answers
          (game_id, question_id, player_id, answer_json, is_correct, score_delta)
         VALUES (?, ?, ?, ?, 1, 100)`,
        [game.id, liveGame.currentQuestion.id, playerId, JSON.stringify({ buzz: true })]
      );

      io.to(`game:${gameCode}`).emit("buzz:winner", {
        playerId,
      });
      io.to(`host:${gameCode}`).emit("answer:received", {
        playerId,
        answer: { buzz: true },
        questionId: liveGame.currentQuestion.id,
        isCorrect: true,
        scoreDelta: 100,
      });
      await emitLeaderboard(io, gameCode, game.id);
    });

    socket.on("disconnect", async () => {
      if (socket.data.playerId) {
        await run("UPDATE players SET connected = 0 WHERE id = ?", [socket.data.playerId]);
      }
    });
  });
}

module.exports = registerGameSocket;
