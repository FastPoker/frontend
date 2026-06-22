// Shared avatar definitions used by profile page and poker table.
// `requires` is the id of an achievement from profile-data.ACHIEVEMENTS — when
// set, the picker shows the avatar locked + grayscale with an "Unlocks with X"
// caption until the user has earned that achievement.
export type AvatarLockId =
  | 'early-bird'
  | 'black-tier'
  | 'first-hand'
  | 'first-sng'
  | 'first-jackpot'
  | 'hundo'
  | 'streak-7'
  | 'heater'
  | 'bluff-master'
  | 'allin-win'
  | 'bankroll-5'
  | 'grind-k'
  | 'quads'
  | 'big-one';

export interface AvatarOption {
  id: string;
  label: string;
  image: string;       // path to SVG/PNG in /avatars/
  fallbackEmoji: string; // fallback if image fails
  gradient: string;     // background gradient for profile selector
  requires?: AvatarLockId; // achievement gate; absent = always available
}

// 28 Early Bird PFPs unlocked by the waitlist achievement. Generated entries
// reference /brand/pfps/pfp-NN.png served from public/.
const EARLY_BIRD_PFPS: AvatarOption[] = Array.from({ length: 28 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    id: `early-bird-${n}`,
    label: `Early Bird #${n}`,
    image: `/brand/pfps/pfp-${n}.png`,
    fallbackEmoji: '🐦', // 🐦
    gradient: 'from-amber-500 to-orange-600',
    requires: 'early-bird',
  };
});

