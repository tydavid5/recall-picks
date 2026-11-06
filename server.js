'use strict';
/**
 * Recall Picks — Track 1, Tatum x Walrus Total Recall
 * Skeleton + working demo. Runs WITHOUT live keys in clearly-labelled MOCK mode.
 *
 * Honest limits (see README.md):
 *  - No football data lives on Sui and Tatum has no odds API. Model + bookie odds are
 *    OFFCHAIN. Sui (via Tatum GraphQL) only proves WHEN a pick was logged — a checkpoint
 *    receipt stored with the pick, before kickoff.
 *  - Walrus Memory is plain text + namespace. Credibility is recomputed in-app from
 *    recalled PICK + OUTCOME memories in time order.
 *  - NEVER expose TATUM_API_KEY or MEMWAL_PRIVATE_KEY to the browser. All Tatum /
 *    Walrus calls are server-side only. This file never logs a key value.
 */
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- tiny .env loader (no values ever logged) ----
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = process.env.PORT || 3000;
const TATUM_API_KEY = process.env.TATUM_API_KEY || '';
const SUI_ADDRESS = process.env.SUI_ADDRESS || '';
const MEMWAL_PRIVATE_KEY = process.env.MEMWAL_PRIVATE_KEY || '';
const MEMWAL_ACCOUNT_ID = process.env.MEMWAL_ACCOUNT_ID || '';
const NAMESPACE = 'recall-picks';
const TATUM_GRAPHQL = 'https://sui-mainnet.gateway.tatum.io/graphql';
const MEMWAL_SERVER_URL = 'https://relayer.memory.walrus.xyz';
// Sample checkpoint taken from Tatum's own docs example — labelled sample everywhere,
// NEVER presented as a live read.
const SAMPLE_CHECKPOINT = 264536804;

const PICKS_FILE = process.env.VERCEL
  ? path.join(require('os').tmpdir(), 'recall-picks', 'picks.json') // Vercel serverless fs is ephemeral; /tmp is writable
  : path.join(__dirname, 'data', 'picks.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed-picks.json');

// ---- math helpers ----
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Standard normal CDF (Abramowitz-Stegun)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
// Inverse normal CDF (Acklam approximation)
function normInv(p) {
  p = clamp(p, 0.0001, 0.9999);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > phigh) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L && k < 100);
  return k - 1;
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }

// ---- odds: decimal odds -> devigged implied probability ----
// Devigging: implied_i = (1/odds_i) / sum(1/odds_j). Needs all outcomes (incl. draw for soccer).
function devigged(odds) {
  const inv = {};
  let sum = 0;
  for (const [k, o] of Object.entries(odds)) {
    if (o && o > 1) { inv[k] = 1 / o; sum += inv[k]; }
  }
  const out = {};
  for (const [k, v] of Object.entries(inv)) out[k] = sum ? v / sum : null;
  out._overround = sum; // >1 means bookie margin; 1.05 = 5% margin
  return out;
}

// ---- ledger ----
async function readPicks() {
  try { return JSON.parse(await fsp.readFile(PICKS_FILE, 'utf8')); }
  catch { return []; }
}
async function writePicks(picks) {
  await fsp.mkdir(path.dirname(PICKS_FILE), { recursive: true });
  await fsp.writeFile(PICKS_FILE, JSON.stringify(picks, null, 2));
}
async function readSeed() {
  try { return JSON.parse(await fsp.readFile(SEED_FILE, 'utf8')); }
  catch { return { memories: [] }; }
}

