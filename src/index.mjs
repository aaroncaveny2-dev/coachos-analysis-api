import { Pool } from "pg";
import { Chess } from "chess.js";
import { analyzeFen } from "./uci.mjs";
import { cpLossMover, makeEngineMetadata } from "./canonical.mjs";

const WORKER_ID = process.env.WORKER_ID || `worker-${Math.random().toString(36).slice(2, 8)}`;
const DATABASE_URL = process.env.DATABASE_URL;
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "/usr/games/stockfish";
const STOCKFISH_DEPTH = Number(process.env.STOCKFISH_DEPTH || 14);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const ANALYSIS_VERSION = "v1-canonical-2026-05";

console.log("[boot] canonical-analysis-worker starting");
console.log("[boot] WORKER_ID=", WORKER_ID);
console.log("[boot] DATABASE_URL present?", Boolean(DATABASE_URL));
console.log("[boot] STOCKFISH_PATH=", STOCKFISH_PATH);
console.log("[boot] STOCKFISH_DEPTH=", STOCKFISH_DEPTH);
console.log("[boot] POLL_INTERVAL_MS=", POLL_INTERVAL_MS);

if (!DATABASE_URL) {
  console.error("[fatal] DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err?.message || err);
});

process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err?.message || err);
});

async function claimJob(client) {
  const result = await client.query(
    `
    WITH next AS (
      SELECT queue_id
      FROM public.game_reanalysis_queue
      WHERE status IN ('pending','paused')
        AND (next_retry_at IS NULL OR next_retry_at <= now())
        AND (locked_at IS NULL OR locked_at < now() - interval '10 minutes')
      ORDER BY priority ASC, requested_at ASC NULLS LAST, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.game_reanalysis_queue q
    SET status = 'running',
        locked_at = now(),
        locked_by = $1,
        started_at = COALESCE(q.started_at, now()),
        error = NULL,
        updated_at = now()
    FROM next
    WHERE q.queue_id = next.queue_id
    RETURNING q.*;
    `,
    [WORKER_ID]
  );

  return result.rows[0] || null;
}

async function loadGame(client, gameId) {
  const gameResult = await client.query(
    `SELECT id, pgn FROM public.games WHERE id = $1`,
    [gameId]
  );

  if (!gameResult.rows[0]) throw new Error(`game not found: ${gameId}`);
  return gameResult.rows[0];
}

async function loadMoveRows(client, gameId) {
  const result = await client.query(
    `
    SELECT *
    FROM public.game_move_analysis
    WHERE game_id = $1
    ORDER BY ply ASC
    `,
    [gameId]
  );

  return result.rows;
}

async function updateQueueProgress(client, queueId, progress, total) {
  await client.query(
    `
    UPDATE public.game_reanalysis_queue
    SET progress_plies = $2,
        total_plies = $3,
        updated_at = now()
    WHERE queue_id = $1
    `,
    [queueId, progress, total]
  );
}

async function writeCanonicalRow(client, row, data) {
  await client.query(
    `
    UPDATE public.game_move_analysis
    SET analysis_version = $2,
        eval_before_white = $3,
        eval_after_white = $4,
        eval_best_white = $5,
        cp_loss_mover = $6,
        best_uci = $7,
        pv = $8,
        depth = $9,
        invariant_status = 'ok',
        invariant_failures = '[]'::jsonb,
        engine_metadata = $10::jsonb,
        updated_at = now()
    WHERE id = $1
    `,
    [
      row.id,
      ANALYSIS_VERSION,
      data.evalBefore,
      data.evalAfter,
      data.evalBest,
      data.cpLoss,
      data.bestUci,
      data.pv,
      data.depth,
      JSON.stringify(data.engineMetadata)
    ]
  );
}

