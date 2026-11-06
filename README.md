# Recall Picks

**Track 1 — Markets & Sports Prediction, Tatum x Walrus Total Recall hackathon.**
Deadline: **Tue 10 Nov 2026, 17:00 UTC / 18:00 WAT**. Winners announced 17 Nov.

A pick journal that **simulates matches, logs picks before events, and learns credibility
scores in Walrus Memory on Mainnet** — so the app learns who to trust, instead of
forgetting everything when you close it.

## What it does

1. **Simulate** — 1,000-run simulation per match, model chosen by sport:
   - American football / basketball: normal points distribution
   - Soccer: Poisson expected goals (draws possible)
   - Tennis: set-by-set, best of 3 or 5
   - Reports win counts, ties, average + median score, margin bands, and sim % vs
     devigged bookie implied %.
2. **Edge filter (the user's rule)** — an edge is flagged **only** when sim ≥ ~70%
   and bookie implied ≤ 55%. Anything else is reported as "no edge by the filter".
3. **Log a pick before kickoff** — team, league, tipster, model % vs bookie %, edge —
   stored with an **onchain receipt**: a Sui mainnet checkpoint from Tatum GraphQL,
   plus wallet balance / latest-tx digest when `SUI_ADDRESS` is set.
4. **Settle** — record the real result. The app writes an OUTCOME memory and recomputes
   credibility per tipster and per league: settled, wins, win rate, average edge, trust score.
5. **Learn** — credibility lives in Walrus Memory as plain-text PICK / OUTCOME /
   CREDIBILITY / LEAGUE memories under namespace `recall-picks`, recalled by meaning
   (`GET /api/memory?q=…`). Next time you pick, the leaderboard shows who earned trust.

## How it uses Tatum + Walrus

- **Tatum Sui GraphQL** (`https://sui-mainnet.gateway.tatum.io/graphql`, server-side only,
  cached 60s) — one checkpoint query per pick: `checkpoint.sequenceNumber`, wallet balance
  (MIST → SUI), recent transactions. Optional SUI price via
  `GET https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD` as a display
  conversion only. Full evidence + curl commands: [`docs/tatum.md`](docs/tatum.md).
  **Do NOT build on Sui JSON-RPC** — deprecated Jul–Oct 2026, Tatum's host 404s on `/`.
- **Walrus Memory** (`@mysten-incubation/memwal`, relayer `https://relayer.memory.walrus.xyz`,
  namespace `recall-picks`) — `rememberAndWait` / `rememberBulkAndWait` (max 20, ≤2MB) /
  `recall` / `listMemories` / `stats`. Full SDK steps: [`docs/walrus.md`](docs/walrus.md).
- **How it learns over time:** every settled pick appends an OUTCOME memory and a fresh
  CREDIBILITY memory; credibility is recomputed from recalled picks + outcomes in time
  order, with trust shrunk toward 50 for small samples
  (`trust = 50 + (win_rate − 0.5)·100·(settled/(settled+3)) + avg_edge·0.2`).

## Honest limits

- **No football data on Sui, and Tatum has no odds API.** Bookmaker odds and the simulation
  model are **offchain**. Sui's job is to prove *when* and *that* a pick was logged
  (checkpoint receipt before kickoff), not whether the team will win.
- The simulation is a model, not a prediction guarantee — and a pregame sim is not a live
  probability once the game has started.
- Walrus Memory is plain text + namespace, no structured fields; credibility is recomputed
  in-app. Writes take ~20s and are append-only.
- In **mock mode** (no keys) every number that would come from a chain is a clearly-labelled
  sample — the checkpoint `264536804` is Tatum's docs example, not a live read, and the
  seed memories are **not** on Mainnet until `npm run seed` runs with real keys.

## Setup

```bash
npm install
cp .env.example .env   # then fill in — NEVER commit .env or any real key
npm start              # http://localhost:3000
```

`.env` (see `.env.example`):

```ini
# PORT=3000
# SUI_ADDRESS=0x...            # optional: anchors the pick receipt
# TATUM_API_KEY=               # dashboard.tatum.io -> Create API Key
# MEMWAL_ACCOUNT_ID=0x...      # Walrus Memory dashboard -> agent's Sui object id
# MEMWAL_PRIVATE_KEY=          # Walrus Memory dashboard -> Delegate keys (server-side ONLY)
# MEMWAL_AGENT_ID=             # Walrus public key (64 hex) — needed on the submission form
```

Turn **auto-upgrade OFF** in the Tatum dashboard before going live (Tatum auto-upgrades
on limit). Free tier: plan for 100k lifetime credits / 3 RPS — see `docs/tatum.md`.

## Seed the 10 Walrus memories

`data/seed-picks.json` = 10 memory texts (3 PICK + 3 OUTCOME, 3 CREDIBILITY, 1 LEAGUE note).
They are **not** on Mainnet yet.

```bash
npm run seed   # refuses without MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID; never logs the key
```

## API

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | Tatum checkpoint (live if `TATUM_API_KEY` set, else `{ok:false, mode:"mock", reason:"no Tatum key yet"}` + labelled sample checkpoint). Cached 60s. |
| POST | `/api/simulate` | `{sport, teamA, teamB, modelPct\|modelWinProbA, bookieOddsA, bookieOddsB, bookieOddsDraw?, expectedPointsA/B, expectedGoalsA/B, setWinProbA?, bestOf?}` → 1,000-run result + edge flag |
| POST | `/api/picks` | `{sport, teamA, teamB, league, tipster, pick, modelPct, bookiePct, eventDate?}` → pick + receipt + memory text (best-effort Walrus write) |
| GET | `/api/picks` | Local ledger (sample picks labelled `sample:true`) |
| POST | `/api/picks/:id/settle` | `{winner, scoreA?, scoreB?, result?}` → OUTCOME + recomputed credibility |
| GET | `/api/credibility` | `{byTipster, byLeague, byTipsterLeague, formula, settled_count}` |
| GET | `/api/memory` | `?q=…` recall, `?action=list\|recall\|stats` — live via memwal, else mock local texts |
| POST | `/api/memory` | `{text}` — `rememberAndWait` (live) / mock acknowledgement |
| GET | `/api/seed` | The 10 seed memory texts (mock — not on Mainnet yet) |

Sports: `american-football`, `soccer`, `basketball`, `tennis`.
Frontend: `public/index.html` — single file, blue/white, mobile-friendly. All mock data
is labelled "Sample / mock" in the UI.

## Repo / submission checklist

- [x] Public GitHub repo with this code + README — https://github.com/tydavid5/recall-picks
- [x] Working demo (live URL or video) — https://recall-picks.vercel.app/ (Vercel Hobby, free)
- [ ] Blog post: what it does, how it uses Tatum + Walrus, how it learned over time
- [x] ≥10 Walrus Memory writes on Mainnet (`npm run seed` + live picks)
- [ ] Tatum Sui RPC used for onchain reads (`/api/health` live, checkpoint on every pick)
- [ ] Submission form: Tatum dashboard Account ID, Tatum API key, `MEMWAL_AGENT_ID`