// ---- credibility ----
// Trust score: shrunk toward 50 for small samples so n=1 cannot give 100.
// trust = 50 + (winRate - 0.5) * 100 * (settled / (settled + 3)) + avgEdgePp * 0.2, clamped 0-100.
function computeCredibility(picks) {
  const settled = picks.filter(p => p.status === 'settled');
  const group = (keyFn) => {
    const m = new Map();
    for (const p of settled) {
      const k = keyFn(p);
      const g = m.get(k) || { key: k, settled: 0, wins: 0, losses: 0, edgeSum: 0 };
      g.settled++; if (p.won) g.wins++; else g.losses++;
      g.edgeSum += (p.edgePp || 0);
      m.set(k, g);
    }
    return [...m.values()].map(g => {
      const winRate = g.settled ? g.wins / g.settled : 0;
      const avgEdge = g.settled ? g.edgeSum / g.settled : 0;
      const trust = clamp(Math.round(50 + (winRate - 0.5) * 100 * (g.settled / (g.settled + 3)) + avgEdge * 0.2), 0, 100);
      return { ...g, win_rate: Math.round(winRate * 1000) / 10, avg_edge_pp: Math.round(avgEdge * 10) / 10, trust_score: trust };
    }).sort((a, b) => b.trust_score - a.trust_score);
  };
  return {
    byTipster: group(p => p.tipster || 'unknown'),
    byLeague: group(p => p.league || 'unknown'),
    byTipsterLeague: group(p => `${p.tipster || 'unknown'} | ${p.league || 'unknown'}`),
    formula: 'trust = 50 + (win_rate - 0.5) * 100 * (settled / (settled + 3)) + avg_edge_pp * 0.2, clamped 0-100. Small samples are shrunk toward 50.',
    settled_count: settled.length,
  };
}
function credibilityText(dateStr, tipster, league, c) {
  return `CREDIBILITY ${dateStr} | tipster: ${tipster} | league: ${league} | settled: ${c.settled} | wins: ${c.wins} | win_rate: ${c.win_rate}% | avg_edge: ${c.avg_edge_pp >= 0 ? '+' : ''}${c.avg_edge_pp}pp | trust: ${c.trust_score} | note: trust is shrunk toward 50 for small samples`;
}