async function processJob(job) {
  console.log("[poll] claimed job", job.queue_id, "game", job.game_id);

  const client = await pool.connect();

  try {
    const game = await loadGame(client, job.game_id);
    const rows = await loadMoveRows(client, job.game_id);

    if (!rows.length) throw new Error("no game_move_analysis rows found");

    const chess = new Chess();
    chess.loadPgn(game.pgn);

    const history = chess.history({ verbose: true });

    if (!history.length) throw new Error("PGN has no moves");

    if (history.length !== rows.length) {
      console.warn("[warn] PGN move count and move rows differ", {
        pgnMoves: history.length,
        rows: rows.length
      });
    }

    const replay = new Chess();
    const total = Math.min(history.length, rows.length);
    let written = 0;

    for (let i = 0; i < total; i++) {
      const row = rows[i];

      if (
        row.analysis_version === ANALYSIS_VERSION &&
        row.invariant_status === "ok" &&
        row.eval_before_white !== null &&
        row.eval_after_white !== null &&
        row.cp_loss_mover !== null
      ) {
        written++;
        await updateQueueProgress(client, job.queue_id, written, total);
        replay.move(history[i]);
        continue;
      }

      const move = history[i];
      const fenBefore = replay.fen();

      const before = await analyzeFen({
        fen: fenBefore,
        stockfishPath: STOCKFISH_PATH,
        depth: STOCKFISH_DEPTH
      });

      const played = replay.move(move);
      const fenAfter = replay.fen();

      const after = await analyzeFen({
        fen: fenAfter,
        stockfishPath: STOCKFISH_PATH,
        depth: STOCKFISH_DEPTH
      });

      let evalBest = before.cp;
      let bestUci = before.bestmove || null;

      const moverColor = move.color;
      const loss = cpLossMover({
        moverColor,
        evalBestWhite: evalBest,
        evalAfterWhite: after.cp,
        playedUci: `${move.from}${move.to}${move.promotion || ""}`,
        bestUci
      });

      const engineMetadata = makeEngineMetadata({
        depth: before.depth || STOCKFISH_DEPTH,
        analysisVersion: ANALYSIS_VERSION
      });

      await writeCanonicalRow(client, row, {
        evalBefore: before.cp,
        evalAfter: after.cp,
        evalBest,
        cpLoss: loss,
        bestUci,
        pv: before.pv || null,
        depth: before.depth || STOCKFISH_DEPTH,
        engineMetadata
      });

      written++;
      console.log("[poll] canonical row written", {
        game: job.game_id,
        ply: row.ply,
        san: row.san,
        cpLoss: loss
      });

      await updateQueueProgress(client, job.queue_id, written, total);
    }

    await client.query(
      `
      UPDATE public.game_reanalysis_queue
      SET status = 'done',
          locked_at = NULL,
          locked_by = NULL,
          finished_at = now(),
          progress_plies = $2,
          total_plies = $2,
          error = NULL,
          updated_at = now()
      WHERE queue_id = $1
      `,
      [job.queue_id, total]
    );

    console.log("[poll] completed job", job.queue_id);
  } catch (err) {
    console.error("[poll] job failed", job.queue_id, err?.message || err);

    await client.query(
      `
      UPDATE public.game_reanalysis_queue
      SET status = 'failed',
          locked_at = NULL,
          locked_by = NULL,
          error = $2,
          updated_at = now()
      WHERE queue_id = $1
      `,
      [job.queue_id, String(err?.message || err)]
    );
  } finally {
    client.release();
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const probe = await client.query("select 1 as probe");
    console.log("[boot] db connection OK", probe.rows[0]);
  } finally {
    client.release();
  }

  console.log("[boot] queue polling started");

  setInterval(() => {
    console.log("[hb] worker alive, polling queue");
  }, 30000);

  while (true) {
    const client = await pool.connect();

    try {
      const job = await claimJob(client);

      if (!job) {
        console.log("[poll] no claimable jobs");
      } else {
        await processJob(job);
      }
    } catch (err) {
      console.error("[poll] loop error:", err?.message || err);
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[fatal] worker crashed during startup:", err?.message || err);
  process.exit(1);
});
