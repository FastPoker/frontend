/**
 * Helpers for building copyable debug payloads from arbitrary errors.
 *
 * The goal: when a user hits a transaction failure, they should be able to
 * tap "Copy debug" and paste a Discord-ready block that gives us everything
 * we need to triage — error name/message, wallet adapter logs, simulation
 * logs, signature if any, RPC, action, wallet pubkey, timestamp.
 *
 * We deliberately do NOT include any keypair material or session-secret
 * fragments. Only public pubkeys, tx sigs, and program-side logs.
 */

export interface ToastDebugContext {
  action?: string;
  wallet?: string;
  programId?: string;
  rpc?: string;
  signature?: string;
  extra?: Record<string, string | number | boolean | null | undefined>;
}

interface NormalizedError {
  name: string;
  message: string;
  code?: string | number;
  logs?: string[];
  signature?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function normalizeError(rawError: unknown): NormalizedError {
  if (rawError instanceof Error) {
    const out: NormalizedError = {
      name: rawError.name || 'Error',
      message: rawError.message || String(rawError),
    };
    if (isObject(rawError)) {
      const anyErr = rawError as unknown as Record<string, unknown>;
      if (typeof anyErr.code === 'string' || typeof anyErr.code === 'number') {
        out.code = anyErr.code as string | number;
      }
      // SendTransactionError / Anchor / wallet adapter sometimes attach logs.
      const logs = anyErr.logs ?? (anyErr as { transactionLogs?: unknown }).transactionLogs;
      if (Array.isArray(logs)) {
        out.logs = logs.filter((l): l is string => typeof l === 'string');
      }
      if (typeof anyErr.signature === 'string') {
        out.signature = anyErr.signature;
      }
    }
    return out;
  }
  if (typeof rawError === 'string') {
    return { name: 'Error', message: rawError };
  }
  if (isObject(rawError)) {
    const message =
      typeof rawError.message === 'string' ? rawError.message : JSON.stringify(rawError);
    return {
      name: typeof rawError.name === 'string' ? rawError.name : 'Error',
      message,
    };
  }
  return { name: 'Error', message: String(rawError) };
}

export function buildDebugBlock(
  error: unknown,
  ctx: ToastDebugContext = {},
): string {
  const e = normalizeError(error);
  const lines: string[] = [];
  lines.push('```');
  lines.push(`time: ${new Date().toISOString()}`);
  if (ctx.action) lines.push(`action: ${ctx.action}`);
  if (ctx.wallet) lines.push(`wallet: ${ctx.wallet}`);
  if (ctx.programId) lines.push(`program: ${ctx.programId}`);
  if (ctx.rpc) lines.push(`rpc: ${ctx.rpc}`);
  if (ctx.signature || e.signature) {
    lines.push(`sig: ${ctx.signature ?? e.signature}`);
  }
  lines.push(`error.name: ${e.name}`);
  lines.push(`error.message: ${e.message}`);
  if (e.code !== undefined) lines.push(`error.code: ${e.code}`);
  if (ctx.extra) {
    for (const [k, v] of Object.entries(ctx.extra)) {
      if (v === undefined || v === null) continue;
      lines.push(`${k}: ${v}`);
    }
  }
  if (e.logs && e.logs.length) {
    lines.push('logs:');
    for (const l of e.logs) lines.push(`  ${l}`);
  }
  lines.push('```');
  return lines.join('\n');
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  // Legacy fallback for non-secure contexts.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
