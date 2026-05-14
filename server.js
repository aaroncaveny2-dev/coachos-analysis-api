require("./instrument.js");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Chess } = require("chess.js");
const Stockfish = require("stockfish");

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

const LOVABLE_API_BASE = process.env.LOVABLE_API_BASE;
const LOVABLE_PROXY_TOKEN = process.env.LOVABLE_PROXY_TOKEN;

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

function analyzePosition(fen) {
  return new Promise((resolve) => {
    const engine = Stockfish();
    let resolved = false;

    const finish = (score) => {
      if (resolved) return;
      resolved = true;
      try {
        engine.terminate();
      } catch {}
      resolve(score);
    };

    engine.onmessage = function (line) {
      if (typeof line !== "string") return;

      if (line.includes("score cp")) {
        const match = line.match(/score cp (-?\d+)/);
        if (match) finish(parseInt(match[1], 10));
      }

      if (line.includes("score mate")) {
        const match = line.match(/score mate (-?\d+)/);
        if (match) {
          const mate = parseInt(match[1], 10);
          finish(mate > 0 ? 10000 : -10000);
        }
      }
    };

    engine.postMessage("uci");
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage("go depth 8");

    setTimeout(() => finish(0), 8000);
  });
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

app.post("/analyze-game", async (req, res) => {
  const { game_id } = req.body;

  try {
    if (!game_id) throw new Error("Missing game_id");

    console.log("Analyzing game:", game_id);

    await lovableFetch("/api/public/analysis/jobs", {
      method: "POST",
      body: JSON.stringify({
        game_id,
        status: "running",
      }),
    });

    const gameResponse = await lovableFetch(
      `/api/public/analysis/games?game_ids=${encodeURIComponent(game_id)}`
    );

    const game = Array.isArray(gameResponse)
      ? gameResponse[0]
      : gameResponse.games?.[0];

    if (!game) throw new Error("Game not found from Lovable proxy");
    if (!game.pgn) throw new Error("Game has no PGN");

    const chess = new Chess();
    chess.loadPgn(game.pgn);

    const moves = chess.history({ verbose: true });
    chess.reset();

    const moveRows = [];

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];

      const fenBefore = chess.fen();
      const evalBefore = await analyzePosition(fenBefore);

      chess.move(move);

      const fenAfter = chess.fen();
      const evalAfter = await analyzePosition(fenAfter);

      const cpl = Math.abs(evalBefore - evalAfter);

      moveRows.push({
        game_id,
        move_number: Math.ceil((i + 1) / 2),
        ply: i + 1,
        player_color: move.color === "w" ? "white" : "black",
        san: move.san,
        uci: move.from + move.to + (move.promotion || ""),
        fen_before: fenBefore,
        fen_after: fenAfter,
        engine_eval_before: evalBefore,
        engine_eval_after: evalAfter,
        centipawn_loss: cpl,
        classification: classify(cpl),
        phase: getPhase(i),
      });
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