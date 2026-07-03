// UnderViz server — minimal Express app.
// Jobs: (a) proxy the Windy Point Forecast API so the key stays server-side,
// (b) cache responses (15 min TTL), (c) accumulate forecast history on disk,
// (d) serve the static client and the shared physics modules.

import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Load .env from the project root, not the process cwd, so `node` can be
// invoked from anywhere.
dotenv.config({ path: path.join(root, '.env') });

const { SERVER } = await import('../lib/config.js');
const { getForecast } = await import('./forecast.js');
const app = express();

app.use(express.static(path.join(root, 'public')));
app.use('/lib', express.static(path.join(root, 'lib')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, windyKey: Boolean(process.env.WINDY_API_KEY) });
});

app.get('/api/forecast', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat and lon query params required' });
  }
  try {
    res.json(await getForecast(lat, lon));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message, warnings: err.warnings ?? [] });
  }
});

const port = Number(process.env.PORT) || SERVER.DEFAULT_PORT;
app.listen(port, () => {
  console.log(`UnderViz listening on http://localhost:${port}`);
  if (!process.env.WINDY_API_KEY) {
    console.warn('WINDY_API_KEY not set — falling back to Open-Meteo for all data.');
  }
});
