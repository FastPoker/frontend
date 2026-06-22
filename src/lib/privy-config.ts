type PrivyLoginMethod = 'email' | 'google' | 'twitter' | 'apple' | 'wallet';

function envFlag(raw: string | undefined, fallback = false): boolean {
  if (raw == null || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const PRIVY_APP_ID = (process.env.NEXT_PUBLIC_PRIVY_APP_ID || '').trim();

// Public source builds are wallet-only unless the operator explicitly opts into
// Privy. Setting an app id alone is not enough.
export const PRIVY_AUTH_ENABLED =
  !!PRIVY_APP_ID && envFlag(process.env.NEXT_PUBLIC_PRIVY_LOGIN_ENABLED, false);

export const PRIVY_EMAIL_ENABLED =
  PRIVY_AUTH_ENABLED && envFlag(process.env.NEXT_PUBLIC_PRIVY_LOGIN_EMAIL, false);
export const PRIVY_GOOGLE_ENABLED =
  PRIVY_AUTH_ENABLED && envFlag(process.env.NEXT_PUBLIC_PRIVY_LOGIN_GOOGLE, false);
export const PRIVY_X_ENABLED =
  PRIVY_AUTH_ENABLED && (
    envFlag(process.env.NEXT_PUBLIC_PRIVY_LOGIN_X, false) ||
    envFlag(process.env.NEXT_PUBLIC_PRIVY_LOGIN_TWITTER, false)
  );
export const PRIVY_APPLE_ENABLED =
  PRIVY_AUTH_ENABLED && envFlag(process.env.NEXT_PUBLIC_PRIVY_LOGIN_APPLE, false);

export const PRIVY_VISIBLE_LOGIN_METHODS: PrivyLoginMethod[] = [
  ...(PRIVY_EMAIL_ENABLED ? (['email'] as const) : []),
  ...(PRIVY_GOOGLE_ENABLED ? (['google'] as const) : []),
  ...(PRIVY_X_ENABLED ? (['twitter'] as const) : []),
  ...(PRIVY_APPLE_ENABLED ? (['apple'] as const) : []),
];

export const PRIVY_LOGIN_METHODS: PrivyLoginMethod[] =
  PRIVY_VISIBLE_LOGIN_METHODS.length > 0
    ? [...PRIVY_VISIBLE_LOGIN_METHODS, 'wallet']
    : ['wallet'];

export const PRIVY_HAS_VISIBLE_LOGIN =
  PRIVY_VISIBLE_LOGIN_METHODS.length > 0;
