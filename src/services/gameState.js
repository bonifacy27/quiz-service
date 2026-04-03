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
      currentQuestionStatus: "closed",
      players: new Map(),
      answers: new Map(),
      buzzWinnerPlayerId: null,
      timerEndsAt: null,
      timerTimeout: null,
    });
  }
  return state.byGameCode.get(code);
}

function clearQuestionTimer(code) {
  const game = ensureGame(code);
  if (game.timerTimeout) {
    clearTimeout(game.timerTimeout);
    game.timerTimeout = null;
  }
}

function resetQuestionState(code) {
  const game = ensureGame(code);
  clearQuestionTimer(code);
  game.answers = new Map();
  game.buzzWinnerPlayerId = null;
  game.timerEndsAt = null;
  game.currentQuestionStatus = "closed";
}

module.exports = {
  ensureGame,
  clearQuestionTimer,
  resetQuestionState,
  state,
};
