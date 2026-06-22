'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useUnifiedWallet } from '@/hooks/useUnifiedWallet';
import { useConnectModal } from '@/components/wallet/FastPokerConnectModal';
import { getLatestBlockhashClient } from '@/lib/blockhash-client';
import { makeL1Connection, ANCHOR_PROGRAM_ID, TABLE_OFFSETS } from '@/lib/constants';
import { sendWalletTx } from '@/lib/send-wallet-tx';
import {
  buildAddWhitelistInstruction,
  buildRemoveWhitelistInstruction,
} from '@/lib/onchain-game';

const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

interface WhitelistPlayer {
  address: string;
  addedAt: string;
  pda: string;
}

interface TableInfo {
  isPrivate: boolean;
  creator: string;
  creatorKnown: boolean;
  isDelegated: boolean;
}

function short(addr: string): string {
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

export default function WhitelistManager({ tableId }: { tableId: string }) {
  const { publicKey, signTransaction, sendTransaction } = useUnifiedWallet();
  const { open: openConnect } = useConnectModal();
  const [players, setPlayers] = useState<WhitelistPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAddress, setNewAddress] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null);

  const tablePk = useMemo(() => {
    try { return new PublicKey(tableId); } catch { return null; }
  }, [tableId]);

  const fetchWhitelist = useCallback(async () => {
    if (!tablePk) {
      setTableInfo(null);
      setPlayers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const conn = makeL1Connection();
      const tableAcct = await conn.getAccountInfo(tablePk);
      if (tableAcct) {
        const isDelegated = tableAcct.owner.equals(DELEGATION_PROGRAM_ID);
        if (isDelegated) {
          setTableInfo({ isPrivate: true, creator: '', creatorKnown: false, isDelegated: true });
        } else {
          const data = Buffer.from(tableAcct.data);
          const creator = data.length >= TABLE_OFFSETS.CREATOR + 32
            ? new PublicKey(data.subarray(TABLE_OFFSETS.CREATOR, TABLE_OFFSETS.CREATOR + 32)).toBase58()
            : '';
          const isPrivate = data.length > TABLE_OFFSETS.IS_PRIVATE
            ? data[TABLE_OFFSETS.IS_PRIVATE] === 1
            : false;
          setTableInfo({ isPrivate, creator, creatorKnown: true, isDelegated: false });
        }
      } else {
        setTableInfo(null);
      }

      const accounts = await conn.getProgramAccounts(ANCHOR_PROGRAM_ID, {
        filters: [
          { dataSize: 81 },
          { memcmp: { offset: 8, bytes: tablePk.toBase58() } },
        ],
      }).catch(() => []);

      const parsed: WhitelistPlayer[] = [];
      for (const { pubkey, account } of accounts) {
        const data = Buffer.from(account.data);
        if (data.length < 80) continue;
        const player = new PublicKey(data.subarray(40, 72)).toBase58();
        const addedAt = Number(data.readBigUInt64LE(72));
        parsed.push({
          address: player,
          addedAt: addedAt > 0 ? new Date(addedAt * 1000).toLocaleDateString() : 'Unknown',
          pda: pubkey.toBase58(),
        });
      }
      parsed.sort((a, b) => a.address.localeCompare(b.address));
      setPlayers(parsed);
    } catch (error) {
      setToast({ msg: error instanceof Error ? error.message : 'Failed to load whitelist', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [tablePk]);

  useEffect(() => { void fetchWhitelist(); }, [fetchWhitelist]);

  const isCreator = Boolean(publicKey && tableInfo?.creatorKnown && tableInfo.creator === publicKey.toBase58());
  const canMutate = Boolean(publicKey && isCreator && tableInfo?.isPrivate && !tableInfo.isDelegated);

  const sendWhitelistTx = async (player: PublicKey, action: 'add' | 'remove') => {
    if (!publicKey || !signTransaction || !tablePk || !canMutate) return;
    const conn = makeL1Connection();
    const ix = action === 'add'
      ? buildAddWhitelistInstruction(publicKey, tablePk, player)
      : buildRemoveWhitelistInstruction(publicKey, tablePk, player);
    const tx = new Transaction().add(ix);
    tx.feePayer = publicKey;
    const { blockhash } = await getLatestBlockhashClient(conn, 'confirmed');
    tx.recentBlockhash = blockhash;
    const sig = await sendWalletTx(tx, conn, { sendTransaction, signTransaction });
    await conn.confirmTransaction(sig, 'confirmed').catch(() => {});
  };

  const addPlayer = async () => {
    if (!canMutate || !newAddress.trim()) return;
    setAdding(true);
    try {
      const playerPk = new PublicKey(newAddress.trim());
      await sendWhitelistTx(playerPk, 'add');
      setToast({ msg: `Added ${short(playerPk.toBase58())} to whitelist`, type: 'success' });
      setNewAddress('');
      await fetchWhitelist();
    } catch (error) {
      setToast({ msg: error instanceof Error ? error.message.slice(0, 140) : 'Add failed', type: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const removePlayer = async (playerAddress: string) => {
    if (!canMutate) return;
    setRemoving(playerAddress);
    try {
      await sendWhitelistTx(new PublicKey(playerAddress), 'remove');
      setToast({ msg: `Removed ${short(playerAddress)}`, type: 'success' });
      await fetchWhitelist();
    } catch (error) {
      setToast({ msg: error instanceof Error ? error.message.slice(0, 140) : 'Remove failed', type: 'error' });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#0a0a0f] text-white">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-md border shadow-lg max-w-sm ${
          toast.type === 'success'
            ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-200'
            : 'bg-red-900/80 border-red-500/30 text-red-200'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{toast.msg}</span>
            <button onClick={() => setToast(null)} className="text-white/50 hover:text-white">x</button>
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/my-tables" className="text-boneDim/70 hover:text-gray-300 text-sm mb-4 block">
          Back to My Tables
        </Link>

        <h1 className="text-2xl font-bold mb-1">
          <span className="text-purple-400">Private Table</span> Whitelist
        </h1>
        <p className="text-boneDim/70 text-sm mb-6">
          Table: <span className="font-mono text-boneDim">{tableId ? `${tableId.slice(0, 12)}...` : 'No table selected'}</span>
        </p>

        {!tablePk ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-md p-8 text-center">
            <p className="text-boneDim">Invalid table address.</p>
          </div>
        ) : !publicKey ? (
          <div className="text-center py-16">
            <p className="text-boneDim mb-4">Connect your wallet to manage the whitelist.</p>
            <button onClick={openConnect} className="btn-orange px-4 py-2 rounded-sm font-mono text-[11px] tracking-[0.18em] font-bold">
              CONNECT WALLET
            </button>
          </div>
        ) : tableInfo && !tableInfo.isPrivate ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-md p-8 text-center">
            <p className="text-boneDim">This table is not private. Only private tables have whitelists.</p>
          </div>
        ) : tableInfo?.creatorKnown && !isCreator ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-md p-8 text-center">
            <p className="text-boneDim">Only the table creator can manage the whitelist.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {tableInfo?.isDelegated && (
              <div className="bg-amber-500/10 border border-amber-500/25 rounded-md p-4">
                <div className="text-amber-400 font-bold text-sm mb-1">Table is in an active game session</div>
                <p className="text-amber-400/70 text-xs">
                  Whitelist changes can only be made while the table is idle on L1. Existing whitelist entries are shown below.
                </p>
              </div>
            )}

            <div className="bg-white/[0.03] border border-white/[0.06] rounded-md p-5">
              <h3 className="text-sm font-bold text-gray-300 mb-3">Add Player</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder="Solana wallet address..."
                  className="flex-1 bg-ink/30 border border-white/[0.08] rounded-sm px-3 py-2.5 text-sm text-white placeholder-boneDim/60 focus:border-purple-500/50 focus:outline-none font-mono"
                />
                <button
                  onClick={addPlayer}
                  disabled={adding || !newAddress.trim() || !canMutate}
                  className="px-5 py-2.5 rounded-sm bg-purple-500 hover:bg-purple-400 text-white font-bold text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                >
                  {adding ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>

            <div className="bg-white/[0.03] border border-white/[0.06] rounded-md p-5">
              <h3 className="text-sm font-bold text-gray-300 mb-3">
                Whitelisted Players ({players.length})
              </h3>

              {loading ? (
                <div className="text-center py-8 text-boneDim/70 text-sm">Loading...</div>
              ) : players.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-boneDim/70 text-sm">No players whitelisted yet.</p>
                  <p className="text-boneDim/60 text-xs mt-1">The table creator can always join without being whitelisted.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {players.map((player) => (
                    <div key={player.pda} className="flex items-center justify-between bg-white/[0.02] border border-white/[0.04] rounded-sm px-3 py-2.5">
                      <div>
                        <div className="text-sm font-mono text-white">{short(player.address)}</div>
                        <div className="text-[10px] text-boneDim/60">Added {player.addedAt}</div>
                      </div>
                      <button
                        onClick={() => removePlayer(player.address)}
                        disabled={removing === player.address || !canMutate}
                        className="px-3 py-1.5 rounded-sm bg-red-500/10 border border-red-500/20 text-rose-300 text-xs font-medium hover:bg-red-500/20 transition-colors disabled:opacity-40"
                      >
                        {removing === player.address ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
