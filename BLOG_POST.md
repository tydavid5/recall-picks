# Recall Picks: a sports pick journal that actually remembers

Track 1 — Markets & Sports Prediction, Tatum x Walrus Total Recall hackathon.
Deadline: Tue 10 Nov 2026, 17:00 UTC.

## The problem

Blockchain apps forget everything every time you close them. Sports apps are
worse: a tipster can claim they called every winner, because nobody kept the
receipts. A pick logged after the game is not a pick.

## What Recall Picks does

1. **Simulate** — 1,000 runs per match (normal points for NFL/NBA, Poisson
   expected goals for soccer, set-by-set for tennis). It reports win counts,
   average score, margin, and sim % vs the devigged bookie implied %.
   An edge is flagged only on the filter I actually use: sim around 70% or
   higher while the bookies price it at 55% or less. Anything else is
   "no edge by the filter".
2. **Log the pick before kickoff** — team, league, tipster, model % vs
   bookie %, edge. At log time the server asks Tatum's Sui GraphQL gateway
   for the live mainnet checkpoint and stores it with the pick. That is the
   onchain receipt: the pick existed, at a real checkpoint, before the game.
3. **Learn who to trust** — after the result, the app writes an OUTCOME
   memory and recomputes a credibility score per tipster and per league
   (settled picks, wins, win rate, average edge, trust shrunk toward 50
   for small samples). The next pick shows that trust badge, so the app
   gets sharper over time instead of resetting every session.

## How it uses Tatum + Walrus

- **Tatum Sui GraphQL** (`https://sui-mainnet.gateway.tatum.io/graphql`,
  server-side only, cached 60s) — one checkpoint query per pick:
  `checkpoint.sequenceNumber`, wallet balance (MIST → SUI), recent
  transactions. Optional SUI price via
  `GET https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD`
  as a display conversion only.
  Do NOT build on Sui JSON-RPC — Sui deprecated it Jul–Oct 2026 and
  Tatum's host 404s on `/`. Full evidence + curl commands: `docs/tatum.md`.
- **Walrus Memory** (`@mysten-incubation/memwal`, relayer
  `https://relayer.memory.walrus.xyz`, namespace `recall-picks`) —
  `rememberAndWait` / `rememberBulkAndWait` / `recall` / `listMemories`.
  Memories are plain text, one fact each: PICK / OUTCOME / CREDIBILITY /
  LEAGUE-note. Full SDK steps: `docs/walrus.md`.

Live proof — VERIFIED 2026-11-06:
- Walrus memory_count: 10, namespace recall-picks, Mainnet relayer
- Blob IDs (all 10, status done): 3iJsZmK6LyAWoZeDJblQKmUeBqS6DS9v7ZbfQEWKTbk, ehmgbF_6703AC7XwNyyd3f3zzx3ynTmb6aXsCSTAjHQ, MRHx-t19DqzvVBA7mG3v97nAiM7D7d_R6qJ17ATLeJA, Hy9bFGeVW5o0vyDDGuNU4a6qcIetJEnhmeAZfGrLPEg, oIdOmwPz7pKf5I762Zb7Edh0KFJZ3YmSNUkKxbk2-Hc, 1vkF7KNDmoENXghdhYat60yKdo_uYhNBWCfqdeCrp-w, FwNatUb4WdxLX3HlPLTDDRJxXWimTAwRBLJS8TS02Og, h2ziWMplncG87SiiX78nPQa0tuf8KyBLrBRfrrfwLf8, hK0QmX_XedC1qMfbJX4qJ-RQA-izVnjRuwWGpxtGuOE, 5gSU3hm3u0EltX3Jktuqi_DjGOx7xOTaKnSTdDxIH4Q
- Live Tatum checkpoint at verification: 342290546, SUI $0.866
- Recall query that returned the memories: GET /api/memory?action=recall&q=Arsenal credibility — returned the Arsenal PICK, OUTCOME and CREDIBILITY texts with matching blob IDs. Full ledger: data/seed-ledger.json

## How it learned over time

Seeded with 10 memories: 3 pick + outcome pairs, 3 credibility summaries,
1 league note. [After live seeding, describe one concrete update here:
e.g. tipster X went from trust N to M after Y settled picks, and how that
changed the next pick's display/sorting.]

## Honest limits

- No football data lives on Sui, and Tatum has no odds API. Bookmaker odds
  and the simulation model are offchain. Sui proves *when* and *that* a pick
  was logged, not whether the team will win.
- A pregame simulation is a model, not a guarantee — and not a live
  probability once the game has started.
- Walrus Memory is plain text + namespace, append-only; credibility is
  recomputed in-app from recalled picks + outcomes in time order.
- In mock mode (no keys) every chain number is a clearly-labelled sample.

Repo: https://github.com/tydavid5/recall-picks
Demo: live at https://recall-picks.vercel.app/ (or run `npm start` locally, see README) — the server's `/api/health`, `/api/memory` and `/api/credibility` endpoints are the live proof.
