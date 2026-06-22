'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  buildFundsActionReview,
  FUNDS_CONFIRM_EVENT,
  type FundsActionPreview,
  type FundsConfirmEventDetail,
} from '@/lib/funds-confirmation';
import { suppressFundsConfirm } from '@/lib/funds-confirm-suppress';

type PendingConfirm = {
  preview: FundsActionPreview;
  resolve: (confirmed: boolean) => void;
};

export function FundsConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  // True from the instant "Continue" is clicked until the modal unmounts, so
  // the button can't be re-clicked or look idle while a (headless, popup-less
  // on Privy) signature is being produced.
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onConfirm = (event: Event) => {
      const detail = (event as CustomEvent<FundsConfirmEventDetail>).detail;
      if (!detail?.preview || !detail.resolve) return;
      detail.handle();
      setPending((current) => {
        current?.resolve(false);
        return { preview: detail.preview, resolve: detail.resolve };
      });
      // Reset the toggle for every new prompt — it should NOT persist as
      // "on" across actions. The user has to opt in per action.
      setDontShowAgain(false);
      setSubmitting(false);
    };

    window.addEventListener(FUNDS_CONFIRM_EVENT, onConfirm);
    return () => window.removeEventListener(FUNDS_CONFIRM_EVENT, onConfirm);
  }, []);

  const review = useMemo(
    () => (pending ? buildFundsActionReview(pending.preview) : null),
    [pending],
  );

  const close = (confirmed: boolean) => {
    if (!pending || submitting) return;
    // Only honor the "Don't show again" toggle if the user actually
    // confirmed — never on cancel. Re-enable in the TEE/Session modal.
    if (confirmed && dontShowAgain) {
      suppressFundsConfirm(pending.preview.title);
    }
    pending.resolve(confirmed);
    setPending(null);
    setDontShowAgain(false);
  };

  const confirm = () => {
    if (!pending || submitting) return;
    setSubmitting(true);
    if (dontShowAgain) suppressFundsConfirm(pending.preview.title);
    // Resolve now so the signature starts immediately, but hold the modal in
    // its "Approving…" state for a frame so the button shows progress instead
    // of staying clickable, then unmount.
    pending.resolve(true);
    requestAnimationFrame(() => {
      setPending(null);
      setSubmitting(false);
      setDontShowAgain(false);
    });
  };

  return (
    <>
      {children}
      {pending && review ? (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/75 px-3 py-4 sm:px-4 sm:py-6 backdrop-blur-sm">
          <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg border border-white/15 bg-ink/95 p-4 sm:p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3 sm:gap-4 border-b border-white/10 pb-4">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-orange">Wallet approval</div>
                <h2 className="mt-1 font-display text-2xl sm:text-3xl uppercase tracking-normal text-bone break-words">{review.title}</h2>
              </div>
              <button
                type="button"
                onClick={() => close(false)}
                disabled={submitting}
                className="shrink-0 h-8 w-8 border border-white/15 text-lg leading-none text-bone/70 hover:border-orange hover:text-orange disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-white/15 disabled:hover:text-bone/70"
                aria-label="Cancel"
              >
                x
              </button>
            </div>

            <div className="space-y-4 py-4 text-sm text-bone/85">
              <div className="grid grid-cols-[72px_minmax(0,1fr)] sm:grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 font-mono text-xs">
                <span className="text-bone/45">Action</span>
                <span className="text-bone break-words">{review.action}</span>
                {review.amount ? (
                  <>
                    <span className="text-bone/45">Amount</span>
                    <span className="text-bone break-words">{review.amount}</span>
                  </>
                ) : null}
                {review.table ? (
                  <>
                    <span className="text-bone/45">Table</span>
                    <span className="break-all text-bone">{review.table}</span>
                  </>
                ) : null}
              </div>

              {review.details.length ? (
                <div className="space-y-1 border border-white/10 bg-white/[0.03] p-3 font-mono text-xs text-bone/70 break-words">
                  {review.details.map((detail, idx) => (
                    <div key={`${detail}-${idx}`}>{detail}</div>
                  ))}
                </div>
              ) : null}

              <div className="border border-orange/30 bg-orange/10 p-3 font-mono text-[11px] text-orange">
                Only approve if this matches what you intended.
              </div>
            </div>

            <label className="flex items-center gap-2 select-none cursor-pointer pt-1 pb-3 text-bone/70 hover:text-bone">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="h-3.5 w-3.5 accent-orange cursor-pointer"
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
                Don't show this confirmation again
              </span>
            </label>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={() => close(false)}
                disabled={submitting}
                className="w-full sm:w-auto border border-white/15 px-4 py-2.5 sm:py-2 font-mono text-xs uppercase tracking-[0.16em] text-bone/75 hover:border-bone hover:text-bone disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={submitting}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-orange px-4 py-2.5 sm:py-2 font-mono text-xs font-bold uppercase tracking-[0.16em] text-black hover:bg-orange/90 disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-black/50 border-t-transparent animate-spin" aria-hidden />
                    Approving…
                  </>
                ) : (
                  'Continue'
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
