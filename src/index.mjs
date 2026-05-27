import { UCIEngine } from "./uci.mjs";

console.log("[boot] canonical-analysis-worker starting");
console.log("[boot] DATABASE_URL present?", Boolean(process.env.DATABASE_URL));
console.log("[boot] STOCKFISH_DEPTH", process.env.STOCKFISH_DEPTH || "14");

async function main() {
  const engine = new UCIEngine();

  console.log("[boot] starting stockfish");
  await engine.init();
  console.log("[boot] stockfish ready");

  console.log("[boot] queue polling started");

  setInterval(() => {
    console.log("[hb] worker alive, polling queue");
  }, 30000);

  // Temporary proof that Stockfish works
  const score = await engine.evaluateFen(
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
  );

  console.log("[test] starting position eval", score);

  while (true) {
    console.log("[poll] worker running");

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
