function enabled(rawValue: string | undefined): boolean {
  const raw = (rawValue || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function indexerReadsEnabled(): boolean {
  return enabled(process.env.NEXT_PUBLIC_ENABLE_INDEXER);
}

export function getIndexerBaseUrl(): string {
  if (!indexerReadsEnabled()) return '';
  return (process.env.INDEXER_BASE_URL || '').trim().replace(/\/+$/, '');
}