// ---- Tatum Sui GraphQL (server-side ONLY, cached 60s) ----
let healthCache = null; // { at, data }
async function fetchTatumCheckpoint() {
  const hasAddress = Boolean(SUI_ADDRESS);
  const query = hasAddress
    ? `query($address:SuiAddress!){ checkpoint{ sequenceNumber } address(address:$address){ balance(coinType:"0x2::sui::SUI"){ totalBalance } transactions(last:5){ nodes{ digest sender{ address } effects{ status timestamp } } } } }`
    : `query{ checkpoint{ sequenceNumber } }`;
  const variables = hasAddress ? { address: SUI_ADDRESS } : {};
  const started = Date.now();
  const res = await fetch(TATUM_GRAPHQL, {
    method: 'POST',
    headers: { 'x-api-key': TATUM_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Tatum GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Tatum GraphQL error: ${JSON.stringify(json.errors).slice(0, 200)}`);
  const checkpoint = Number(json?.data?.checkpoint?.sequenceNumber);
  if (!Number.isFinite(checkpoint)) throw new Error('Tatum GraphQL returned no checkpoint.sequenceNumber');
  let balanceSui = null, latestDigest = null, suiTimestamp = null;
  const addr = json?.data?.address;
  if (addr?.balance?.totalBalance != null) balanceSui = Number(addr.balance.totalBalance) / 1e9; // MIST -> SUI
  const tx = addr?.transactions?.nodes?.[0];
  if (tx?.digest) { latestDigest = tx.digest; suiTimestamp = tx?.effects?.timestamp || null; }
  // Optional SUI price (display conversion only, 20 credits, cached with checkpoint).
  let suiPriceUSD = null;
  try {
    const pr = await fetch('https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD', {
      headers: { 'x-api-key': TATUM_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (pr.ok) { const pj = await pr.json(); suiPriceUSD = Number(pj?.value ?? pj?.rate ?? pj?.data?.value) || null; }
  } catch { /* price is optional — never fail health on it */ }
  return {
    ok: true, mode: 'live', source: 'tatum-sui-mainnet-graphql',
    checkpoint, balanceSui, latestDigest, suiTimestamp, suiPriceUSD,
    latencyMs: Date.now() - started, cachedAt: new Date().toISOString(),
    suiscanUrl: latestDigest ? `https://suiscan.xyz/mainnet/tx/${latestDigest}` : null,
  };
}
async function getHealth() {
  const now = Date.now();
  if (healthCache && now - healthCache.at < 60000) return healthCache.data;
  let data;
  if (!TATUM_API_KEY) {
    data = {
      ok: false, mode: 'mock', source: 'mock-sample',
      reason: 'no Tatum key yet',
      checkpoint: SAMPLE_CHECKPOINT,
      balanceSui: null, latestDigest: null, suiTimestamp: null, suiPriceUSD: null,
      cachedAt: new Date().toISOString(),
      note: 'Sample checkpoint from Tatum docs example — NOT a live read. Set TATUM_API_KEY in .env for a live Sui mainnet checkpoint via Tatum GraphQL.',
      suiscanUrl: null,
    };
  } else {
    try { data = await fetchTatumCheckpoint(); }
    catch (e) {
      data = {
        ok: false, mode: 'live-error', source: 'tatum-sui-mainnet-graphql',
        reason: String(e.message || e).slice(0, 200),
        checkpoint: SAMPLE_CHECKPOINT, balanceSui: null, latestDigest: null,
        suiTimestamp: null, suiPriceUSD: null, cachedAt: new Date().toISOString(),
        note: 'Live Tatum call failed — showing the labelled sample checkpoint instead. Do not treat it as live.',
        suiscanUrl: null,
      };
    }
  }
  healthCache = { at: now, data };
  return data;
}

// ---- Walrus Memory (server-side ONLY) ----
let memwalClient = null, memwalError = null;
async function getMemwalClient() {
  if (memwalClient) return memwalClient;
  if (memwalError) throw memwalError;
  if (!MEMWAL_PRIVATE_KEY || !MEMWAL_ACCOUNT_ID) return null;
  try {
    const mod = await import('@mysten-incubation/memwal');
    const MemWal = mod.MemWal || mod.default || mod;
    const opts = { key: MEMWAL_PRIVATE_KEY, accountId: MEMWAL_ACCOUNT_ID, serverUrl: MEMWAL_SERVER_URL, namespace: NAMESPACE };
    memwalClient = typeof MemWal.create === 'function' ? await MemWal.create(opts) : new MemWal(opts);
    return memwalClient;
  } catch (e) { memwalError = e; throw e; }
}
function memwalMode() { return (MEMWAL_PRIVATE_KEY && MEMWAL_ACCOUNT_ID) ? 'live' : 'mock'; }
// Best-effort write; never fails the pick/settle that triggered it. Returns {mode, blobId}.
async function tryWriteMemory(text) {
  if (memwalMode() === 'mock') return { mode: 'mock', blobId: null, note: 'Mock — no Walrus key yet. Text kept in local ledger only, NOT on Mainnet.' };
  try {
    const client = await getMemwalClient();
    const res = await client.rememberAndWait(text);
    const blobId = res?.blobId || res?.blob_id || res?.id || null;
    return { mode: 'live', blobId, note: blobId ? 'Written to Walrus Memory on Mainnet.' : 'rememberAndWait returned without a blob_id — check the Walrus dashboard.' };
  } catch (e) {
    return { mode: 'live-error', blobId: null, note: `Walrus write failed: ${String(e.message || e).slice(0, 160)}` };
  }
}
function mockMemories(picks, seed) {
  const seen = new Set();
  const out = [];
  const push = (text, kind, pickId, source) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ text, kind, pick_id: pickId || null, blob_id: null, source, status: 'mock — not on Mainnet' });
  };
  for (const m of (seed.memories || [])) push(m.text, m.kind, m.pick_id, 'seed-picks.json (sample)');
  for (const p of picks) {
    push(p.memoryText, 'PICK', p.pick_id, 'local ledger');
    if (p.outcomeText) push(p.outcomeText, 'OUTCOME', p.pick_id, 'local ledger');
  }
  return out;
}

