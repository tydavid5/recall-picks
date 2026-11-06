'use strict';
/**
 * Seed Walrus Memory with the 10 sample memory texts in data/seed-picks.json.
 * REFUSES to run without real Walrus env vars. Never logs the private key.
 * Usage: MEMWAL_PRIVATE_KEY=... MEMWAL_ACCOUNT_ID=... npm run seed
 *   (or put them in .env — this script reads .env the same way server.js does)
 */
const fs = require('fs');
const path = require('path');

(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

async function main() {
  const key = process.env.MEMWAL_PRIVATE_KEY || '';
  const accountId = process.env.MEMWAL_ACCOUNT_ID || '';
  if (!key || !accountId) {
    console.error('REFUSED: MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID are both required.');
    console.error('Create a delegate key in the Walrus Memory dashboard (https://memory.walrus.xyz/dashboard),');
    console.error('put the two values in .env (never commit .env), then run npm run seed again.');
    console.error('Nothing was written. No key value is printed here.');
    process.exit(2);
  }
  const seedPath = path.join(__dirname, '..', 'data', 'seed-picks.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const texts = (seed.memories || []).map(m => m.text);
  if (!texts.length || texts.length > 20) {
    console.error(`REFUSED: seed file has ${texts.length} memories (rememberBulkAndWait max is 20).`);
    process.exit(2);
  }
  console.log(`Seeding ${texts.length} memories to Walrus Memory (namespace: recall-picks, Mainnet relayer)...`);
  const mod = await import('@mysten-incubation/memwal');
  const MemWal = mod.MemWal || mod.default || mod;
  const opts = { key, accountId, serverUrl: 'https://relayer.memory.walrus.xyz', namespace: 'recall-picks' };
  const client = typeof MemWal.create === 'function' ? await MemWal.create(opts) : new MemWal(opts);
  const res = await client.rememberBulkAndWait(texts.map(t => ({ text: t })));
  // rememberBulkAndWait takes [{text, namespace?}] and returns
  // {results:[{id, blob_id, status, namespace}], total, succeeded, failed}.
  console.log('Seed write finished.');
  console.log('Result (blob ids / statuses only — no key material):', JSON.stringify(res, null, 2).slice(0, 4000));
  console.log('Verify in the Walrus Memory dashboard, then re-check GET /api/memory (live mode).');
}
main().catch(e => { console.error('Seed failed:', String(e.message || e).slice(0, 500)); process.exit(1); });
