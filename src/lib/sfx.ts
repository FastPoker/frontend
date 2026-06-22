/**
 * FastPoker SFX — Web Audio synthesized sounds.
 * Ported from Mockup 1.4 sfx.jsx. No external files required.
 *
 * Usage:
 *   import { SFX } from '@/lib/sfx';
 *   SFX.play('fold');
 *   SFX.setMuted(true);
 */

const STORAGE_KEY = 'fp.sfx.muted';
const VOL_KEY = 'fp.sfx.volume';

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let _muted = false;
let _volume = 0.7;

// Load persisted prefs
if (typeof window !== 'undefined') {
  try { _muted = localStorage.getItem(STORAGE_KEY) === '1'; } catch {}
  try {
    const v = parseFloat(localStorage.getItem(VOL_KEY) ?? '');
    if (!isNaN(v)) _volume = v;
  } catch {}
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC() as AudioContext;
    masterGain = ctx.createGain();
    masterGain.gain.value = _muted ? 0 : _volume;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  return ctx;
}

// Resume on user gesture
if (typeof window !== 'undefined') {
  const resume = () => { ensureCtx(); };
  (['pointerdown', 'keydown', 'touchstart'] as const).forEach(ev => {
    window.addEventListener(ev, resume, { passive: true });
  });
}

// ─── Primitives ────────────────────────────────────────────────────────────

interface ToneOpts {
  freq?: number;
  type?: OscillatorType;
  dur?: number;
  attack?: number;
  vol?: number;
  sweep?: { from?: number; to: number } | null;
  filter?: { type?: BiquadFilterType; freq?: number; Q?: number } | null;
  detune?: number;
}

function tone({ freq = 440, type = 'sine', dur = 0.12, attack = 0.002, vol = 0.3, sweep = null, filter = null, detune = 0 }: ToneOpts) {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  if (detune) osc.detune.value = detune;
  if (sweep) {
    osc.frequency.setValueAtTime(sweep.from ?? freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweep.to), t + dur);
  }
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  let node: AudioNode = osc;
  if (filter) {
    const f = c.createBiquadFilter();
    f.type = filter.type ?? 'lowpass';
    f.frequency.value = filter.freq ?? 2000;
    f.Q.value = filter.Q ?? 1;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(masterGain);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

interface NoiseOpts {
  dur?: number;
  vol?: number;
  type?: BiquadFilterType;
  cutoff?: number;
  Q?: number;
  sweep?: { from?: number; to: number } | null;
  attack?: number;
}

function noise({ dur = 0.15, vol = 0.25, type = 'lowpass', cutoff = 1500, Q = 1, sweep = null, attack = 0.005 }: NoiseOpts) {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t = c.currentTime;
  const bufSize = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, bufSize, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = cutoff;
  f.Q.value = Q;
  if (sweep) {
    f.frequency.setValueAtTime(sweep.from ?? cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, sweep.to), t + dur);
  }
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(masterGain);
  src.start(t);
  src.stop(t + dur + 0.05);
}

interface ArpOpts {
  type?: OscillatorType;
  stepDur?: number;
  vol?: number;
  gap?: number;
  filter?: { type?: BiquadFilterType; freq?: number } | null;
}

function arp(notes: number[], { type = 'triangle', stepDur = 0.08, vol = 0.25, gap = 0, filter = null }: ArpOpts = {}) {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t0 = c.currentTime;
  notes.forEach((freq, i) => {
    const t = t0 + i * (stepDur + gap);
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + stepDur);
    let node: AudioNode = osc;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = filter.type ?? 'lowpass';
      f.frequency.value = filter.freq ?? 4000;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(masterGain!);
    osc.start(t);
    osc.stop(t + stepDur + 0.05);
  });
}

// ─── Sound library ──────────────────────────────────────────────────────────

type SoundName =
  | 'ui-click' | 'ui-tap' | 'ui-toggle' | 'ui-tab' | 'ui-slider' | 'ui-copy' | 'ui-hover'
  | 'card-deal' | 'card-flip' | 'chip-bet' | 'chip-stack' | 'chip-pot'
  | 'check' | 'fold' | 'call' | 'raise' | 'all-in' | 'dealer-move' | 'bet-slide'
  | 'timer-tick' | 'timer-crit' | 'timebank'
  | 'hand-won' | 'all-in-won' | 'bad-beat' | 'first-hand' | 'level-up' | 'itm'
  | 'tourney-win' | 'eliminated' | 'bluff' | 'heads-up' | 'bubble' | 'stack-doubled' | 'chop-offered'
  | 'modal-open' | 'modal-close' | 'tip-success' | 'deposit'
  | 'table-join' | 'connection-drop' | 'message' | 'dealing';

