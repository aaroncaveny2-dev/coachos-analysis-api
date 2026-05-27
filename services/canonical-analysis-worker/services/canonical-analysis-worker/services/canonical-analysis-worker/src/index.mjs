import { Pool } from "pg";
import { spawn } from "child_process";
import { Chess } from "chess.js";
import { evaluatePosition } from "./uci.mjs";
import { normalizeEvaluation } from "./canonical.mjs";

console.log("[boot] canonical-analysis-worker starting");

const DATABASE_URL = process.env.DATABASE_URL;
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "/usr/games/stockfish";
const STOCKFISH_DEPTH = Number(process.env.STOCKFISH_DEPTH || 14);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const WORKER_ID = process.env.WORKER_ID || "worker-1";

console.log("[boot] WORKER_ID=", WORKER_ID);
console.log("[boot] DATABASE_URL present?", !!DATABASE_URL);
console.log("[boot] STOCKFISH_PATH=", STOCKFISH_PATH);
console.log("[boot] STOCKFISH_DEPTH=", STOCKFISH_DEPTH);
console.log("[boot] POLL_INTERVAL_MS=", POLL_INTERVAL_MS);

if (!DATABASE_URL) {
  console.error("[fatal] DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection", err);
});

async function probeDatabase() {
  const client = await pool.connect();

  try {
    const result = await client.query("select 1 as ok");
    console.log("[boot] db connection OK", result.rows[0]);
  } finally {
    client.release();
  }
}

async function claimJob(client) {
  const sql = `
    WITH next AS (
      SELECT queue_id
      FROM public.game_reanalysis_queue
      WHERE status IN ('pending','paused')
        AND (next_retry_at IS NULL OR next_retry_at <= now())
        AND (
          locked_at IS NULL
          OR locked_at < now() - interval '10 minutes'
        )
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.game_reanalysis_queue q
    SET
      status='running',
      locked_at=now(),
      locked_by=$1,
      error=NULL
    FROM next
    WHERE q.queue_id = next.queue_id
    RETURNING q.*;
  `;

  const result = await client.query(sql, [WORKER_ID]);

  return result.rows[0] || null;
}

async function processJob(job) {
  console.log("[poll] processing game", job.game_id);

  const client = await pool.connect();

  try {
    const movesResult = await client.query(
      `
      SELECT *
      FROM public.game_move_analysis
      WHERE game_id = $1
      ORDER BY ply ASC
      `,
      [job.game_id]
    );

    const chess = new Chess();

    for (const row of movesResult.rows) {
      try {
        const fen = chess.fen();

        const evaluation = await evaluatePosition({
          fen,
          stockfishPath: STOCKFISH_PATH,
          depth: STOCKFISH_DEPTH,
        });

        const normalized = normalizeEvaluation(evaluation);

        await client.query(
          `
          UPDATE public.game_move_analysis
          SET
            analysis_version = 'v1-canonical-2026-05',
            eval_before_white = $1,
            invariant_status = 'ok',
            updated_at = now()
          WHERE id = $2
          `,
          [normalized.cp, row.id]
        );

        console.log("[poll] canonical row written ply", row.ply);

        if (row.san) {
          chess.move(row.san);
        }
      } catch (err) {
        console.error("[poll] failed ply", row.ply, err.message);
      }
    }

    await client.query(
      `
      UPDATE public.game_reanalysis_queue
      SET
        status='done',
        locked_at=NULL,
        locked_by=NULL,
        updated_at=now()
      WHERE queue_id = $1
      `,
      [job.queue_id]
    );

    console.log("[poll] completed job", job.queue_id);
  } finally {
    client.release();
  }
}

async function main() {
  await probeDatabase();

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
        console.log("[poll] claimed job", job.queue_id);

        await processJob(job);
      }
    } catch (err) {
      console.error("[poll] db error", err.message);
    } finally {
      client.release();
    }

    await new Promise((resolve) =>
      setTimeout(resolve, POLL_INTERVAL_MS)
    );
  }
}

main().catch((err) => {
  console.error("[fatal] startup failure", err);
  process.exit(1);
});
