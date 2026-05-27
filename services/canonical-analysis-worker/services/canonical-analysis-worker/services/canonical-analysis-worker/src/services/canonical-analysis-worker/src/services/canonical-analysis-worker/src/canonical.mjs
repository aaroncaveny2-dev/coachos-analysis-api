export function normalizeEvaluation(evalResult) {
  if (!evalResult) {
    return {
      cp: 0,
      bestmove: null,
    };
  }

  return {
    cp: evalResult.cp ?? 0,
    bestmove: evalResult.bestmove ?? null,
  };
}