// ---- simulation ----
function simulate(body) {
  const sport = String(body.sport || 'american-football').toLowerCase();
  const teamA = body.teamA || 'Team A';
  const teamB = body.teamB || 'Team B';
  const runs = 1000;
  const modelWinProbA = body.modelWinProbA != null ? clamp(Number(body.modelWinProbA), 0.01, 0.99)
    : (body.modelPct != null ? clamp(Number(body.modelPct) / 100, 0.01, 0.99) : 0.5);
  const odds = {};
  if (body.bookieOddsA) odds.A = Number(body.bookieOddsA);
  if (body.bookieOddsB) odds.B = Number(body.bookieOddsB);
  if (body.bookieOddsDraw) odds.D = Number(body.bookieOddsDraw);
  const dev = devigged(odds);
  const bookieA = dev.A ?? null;

  let winsA = 0, winsB = 0, ties = 0;
  const scoresA = [], scoresB = [];
  const marginBands = {};
  const band = (m, label) => { marginBands[label] = (marginBands[label] || 0) + 1; };

  if (sport === 'soccer') {
    const expA = body.expectedGoalsA != null ? Number(body.expectedGoalsA) : clamp(1.35 + (modelWinProbA - 0.5) * 1.6, 0.3, 2.8);
    const expB = body.expectedGoalsB != null ? Number(body.expectedGoalsB) : clamp(2.7 - expA, 0.3, 2.8);
    for (let i = 0; i < runs; i++) {
      const a = poisson(expA), b = poisson(expB);
      scoresA.push(a); scoresB.push(b);
      if (a > b) { winsA++; band(a - b, a - b === 1 ? 'win by 1' : a - b === 2 ? 'win by 2' : 'win by 3+'); }
      else if (b > a) { winsB++; }
      else ties++;
    }
    return finish({ sport, teamA, teamB, runs, winsA, winsB, ties, scoresA, scoresB, marginBands, modelWinProbA, bookieA, dev, model: `Poisson expected goals: ${teamA} ${expA.toFixed(2)}, ${teamB} ${expB.toFixed(2)}`, scoreLabel: 'goals' });
  }
  if (sport === 'tennis') {
    const bestOf = body.bestOf === 5 ? 5 : 3;
    const setsToWin = bestOf === 5 ? 3 : 2;
    // Invert match win prob -> set win prob for best-of-3/5 (numeric search).
    let pSet = modelWinProbA;
    if (body.setWinProbA == null) {
      const matchWin = (p) => {
        let w = 0;
        for (let s = setsToWin; s <= bestOf; s++) {
          // P(win in exactly s sets) = C(s-1, setsToWin-1) * p^setsToWin * (1-p)^(s-setsToWin)
          const comb = (n, k) => { let r = 1; for (let j = 1; j <= k; j++) r = r * (n - j + 1) / j; return r; };
          w += comb(s - 1, setsToWin - 1) * Math.pow(p, setsToWin) * Math.pow(1 - p, s - setsToWin);
        }
        return w;
      };
      let lo = 0.01, hi = 0.99;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (matchWin(mid) < modelWinProbA) lo = mid; else hi = mid; }
      pSet = (lo + hi) / 2;
    } else pSet = clamp(Number(body.setWinProbA), 0.01, 0.99);
    for (let i = 0; i < runs; i++) {
      let a = 0, b = 0;
      while (a < setsToWin && b < setsToWin) { if (Math.random() < pSet) a++; else b++; }
      scoresA.push(a); scoresB.push(b);
      if (a > b) { winsA++; band(a, a === setsToWin && b === 0 ? 'straight sets' : `win ${a}-${b}`); }
      else winsB++;
    }
    return finish({ sport, teamA, teamB, runs, winsA, winsB, ties: 0, scoresA, scoresB, marginBands, modelWinProbA, bookieA, dev, model: `Set-by-set, best of ${bestOf}, set win prob ${teamA} ${(pSet * 100).toFixed(1)}%`, scoreLabel: 'sets' });
  }
  // Points sports: american-football (NFL) and basketball (NBA)
  const isNba = sport === 'basketball';
  const sd = isNba ? 11 : 13.5;
  const base = isNba ? 112 : 24;
  let expA, expB;
  if (body.expectedPointsA != null && body.expectedPointsB != null) { expA = Number(body.expectedPointsA); expB = Number(body.expectedPointsB); }
  else {
    const marginMean = normInv(modelWinProbA) * sd * Math.SQRT2;
    expA = base + marginMean / 2; expB = base - marginMean / 2;
  }
  for (let i = 0; i < runs; i++) {
    const a = Math.max(0, Math.round(expA + randn() * sd));
    const b = Math.max(0, Math.round(expB + randn() * sd));
    scoresA.push(a); scoresB.push(b);
    if (a > b) { winsA++; const m = a - b; band(m, m <= 7 ? 'win by 1-7' : m <= 14 ? 'win by 8-14' : 'win by 15+'); }
    else if (b > a) winsB++;
    else ties++;
  }
  return finish({ sport, teamA, teamB, runs, winsA, winsB, ties, scoresA, scoresB, marginBands, modelWinProbA, bookieA, dev, model: `Normal points distribution: ${teamA} ${expA.toFixed(1)} ± ${sd}, ${teamB} ${expB.toFixed(1)} ± ${sd}`, scoreLabel: 'points' });
}
function finish(o) {
  const winPctA = Math.round(o.winsA / o.runs * 1000) / 10;
  const winPctB = Math.round(o.winsB / o.runs * 1000) / 10;
  const tiePct = Math.round(o.ties / o.runs * 1000) / 10;
  const avgMargin = Math.round(mean(o.scoresA.map((a, i) => a - o.scoresB[i])) * 10) / 10;
  const edgePp = o.bookieA != null ? Math.round((winPctA / 100 - o.bookieA) * 1000) / 10 : null;
  // User's filter: edge ONLY when sim ~70%+ and bookie <=55%.
  const edge = winPctA >= 70 && o.bookieA != null && o.bookieA * 100 <= 55;
  return {
    sport: o.sport, teamA: o.teamA, teamB: o.teamB, runs: o.runs,
    winsA: o.winsA, winsB: o.winsB, ties: o.ties,
    winPctA, winPctB, tiePct,
    avgScoreA: Math.round(mean(o.scoresA) * 10) / 10,
    avgScoreB: Math.round(mean(o.scoresB) * 10) / 10,
    medianScoreA: median(o.scoresA), medianScoreB: median(o.scoresB),
    avgMargin, marginBands: o.marginBands,
    modelWinProbA: Math.round(o.modelWinProbA * 1000) / 10,
    bookieImpliedA: o.bookieA != null ? Math.round(o.bookieA * 1000) / 10 : null,
    bookieImpliedB: o.dev.B != null ? Math.round(o.dev.B * 1000) / 10 : null,
    bookieImpliedDraw: o.dev.D != null ? Math.round(o.dev.D * 1000) / 10 : null,
    bookieOverround: o.dev._overround ? Math.round(o.dev._overround * 1000) / 10 : null,
    edgePp, edge,
    verdict: edge ? `EDGE — sim ${winPctA}% vs bookie ${o.bookieA != null ? Math.round(o.bookieA * 100) : '?'}% (filter: sim ≥70% and bookie ≤55%)`
      : (o.bookieA != null ? `No edge by the filter — sim ${winPctA}% vs bookie ${Math.round(o.bookieA * 100)}%.` : 'No bookie odds supplied — no edge check possible.'),
    model: o.model, scoreLabel: o.scoreLabel,
    note: 'Offchain model simulation (1,000 runs). Not a prediction guarantee and not onchain.',
  };
}

