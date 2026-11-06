# Walrus Memory — integration for Recall Picks

Verified 6 Nov 2026 (see `~/workspace/goals/tatum-total-recall-track-1-sports-prediction-app/GOAL.md`).

## What it is

Walrus Memory is portable, onchain memory for agents/apps: plain-text memories stored
under a namespace, retrievable later by semantic recall. For Recall Picks it is the
learning loop — PICK memories logged before kickoff, OUTCOME memories after the result,
CREDIBILITY memories summarising who to trust.

- Mainnet relayer: https://relayer.memory.walrus.xyz
- Dashboard: https://memory.walrus.xyz/dashboard
- Docs: https://docs.wal.app/walrus-memory
- TS SDK: `@mysten-incubation/memwal` (0.1.11) — used by this repo
- Python SDK: `memwal` 0.2.2.dev4 (not used here)
- Discord (stuck?): https://discord.gg/walrusprotocol

## Getting the keys — no create-agent API

There is **no API to create an agent**. The user signs in on the dashboard and creates
a delegate key under **Delegate keys**. That gives three values:

| Value | Where | Use |
|---|---|---|
| `MEMWAL_ACCOUNT_ID` | dashboard agent page | Sui object id (`0x…`) — server env var |
| `MEMWAL_PRIVATE_KEY` | Delegate keys → private key | Ed25519 hex — **server-side only, never commit, never in chat** |
| `MEMWAL_AGENT_ID` | Delegate keys → public key | 64 hex chars = `getPublicKeyHex()` — needed on the submission form |

Verify `getPublicKeyHex()` matches the dashboard public key before submitting.
The public relayer covers WAL storage + SUI gas — **$0 to the builder, no wallet / WAL needed**.
Writes are async, ~20s; wait for status `done` + a `blob_id`.

## SDK usage (what `server.js` and `scripts/seed.js` do)

```js
import { MemWal } from '@mysten-incubation/memwal';

const client = await MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY,      // server-side only
  accountId: process.env.MEMWAL_ACCOUNT_ID,
  serverUrl: 'https://relayer.memory.walrus.xyz',
  namespace: 'recall-picks',
});

// Write one memory, wait for it to land:
await client.rememberAndWait(text);

// Write up to 20 at once (≤2MB total) — used by npm run seed.
// NOTE (verified against installed memwal 0.1.13): items are {text, namespace?} objects,
// NOT plain strings, and the result is {results:[{id, blob_id, status, namespace}], total, succeeded, failed}.
await client.rememberBulkAndWait(texts.map(t => ({ text: t })));

// Recall by meaning (returns {memories:[{blob_id, text, distance, ...}]}):
await client.recall({ query: 'Chiefs NFL', limit: 10, namespace: 'recall-picks' });

// List / count — returns METADATA ONLY (blob_id, created_at, status), no text.
// Use recall() to read memory text.
await client.listMemories({ namespace: 'recall-picks' });
// stats: there is no public client.stats() in 0.1.13 — count listMemories() instead.
```

If the SDK's export shape differs in a newer version, `server.js` falls back to
`mod.default` / `new MemWal(opts)` — check the installed version's README if `create` is missing.

## Memory model — plain text, one fact per memory, append-only

Memory is plain text + namespace, **no structured fields**. Credibility is recomputed
in-app from recalled PICK + OUTCOME memories in time order. Formats (exact):

```
PICK 2026-11-02 | Kansas City Chiefs vs Buffalo Bills | NFL | pick: Kansas City Chiefs | model: 71% | bookie: 54% | edge: +17pp | tipster: Five | status: pending | pick_id: rp-seed-chiefs-bills

OUTCOME 2026-11-02 | Kansas City Chiefs vs Buffalo Bills | NFL | result: Kansas City Chiefs won 27-24 | pick: Kansas City Chiefs | outcome: WON | tipster: Five | pick_id: rp-seed-chiefs-bills

CREDIBILITY 2026-11-04 | tipster: Five | league: NFL | settled: 1 | wins: 1 | win_rate: 100% | avg_edge: +17pp | trust: 66 | note: sample n=1, low confidence — trust is shrunk toward 50 until more picks settle

LEAGUE 2026-11-04 | NFL | note: Home teams in this sample won 1 of 1 settled home pick; do not over-read n=1. Track home/away split per league as picks settle, and re-check after 10+ settled picks per league.
```

Trust formula (in `server.js` `computeCredibility`):
`trust = 50 + (win_rate - 0.5) * 100 * (settled / (settled + 3)) + avg_edge_pp * 0.2`, clamped 0–100.
Small samples are shrunk toward 50, so n=1 cannot score 100.

## Seeding the 10 required memories

`data/seed-picks.json` holds exactly 10 memory texts — 3 PICK + 3 OUTCOME (3 pairs),
3 CREDIBILITY, 1 LEAGUE note — ready for `rememberBulkAndWait`. They are **NOT on Mainnet yet**;
the file and the UI both say so.

```bash
# Refuses to run without real Walrus env vars, and never logs the private key:
npm run seed
# With keys in .env (MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID), it writes all 10,
# prints blob ids / statuses only, and tells you to verify in the dashboard.
```

Then check the live count:

```bash
curl -s "http://localhost:3000/api/memory?action=stats" | python3 -m json.tool
# Live: {"mode":"live","memory_count":10,...}
# Mock (no keys): {"mode":"mock","memory_count":10,"note":"MOCK — no Walrus key yet..."}
#   — mock count is the local seed+ledger text count, NOT a Mainnet count.
```

## Endpoints in this app

- `GET /api/memory` — list (live: `listMemories`; mock: local ledger + seed texts, labelled)
- `GET /api/memory?q=Chiefs` / `?action=recall&q=…` — semantic recall (live) / text filter (mock)
- `GET /api/memory?action=stats` — memory count (live: `stats()` / list count; mock: local count)
- `POST /api/memory` `{text}` — `rememberAndWait` (live) / mock acknowledgement (no key)
- `POST /api/picks` and `POST /api/picks/:id/settle` also best-effort write the PICK /
  OUTCOME / CREDIBILITY texts to Walrus; a failed Walrus write never fails the pick.
