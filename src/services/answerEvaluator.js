function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function evaluateAnswer(question, answer) {
  if (!question || !question.type || !question.payload) {
    return { isCorrect: false, scoreDelta: 0 };
  }

  if (question.type === "abcd") {
    const selectedIndex = Number(answer && answer.optionIndex);
    const correct = Number(question.payload.correct);
    const isCorrect = Number.isInteger(selectedIndex) && selectedIndex === correct;
    return { isCorrect, scoreDelta: isCorrect ? 100 : 0 };
  }

  if (question.type === "text") {
    const userText = normalizeText(answer && answer.text);
    const correctText = normalizeText(question.payload.correctAnswer || question.payload.correctText);
    const isCorrect = Boolean(userText) && userText === correctText;
    return { isCorrect, scoreDelta: isCorrect ? 100 : 0 };
  }

  if (question.type === "number") {
    const userNumber = Number(answer && answer.number);
    const correctNumber = Number(question.payload.correctNumber);
    const isCorrect = Number.isFinite(userNumber) && userNumber === correctNumber;
    return { isCorrect, scoreDelta: isCorrect ? 100 : 0 };
  }

  return { isCorrect: false, scoreDelta: 0 };
}

function getCorrectAnswerText(question) {
  if (!question || !question.payload) return "";
  if (question.type === "abcd") {
    const correct = Number(question.payload.correct);
    const options = Array.isArray(question.payload.options) ? question.payload.options : [];
    return options[correct] ? `Верный ответ: ${options[correct]}` : "";
  }
  if (question.type === "text") return `Верный ответ: ${question.payload.correctAnswer || question.payload.correctText || ""}`;
  if (question.type === "number") return `Верный ответ: ${question.payload.correctNumber}`;
  return "";
}

module.exports = {
  evaluateAnswer,
  getCorrectAnswerText,
  normalizeText,
};