// ---- routes ----
app.get('/api/health', async (req, res) => {
  try { res.json(await getHealth()); }
  catch (e) { res.status(500).json({ ok: false, mode: 'live-error', reason: String(e.message || e).slice(0, 200) }); }
});

app.post('/api/simulate', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.teamA || !b.teamB) return res.status(400).json({ error: 'teamA and teamB are required' });
    if (!['american-football', 'soccer', 'basketball', 'tennis'].includes(String(b.sport || 'american-football').toLowerCase()))
      return res.status(400).json({ error: 'sport must be american-football, soccer, basketball or tennis' });
    res.json(simulate(b));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/picks', async (req, res) => {
  const picks = await readPicks();
  res.json({ mode: memwalMode() === 'live' ? 'live' : 'mock', picks, count: picks.length, note: picks.some(p => p.sample) ? 'Sample picks are labelled sample:true — they are demo history, not live Mainnet memories.' : undefined });
});

app.post('/api/picks', async (req, res) => {
  try {
    const b = req.body || {};
    for (const f of ['teamA', 'teamB', 'league', 'tipster', 'pick']) {
      if (!b[f]) return res.status(400).json({ error: `${f} is required` });
    }
    const modelPct = b.modelPct != null ? Number(b.modelPct) : null;
    const bookiePct = b.bookiePct != null ? Number(b.bookiePct) : null;
    if (modelPct == null || bookiePct == null || Number.isNaN(modelPct) || Number.isNaN(bookiePct))
      return res.status(400).json({ error: 'modelPct and bookiePct (percent, e.g. 71) are required' });
    const edgePp = Math.round((modelPct - bookiePct) * 10) / 10;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const pick_id = 'rp-' + now.getTime().toString(36) + crypto.randomBytes(2).toString('hex');
    const health = await getHealth();
    const receipt = {
      checkpoint: health.checkpoint, mode: health.mode, source: health.source,
      suiTimestamp: health.suiTimestamp || null, balanceSui: health.balanceSui ?? null,
      suiscanUrl: health.suiscanUrl || null,
      note: health.mode === 'live'
        ? `Verified on Sui mainnet · Checkpoint #${health.checkpoint} · via Tatum`
        : 'Mock — no Tatum key yet. Sample checkpoint, NOT a live read.',
    };
    const memoryText = `PICK ${dateStr} | ${b.teamA} vs ${b.teamB} | ${b.league} | pick: ${b.pick} | model: ${modelPct}% | bookie: ${bookiePct}% | edge: ${edgePp >= 0 ? '+' : ''}${edgePp}pp | tipster: ${b.tipster} | status: pending | pick_id: ${pick_id}`;
    const pick = {
      pick_id, sport: String(b.sport || 'american-football').toLowerCase(),
      teamA: b.teamA, teamB: b.teamB, league: b.league, tipster: b.tipster, pick: b.pick,
      modelPct, bookiePct, edgePp, eventDate: b.eventDate || dateStr,
      timestamp: now.toISOString(), status: 'pending', won: null,
      receipt, memoryText, sample: false,
    };
    const picks = await readPicks();
    picks.unshift(pick);
    await writePicks(picks);
    // Best-effort Walrus write (mock returns immediately; live writes async on Mainnet).
    pick.memory = await tryWriteMemory(memoryText);
    // Persist the memory status on the stored copy too.
    const stored = await readPicks();
    const idx = stored.findIndex(p => p.pick_id === pick_id);
    if (idx >= 0) { stored[idx].memory = pick.memory; await writePicks(stored); }
    res.status(201).json(pick);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/picks/:id/settle', async (req, res) => {
  try {
    const picks = await readPicks();
    const pick = picks.find(p => p.pick_id === req.params.id);
    if (!pick) return res.status(404).json({ error: 'pick not found' });
    if (pick.status === 'settled') return res.status(400).json({ error: 'pick already settled' });
    const b = req.body || {};
    const winnerRaw = String(b.winner || b.result || '').trim();
    if (!winnerRaw) return res.status(400).json({ error: 'winner is required (team name, "teamA", "teamB" or "draw")' });
    const winner = winnerRaw.toLowerCase() === 'teama' ? pick.teamA
      : winnerRaw.toLowerCase() === 'teamb' ? pick.teamB
      : winnerRaw.toLowerCase() === 'draw' ? 'draw' : winnerRaw;
    const won = winner === 'draw' ? String(pick.pick).toLowerCase() === 'draw'
      : String(pick.pick).toLowerCase() === String(winner).toLowerCase();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const resultStr = b.result || (b.scoreA != null && b.scoreB != null
      ? (winner === 'draw' ? `Draw ${b.scoreA}-${b.scoreB}` : `${winner} won ${b.scoreA}-${b.scoreB}`)
      : `${winner} won`);
    pick.status = 'settled'; pick.won = won;
    pick.outcome = { winner, result: resultStr, scoreA: b.scoreA ?? null, scoreB: b.scoreB ?? null, settledAt: now.toISOString() };
    pick.outcomeText = `OUTCOME ${dateStr} | ${pick.teamA} vs ${pick.teamB} | ${pick.league} | result: ${resultStr} | pick: ${pick.pick} | outcome: ${won ? 'WON' : 'LOST'} | tipster: ${pick.tipster} | pick_id: ${pick.pick_id}`;
    // Recompute credibility for this tipster+league and write it as a memory too.
    const cred = computeCredibility(picks);
    const mine = cred.byTipsterLeague.find(c => c.key === `${pick.tipster} | ${pick.league}`)
      || cred.byTipster.find(c => c.key === pick.tipster);
    pick.credibility = mine || null;
    pick.credibilityText = mine ? credibilityText(dateStr, pick.tipster, pick.league, mine) : null;
    await writePicks(picks);
    pick.memoryOutcome = await tryWriteMemory(pick.outcomeText);
    if (pick.credibilityText) pick.memoryCredibility = await tryWriteMemory(pick.credibilityText);
    res.json({ ...pick, credibility: cred });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/credibility', async (req, res) => {
  const picks = await readPicks();
  res.json({ mode: memwalMode() === 'live' ? 'live' : 'mock', ...computeCredibility(picks) });
});

app.get('/api/memory', async (req, res) => {
  try {
    const q = String(req.query.q || req.query.query || '').trim();
    const action = String(req.query.action || 'list').toLowerCase();
    if (memwalMode() === 'live') {
      const client = await getMemwalClient();
      if (action === 'recall' && q) {
        const out = await client.recall({ query: q, limit: 10, namespace: NAMESPACE });
        const memories = Array.isArray(out) ? out : (out?.memories || out?.results || []);
        return res.json({ mode: 'live', namespace: NAMESPACE, query: q, memory_count: memories.length, memories, blob_ids: memories.map(m => m.blobId || m.blob_id || null).filter(Boolean) });
      }
      if (action === 'stats') {
        let stats = null;
        try { stats = typeof client.stats === 'function' ? await client.stats() : null; } catch { stats = null; }
        // NOTE: memwal 0.1.13 has no public stats() — resolveOwner uses POST /api/stats
        // internally. Count via listMemories() instead, falling back to recall
        // (listMemories occasionally drops the socket; recall is the reliable read).
        let memories = [];
        try {
          const list = typeof client.listMemories === 'function' ? await client.listMemories({ namespace: NAMESPACE }) : { memories: [] };
          memories = Array.isArray(list) ? list : (list?.memories || []);
        } catch {
          const out = await client.recall({ query: 'pick credibility outcome', limit: 20, namespace: NAMESPACE });
          memories = out?.results || out?.memories || [];
        }
        return res.json({ mode: 'live', namespace: NAMESPACE, memory_count: stats?.memory_count ?? stats?.count ?? memories.length, stats, blob_ids: memories.map(m => m.blobId || m.blob_id || null).filter(Boolean), memories: memories.slice(0, 20), note: 'listMemories returns metadata only (blob_id, created_at, status) — no text. Use recall (?action=recall&q=…) to read memory text.' });
      }
      // listMemories returns MemorySummary metadata only — no decrypted text.
      // Fall back to recall on a socket error (seen live 2026-11-06).
      let memories = [];
      try {
        const list = typeof client.listMemories === 'function' ? await client.listMemories({ namespace: NAMESPACE }) : { memories: [] };
        memories = Array.isArray(list) ? list : (list?.memories || []);
      } catch {
        const out = await client.recall({ query: 'pick credibility outcome league', limit: 20, namespace: NAMESPACE });
        const recalled = out?.results || out?.memories || [];
        return res.json({ mode: 'live', namespace: NAMESPACE, memory_count: recalled.length, blob_ids: recalled.map(m => m.blobId || m.blob_id || null).filter(Boolean), memories: recalled, note: 'listMemories dropped the connection, so this is a recall read instead — texts verified from Walrus Mainnet.' });
      }
      return res.json({ mode: 'live', namespace: NAMESPACE, memory_count: memories.length, blob_ids: memories.map(m => m.blobId || m.blob_id || null).filter(Boolean), memories: memories.slice(0, 50).map(m => ({ blob_id: m.blob_id || m.blobId || null, created_at: m.created_at || null, status: m.status || null, text: null, kind: 'metadata-only' })), note: 'listMemories returns metadata only (blob_id, created_at, status) — no text. Use recall (?action=recall&q=…) to read memory text.' });
    }
    // Mock mode: local ledger + seed texts, clearly labelled.
    const picks = await readPicks();
    const seed = await readSeed();
    let memories = mockMemories(picks, seed);
    if (q) {
      const needle = q.toLowerCase();
      memories = memories.filter(m => m.text.toLowerCase().includes(needle));
    }
    res.json({
      mode: 'mock', namespace: NAMESPACE, query: q || null,
      memory_count: memories.length, blob_ids: [],
      memories,
      note: 'MOCK — no Walrus key yet. These texts live in the local ledger / seed file only and are NOT on Walrus Mainnet. Set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID, then run npm run seed.',
    });
  } catch (e) {
    res.status(500).json({ mode: 'live-error', error: String(e.message || e).slice(0, 300), note: 'Walrus Memory call failed. Check the server log (keys are never logged) and the Walrus dashboard.' });
  }
});

app.post('/api/memory', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 8000) return res.status(400).json({ error: 'text too long (max 8000 chars)' });
  const result = await tryWriteMemory(text);
  res.json({ text, ...result, namespace: NAMESPACE });
});

app.get('/api/seed', async (req, res) => {
  const seed = await readSeed();
  res.json({ mode: 'mock', note: 'Seed memory texts — NOT on Mainnet yet. Run npm run seed with real Walrus env vars to write them.', ...seed });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Recall Picks listening on http://localhost:${PORT}`);
    console.log(`Mode: Tatum ${TATUM_API_KEY ? 'key present (live attempts enabled)' : 'MOCK (no TATUM_API_KEY)'} | Walrus ${memwalMode() === 'live' ? 'key present (live attempts enabled)' : 'MOCK (no MEMWAL_* keys)'}`);
    console.log('Keys are never logged. See README.md for setup.');
  });
}
module.exports = app;
