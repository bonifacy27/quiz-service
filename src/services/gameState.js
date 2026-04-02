const state = {
  byGameCode: new Map(),
};

function ensureGame(code) {
  if (!state.byGameCode.has(code)) {
    state.byGameCode.set(code, {
      code,
      status: "lobby",
      currentQuestionIndex: -1,
      currentQuestion: null,
      players: new Map(),
      answers: new Map(),
      buzzWinnerPlayerId: null,
      timerEndsAt: null,
    });
  }
  return state.byGameCode.get(code);
}

function resetQuestionState(code) {
  const game = ensureGame(code);
  game.answers = new Map();
  game.buzzWinnerPlayerId = null;
  game.timerEndsAt = null;
}

module.exports = {
  ensureGame,
  resetQuestionState,
  state,
};
