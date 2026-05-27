import { spawn } from "child_process";

const STOCKFISH_PATH =
  process.env.STOCKFISH_PATH || "/usr/games/stockfish";

const DEFAULT_DEPTH = Number(process.env.STOCKFISH_DEPTH || 14);

export class UCIEngine {
  constructor() {
    this.engine = spawn(STOCKFISH_PATH);
    this.ready = false;
  }

  async init() {
    return new Promise((resolve, reject) => {
      let initialized = false;

      this.engine.stdout.on("data", (data) => {
        const text = data.toString();

        if (text.includes("uciok") && !initialized) {
          initialized = true;
          this.ready = true;
          resolve();
        }
      });

      this.engine.stderr.on("data", (data) => {
        console.error("[stockfish stderr]", data.toString());
      });

      this.engine.on("error", reject);

      this.engine.stdin.write("uci\n");
    });
  }

  async evaluateFen(fen, depth = DEFAULT_DEPTH) {
    return new Promise((resolve, reject) => {
      let latestScore = null;

      const onData = (data) => {
        const text = data.toString();

        const lines = text.split("\n");

        for (const line of lines) {
          if (line.includes("score cp")) {
            const match = line.match(/score cp (-?\d+)/);

            if (match) {
              latestScore = Number(match[1]);
            }
          }

          if (line.startsWith("bestmove")) {
            this.engine.stdout.off("data", onData);
            resolve(latestScore);
          }
        }
      };

      this.engine.stdout.on("data", onData);

      this.engine.stdin.write(`position fen ${fen}\n`);
      this.engine.stdin.write(`go depth ${depth}\n`);

      setTimeout(() => {
        this.engine.stdout.off("data", onData);
        reject(new Error("Stockfish timeout"));
      }, 30000);
    });
  }

  close() {
    this.engine.stdin.write("quit\n");
    this.engine.kill();
  }
}
