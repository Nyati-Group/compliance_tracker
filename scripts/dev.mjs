// Local development: the API server (restarts on change) and the Vite dev server (hot reload), side by side.
// Open the address Vite prints; it forwards /api, /auth, /files, /data and /images to the API server.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['--watch', 'server.js'], { cwd: new URL('../server/', import.meta.url), stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'client/vite.config.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
];
const stop = () => { for (const p of procs) p.kill(); process.exit(); };
for (const p of procs) p.on('exit', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