const SOUNDS: Record<SoundName, () => void> = {
  // ── UI ──
  'ui-click':   () => tone({ freq: 880, type: 'square', dur: 0.04, vol: 0.12, filter: { type: 'lowpass', freq: 2400, Q: 0.7 } }),
  'ui-tap':     () => tone({ freq: 1200, type: 'sine', dur: 0.05, vol: 0.14 }),
  'ui-toggle':  () => { tone({ freq: 660, type: 'triangle', dur: 0.06, vol: 0.15 }); setTimeout(() => tone({ freq: 990, type: 'triangle', dur: 0.06, vol: 0.13 }), 30); },
  'ui-tab':     () => tone({ freq: 520, type: 'triangle', dur: 0.08, vol: 0.14, sweep: { from: 520, to: 780 } }),
  'ui-slider':  () => tone({ freq: 1400, type: 'sine', dur: 0.02, vol: 0.08 }),
  'ui-copy':    () => { tone({ freq: 880, type: 'sine', dur: 0.05, vol: 0.14 }); setTimeout(() => tone({ freq: 1320, type: 'sine', dur: 0.08, vol: 0.14 }), 50); },
  'ui-hover':   () => tone({ freq: 2400, type: 'sine', dur: 0.015, vol: 0.04 }),

  // ── Gameplay ──
  'card-deal':  () => noise({ dur: 0.08, vol: 0.2, cutoff: 3200, Q: 0.8, sweep: { from: 4000, to: 1200 } }),
  'card-flip':  () => { noise({ dur: 0.05, vol: 0.18, cutoff: 4500 }); setTimeout(() => tone({ freq: 880, type: 'triangle', dur: 0.06, vol: 0.1 }), 40); },
  'chip-bet':   () => { for (let i = 0; i < 2; i++) setTimeout(() => tone({ freq: 1800 + Math.random() * 400, type: 'square', dur: 0.04, vol: 0.12, filter: { type: 'bandpass', freq: 2200, Q: 4 } }), i * 28); },
  'chip-stack': () => { for (let i = 0; i < 5; i++) setTimeout(() => tone({ freq: 1600 + Math.random() * 600, type: 'square', dur: 0.03, vol: 0.1, filter: { type: 'bandpass', freq: 2400, Q: 5 } }), i * 35); },
  'chip-pot':   () => { for (let i = 0; i < 8; i++) setTimeout(() => tone({ freq: 1400 + Math.random() * 800, type: 'square', dur: 0.04, vol: 0.12, filter: { type: 'bandpass', freq: 2200, Q: 4 } }), i * 40); },
  'check':      () => { tone({ freq: 200, type: 'sine', dur: 0.04, vol: 0.2 }); noise({ dur: 0.03, vol: 0.08, cutoff: 600 }); },
  'fold':       () => noise({ dur: 0.22, vol: 0.16, cutoff: 1800, Q: 0.7, sweep: { from: 3000, to: 200 } }),
  'call':       () => tone({ freq: 480, type: 'triangle', dur: 0.1, vol: 0.18, sweep: { from: 480, to: 620 } }),
  'raise':      () => { tone({ freq: 440, type: 'triangle', dur: 0.08, vol: 0.18 }); setTimeout(() => tone({ freq: 660, type: 'triangle', dur: 0.1, vol: 0.2 }), 60); },
  'all-in':     () => { arp([440, 660, 880, 1320], { stepDur: 0.06, vol: 0.22, type: 'sawtooth', filter: { type: 'lowpass', freq: 3200 } }); setTimeout(() => noise({ dur: 0.4, vol: 0.1, cutoff: 400, sweep: { from: 800, to: 100 } }), 40); },
  'dealer-move':() => tone({ freq: 1000, type: 'sine', dur: 0.12, vol: 0.14, sweep: { from: 700, to: 1200 } }),
  'bet-slide':  () => noise({ dur: 0.12, vol: 0.14, cutoff: 2400, Q: 0.9, sweep: { from: 3000, to: 800 } }),

  // ── Timer / pressure ──
  'timer-tick': () => tone({ freq: 1500, type: 'square', dur: 0.045, vol: 0.14, filter: { type: 'bandpass', freq: 1600, Q: 10 } }),
  'timer-crit': () => { for (let i = 0; i < 3; i++) setTimeout(() => tone({ freq: 900 + i * 60, type: 'square', dur: 0.06, vol: 0.2, filter: { type: 'bandpass', freq: 1200, Q: 6 } }), i * 70); },
  'timebank':   () => arp([660, 880, 1320], { stepDur: 0.06, vol: 0.22, type: 'triangle' }),

  // ── Ceremonies ──
  'hand-won': () => {
    tone({ freq: 1568, type: 'sine', dur: 0.08, vol: 0.22 });
    setTimeout(() => tone({ freq: 2093, type: 'sine', dur: 0.18, vol: 0.22 }), 80);
    setTimeout(() => tone({ freq: 1568, type: 'sine', dur: 0.04, vol: 0.1, filter: { type: 'highpass', freq: 2000 } }), 140);
  },
  'all-in-won': () => {
    noise({ dur: 0.28, vol: 0.18, cutoff: 1400, Q: 0.6, sweep: { from: 400, to: 2000 } });
    setTimeout(() => { [523, 659, 784, 1047].forEach(f => tone({ freq: f, type: 'triangle', dur: 0.45, vol: 0.18 })); }, 260);
    setTimeout(() => tone({ freq: 2093, type: 'sine', dur: 0.6, vol: 0.14 }), 320);
  },
  'bad-beat': () => {
    [880, 740, 622, 523].forEach((f, i) => setTimeout(() => tone({ freq: f, type: 'sawtooth', dur: 0.2, vol: 0.14, filter: { type: 'lowpass', freq: 2000 } }), i * 140));
    setTimeout(() => { for (let i = 0; i < 12; i++) setTimeout(() => tone({ freq: 1500 + Math.random() * 1500, type: 'square', dur: 0.05, vol: 0.14, filter: { type: 'bandpass', freq: 2400, Q: 6 } }), i * 50); }, 700);
    setTimeout(() => [1047, 1319, 1568, 2093].forEach(f => tone({ freq: f, type: 'triangle', dur: 0.6, vol: 0.18 })), 1300);
  },
  'first-hand': () => {
    tone({ freq: 523, type: 'sine', dur: 0.5, vol: 0.22 });
    tone({ freq: 784, type: 'sine', dur: 0.5, vol: 0.18 });
    setTimeout(() => tone({ freq: 1047, type: 'sine', dur: 0.6, vol: 0.14 }), 200);
  },
  'level-up': () => {
    arp([659, 988, 1319, 1976, 2637], { stepDur: 0.06, vol: 0.22, type: 'square', filter: { type: 'lowpass', freq: 3600 } });
    setTimeout(() => arp([1319, 1976, 2637], { stepDur: 0.08, vol: 0.22, type: 'triangle' }), 380);
  },
  'itm': () => {
    tone({ freq: 1760, type: 'sine', dur: 0.12, vol: 0.22 });
    setTimeout(() => tone({ freq: 2349, type: 'sine', dur: 0.28, vol: 0.2 }), 120);
    setTimeout(() => tone({ freq: 1760, type: 'sine', dur: 0.04, vol: 0.08, filter: { type: 'highpass', freq: 1500 } }), 200);
  },
  'tourney-win': () => {
    noise({ dur: 0.4, vol: 0.16, cutoff: 800, sweep: { from: 400, to: 1600 } });
    setTimeout(() => arp([392, 523, 659, 784, 1047, 1319, 1568], { stepDur: 0.07, vol: 0.22, type: 'sawtooth', filter: { type: 'lowpass', freq: 3600 } }), 380);
    setTimeout(() => { [523, 659, 784, 1047, 1319, 1568].forEach(f => tone({ freq: f, type: 'triangle', dur: 1.0, vol: 0.18 })); }, 900);
    setTimeout(() => tone({ freq: 131, type: 'sine', dur: 1.4, vol: 0.18, sweep: { from: 65, to: 131 } }), 900);
    setTimeout(() => noise({ dur: 0.8, vol: 0.12, cutoff: 6000, type: 'highpass' }), 900);
  },
  'eliminated': () => {
    [523, 415, 349].forEach((f, i) => setTimeout(() => tone({ freq: f, type: 'triangle', dur: 0.3, vol: 0.2 }), i * 180));
    setTimeout(() => { tone({ freq: 110, type: 'sine', dur: 0.4, vol: 0.24, sweep: { from: 180, to: 60 } }); noise({ dur: 0.3, vol: 0.12, cutoff: 300 }); }, 620);
  },
  'bluff': () => {
    [622, 659, 698, 740, 784].forEach((f, i) => setTimeout(() => tone({ freq: f, type: 'sine', dur: 0.08, vol: 0.16, filter: { type: 'lowpass', freq: 2000 } }), i * 50));
    setTimeout(() => tone({ freq: 1568, type: 'sine', dur: 0.3, vol: 0.14 }), 300);
  },
  'heads-up': () => {
    tone({ freq: 98, type: 'sawtooth', dur: 0.4, vol: 0.22, filter: { type: 'lowpass', freq: 800 } });
    setTimeout(() => tone({ freq: 880, type: 'square', dur: 0.2, vol: 0.18, filter: { type: 'lowpass', freq: 2000 } }), 260);
    setTimeout(() => noise({ dur: 0.2, vol: 0.14, cutoff: 3000 }), 260);
  },
  'bubble': () => {
    [659, 698, 740].forEach(f => tone({ freq: f, type: 'sine', dur: 0.25, vol: 0.14 }));
    setTimeout(() => [659, 622].forEach(f => tone({ freq: f, type: 'sine', dur: 0.2, vol: 0.12 })), 180);
  },
  'stack-doubled': () => {
    noise({ dur: 0.18, vol: 0.14, cutoff: 800, sweep: { from: 200, to: 3000 } });
    setTimeout(() => [523, 784, 1047, 1568].forEach(f => tone({ freq: f, type: 'triangle', dur: 0.4, vol: 0.18 })), 160);
  },
  'chop-offered': () => {
    tone({ freq: 880, type: 'sine', dur: 0.3, vol: 0.2 });
    tone({ freq: 1320, type: 'sine', dur: 0.3, vol: 0.14 });
  },

  // ── Modals / transactions ──
  'modal-open': () => {
    noise({ dur: 0.12, vol: 0.08, cutoff: 1800, Q: 0.6, sweep: { from: 600, to: 2800 } });
    setTimeout(() => {
      tone({ freq: 880, type: 'sine', dur: 0.22, vol: 0.14, filter: { type: 'lowpass', freq: 2400 } });
      tone({ freq: 1320, type: 'sine', dur: 0.18, vol: 0.08 });
    }, 50);
  },
  'modal-close': () => {
    tone({ freq: 660, type: 'sine', dur: 0.14, vol: 0.12, filter: { type: 'lowpass', freq: 1800 } });
    setTimeout(() => tone({ freq: 440, type: 'sine', dur: 0.1, vol: 0.09 }), 40);
  },
  'tip-success': () => {
    tone({ freq: 1319, type: 'sine', dur: 0.1, vol: 0.18 });
    setTimeout(() => tone({ freq: 1760, type: 'sine', dur: 0.14, vol: 0.18 }), 90);
    setTimeout(() => tone({ freq: 2637, type: 'sine', dur: 0.22, vol: 0.14 }), 180);
  },
  'deposit': () => {
    tone({ freq: 1976, type: 'sine', dur: 0.08, vol: 0.18 });
    setTimeout(() => tone({ freq: 1568, type: 'sine', dur: 0.08, vol: 0.16 }), 70);
    setTimeout(() => tone({ freq: 2637, type: 'sine', dur: 0.3, vol: 0.18 }), 150);
  },

  // ── Table events ──
  'table-join':       () => arp([440, 554, 659], { stepDur: 0.1, vol: 0.18, type: 'sine' }),
  'connection-drop':  () => { tone({ freq: 330, type: 'sawtooth', dur: 0.3, vol: 0.18, sweep: { from: 440, to: 180 } }); setTimeout(() => tone({ freq: 220, type: 'sawtooth', dur: 0.3, vol: 0.18, sweep: { from: 260, to: 120 } }), 200); },
  'message':          () => tone({ freq: 1760, type: 'sine', dur: 0.08, vol: 0.12 }),
  'dealing':          () => { for (let i = 0; i < 6; i++) setTimeout(() => SOUNDS['card-deal'](), i * 90); },
};

function play(name: SoundName): void {
  if (_muted) return;
  if (typeof window === 'undefined') return;
  const fn = SOUNDS[name];
  if (!fn) return;
  try { fn(); } catch {}
}

function setMuted(m: boolean): void {
  _muted = !!m;
  try { localStorage.setItem(STORAGE_KEY, _muted ? '1' : '0'); } catch {}
  if (masterGain) masterGain.gain.value = _muted ? 0 : _volume;
}

function isMuted(): boolean { return _muted; }

function setVolume(v: number): void {
  _volume = Math.max(0, Math.min(1, v));
  try { localStorage.setItem(VOL_KEY, String(_volume)); } catch {}
  if (masterGain && !_muted) masterGain.gain.value = _volume;
}

function getVolume(): number { return _volume; }

export const SFX = { play, setMuted, isMuted, setVolume, getVolume };
export type { SoundName };
