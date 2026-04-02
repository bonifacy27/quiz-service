const { run, get } = require("../db");
const { ensureGame } = require("../services/gameState");

function registerGameSocket(io) {
  io.on("connection", (socket) => {
    socket.on("host:join", async ({ gameCode }) => {
      socket.join(`game:${gameCode}`);
      socket.join(`host:${gameCode}`);
      socket.emit("host:joined", { ok: true });
    });

    socket.on("screen:join", async ({ gameCode }) => {
      socket.join(`game:${gameCode}`);
      socket.join(`screen:${gameCode}`);
      socket.emit("screen:joined", { ok: true });
    });

    socket.on("player:join", async ({ gameCode, playerId, sessionToken }) => {
      const player = await get(
        "SELECT * FROM players WHERE id = ? AND session_token = ?",
        [playerId, sessionToken]
      );
      if (!player) {
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

      socket.emit("player:joined", { ok: true, player: { id: player.id, name: player.name } });
    });

    socket.on("answer:submit", async ({ gameCode, playerId, answer }) => {
      const liveGame = ensureGame(gameCode);
      if (!liveGame.currentQuestion) return;

      const answerKey = `${liveGame.currentQuestion.id}:${playerId}`;
      if (liveGame.answers.has(answerKey)) return;

      liveGame.answers.set(answerKey, answer);

      await run(
        "INSERT INTO player_answers (game_id, question_id, player_id, answer_json) VALUES (?, ?, ?, ?)",
        [0, liveGame.currentQuestion.id, playerId, JSON.stringify(answer)]
      );

      io.to(`host:${gameCode}`).emit("answer:received", {
        playerId,
        answer,
        questionId: liveGame.currentQuestion.id,
      });
    });

    socket.on("buzz:press", ({ gameCode, playerId }) => {
      const liveGame = ensureGame(gameCode);
      if (!liveGame.currentQuestion || liveGame.currentQuestion.type !== "buzz") return;
      if (liveGame.buzzWinnerPlayerId) return;

      liveGame.buzzWinnerPlayerId = playerId;

      io.to(`game:${gameCode}`).emit("buzz:winner", {
        playerId,
      });
    });

    socket.on("disconnect", async () => {
      if (socket.data.playerId) {
        await run("UPDATE players SET connected = 0 WHERE id = ?", [socket.data.playerId]);
      }
    });
  });
}

module.exports = registerGameSocket;
