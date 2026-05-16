require("./instrument.js");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Chess } = require("chess.js");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

const LOVABLE_API_BASE = process.env.LOVABLE_API_BASE;
const LOVABLE_PROXY_TOKEN = process.env.LOVABLE_PROXY_TOKEN;
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "stockfish";
const STOCKFISH_DEPTH = Number(process.env.STOCKFISH_DEPTH || 6);
const POSITION_TIMEOUT_MS = 10000;
const GAME_TIMEOUT_MS = 5 * 60 * 1000;
if (!LOVABLE_API_BASE || !LOVABLE_PROXY_TOKEN) {
  console.error("Missing LOVABLE_API_BASE or LOVABLE_PROXY_TOKEN");
}

async function lovableFetch(path, options = {}) {
  const response = await fetch(`${LOVABLE_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOVABLE_PROXY_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Lovable proxy error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/test", (req, res) => {
  res.json({
    message: "Analysis API is reachable",
    lovableConfigured: Boolean(LOVABLE_API_BASE && LOVABLE_PROXY_TOKEN),
  });
});

function createEngine() {
  return new Promise((resolve, reject) => {
    const proc = spawn(STOCKFISH_PATH);
    let buffer = "";
    const listeners = [];

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();

      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        listeners.forEach((fn) => fn(line));
      }
    });

    proc.stderr.on("data", (chunk) => {
      console.error("Stockfish stderr:", chunk.toString());
    });

    proc.on("error", reject);

    const send = (cmd) => {
      proc.stdin.write(cmd + "\n");
    };

    const onLine = (fn) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    };

    const waitFor = (predicate, timeoutMs, label) =>
      new Promise((resolveWait, rejectWait) => {
        let off;

        const timer = setTimeout(() => {
          if (off) off();
          rejectWait(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        off = onLine((line) => {
          const result = predicate(line);
          if (result !== undefined) {
            clearTimeout(timer);
            off();
            resolveWait(result);
          }
        });
      });

    resolve({
      send,
      async init() {
        send("uci");
        await waitFor((line) => (line === "uciok" ? true : undefined), 5000, "uci init");

        send("isready");
        await waitFor((line) => (line === "readyok" ? true : undefined), 5000, "engine ready");
      },
      async evaluateFen(fen) {
        send("ucinewgame");
        send(`position fen ${fen}`);
        send(`go depth ${STOCKFISH_DEPTH}`);

        let lastScore = null;

        return waitFor(
          (line) => {
            const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
            if (scoreMatch) {
              const type = scoreMatch[1];
              const value = parseInt(scoreMatch[2], 10);
              lastScore = type === "mate" ? (value > 0 ? 10000 : -10000) : value;
            }

            const bestMoveMatch = line.match(/^bestmove (\S+)/);
            if (bestMoveMatch) {
              return {
                bestmove: bestMoveMatch[1],
                score: lastScore ?? 0,
              };
            }

            return undefined;
          },
          POSITION_TIMEOUT_MS,
          "position eval"
        );
      },
      async quit() {
        try {
          send("quit");
        } catch {}
        try {
          proc.kill();
        } catch {}
      },
    });
  });
}

function sideToMove(fen) {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function normalizeToWhiteScore(score, fen) {
  return sideToMove(fen) === "black" ? -score : score;
}

function calculateCentipawnLoss(evalBeforeWhite, evalAfterWhite, moverColor) {
  if (moverColor === "white") {
    return Math.max(0, evalBeforeWhite - evalAfterWhite);
  }

  return Math.max(0, evalAfterWhite - evalBeforeWhite);
}
 

function classify(cpl) {
  if (cpl < 30) return "good";
  if (cpl < 80) return "inaccuracy";
  if (cpl < 200) return "mistake";
  return "blunder";
}

function getPhase(plyIndex) {
  if (plyIndex < 20) return "opening";
  if (plyIndex < 60) return "middlegame";
  return "endgame";
}
app.get("/engine-test", async (req, res) => {
  let engine;

  try {
    engine = await createEngine();
    await engine.init();

    const result = await engine.evaluateFen(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    );

    await engine.quit();
    engine = null;

    res.json({
      ok: true,
      score: result.score,
      bestmove: result.bestmove,
      platform: process.platform,
      stockfishPath: STOCKFISH_PATH,
      depth: STOCKFISH_DEPTH,
    });
  } catch (err) {
    try {
      if (engine) await engine.quit();
    } catch {}

    res.status(500).json({
      ok: false,
      error: err.message,
      platform: process.platform,
      stockfishPath: STOCKFISH_PATH,
    });
  }
});app.post("/analyze-game", async (req, res) => {
  const { game_id } = req.body;
let game;

  try {
    if (!game_id) throw new Error("Missing game_id");

    console.log("Analyzing game:", game_id);

    const gameResponse = await lovableFetch(
      `/api/public/analysis/games?game_ids=${encodeURIComponent(game_id)}`
    );

   game = Array.isArray(gameResponse)
      ? gameResponse[0]
      : gameResponse.games?.[0];

    if (!game) throw new Error("Game not found from Lovable proxy");
    if (!game.pgn) throw new Error("Game has no PGN");
await lovableFetch("/api/public/analysis/jobs", {
  method: "POST",
  body: JSON.stringify({
    game_id,
    student_id: game.student_id,
    status: "running",
  }),
});
    const chess = new Chess();
    chess.loadPgn(game.pgn);

    const moves = chess.history({ verbose: true });
    chess.reset();

    const moveRows = [];
const engine = await createEngine();
await engine.init();

console.log(`[${game_id}] engine ready, analyzing ${moves.length} ply at depth ${STOCKFISH_DEPTH}`);

try {
  const startedAt = Date.now();

  for (let i = 0; i < moves.length; i++) {
    if (Date.now() - startedAt > GAME_TIMEOUT_MS) {
      throw new Error("Game analysis timed out after 5 minutes");
    }

    const move = moves[i];

    const fenBefore = chess.fen();
    const evalBeforeRaw = await engine.evaluateFen(fenBefore);
    const evalBefore = normalizeToWhiteScore(evalBeforeRaw.score, fenBefore);

    chess.move(move);

    const fenAfter = chess.fen();
    const evalAfterRaw = await engine.evaluateFen(fenAfter);
    const evalAfter = normalizeToWhiteScore(evalAfterRaw.score, fenAfter);

    const moverColor = move.color === "w" ? "white" : "black";
    const cpl = calculateCentipawnLoss(evalBefore, evalAfter, moverColor);

    moveRows.push({
      game_id,
      move_number: Math.ceil((i + 1) / 2),
      ply: i + 1,
      player_color: moverColor,
      san: move.san,
      uci: move.from + move.to + (move.promotion || ""),
      fen_before: fenBefore,
      fen_after: fenAfter,
      engine_eval_before: evalBefore,
      engine_eval_after: evalAfter,
      best_move: evalBeforeRaw.bestmove,
      centipawn_loss: cpl,
      classification: classify(cpl),
      phase: getPhase(i),
    });

    if ((i + 1) % 5 === 0) {
      console.log(`[${game_id}] progress ${i + 1}/${moves.length} ply`);
    }
  }
} finally {
  await engine.quit();
}

    await lovableFetch("/api/public/analysis/move-analysis", {
      method: "POST",
      body: JSON.stringify({
        game_id,
        replace: true,
        moves: moveRows,
      }),
    });

    await lovableFetch("/api/public/analysis/jobs", {
      method: "POST",
      body: JSON.stringify({
        game_id,
        student_id: game.student_id,
        status: "completed",
        completed_at: new Date().toISOString(),
      }),
    });

    res.json({
      success: true,
      game_id,
      moves_analyzed: moveRows.length,
    });
  } catch (err) {
    console.error("Analyze game failed:", err.message);

    try {
      await lovableFetch("/api/public/analysis/jobs", {
        method: "POST",
        body: JSON.stringify({
  game_id,
  student_id: game?.student_id || req.body.student_id || null,
  status: "failed",
  error_message: err.message,
}),
      });
    } catch (proxyErr) {
      console.error("Failed to mark job failed:", proxyErr.message);
    }

    res.status(500).json({ error: err.message });
  }
});

app.post("/analyze-student", async (req, res) => {
  const { student_id } = req.body;

  try {
    if (!student_id) throw new Error("Missing student_id");

    console.log("Analyzing student:", student_id);

    const gameResponse = await lovableFetch(
      `/api/public/analysis/games?student_id=${encodeURIComponent(
        student_id
      )}&limit=20`
    );

    const games = Array.isArray(gameResponse)
      ? gameResponse
      : gameResponse.games || [];

    console.log(`Found ${games.length} games`);

    if (!games.length) {
      return res.json({ success: true, message: "No games found" });
    }

    let totalBlunders = 0;
    let totalMistakes = 0;
    const phaseCounts = { opening: 0, middlegame: 0, endgame: 0 };
    const analyzedGames = [];

    for (const game of games) {
      try {
        const result = await fetch(
          `https://coachos-analysis-api.onrender.com/analyze-game`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ game_id: game.id }),
          }
        );

        if (!result.ok) {
          const errorText = await result.text();
          console.error(`Game ${game.id} failed:`, errorText);
          continue;
        }

        analyzedGames.push(game);
      } catch (err) {
        console.error(`Game ${game.id} failed:`, err.message);
      }
    }

    const summaryFocus =
      analyzedGames.length > 0
        ? "Review recent games for recurring mistakes"
        : "Analyze recent games";

    const summaryReason =
      analyzedGames.length > 0
        ? `CoachOS analyzed ${analyzedGames.length} recent games and found patterns that need review.`
        : "No games were successfully analyzed yet.";

    await lovableFetch("/api/public/analysis/student-summary", {
      method: "POST",
      body: JSON.stringify({
        student_id,
        games_analyzed: analyzedGames.length,
        avg_blunders_per_game:
          analyzedGames.length > 0
            ? Number((totalBlunders / analyzedGames.length).toFixed(2))
            : 0,
        weakest_phase: "middlegame",
        common_mistake_type: "review needed",
        suggested_focus: summaryFocus,
        reason: summaryReason,
        suggested_assignment:
          "Review 2 recent games and identify the first major mistake in each.",
      }),
    });

    res.json({
      success: true,
      games_found: games.length,
      games_analyzed: analyzedGames.length,
    });
  } catch (err) {
    console.error("Analyze student failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});
const Sentry = require("@sentry/node");

Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  res.status(500).json({
    error: "Internal server error",
    eventId: res.sentry || null,
  });
});
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});