# Tatum Sui — integration evidence for Recall Picks

Source research: 6 Nov 2026, via `browser.search` / `browser.open`, no sign-up.
Full report: `~/workspace/goals/tatum-total-recall-track-1-sports-prediction-app/hidden_files/research-tatum.md`

## Verdict

**Do NOT build on Sui JSON-RPC.** Sui deprecated it Jul–Oct 2026; Tatum's host 404s on `/`
and serves GraphQL at `/graphql`. Primary for this app: **Tatum Sui GraphQL**.
Server-side alternative: **gRPC**. JSON-RPC code is deliberately absent from this repo.

## 1. Free key + Account ID

1. https://dashboard.tatum.io — sign up free, Create API Key.
2. Same key works for all Sui networks — "Three Sui networks. One key".
3. **Account_ID** (needed on the Total Recall submission form): Tatum Dashboard, **bottom left corner**.
4. Put the key only in `.env` (server-side) and in the submission form — never in the repo, README, or frontend.

Free-tier limits are conflicting — plan for the worst case: **100,000 lifetime credits, 3 req/sec, 2 keys**
(pricing page, checked 29–31 Oct 2026). Tatum's changelog (2026-09-03) says 1M/month; treat that as
a bonus, not a promise. **Trap: Tatum auto-upgrades on limit — turn auto-upgrade OFF in the dashboard**
before the demo goes live.

Credit costs: standard RPC call ~2 credits (indicative, not re-verified on a Sui page);
`GET /v4/data/rate/symbol` = 20 credits with a fiat basePair.

## 2. GraphQL — primary (what `server.js` uses)

- URL: `https://sui-mainnet.gateway.tatum.io/graphql`
- Method: `POST`, header `x-api-key: YOUR_API_KEY`, `Content-Type: application/json`
- Mainnet-only; no GraphQL on testnet, no subscriptions.
- Verified by three independent fellow Total Recall builders (dev.to `CallBook`, `SpendMemory`,
  `Second Thought`, Medium `RightCall`, Oct–Nov 2026) after JSON-RPC failed for them.
- Field names checked against Sui's own GraphQL reference: `address.balance(coinType:)`
  returns `totalBalance` / `coinBalance` / `addressBalance`; `address.transactions(last:)`
  returns `digest`, `sender.address`, `effects.status/timestamp`. Balances are in **MIST**
  (1 SUI = 1,000,000,000 MIST — divide by 1e9 before displaying).

```bash
curl -X POST https://sui-mainnet.gateway.tatum.io/graphql \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"query($address:SuiAddress!){ checkpoint{ sequenceNumber } address(address:$address){ balance(coinType:\"0x2::sui::SUI\"){ totalBalance coinBalance addressBalance } transactions(last:5){ nodes{ digest sender{ address } effects{ status timestamp } } } } }","variables":{"address":"0x<YOUR_SUI_ADDRESS>"}}'
```

Checkpoint-only version (used when no `SUI_ADDRESS` is set):

```bash
curl -X POST https://sui-mainnet.gateway.tatum.io/graphql \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{ checkpoint{ sequenceNumber } }"}'
```

Expected: a JSON object with `data.checkpoint.sequenceNumber` (a large integer).
If it 404s or returns GraphQL `errors`, the app's `/api/health` reports `mode: "live-error"`
and shows the labelled sample checkpoint instead of faking a live number.

## 3. gRPC — server-side alternative / smoke test

- Endpoint: `sui-mainnet-grpc.gateway.tatum.io:443` (testnet: `sui-testnet-grpc.gateway.tatum.io:443`)
- Auth: `x-api-key` as gRPC metadata, TLS on 443.
- Verified in Tatum docs (`docs.tatum.io/reference/sui-grpc`, 2026-07-22): "Sui gRPC …
  replacing the deprecated JSON-RPC for full node interactions."
- Do NOT use gRPC from the browser (native gRPC, not gRPC-web).

