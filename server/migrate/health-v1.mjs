// Migration 004: project compliance intelligence.
//   node migrate/health-v1.mjs            dry run (shows what would be created)
//   node migrate/health-v1.mjs --apply    backs up, then: creates indexes, saves default health settings (only if none exist),
//                                         and writes today's first score snapshot and rule-based recommendations for every project
// Adds data only. Nothing existing is changed or deleted. Safe to re-run: snapshots and recommendations are updated in place, never duplicated.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { backup } from './backup.mjs';
import { loadShared, healthOf, saveSnapshot, syncRecs } from '../intel.mjs';
import { buildRecommendations, DEFAULT_HEALTH } from '../health.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const APPLY = process.argv.includes('--apply');

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'compliance_tracker');
try {
  const shared = await loadShared(db);
  const ids = [...Object.keys(shared.w.projects), ...Object.keys(shared.w.companies)];
  const hasSettings = !!(await db.collection('settings').findOne({ _id: 'health' }));
  const rows = ids.map((id) => { const h = healthOf(shared, id); return { id, name: h.scope.name, score: h.score, cat: h.category, recs: buildRecommendations(h, {}).length }; });
  console.log(`Views to score: ${ids.length}. Default health settings: ${hasSettings ? 'already present, will not be changed' : 'will be saved'}.`);
  const withScore = rows.filter((r) => r.score != null);
  console.log(`Scored: ${withScore.length}; example: ${withScore.slice(0, 3).map((r) => `${r.name} = ${r.score} (${r.cat}), ${r.recs} recommendations`).join(' | ')}`);
  if (!APPLY) { console.log('\nDRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }

  await backup('pre-health-v1');
  await db.collection('ai_recommendations').createIndexes([{ key: { scope_id: 1, status: 1 } }, { key: { dedupe_key: 1 } }, { key: { priority: 1, updated_at: -1 } }]);
  await db.collection('health_snapshots').createIndexes([{ key: { scope_id: 1, date: -1 } }]);
  await db.collection('ai_analyses').createIndexes([{ key: { project_id: 1, analysed_at: -1 } }]);
  if (!hasSettings) await db.collection('settings').insertOne({ _id: 'health', ...DEFAULT_HEALTH, updated_by: 'migration', updated_at: new Date().toISOString() });
  let recs = 0;
  for (const id of ids) { const h = healthOf(shared, id); await saveSnapshot(db, h); const r = await syncRecs(db, h, buildRecommendations(h, {})); recs += r.created + r.updated; }
  console.log(`\nApplied. Snapshots written for ${ids.length} views; ${recs} recommendation(s) created or refreshed.`);
} finally { await client.close(); }
