'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NoteColor } from '@/hooks/usePlayerNotes';

const NOTE_MAX_LEN = 500;

// Swatch palette — keep in lockstep with NOTE_COLORS (lib/player-notes.ts).
const SWATCHES: { key: NoteColor; hex: string; label: string }[] = [
  { key: 'none', hex: 'transparent', label: 'None' },
  { key: 'red', hex: '#ef4444', label: 'Red' },
  { key: 'orange', hex: '#F26A1F', label: 'Orange' },
  { key: 'yellow', hex: '#F4A52A', label: 'Yellow' },
  { key: 'green', hex: '#22c55e', label: 'Green' },
  { key: 'blue', hex: '#3b82f6', label: 'Blue' },
  { key: 'purple', hex: '#a855f7', label: 'Purple' },
];

function shortWallet(w: string): string {
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

const NOTE_MIN_LEVEL = 5;

export function PlayerNoteModal({
  open,
  targetPubkey,
  targetName,
  initialNote,
  initialColor,
  authorLevel,
  onSave,
  onClose,
  onEnsureLoaded,
}: {
  open: boolean;
  targetPubkey: string;
  targetName?: string;
  initialNote: string;
  initialColor: NoteColor;
  /** Author's account level. Notes unlock at level 5. undefined = unknown (let
   *  the server decide). */
  authorLevel?: number;
  onSave: (note: string, color: NoteColor) => Promise<boolean>;
  onClose: () => void;
  /** Trigger the (signed) one-time load of the author's notes. */
  onEnsureLoaded?: () => void;
}) {
  const [note, setNote] = useState(initialNote);
  const [color, setColor] = useState<NoteColor>(initialColor);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = authorLevel != null && authorLevel < NOTE_MIN_LEVEL;

  // Reseed when the target (or its stored note) changes — the modal is reused
  // across players.
  useEffect(() => {
    setNote(initialNote);
    setColor(initialColor);
    setSaving(false);
    setError(null);
  }, [targetPubkey, initialNote, initialColor]);

  // Load existing notes once on open, but ONLY when unlocked — so a sub-level-5
  // user never gets a signing popup for a feature they can't use.
  useEffect(() => {
    if (open && !locked) onEnsureLoaded?.();
  }, [open, locked, onEnsureLoaded]);

  // Guard SSR — createPortal needs document. (The game page is client-only, but
  // be safe.)
  if (!open || typeof document === 'undefined') return null;

  const dirty = note !== initialNote || color !== initialColor;

  const handleSave = async () => {
    if (saving || locked) return;
    setSaving(true);
    setError(null);
    const ok = await onSave(note, color);
    setSaving(false);
    if (ok) onClose();
    else setError('Could not save. You may have reached the 200-player note limit.');
  };

  // Portal to <body> so the overlay escapes the table's transformed/scaled
  // containers (a CSS transform makes `fixed` anchor to that ancestor, which was
  // clipping + offsetting this modal on mobile and desktop). z is very high so
  // it sits above all table chrome.
  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-ink/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-room hairline rounded-xl w-full max-w-[380px] p-4 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-boneDim/60 hover:text-bone transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="font-display text-lg text-bone tracking-wide pr-6">PLAYER NOTE</div>
        <div className="font-mono text-[11px] text-boneDim/70 mt-0.5 truncate">
          {targetName ? `${targetName} · ` : ''}{shortWallet(targetPubkey)}
        </div>

        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-boneDim/50 font-mono">
          <Lock size={10} />
          <span>Private to you. Never shown to this player or anyone else.</span>
        </div>

        {locked ? (
          <div className="mt-4">
            <div className="rounded-lg hairline bg-ink/50 px-4 py-5 text-center">
              <div className="font-display text-bone text-base">Notes unlock at level {NOTE_MIN_LEVEL}</div>
              <div className="font-mono text-[11px] text-boneDim/70 mt-1">
                You&apos;re level {authorLevel}. Keep playing to unlock private player notes.
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-full mt-3 py-2 rounded-lg hairline text-sm text-boneDim hover:text-bone transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {/* Color tags */}
            <div className="flex items-center gap-2 mt-3">
              {SWATCHES.map((s) => {
                const active = color === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    title={s.label}
                    onClick={() => setColor(s.key)}
                    className={cn(
                      'w-6 h-6 rounded-full border flex items-center justify-center transition-all',
                      active ? 'border-bone scale-110' : 'border-bone/20 hover:border-bone/50',
                      s.key === 'none' && 'text-boneDim/60',
                    )}
                    style={s.key === 'none' ? undefined : { background: s.hex, boxShadow: active ? `0 0 8px ${s.hex}` : undefined }}
                  >
                    {s.key === 'none' && <span className="text-[9px] font-mono">∅</span>}
                  </button>
                );
              })}
            </div>

            {/* Note text */}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX_LEN))}
              rows={4}
              maxLength={NOTE_MAX_LEN}
              placeholder="e.g. limps then folds to any raise, overbets the river as a bluff…"
              className="w-full mt-3 px-3 py-2 rounded-lg bg-ink/60 hairline text-sm text-bone placeholder:text-boneDim/40 resize-none focus:outline-none focus:ring-1 focus:ring-orange/50"
            />
            <div className="flex items-center justify-between mt-1">
              <span className="font-mono text-[10px] text-boneDim/40">{note.length}/{NOTE_MAX_LEN}</span>
              {error && <span className="font-mono text-[10px] text-red-400 text-right">{error}</span>}
            </div>

            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg hairline text-sm text-boneDim hover:text-bone transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!dirty || saving}
                className="btn-orange flex-1 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
