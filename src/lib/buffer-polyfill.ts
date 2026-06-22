// Patch the browser-side Buffer polyfill with the BigInt read/write methods
// that some bundles ship without. The Solana web3 stack relies on
// `Buffer.from(data).readBigUInt64LE(offset)` everywhere we decode account
// state — without this shim the production build crashes on Earn / Profile /
// Lobby with `readBigUInt64LE is not a function`.
//
// `DataView.getBigUint64` is supported in every modern browser (2018+), so we
// route the polyfilled methods through it.

import { Buffer as NpmBuffer } from 'buffer';

type BufLike = {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
  [k: number]: number;
};

// Next.js bundles its own copy of `buffer` at `next/dist/compiled/buffer`,
// which has a separate prototype chain from the npm `buffer` package. A patch
// applied only to one of them won't reach the other. Collect every Buffer
// prototype we can find — npm import, runtime global, and (if it exists)
// Next's compiled copy via globalThis — and patch them all.
type ProtoBag = Record<string, unknown>;
const seen = new Set<ProtoBag>();
const protos: ProtoBag[] = [];

function track(maybeBuffer: unknown): void {
  if (!maybeBuffer) return;
  const proto = (maybeBuffer as { prototype?: unknown }).prototype;
  if (!proto || typeof proto !== 'object') return;
  const bag = proto as ProtoBag;
  if (seen.has(bag)) return;
  seen.add(bag);
  protos.push(bag);
}

track(NpmBuffer);
if (typeof globalThis !== 'undefined') {
  // The runtime global Buffer (in browsers, this is whatever Next/webpack/Turbopack
  // chose to expose). May === NpmBuffer or may be the compiled copy.
  track((globalThis as { Buffer?: unknown }).Buffer);
}

function viewOf(buf: BufLike, offset: number, length: number): DataView {
  return new DataView(
    buf.buffer as ArrayBuffer,
    buf.byteOffset + offset,
    length,
  );
}

function patch(proto: ProtoBag): void {
  if (typeof proto.readBigUInt64LE !== 'function') {
    proto.readBigUInt64LE = function (this: BufLike, offset = 0): bigint {
      return viewOf(this, offset, 8).getBigUint64(0, true);
    };
  }
  if (typeof proto.readBigInt64LE !== 'function') {
    proto.readBigInt64LE = function (this: BufLike, offset = 0): bigint {
      return viewOf(this, offset, 8).getBigInt64(0, true);
    };
  }
  if (typeof proto.readBigUInt64BE !== 'function') {
    proto.readBigUInt64BE = function (this: BufLike, offset = 0): bigint {
      return viewOf(this, offset, 8).getBigUint64(0, false);
    };
  }
  if (typeof proto.readBigInt64BE !== 'function') {
    proto.readBigInt64BE = function (this: BufLike, offset = 0): bigint {
      return viewOf(this, offset, 8).getBigInt64(0, false);
    };
  }
  if (typeof proto.writeBigUInt64LE !== 'function') {
    proto.writeBigUInt64LE = function (this: BufLike, value: bigint, offset = 0): number {
      viewOf(this, offset, 8).setBigUint64(0, BigInt.asUintN(64, value), true);
      return offset + 8;
    };
  }
  if (typeof proto.writeBigInt64LE !== 'function') {
    proto.writeBigInt64LE = function (this: BufLike, value: bigint, offset = 0): number {
      viewOf(this, offset, 8).setBigInt64(0, BigInt.asIntN(64, value), true);
      return offset + 8;
    };
  }
  if (typeof proto.writeBigUInt64BE !== 'function') {
    proto.writeBigUInt64BE = function (this: BufLike, value: bigint, offset = 0): number {
      viewOf(this, offset, 8).setBigUint64(0, BigInt.asUintN(64, value), false);
      return offset + 8;
    };
  }
  if (typeof proto.writeBigInt64BE !== 'function') {
    proto.writeBigInt64BE = function (this: BufLike, value: bigint, offset = 0): number {
      viewOf(this, offset, 8).setBigInt64(0, BigInt.asIntN(64, value), false);
      return offset + 8;
    };
  }
}

for (const proto of protos) patch(proto);

// Also patch Uint8Array.prototype so any code that does
// `new Uint8Array(...).readBigUInt64LE(...)` (which Next's compiled buffer
// inherits from) still works. Uint8Array.prototype is shared globally so
// patching it once is enough.
if (typeof Uint8Array !== 'undefined') {
  patch(Uint8Array.prototype as unknown as ProtoBag);
}

export {};
