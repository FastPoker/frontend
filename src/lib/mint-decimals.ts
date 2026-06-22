import { Connection, PublicKey } from '@solana/web3.js';

const cache = new Map<string, number>([
  ['', 9],
  [PublicKey.default.toBase58(), 9],
]);

export async function resolveMintDecimals(conn: Connection, mints: string[]): Promise<void> {
  const need = Array.from(new Set(mints.filter((m) => m && !cache.has(m))));
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map((m) => new PublicKey(m))).catch(() => null);
    if (!infos) continue;
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (info && info.data.length > 44) cache.set(chunk[j], info.data[44]);
    }
  }
}

export async function attachTokenDecimals<T extends { tokenMint: string; decimals?: number }>(
  conn: Connection,
  rows: T[],
): Promise<void> {
  await resolveMintDecimals(conn, rows.map((r) => r.tokenMint));
  for (const r of rows) r.decimals = cache.get(r.tokenMint) ?? r.decimals ?? 9;
}
