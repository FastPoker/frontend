'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useChat, type ChatMessage } from '@/hooks/useChat';
import { useChatProfiles } from '@/hooks/useChatProfiles';
import { AvatarRing } from '@/components/progression/AvatarRing';

// Render text safely. React's default text node escaping handles XSS — never
// pass message text to dangerouslySetInnerHTML.

function shortWallet(w: string): string {
  if (!w || w === '11111111111111111111111111111111') return 'system';
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

interface ChatPanelProps {
  /** Either 'global' or 'table:<PDA>'. */
  channel: string;
  /** Optional friendly title shown above the messages list. */
  title?: string;
  /** Pixel height for the panel. Default 320. */
  heightPx?: number;
  /**
   * Show profile avatars + frames next to each message. Enable for global chat;
   * leave OFF for table chat to avoid IP-leak / mid-hand-tell attack vectors.
   */
  showAvatars?: boolean;
}

export function ChatPanel({ channel, title, heightPx = 320, showAvatars = false }: ChatPanelProps) {
  const channels = useMemo(() => [channel], [channel]);
  const chat = useChat({ channels });
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages: ChatMessage[] = chat.messagesByChannel[channel] ?? [];

  // Resolve all distinct wallets in the visible message list to profile data.
  const wallets = useMemo(() => Array.from(new Set(messages.map((m) => m.wallet))), [messages]);
  const profilesEnabled = showAvatars && wallets.length > 0;
  const profiles = useChatProfiles(profilesEnabled ? wallets : []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    chat.send(channel, text);
    setDraft('');
  };

  const isAuthed = chat.status === 'authed';
  const placeholder =
    chat.status === 'idle' || chat.status === 'connecting'
      ? 'connecting…'
      : chat.status === 'awaiting-sig'
        ? 'waiting on wallet signature…'
        : !isAuthed
          ? chat.lastError ?? 'unable to connect'
          : 'say hi';

  return (
    <div
      className="flex flex-col rounded-sm hairline bg-inkA overflow-hidden"
      style={{ height: heightPx }}
    >
      <div className="px-3 py-2 hairline-b flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] tracking-[0.22em] text-bone/85">
          {title ?? (channel === 'global' ? 'GLOBAL CHAT' : 'TABLE CHAT')}
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isAuthed ? 'bg-emerald-400' : chat.status === 'error' ? 'bg-rose-400' : 'bg-amber-400'
            }`}
          />
          <span className="font-mono text-[8px] text-boneDim/60 tracking-[0.18em] uppercase">
            {chat.status}
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {messages.length === 0 && (
          <div className="font-mono text-[10px] text-boneDim/50 italic">no messages yet.</div>
        )}
        {messages.map((m) => {
          const mine = chat.authedWallet && m.wallet === chat.authedWallet;
          const time = new Date(m.ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
          const profile = showAvatars ? profiles[m.wallet] ?? null : null;
          const displayName = profile?.username || shortWallet(m.wallet);
          const isReal = m.wallet && m.wallet !== '11111111111111111111111111111111';
          const profileHref = `/profile?address=${encodeURIComponent(m.wallet)}`;
          const nameNode = isReal ? (
            <Link
              href={profileHref}
              className={`${mine ? 'text-amber-300' : 'text-orange-300'} hover:text-amber-100 underline decoration-orange/20 underline-offset-2 hover:decoration-amber-300/60 transition`}
              title={`Open profile · ${m.wallet}`}
            >
              {displayName}
            </Link>
          ) : (
            <span className={mine ? 'text-amber-300' : 'text-orange-300'}>{displayName}</span>
          );

          if (showAvatars) {
            // AvatarRing shows the tier-frame (bronze/silver/gold/platinum/diamond)
            // and XP arc — same component the navbar + profile card use, so a
            // user's chat avatar matches their public profile.
            const avatarSrc = profile?.avatarImageUrl || profile?.avatarUrl || null;
            return (
              <div
                key={m.id}
                className="flex items-start gap-2.5 font-mono text-[11px] leading-tight"
              >
                <Link
                  href={profileHref}
                  className="shrink-0 mt-[1px]"
                  title={`Open profile · ${m.wallet}`}
                >
                  <AvatarRing
                    size={28}
                    level={profile?.level ?? 0}
                    xp={profile?.xpInLevel ?? 0}
                    seed={profile?.avatarSeed || m.wallet}
                    avatarSrc={avatarSrc}
                    avatarLabel={profile?.username || m.wallet}
                    frameAnim="off"
                  />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5 flex-wrap">
                    {nameNode}
                    <span className="text-boneDim/45 tabular-nums text-[9px]">{time}</span>
                  </div>
                  <div className="text-bone/85 break-words">{m.text}</div>
                </div>
              </div>
            );
          }

          return (
            <div key={m.id} className="font-mono text-[11px] leading-tight">
              <span className="text-boneDim/45 tabular-nums">{time}</span>{' '}
              {nameNode}{' '}
              <span className="text-bone/85 break-words">{m.text}</span>
            </div>
          );
        })}
      </div>

      {chat.lastReject && chat.lastReject.channel === channel && (
        <div className="px-3 py-1 border-t border-rose-500/30 bg-rose-500/5 font-mono text-[10px] text-rose-300">
          {chat.lastReject.reason}
        </div>
      )}

      <form onSubmit={submit} className="hairline-t px-2 py-2 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          disabled={!isAuthed}
          placeholder={placeholder}
          className="flex-1 bg-ink/40 hairline rounded-sm px-2 py-1.5 font-mono text-[11px] text-bone/90 outline-none disabled:opacity-50 placeholder:text-boneDim/40"
        />
        <button
          type="submit"
          disabled={!isAuthed || !draft.trim()}
          className="px-3 py-1.5 rounded-sm border border-orange/40 hover:border-orange hover:bg-orange/10 font-mono text-[10px] tracking-[0.18em] text-orange/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          SEND
        </button>
      </form>
    </div>
  );
}
