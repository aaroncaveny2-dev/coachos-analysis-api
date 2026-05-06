require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Chess } = require('chess.js');
const Stockfish = require('stockfish');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// HEALTH
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// RUN STOCKFISH ANALYSIS FOR A POSITION
function analyzePosition(fen) {
  return new Promise((resolve) => {
    const engine = Stockfish();

    let resolved = false;

    engine.onmessage = function (line) {
      if (typeof line !== 'string') return;

      if (line.includes('score cp')) {
        const match = line.match(/score cp (-?\d+)/);
        if (match && !resolved) {
          resolved = true;
          engine.terminate();
          resolve(parseInt(match[1], 10));
        }
      }

      if (line.includes('score mate')) {
        resolved = true;
        engine.terminate();
        resolve(10000); // treat mate as huge eval
      }
    };

    engine.postMessage('uci');
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage('go depth 10');
  });
}

// CLASSIFICATION
function classify(cpl) {
  if (cpl < 30) return 'good';
  if (cpl < 80) return 'inaccuracy';
  if (cpl < 200) return 'mistake';
  return 'blunder';
}

// PHASE
function getPhase(moveIndex) {
  if (moveIndex < 20) return 'opening';
  if (moveIndex < 60) return 'middlegame';
  return 'endgame';
}

// ANALYZE GAME
app.post('/analyze-game', async (req, res) => {
  const { game_id } = req.body;

  try {
    await supabase
      .from('game_analysis_jobs')
      .update({ status: 'running' })
      .eq('game_id', game_id);

    const { data: game } = await supabase
      .from('games')
      .select('*')
      .eq('id', game_id)
      .single();

    if (!game) throw new Error('Game not found');

    const chess = new Chess();
    chess.loadPgn(game.pgn);

    const moves = chess.history({ verbose: true });

    chess.reset();

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];

      const fenBefore = chess.fen();

      const evalBefore = await analyzePosition(fenBefore);

      chess.move(move);

      const fenAfter = chess.fen();

      const evalAfter = await analyzePosition(fenAfter);

      const cpl = Math.abs(evalBefore - evalAfter);

      await supabase.from('game_move_analysis').insert({
        game_id: game_id,
        move_number: Math.ceil((i + 1) / 2),
        ply: i + 1,
        player_color: move.color === 'w' ? 'white' : 'black',
        san: move.san,
        uci: move.from + move.to,
        fen_before: fenBefore,
        fen_after: fenAfter,
        engine_eval_before: evalBefore,
        engine_eval_after: evalAfter,
        centipawn_loss: cpl,
        classification: classify(cpl),
        phase: getPhase(i),
      });
    }

    await supabase
      .from('game_analysis_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('game_id', game_id);

    res.json({ success: true });

  } catch (err) {
    console.error(err);

    await supabase
      .from('game_analysis_jobs')
      .update({
        status: 'failed',
        error_message: err.message,
      })
      .eq('game_id', game_id);

    res.status(500).json({ error: err.message });
  }
});

// START
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});