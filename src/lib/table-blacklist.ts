import * as fs from 'fs';
import * as path from 'path';

const TABLE_BLACKLIST_PATH = path.resolve('data/table-blacklist.json');

type TableBlacklistEntry = string | { pubkey?: unknown };

export function getTableBlacklist(): Set<string> {
  try {
    if (!fs.existsSync(TABLE_BLACKLIST_PATH)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(TABLE_BLACKLIST_PATH, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const pubkeys = parsed
      .map((entry: TableBlacklistEntry) => (typeof entry === 'string' ? entry : entry?.pubkey))
      .filter((pubkey): pubkey is string => typeof pubkey === 'string' && pubkey.length > 0);
    return new Set(pubkeys);
  } catch {
    return new Set();
  }
}
