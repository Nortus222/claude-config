import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// A random ULID, without process-global monotonic state.
export const newId = (now = Date.now()): string => {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new RangeError('Invalid timestamp.');
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  randomBytes(10).copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = alphabet[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
};

export const newTokenSecret = (): string => randomBytes(32).toString('base64url');
export const hashTokenSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');
export const verifyTokenSecret = (secret: string, hash: string): boolean => {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(hashTokenSecret(secret), 'hex'), Buffer.from(hash, 'hex'));
};
export const machineToken = (accountId: string, machineId: string, secret: string): string =>
  `nmt_${accountId}_${machineId}_${secret}`;
