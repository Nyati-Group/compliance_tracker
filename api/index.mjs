// Vercel serverless entrypoint: every request is rewritten here (see vercel.json), and the
// app underneath handles routing exactly as it does on a traditional host.
// If the server cannot start (a missing setting, no database), every request gets a JSON answer saying why,
// instead of Vercel's bare FUNCTION_INVOCATION_FAILED; the full error is in the function logs.
let app;
try {
  app = (await import('../server/server.js')).default;
} catch (e) {
  console.error('Server start-up failed:', e);
  // Anything that looks like a connection string is removed from the message before it is shown.
  const detail = String(e && (e.code ? `${e.code}: ` : '') + (e && e.message)).replace(/mongodb(\+srv)?:\/\/\S+/gi, '[database address]').slice(0, 400);
  const error = e.startup ? `The server could not start: ${e.message}` : `The server could not start (${detail}). See the function logs in Vercel.`;
  app = (req, res) => { res.statusCode = 500; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error })); };
}

export default app;
