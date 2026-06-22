'use client';

// Scroll-gated consent modal. Opened when a user clicks the "I agree" checkbox
// on the register or dealer-mint flow. The "Accept" button stays disabled until
// the body is scrolled to the bottom AND the in-modal checkbox is ticked, then
// onAccept() flips the caller's accepted state. The signed-message / consent
// -service persistence (ed25519 + version hashes) is a separate backend piece,
// not wired here yet.
import { useEffect, useRef, useState } from 'react';

// "Scrolled to the bottom" tolerance. Generous on purpose: mobile browsers
// report fractional scroll offsets and the body has bottom padding, so a tight
// threshold (e.g. 8px) means a user visually at the bottom never satisfies it
// and the accept checkbox stays disabled. 40px reliably unlocks on mobile.
const BOTTOM_TOLERANCE = 40;

export function ConsentModal({
  open,
  onClose,
  onAccept,
  title,
  body,
  checkboxLabel,
  acceptLabel,
}: {
  open: boolean;
  onClose: () => void;
  onAccept: () => void;
  title: string;
  body: React.ReactNode;
  checkboxLabel: React.ReactNode;
  acceptLabel: string;
}) {
  const [checked, setChecked] = useState(false);
  const [atBottom, setAtBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setChecked(false); setAtBottom(false); }
  }, [open]);

  // Unlock when the body is at (or near) the bottom, OR when it already fits
  // without scrolling. Mobile webviews (Phantom's in-app browser especially)
  // fire scroll events unreliably and mis-measure clientHeight, which used to
  // leave this gate permanently locked and block the dealer mint. So we re-check
  // on open, after reflow, and on resize — and, as a last resort, unlock after a
  // short read dwell so a webview that never reports a scroll event can't trap
  // the user. The checkbox below is the binding consent; this gate is a nudge.
  useEffect(() => {
    if (!open) return;
    const mark = () => {
      const el = scrollRef.current;
      if (!el) return;
      const fits = el.scrollHeight <= el.clientHeight + BOTTOM_TOLERANCE;
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOLERANCE;
      if (fits || near) setAtBottom(true);
    };
    mark();
    const timers = [
      setTimeout(mark, 200),
      setTimeout(mark, 1000),
      setTimeout(() => setAtBottom(true), 6000),
    ];
    window.addEventListener('resize', mark);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('resize', mark); };
  }, [open]);

  if (!open) return null;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fits = el.scrollHeight <= el.clientHeight + BOTTOM_TOLERANCE;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOLERANCE;
    if (fits || near) setAtBottom(true);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        // vh baseline (universally supported) + dvh on top via inline style.
        // Older mobile/Phantom webviews that don't parse dvh silently fall back
        // to the vh class; without a working cap the modal grows past the
        // screen and the accept button ends up off-screen / untappable.
        className="w-full max-w-lg max-h-[86vh] flex flex-col glass-room rounded-sm border border-orange/25 overflow-hidden"
        style={{ maxHeight: '86dvh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 shrink-0">
          <h2 className="font-display text-bone text-lg leading-tight">{title}</h2>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          onTouchMove={onScroll}
          onTouchEnd={onScroll}
          // Momentum + contained scrolling so the body itself scrolls inside
          // mobile webviews (otherwise the page behind grabs the touch and the
          // body never reaches the bottom, leaving the accept gate stuck).
          style={{ WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
          className="px-5 py-4 overflow-y-auto grow font-mono text-[11px] leading-relaxed text-boneDim/80 space-y-3"
        >
          {body}
        </div>

        <div className="px-5 py-4 border-t border-white/10 shrink-0 space-y-3 bg-ink/40">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              disabled={!atBottom}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-orange shrink-0 disabled:opacity-40"
            />
            <span className="font-mono text-[10px] leading-snug text-boneDim/75">{checkboxLabel}</span>
          </label>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-sm font-mono text-[10px] tracking-[0.18em] text-boneDim hover:text-bone border border-white/10 hover:border-white/25 transition"
            >
              CANCEL
            </button>
            <button
              type="button"
              onClick={() => { onAccept(); onClose(); }}
              disabled={!checked}
              className="btn-orange px-4 py-2 rounded-sm font-mono text-[10px] tracking-[0.18em] font-bold disabled:opacity-40"
            >
              {acceptLabel}
            </button>
          </div>
          {!atBottom && (
            <p className="font-mono text-[9px] text-boneDim/45 text-center">
              Scroll to the bottom to enable acceptance.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Body content ─────────────────────────────────────────────────────────
// Exact text from the Mainnet Beta Legal & Risk package (formal register).

function Grp({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[10px] tracking-[0.18em] text-orange/85">{heading}</div>
      <ul className="list-disc list-outside ml-4 space-y-1">{children}</ul>
    </div>
  );
}

export function PlayerConsentBody() {
  return (
    <>
      <p className="text-bone/90">Fast Poker is live on Solana mainnet in beta. By continuing, you acknowledge:</p>

      <Grp heading="SOFTWARE STATUS">
        <li>The Fast Poker protocol is early software.</li>
        <li>The contracts have undergone internal review only unless otherwise stated.</li>
        <li>The software is provided AS IS and AS AVAILABLE.</li>
        <li>Bugs, exploits, downtime, table pauses, failed hands, voided sessions, delayed settlement, and temporary loss of card visibility may occur.</li>
      </Grp>

      <Grp heading="FINANCIAL RISK">
        <li>You may lose some or all funds you deposit, win, hold, or use in protocol interactions.</li>
        <li>There is no insurance, recovery fund, operator guarantee, or guaranteed outcome.</li>
        <li>$FP is a utility token. It is not an investment, has no guaranteed value, and may be worth zero.</li>
      </Grp>

      <Grp heading="NO REFUNDS, NO COMPENSATION">
        <li>All deposits, withdrawals, rake, buy-ins, jackpot draws, $FP claims, license mints, auctions, and on-chain transactions are FINAL.</li>
        <li>Paradice Technologies Inc. does not offer refunds, reversals, make-goods, or compensation of any kind under any circumstances, including software bugs, failed hands, disconnections, table pauses, voided sessions, network outages, MagicBlock or TEE failures, exploit losses, mistaken transactions, lost private keys, wallet issues, or user error.</li>
        <li>No support ticket, dispute, or escalation will result in funds being credited or returned outside the on-chain protocol logic.</li>
      </Grp>

      <Grp heading="PROTOCOL CHANGES">
        <li>Protocol parameters may change, including rake splits, jackpot odds, emissions, time-bank rules, table mechanics, reward logic, supported tokens, and dealer requirements.</li>
        <li>Tables may be paused or retired.</li>
        <li>Third-party rooms, frontends, or operators are independent and carry their own risks.</li>
      </Grp>

      <Grp heading="YOUR REPRESENTATIONS">
        <li>You are legally allowed to use Fast Poker in your jurisdiction.</li>
        <li>You meet the required age for online gaming or gambling where you are located.</li>
        <li>You are not located in, resident of, or acting for a prohibited or sanctioned jurisdiction.</li>
        <li>You are using your own funds. You are not playing, depositing, or transacting on behalf of any other person.</li>
        <li>You are not relying on Paradice Technologies Inc., Fast Poker, or any team member for legal, tax, financial, or gambling advice.</li>
        <li>You are responsible for taxes, legal compliance, bankroll management, wallet security, and all decisions you make.</li>
      </Grp>

      <Grp heading="LIABILITY">
        <li>To the maximum extent permitted by law, Paradice Technologies Inc., its affiliates, contributors, and operators are not liable for any loss arising from your use of the protocol, including losses from smart contract bugs, network failures, malicious actors, or your own decisions.</li>
        <li>Your sole remedy in any dispute is to stop using the protocol.</li>
      </Grp>

    </>
  );
}

export function DealerConsentBody() {
  return (
    <>
      <p className="text-bone/90">
        Operating a Fast Poker Dealer Node is a permissionless, independent activity. You are not an
        employee, agent, partner, contractor, or representative of Paradice Technologies Inc.
      </p>

      <Grp heading="NO PROFIT GUARANTEE">
        <li>Dealer operation carries no guarantee of profit, revenue, rake share, $FP rewards, tips, or any other return.</li>
        <li>You may operate at a sustained loss. You may earn nothing.</li>
        <li>Profitability depends on game volume, fee markets, competition, protocol parameters, infrastructure quality, and network conditions.</li>
      </Grp>

      <Grp heading="OPERATING COSTS ARE YOURS">
        <li>You are responsible for SOL transaction fees, priority fees, rent locked in accounts, MagicBlock costs, server costs, RPC costs, bandwidth, and any third-party services.</li>
        <li>These costs are not reimbursed by Paradice Technologies Inc.</li>
        <li>Rent may only be recoverable where the protocol and account design allow proper account closure.</li>
      </Grp>

      <Grp heading="SOFTWARE AND PROTOCOL RISK">
        <li>Dealer software is provided AS IS and AS AVAILABLE.</li>
        <li>Bugs, network issues, TEE issues, RPC failures, bad configuration, or protocol changes may cause failed settlement, missed rewards, lost opportunities, downtime, or operating losses.</li>
        <li>Paradice Technologies Inc. has no obligation to compensate operators for any loss.</li>
        <li>Protocol parameters, including rake splits, dealer share, emissions, and operating requirements, may change at any time. You operate under current parameters and accept future changes as a condition of continued operation.</li>
      </Grp>

      <Grp heading="INDEPENDENT FRONTENDS AND WHITE-LABEL ROOMS">
        <li>If you operate a player-facing interface, branded room, or third-party frontend in addition to your Dealer Node, you are solely responsible for the relationship with your end users, including support, disputes, marketing claims, advertising compliance, and consumer protection law.</li>
        <li>Paradice Technologies Inc. has no relationship with your end users and no obligation to mediate disputes between you and your users.</li>
      </Grp>

      <Grp heading="COMPLIANCE">
        <li>You are responsible for your own legal, tax, gaming, gambling, AML, KYC, consumer protection, and business obligations.</li>
        <li>Paradice Technologies Inc. develops software. Dealer operators are independent participants.</li>
      </Grp>

    </>
  );
}
