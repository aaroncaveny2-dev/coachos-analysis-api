export const ANALYSIS_VERSION = "v1-canonical-2026-05";

export function uciFromMove(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

export function computeCpLossMover({ moverColor, evalBestWhite, evalAfterWhite, playedUci, bestUci }) {
  if (playedUci && bestUci && playedUci === bestUci) return 0;

  const raw =
    moverColor === "w"
      ? evalBestWhite - evalAfterWhite
      : evalAfterWhite - evalBestWhite;

  return Math.max(0, Math.round(raw));
}

export function makeEngineMetadata({ depth }) {
  return {
    engine: "stockfish-worker",
    runtime: "render-background-worker",
    depth,
    multipv: 1,
    analysis_version: ANALYSIS_VERSION,
    generated_at: new Date().toISOString()
  };
}
