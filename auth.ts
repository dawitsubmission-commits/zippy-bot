// Admin authorization helpers. Admin IDs come from a Cloudflare secret, never from code.

// "123456789, 987654321" -> Set {123456789, 987654321}. Bad entries are ignored.
export function parseAdminIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  if (!raw) return ids;
  for (const part of raw.split(/[\s,;]+/)) {
    if (!/^\d+$/.test(part)) continue;
    const n = Number(part);
    if (Number.isSafeInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

// Fails closed: no ID, or no admins configured, means "not an admin".
export function isAdmin(userId: number | undefined, admins: Set<number>): boolean {
  if (userId === undefined || !Number.isSafeInteger(userId)) return false;
  return admins.has(userId);
}

// Compares two secrets without leaking where they differ (timing-safe).
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
