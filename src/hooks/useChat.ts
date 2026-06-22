'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import bs58 from 'bs58';

export interface ChatMessage {
  id: string;
  channel: string;
  wallet: string;
  text: string;
  ts: number;
}

export type ChatStatus =
  | 'idle'
  | 'connecting'
  | 'awaiting-sig'
  | 'authed'
  | 'error'
  | 'disconnected';

export interface UseChatOptions {
  /** Chat WebSocket URL. Defaults to env NEXT_PUBLIC_CHAT_WS_URL or same-origin /chat. */
  url?: string;
  /** Channels to subscribe once authed. Pass `['global', 'table:<PDA>']` etc. */
  channels: string[];
  /** When false, do nothing — useful while a wallet is still loading. */
  enabled?: boolean;
}

export interface UseChatResult {
  status: ChatStatus;
  authedWallet: string | null;
  /** Per-channel message history (ring buffer of recent + live). */
  messagesByChannel: Record<string, ChatMessage[]>;
  /** Last error from server (if any). */
  lastError: string | null;
  /** Last reject (rate-limited, in-hand mute, etc.). */
  lastReject: { channel: string; reason: string } | null;
  send: (channel: string, text: string) => void;
  reconnect: () => void;
}

function resolveChatWsUrl(override?: string): string {
  const configured = override?.trim() || process.env.NEXT_PUBLIC_CHAT_WS_URL?.trim();
  if (configured) {
    if (configured.startsWith('/') && typeof window !== 'undefined') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}${configured}`;
    }
    return configured;
  }

  if (typeof window === 'undefined') return 'ws://localhost:4400';

  const { hostname, host, protocol } = window.location;
  const isLocal =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';

  if (isLocal) return 'ws://localhost:4400';

  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/chat`;
}

export function useChat(opts: UseChatOptions): UseChatResult {
  const { signMessage, publicKey, isConnected: connected } = useUnifiedWallet();
  const url = resolveChatWsUrl(opts.url);
  const channelsRef = useRef<string[]>(opts.channels);
  channelsRef.current = opts.channels;

  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [authedWallet, setAuthedWallet] = useState<string | null>(null);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastReject, setLastReject] = useState<{ channel: string; reason: string } | null>(null);
  const reconnectTokenRef = useRef(0);

  const enabled = opts.enabled !== false;

  const subscribeAll = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const ch of channelsRef.current) {
      ws.send(JSON.stringify({ type: 'sub', channel: ch }));
    }
  }, []);

  const send = useCallback((channel: string, text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'send', channel, text }));
  }, []);

  const reconnect = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
    }
    reconnectTokenRef.current += 1;
    setMessagesByChannel({});
    setStatus('idle');
    setAuthedWallet(null);
    setLastError(null);
    setLastReject(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!connected || !publicKey || !signMessage) return;
    const myToken = reconnectTokenRef.current;

    let cancelled = false;
    setStatus('connecting');
    setLastError(null);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => { /* wait for challenge */ };

    ws.onmessage = async (ev) => {
      if (cancelled || myToken !== reconnectTokenRef.current) return;
      let parsed: { type?: string; [k: string]: unknown };
      try { parsed = JSON.parse(ev.data); } catch { return; }
      switch (parsed.type) {
        case 'challenge': {
          setStatus('awaiting-sig');
          try {
            const prefix = String(parsed.prefix ?? '');
            const msg = new TextEncoder().encode(prefix);
            const sigBytes = await signMessage(msg);
            ws.send(JSON.stringify({
              type: 'auth',
              wallet: publicKey.toBase58(),
              sig: bs58.encode(sigBytes),
            }));
          } catch (err) {
            setLastError(err instanceof Error ? err.message : String(err));
            setStatus('error');
            try { ws.close(); } catch { /* ignore */ }
          }
          return;
        }
        case 'authed': {
          setAuthedWallet(typeof parsed.wallet === 'string' ? parsed.wallet : null);
          setStatus('authed');
          subscribeAll();
          return;
        }
        case 'history': {
          const ch = String(parsed.channel ?? '');
          const list = Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : [];
          setMessagesByChannel((cur) => ({ ...cur, [ch]: list }));
          return;
        }
        case 'msg': {
          const m = parsed.message as ChatMessage | undefined;
          if (!m || !m.channel) return;
          setMessagesByChannel((cur) => {
            const list = cur[m.channel] ?? [];
            return { ...cur, [m.channel]: [...list, m].slice(-200) };
          });
          return;
        }
        case 'rejected': {
          setLastReject({
            channel: String(parsed.channel ?? ''),
            reason: String(parsed.reason ?? ''),
          });
          return;
        }
        case 'error': {
          setLastError(typeof parsed.reason === 'string' ? parsed.reason : 'unknown');
          setStatus('error');
          return;
        }
      }
    };

    ws.onclose = () => {
      if (cancelled || myToken !== reconnectTokenRef.current) return;
      setStatus('disconnected');
    };

    ws.onerror = () => {
      if (cancelled || myToken !== reconnectTokenRef.current) return;
      setStatus('error');
    };

    return () => {
      cancelled = true;
      try { ws.close(); } catch { /* ignore */ }
    };
  }, [enabled, connected, publicKey, signMessage, url, subscribeAll]);

  return {
    status,
    authedWallet,
    messagesByChannel,
    lastError,
    lastReject,
    send,
    reconnect,
  };
}
