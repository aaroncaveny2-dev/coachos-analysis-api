import { spawn } from "child_process";

export async function evaluatePosition({
  fen,
  stockfishPath,
  depth = 14,
}) {
  return new Promise((resolve, reject) => {
    const engine = spawn(stockfishPath);

    let bestMove = null;
    let evaluation = null;

    const timeout = setTimeout(() => {
      engine.kill();
      reject(new Error("stockfish timeout"));
    }, 15000);

    engine.stdout.on("data", (data) => {
      const text = data.toString();

      const lines = text.split("\n");

      for (const line of lines) {
        if (line.includes("score cp")) {
          const match = line.match(/score cp (-?\d+)/);

          if (match) {
            evaluation = Number(match[1]);
          }
        }

        if (line.includes("score mate")) {
          const match = line.match(/score mate (-?\d+)/);

          if (match) {
            const mate = Number(match[1]);

            evaluation = mate > 0 ? 100000 : -100000;
          }
        }

        if (line.startsWith("bestmove")) {
          const parts = line.trim().split(" ");

          bestMove = parts[1];

          clearTimeout(timeout);

          engine.kill();

          resolve({
            cp: evaluation,
            bestmove: bestMove,
          });
        }
      }
    });

    engine.stderr.on("data", (data) => {
      console.error("[stockfish stderr]", data.toString());
    });

    engine.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    engine.stdin.write("uci\n");
    engine.stdin.write("isready\n");
    engine.stdin.write(`position fen ${fen}\n`);
    engine.stdin.write(`go depth ${depth}\n`);
  });
}
