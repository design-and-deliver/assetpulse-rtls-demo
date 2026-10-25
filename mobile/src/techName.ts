/** Keeps the handheld's key apart from the console pager's, so one browser running both is two techs. */
const STORAGE_KEY = 'assetpulse.phoneDevice';

function randomKey(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/**
 * This device's key, kept in localStorage on web so the "Tech N" name survives reloads. Native
 * builds (no localStorage) and blocked storage get a fresh key per launch.
 */
export function deviceKey(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const key = randomKey();
    localStorage.setItem(STORAGE_KEY, key);
    return key;
  } catch {
    return randomKey();
  }
}

/** "Tech 1", "Tech 2"… from the server, numbered per hospital; null if it can't answer. */
export async function fetchTechName(origin: string, hospitalId: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ h: hospitalId, d: deviceKey() });
    const res = await fetch(`${origin}/api/tech-name?${params}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: unknown };
    return typeof body.name === 'string' ? body.name : null;
  } catch {
    return null;
  }
}
