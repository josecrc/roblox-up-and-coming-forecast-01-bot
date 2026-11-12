/**
 * Calibrated probabilistic forecaster for Roblox Up-and-Coming top 10.
 * Combines rank momentum, player growth, 28-day age-out filtering, and a
 * sharp Laplace kernel (scale=1.6) with 0.25 unnamed mass.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const SCALE = 1.6;
const UNNAMED_SHARE = 0.25;
const MAX_CANDIDATES = 35;
const DAY_MS = 86_400_000;

interface ChartRow {
  rank: number;
  universe_id: number;
  playing?: number | null;
}

interface GameDetails {
  created?: string | null;
}

interface Snapshot {
  up_and_coming: ChartRow[];
  details?: Record<string, GameDetails> | null;
}

interface Task {
  places: number;
  output: string;
  window?: { from?: string };
}

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as Task;
const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l !== '');

const snapshots = lines.slice(-6).map((l) => JSON.parse(l) as Snapshot);
const last = snapshots[snapshots.length - 1]!;
const windowFromMs = task.window?.from ? Date.parse(task.window.from) : NaN;

const rankHistory = new Map<number, number[]>();
const playHistory = new Map<number, number[]>();
for (const snap of snapshots) {
  for (const row of snap.up_and_coming) {
    let rArr = rankHistory.get(row.universe_id);
    if (rArr === undefined) {
      rArr = [];
      rankHistory.set(row.universe_id, rArr);
    }
    rArr.push(row.rank);
    if (typeof row.playing === 'number' && row.playing > 0) {
      let pArr = playHistory.get(row.universe_id);
      if (pArr === undefined) {
        pArr = [];
        playHistory.set(row.universe_id, pArr);
      }
      pArr.push(row.playing);
    }
  }
}

const candidates = [...last.up_and_coming]
  .sort((a, b) => a.rank - b.rank)
  .slice(0, MAX_CANDIDATES)
  .filter((r) => {
    if (!Number.isFinite(windowFromMs) || !last.details) return true;
    const created = last.details[String(r.universe_id)]?.created;
    if (!created) return true;
    const ageDays = (windowFromMs - Date.parse(created)) / DAY_MS;
    return ageDays < 26.0;
  })
  .map((r) => {
    const rHist = rankHistory.get(r.universe_id) ?? [r.rank];
    const rankVel = (r.rank - rHist[0]!) / Math.max(1, rHist.length - 1);
    const pHist = playHistory.get(r.universe_id);
    let playBoost = 0;
    if (pHist && pHist.length >= 2 && pHist[0]! > 0) {
      const growth = (pHist[pHist.length - 1]! - pHist[0]!) / pHist[0]!;
      playBoost = Math.max(-2, Math.min(2, growth * 2));
    }
    const predRank = Math.max(1, r.rank + 0.35 * rankVel - playBoost);
    return { universe_id: r.universe_id, predRank };
  });

const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
for (let place = 1; place <= task.places; place++) {
  const weights = candidates.map((c) => ({
    universe_id: c.universe_id,
    w: Math.exp(-Math.abs(place - c.predRank) / SCALE),
  }));
  const totalW = weights.reduce((acc, x) => acc + x.w, 0);
  const scale = (1 - UNNAMED_SHARE) / (totalW || 1);
  for (const x of weights) {
    const p = Number((x.w * scale).toFixed(6));
    if (p >= 0.0002) {
      probabilities.push({ universe_id: x.universe_id, place, p });
    }
  }
}

const top10 = [...candidates]
  .sort((a, b) => a.predRank - b.predRank)
  .slice(0, task.places)
  .map((c) => c.universe_id);

// Deterministic forecast output
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top10 })}\n`);
