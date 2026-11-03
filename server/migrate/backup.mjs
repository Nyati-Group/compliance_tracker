// Read-only backup. Copies the master files and exports every MongoDB collection to JSON under server/backups/<timestamp>/.
// Run:  node migrate/backup.mjs        (from the server folder)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
if (fs.existsSync(path.join(here, '..', '.env'))) process.loadEnvFile(path.join(here, '..', '.env'));

export async function backup(label = 'manual') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(here, '..', 'backups', `${stamp}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['items.json', 'stages.json']) fs.copyFileSync(path.join(root, 'app', f), path.join(dir, f));

  const counts = {};
  if (process.env.MONGODB_URI) {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    try {
      const db = client.db(process.env.MONGODB_DB || 'compliance_tracker');
      for (const { name } of await db.listCollections().toArray()) {
        if (name.startsWith('system.')) continue;
        const docs = await db.collection(name).find().toArray();
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 1));
        counts[name] = docs.length;
      }
    } finally { await client.close(); }
  }
  console.log(`Backup written to ${dir}`);
  console.log('Collections:', JSON.stringify(counts));
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await backup(process.argv[2] || 'manual');
