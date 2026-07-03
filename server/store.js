// Small on-disk JSON store. Two uses:
//   HistoryStore — persists fetched forecast hours per site so hindcast history
//                  accumulates as the app runs (Windy has no hindcast endpoint).
//   LastGoodStore — last successful API response per site, served with a
//                   staleness flag when every upstream source fails.

import fs from 'node:fs';
import path from 'node:path';
import { SERVER } from '../lib/config.js';

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(key) {
    return path.join(this.dir, key.replace(/[^0-9a-zA-Z._-]/g, '_') + '.json');
  }

  read(key) {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(key), 'utf8'));
    } catch {
      return null;
    }
  }

  write(key, obj) {
    const file = this.fileFor(key);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }
}

export class HistoryStore extends JsonStore {
  /** Upsert hourly records; prunes entries older than the retention window. */
  upsert(key, hours) {
    const obj = this.read(key) ?? { hours: {} };
    for (const h of hours ?? []) {
      if (h && isFinite(h.ts)) obj.hours[h.ts] = h;
    }
    const cutoff = Date.now() - SERVER.HISTORY_RETENTION_DAYS * 86400e3;
    for (const ts of Object.keys(obj.hours)) {
      if (Number(ts) < cutoff) delete obj.hours[ts];
    }
    this.write(key, obj);
  }

  /** Sorted records with from <= ts < to. */
  range(key, from, to) {
    const obj = this.read(key);
    if (!obj) return [];
    return Object.values(obj.hours)
      .filter((h) => h.ts >= from && h.ts < to)
      .sort((a, b) => a.ts - b.ts);
  }
}

export class LastGoodStore extends JsonStore {
  save(key, payload) {
    this.write(key, { savedAt: Date.now(), payload });
  }

  load(key) {
    return this.read(key);
  }
}
