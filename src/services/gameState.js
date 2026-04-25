const state = {
  byGameCode: new Map(),
};

function defaultScreenState() {
  return {
    showQr: true,
    showLeaderboard: false,
    showPlayers: false,
    showWinners: false,
    showRoundScores: false,
  };
}

function ensureGame(code) {
  if (!state.byGameCode.has(code)) {
    state.byGameCode.set(code, {
      code,
      status: "lobby",
      currentSessionId: null,
      activeRoundId: null,
      roundQuestionIndex: -1,
      currentQuestion: null,
      currentQuestionStatus: "closed",
      players: new Map(),
      answers: new Map(),
      buzzWinnerPlayerId: null,
      timerEndsAt: null,
      timerTimeout: null,
      screen: defaultScreenState(),
      activeRoundAnnouncement: null,
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

function resetSessionState(code, { keepPlayers = false } = {}) {
  const game = ensureGame(code);
  resetQuestionState(code);
  game.activeRoundId = null;
  game.roundQuestionIndex = -1;
  game.currentQuestion = null;
  game.screen = defaultScreenState();
  game.activeRoundAnnouncement = null;
  if (!keepPlayers) {
    game.players = new Map();
  }
}

module.exports = {
  ensureGame,
  clearQuestionTimer,
  resetQuestionState,
  resetSessionState,
  state,
};
