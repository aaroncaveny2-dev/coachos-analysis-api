export function normalizeFen(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

export function cpLoss(before, after, sideToMove) {
  if (
    before === null ||
    before === undefined ||
    after === null ||
    after === undefined
  ) {
    return null;
  }

  if (sideToMove === "w") {
    return before - after;
  }

  return after - before;
}

export function classifyLoss(loss) {
  if (loss === null || loss === undefined) return "unknown";

  const abs = Math.abs(loss);

  if (abs < 20) return "best";
  if (abs < 60) return "excellent";
  if (abs < 120) return "good";
  if (abs < 250) return "inaccuracy";
  if (abs < 500) return "mistake";

  return "blunder";
}
