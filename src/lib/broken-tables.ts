import * as fs from 'fs';
import * as path from 'path';

const BROKEN_TABLES_PATH = path.resolve('data/broken-tables.json');

export function getBrokenTablesList(): { pubkey: string; reason: string; markedAt: number }[] {
  try {
    if (!fs.existsSync(BROKEN_TABLES_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(BROKEN_TABLES_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
