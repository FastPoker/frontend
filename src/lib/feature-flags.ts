function enabledByDefault(rawValue: string | undefined): boolean {
  const raw = (rawValue || '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function disabledByDefault(rawValue: string | undefined): boolean {
  const raw = (rawValue || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export const PROFILE_API_ENABLED = enabledByDefault(process.env.NEXT_PUBLIC_ENABLE_PROFILES);
export const ACHIEVEMENTS_ENABLED = enabledByDefault(process.env.NEXT_PUBLIC_ENABLE_ACHIEVEMENTS);
export const INDEXER_API_ENABLED = disabledByDefault(process.env.NEXT_PUBLIC_ENABLE_INDEXER);
export const INTEGRITY_API_ENABLED = disabledByDefault(process.env.NEXT_PUBLIC_ENABLE_INTEGRITY);