```bash
# from inside the cloned proto dir: git clone https://github.com/MystenLabs/sui-apis.git
grpcurl \
  -H "x-api-key: YOUR_API_KEY" \
  -import-path . \
  -proto sui/rpc/v2/ledger_service.proto \
  -proto sui/rpc/v2/checkpoint.proto \
  sui-mainnet-grpc.gateway.tatum.io:443 \
  sui.rpc.v2.LedgerService/GetCheckpoint
# Tatum's example response: {"checkpoint":{"sequenceNumber":"264536804","digest":"26uaqDyg9ENJwL8URuWpXVnYxetjAQ779C6AQh7jypiF"}}
# (that sequenceNumber is Tatum's example, not a live value — use whatever it returns live)
```

## 4. Data API — SUI price (display conversion only)

```bash
curl "https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD" \
  -H "x-api-key: YOUR_API_KEY" -H "accept: application/json"
# Docs: docs.tatum.io/reference/getexchangerate. Always pass basePair=USD (default is EUR).
# Cost 20 credits (fiat basePair, free plan OK). SUI price has NO causal link to a match —
# it is used only as a display conversion, never as a prediction input.
```

Not verified for Sui — do not cite as available: a Sui-specific Transactions API endpoint,
a Sui token-price-history endpoint, or a Sui NFT/DeFi Data API endpoint. Use GraphQL
`transactions(last:)` for recent-tx reads. Wallet Portfolio (`GET /v4/data/wallet/portfolio`,
`chain=sui-mainnet`) is unverified for Sui — test it once; if it 400s, use GraphQL `balance()`.

## 5. How this app uses it — "onchain receipt for every pick"

1. User logs a pick before the event (team, market, model % vs bookie %, edge).
2. Server does **one cached** GraphQL query: latest checkpoint + (if `SUI_ADDRESS` is set)
   wallet balance / recent transactions. Cache 60s, ≥350ms between calls, never from the browser.
3. Stored with the pick (and in Walrus Memory): `checkpoint`, `suiTimestamp`, `walletBalanceSUI`,
   `digest` of the wallet's latest tx if any.
4. UI shows on each pick card: `Verified on Sui mainnet · Checkpoint #<live number> · <date/time> · via Tatum`,
   with a Suiscan link for the digest.
5. After the result, the scorecard updates the tipster/league credibility score in Walrus Memory.

That is the honest use: the chain proves *when* and *that* the pick was logged, not *whether*
the team will win. There is no football data on Sui and Tatum has no sports-odds API — do not fake that.

## 6. Verify it works (demo checklist)

```bash
# 1. gRPC smoke test (proves key + network) — see §3 above
# 2. GraphQL checkpoint (proves the demo path) — see §2 above
# 3. Price (proves Data API + credits) — see §4 above
# 4. App health check (server proxy, cached 60s):
curl -s http://localhost:3000/api/health | python3 -m json.tool
# Live: {"ok":true,"mode":"live","source":"tatum-sui-mainnet-graphql","checkpoint":<live number>,...}
# Mock (no key): {"ok":false,"mode":"mock","reason":"no Tatum key yet","checkpoint":264536804,...}
#   — 264536804 is Tatum's docs example, labelled "mock-sample", NOT a live read.
```

Credit-burn sanity: 1 checkpoint query (~2 credits) + 1 price call (20 credits) per 60s server
cache refresh, shared by all visitors — a full judging day costs a few thousand credits at most,
inside even the 100k-lifetime worst case.

## 7. Pitfalls (from the research)

1. JSON-RPC deprecation is the #1 trap — build on GraphQL, smoke-test gRPC.
2. 3 RPS shared across interfaces — cache 30–60s, never call Tatum per page load per user from the browser.
3. Never expose the key in the browser — proxy through the server (`/api/health`, `/api/picks`).
4. Mainnet vs testnet mismatch — Walrus Memory writes must be Mainnet, so Tatum reads must be mainnet too.
5. Free-tier ambiguity + auto-upgrade — plan on 100k lifetime; disable auto-upgrade.
6. Sui is object-centric — balances are `totalBalance = coinBalance + addressBalance` in MIST.
7. GraphQL is still beta in Sui's own docs — re-test the exact query on submission day.
