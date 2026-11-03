// Migration 005: Regulatory Updates.
//   node migrate/regulatory-v1.mjs            dry run (shows what would be created)
//   node migrate/regulatory-v1.mjs --apply    backs up, then creates indexes and adds the starting official sources (existing sources are never changed)
// Adds data only. Collections used: regulatory_sources, regulatory_updates, regulatory_runs (new); notifications is reused.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { backup } from './backup.mjs';
import { seedSources, ensureIndexes } from '../regulatory-routes.mjs';
import { SEED_SOURCES } from '../regulatory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const APPLY = process.argv.includes('--apply');

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'compliance_tracker');
try {
  const have = new Set((await db.collection('regulatory_sources').find({}, { projection: { _id: 1 } }).toArray()).map((s) => s._id));
  const fresh = SEED_SOURCES.filter((s) => !have.has(s._id));
  console.log(`Sources already present: ${have.size}. To add: ${fresh.length}`);
  for (const s of fresh) console.log(`  ${s.enabled ? 'MONITORED ' : s.kind === 'manual' ? 'manual    ' : 'disabled  '} ${s.name}  ${s.url || '(no address)'}`);
  if (!APPLY) { console.log('\nDRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }
  await backup('pre-regulatory-v1');
  await ensureIndexes(db);
  const added = await seedSources(db);
  console.log(`\nApplied. Indexes ensured; ${added} source(s) added. Existing notifications, projects and compliance data were not touched.`);
} finally { await client.close(); }
