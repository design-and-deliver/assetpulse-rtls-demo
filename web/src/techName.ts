const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * This browser's key for one tech role, kept in localStorage so the name survives reloads. The
 * console's pager and the /tech handheld pass different `storageKey`s, so one browser running
 * both still counts as two techs. Private windows and blocked storage get a fresh key per load.
 */
export function deviceKey(storageKey: string): string {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return stored;
  } catch {
    // Storage blocked: fall through to a per-load key.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const key = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  try {
    localStorage.setItem(storageKey, key);
  } catch {
    // The name just won't stick across reloads.
  }
  return key;
}

/** "Tech 1", "Tech 2"… from the server, numbered per hospital; `fallback` if it can't answer. */
export async function fetchTechName(
  origin: string,
  hospitalId: string,
  key: string,
  fallback: string,
): Promise<string> {
  try {
    const params = new URLSearchParams({ h: hospitalId, d: key });
    const res = await fetch(`${origin}/api/tech-name?${params}`);
    if (!res.ok) return fallback;
    const body = (await res.json()) as { name?: unknown };
    return typeof body.name === 'string' ? body.name : fallback;
  } catch {
    return fallback;
  }
}
