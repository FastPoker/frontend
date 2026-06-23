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

// Navbar page visibility. These optional content pages ship in the original nav,
// so they default to VISIBLE. Set the matching env to 0/false/off to drop the
// nav entry (the route itself is untouched). Read the same NEXT_PUBLIC_* way as
// the flags above so the value is inlined at build time and SSR-safe.
export const NAV_EARN_VISIBLE = enabledByDefault(process.env.NEXT_PUBLIC_NAV_EARN);
export const NAV_AUCTIONS_VISIBLE = enabledByDefault(process.env.NEXT_PUBLIC_NAV_AUCTIONS);
export const NAV_DEALER_VISIBLE = enabledByDefault(process.env.NEXT_PUBLIC_NAV_DEALER);
export const NAV_HOW_TO_PLAY_VISIBLE = enabledByDefault(process.env.NEXT_PUBLIC_NAV_HOW_TO_PLAY);