export const AVATAR_OPTIONS: AvatarOption[] = [
  // ─── NFT / Culture ───
  { id: 'punk',        label: 'CryptoPunk',    image: '/avatars/punk.svg',        fallbackEmoji: '\uD83E\uDD16', gradient: 'from-cyan-600 to-blue-700' },
  { id: 'punk-ape',    label: 'Punk Ape',      image: '/avatars/punk-ape.svg',    fallbackEmoji: '\uD83D\uDC12', gradient: 'from-amber-600 to-orange-700' },
  { id: 'punk-zombie', label: 'Punk Zombie',   image: '/avatars/punk-zombie.svg', fallbackEmoji: '\uD83E\uDDDF', gradient: 'from-green-700 to-emerald-800' },
  { id: 'punk-alien',  label: 'Punk Alien',    image: '/avatars/punk-alien.svg',  fallbackEmoji: '\uD83D\uDC7D', gradient: 'from-teal-500 to-cyan-600' },
  { id: 'boredape',    label: 'Bored Ape',     image: '/avatars/boredape.svg',    fallbackEmoji: '\uD83D\uDC35', gradient: 'from-amber-500 to-yellow-600' },

  // ─── Crypto culture ───
  { id: 'popcat',    label: 'Popcat',      image: '/avatars/popcat.svg',     fallbackEmoji: '\uD83D\uDE40', gradient: 'from-amber-400 to-yellow-500' },
  { id: 'pepe',      label: 'Pepe',        image: '/avatars/pepe.svg',       fallbackEmoji: '\uD83D\uDC38', gradient: 'from-green-500 to-emerald-600' },
  { id: 'trump',     label: '$TRUMP',      image: '/avatars/trump.svg',      fallbackEmoji: '\uD83C\uDFB0', gradient: 'from-yellow-400 to-amber-500' },
  { id: 'pengu',     label: 'Pengu',       image: '/avatars/pengu.svg',      fallbackEmoji: '\uD83D\uDC27', gradient: 'from-sky-400 to-blue-500' },
  { id: 'fartcoin',  label: 'Fartcoin',    image: '/avatars/fartcoin.svg',   fallbackEmoji: '\uD83D\uDCA8', gradient: 'from-green-400 to-lime-500' },
  { id: 'mew',       label: 'MEW',         image: '/avatars/mew.svg',        fallbackEmoji: '\uD83D\uDC31', gradient: 'from-orange-400 to-red-500' },
  { id: 'shiba',     label: 'Shiba Inu',   image: '/avatars/shiba.svg',      fallbackEmoji: '\uD83D\uDC15', gradient: 'from-red-500 to-orange-500' },
  { id: 'dogecoin',  label: 'Dogecoin',    image: '/avatars/dogecoin.svg',   fallbackEmoji: '\uD83D\uDC36', gradient: 'from-amber-400 to-yellow-400' },

  // ─── Crypto Logos ───
  { id: 'solana',    label: 'Solana',      image: '/avatars/solana.svg',     fallbackEmoji: '\u25CE', gradient: 'from-violet-500 to-fuchsia-500' },
  { id: 'bitcoin',   label: 'Bitcoin',     image: '/avatars/bitcoin.svg',    fallbackEmoji: '\u20BF', gradient: 'from-amber-500 to-orange-600' },
  { id: 'ethereum',  label: 'Ethereum',    image: '/avatars/ethereum.svg',   fallbackEmoji: '\u039E', gradient: 'from-indigo-400 to-purple-500' },
  { id: 'raydium',   label: 'Raydium',     image: '/avatars/raydium.svg',    fallbackEmoji: '\u2622', gradient: 'from-purple-500 to-indigo-500' },
  { id: 'chainlink', label: 'Chainlink',   image: '/avatars/chainlink.svg',  fallbackEmoji: '\u26D3', gradient: 'from-blue-500 to-indigo-600' },
  { id: 'sui',       label: 'Sui',         image: '/avatars/sui.svg',        fallbackEmoji: '\uD83D\uDCA7', gradient: 'from-sky-400 to-blue-600' },
  { id: 'toncoin',   label: 'Toncoin',     image: '/avatars/toncoin.svg',    fallbackEmoji: '\uD83D\uDC8E', gradient: 'from-cyan-400 to-blue-500' },

  // ─── Poker Suits (classic) ───
  { id: 'spade',     label: 'Spade',       image: '',  fallbackEmoji: '\u2660\uFE0F', gradient: 'from-cyan-500 to-blue-600' },
  { id: 'diamond',   label: 'Diamond',     image: '',  fallbackEmoji: '\u2666\uFE0F', gradient: 'from-red-500 to-pink-500' },
  { id: 'heart',     label: 'Heart',       image: '',  fallbackEmoji: '\u2665\uFE0F', gradient: 'from-pink-500 to-rose-500' },
  { id: 'club',      label: 'Club',        image: '',  fallbackEmoji: '\u2663\uFE0F', gradient: 'from-emerald-500 to-green-600' },

  // \u2500\u2500\u2500 BLACK TIER (10 SOL+ SNG) \u2500\u2500\u2500
  { id: 'hype-beast',     label: 'Hype Beast',     image: '/avatars/new/hype-beast.png',    fallbackEmoji: '\ud83d\udc51', gradient: 'from-zinc-900 to-black',         requires: 'black-tier' },
  { id: 'billionaire',    label: 'Billionaire',    image: '/avatars/new/billionaire.png',   fallbackEmoji: '\ud83d\udcb0', gradient: 'from-amber-700 to-zinc-900',     requires: 'black-tier' },

  // \u2500\u2500\u2500 Achievement-gated character PFPs (off-chain unlocks) \u2500\u2500\u2500
  { id: 'crash-dummy',    label: 'Crash Dummy',    image: '/avatars/new/crash-dummy.png',   fallbackEmoji: '\ud83d\udca5', gradient: 'from-orange-500 to-amber-600',   requires: 'first-hand' },
  { id: 'jester',         label: 'Jester',         image: '/avatars/new/jester.png',        fallbackEmoji: '\ud83c\udfad', gradient: 'from-violet-500 to-fuchsia-600', requires: 'bluff-master' },
  { id: 'loser',          label: 'Loser',          image: '/avatars/new/loser.png',         fallbackEmoji: '\ud83d\udca9', gradient: 'from-slate-500 to-slate-700',    requires: 'first-sng' },
  { id: 'lucky-toad',     label: 'Lucky Toad',     image: '/avatars/new/lucky-toad.png',    fallbackEmoji: '\ud83d\udc38', gradient: 'from-green-500 to-emerald-700',  requires: 'first-jackpot' },
  { id: 'mr-hot-streak',  label: 'Mr Hot Streak',  image: '/avatars/new/mr-hot-streak.png', fallbackEmoji: '\ud83d\udd25', gradient: 'from-red-500 to-orange-600',     requires: 'heater' },
  { id: 'the-brawler',    label: 'The Brawler',    image: '/avatars/new/the-brawler.png',   fallbackEmoji: '\ud83e\udd4a', gradient: 'from-rose-500 to-red-700',       requires: 'allin-win' },
  { id: 'the-rat',        label: 'The Rat',        image: '/avatars/new/the-rat.png',       fallbackEmoji: '\ud83d\udc00', gradient: 'from-zinc-600 to-zinc-800',      requires: 'bankroll-5' },
  { id: 'fish',           label: 'Fish',           image: '/avatars/new/fish.png',          fallbackEmoji: '\ud83d\udc1f', gradient: 'from-sky-400 to-blue-600',       requires: 'hundo' },
  { id: 'runner',         label: 'Runner',         image: '/avatars/new/runner.png',        fallbackEmoji: '\ud83c\udfc3', gradient: 'from-lime-500 to-emerald-600',   requires: 'streak-7' },
  { id: 'shark',          label: 'Shark',          image: '/avatars/new/shark.png',         fallbackEmoji: '\ud83e\udd88', gradient: 'from-slate-500 to-cyan-700',     requires: 'grind-k' },
  { id: 'tilted',         label: 'Tilted',         image: '/avatars/new/tilted.png',        fallbackEmoji: '\ud83d\ude21', gradient: 'from-rose-600 to-red-800',       requires: 'quads' },
  { id: 'whale',          label: 'Whale',          image: '/avatars/new/whale.png',         fallbackEmoji: '\ud83d\udc0b', gradient: 'from-indigo-500 to-blue-800',    requires: 'big-one' },

  // \u2500\u2500\u2500 Early Bird (waitlist achievement) \u2500\u2500\u2500
  ...EARLY_BIRD_PFPS,
];

export function getAvatarById(id: string): AvatarOption | null {
  return AVATAR_OPTIONS.find(a => a.id === id) || null;
}

// Returns true if the avatar requires an achievement the user does not have.
export function isAvatarLocked(option: AvatarOption, achievements: ReadonlySet<string> | readonly string[] = []): boolean {
  if (!option.requires) return false;
  const set = achievements instanceof Set ? achievements : new Set(achievements);
  return !set.has(option.requires);
}
