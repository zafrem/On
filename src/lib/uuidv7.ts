import { randomFillSync } from 'node:crypto';

/**
 * UUIDv7 (NFR-11): 48-bit big-endian Unix-ms timestamp + 74 random bits, so ids sort
 * by creation time. Ids are normally minted client-side; the server generates one only
 * when a request omits it.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  const ts = Date.now();
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
