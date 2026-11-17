// Re-evaluate applicability for every company, project, phase and building after shared/items.json or
// shared/applicability.json changed (new records get their rows; changed rules update "auto" rows; manual decisions are kept).
//   node migrate/refresh-applicability.mjs            dry run: says which database it would refresh
//   node migrate/refresh-applicability.mjs --apply    backs up that database, then refreshes it
// Another database:  MONGODB_DB=compliance_tracker node migrate/refresh-applicability.mjs --apply
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { generate } from '../generate.mjs';
import { backup } from './backup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '..', '.env'));
const DB_NAME = process.env.MONGODB_DB || 'compliance_tracker';
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
try {
  const db = client.db(DB_NAME);
  console.log(`Target: database "${DB_NAME}" (${await db.collection('applicability').countDocuments()} applicability rows).`);
  if (!process.argv.includes('--apply')) { console.log('DRY RUN: nothing was written. Re-run with --apply.'); process.exit(0); }
  await backup('before-refresh-applicability');
  const s = await generate(db, { all: true }, 'migration');
  console.log(`Instances: ${s.instances}; new: ${s.created}; updated: ${s.updated}; unchanged: ${s.unchanged}; manual decisions that now disagree: ${s.manual_disagree}`);
  console.log('By status:', JSON.stringify(s.byStatus));
} finally { await client.close(); }
