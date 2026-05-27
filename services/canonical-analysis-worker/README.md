# Canonical Analysis Worker

Background Stockfish worker for CoachOS canonical analysis.

## Render settings

### Service Type
Background Worker

### Root Directory
services/canonical-analysis-worker

### Runtime
Docker

### Dockerfile Path
Dockerfile

### Docker Build Context
.

### Docker Command
(blank)

## Environment Variables

DATABASE_URL=postgres connection string

Optional:

STOCKFISH_DEPTH=14
POLL_INTERVAL_MS=3000
WORKER_ID=worker-1

## Expected boot logs

[boot] canonical-analysis-worker starting
[boot] db connection OK
[boot] queue polling started
[hb] worker alive, polling queue
