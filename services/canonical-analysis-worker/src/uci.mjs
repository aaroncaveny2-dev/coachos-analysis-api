import { spawn } from "child_process";

function parseInfoLine(line) {
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const depthMatch = line.match(/\bdepth (\d+)/);
  const pvMatch = line.match(/\bpv (.+)$/);

  let cp = null;

  if (cpMatch) cp = Number(cpMatch[1]);
  if (mateMatch) cp = Number(mateMatch[1]) > 0 ? 100000 : -100000;

  return {
    cp,
    depth: depthMatch ? Number(depthMatch[1]) : null,
    pv: pvMatch ? pvMatch[1] : null
  };
}

export function analyzeFen({ fen, stockfishPath, depth = 14, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const engine = spawn(stockfishPath, [], { stdio: "pipe" });

    let latest = { cp: 0, depth, pv: null };
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        engine.stdin.write("quit\n");
        engine.kill();
      } catch {}
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error("stockfish timeout")), timeoutMs);

    engine.stdout.on("data", (chunk) => {
      const lines = chunk.toString("utf8").split(/\r?\n/);

      for (const line of lines) {
        if (line.startsWith("info ")) {
          const parsed = parseInfoLine(line);
          if (parsed.cp !== null) latest.cp = parsed.cp;
          if (parsed.depth !== null) latest.depth = parsed.depth;
          if (parsed.pv !== null) latest.pv = parsed.pv;
        }

        if (line.startsWith("bestmove ")) {
          const bestmove = line.split(/\s+/)[1];
          finish(null, { ...latest, bestmove });
        }
      }
    });

    engine.stderr.on("data", (chunk) => {
      console.error("[stockfish]", chunk.toString("utf8"));
    });

    engine.on("error", finish);

    engine.stdin.write("uci\n");
    engine.stdin.write("isready\n");
    engine.stdin.write(`position fen ${fen}\n`);
    engine.stdin.write(`go depth ${depth}\n`);
  });
}
