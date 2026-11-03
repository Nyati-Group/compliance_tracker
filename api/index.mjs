// Vercel serverless entrypoint: every request is rewritten here (see vercel.json), and the
// Express app underneath handles routing exactly as it does on a traditional host.
import app from '../server/server.js';

export default app;
