/**
 * Enrichit lists/seed.json : marque verified:false si pas d'id numérique.
 * La résolution live des ids se fait au runtime (H2) faute d'accès X offline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'lists/seed.json');
const raw = readFileSync(path, 'utf8');
const seed = JSON.parse(raw);
const hash = createHash('sha256').update(raw).digest('hex');
let withId = 0;
let unverified = 0;
seed.entries = (seed.entries || []).map((e) => {
  const entry = { ...e };
  if (entry.id) {
    entry.verified = true;
    withId++;
  } else {
    entry.verified = false;
    unverified++;
  }
  return entry;
});
seed.integrity = {
  sha256_at_enrich: hash,
  enriched_at: new Date().toISOString(),
  note: 'Handles without numeric id are unverified; runtime resolves id and checks handle match before block.',
};
writeFileSync(path, JSON.stringify(seed, null, 1) + '\n');
console.log(JSON.stringify({ total: seed.entries.length, withId, unverified }, null, 2));
