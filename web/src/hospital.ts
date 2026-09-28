import { HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Reads `?h=` from the URL; with none (or a bad one) mints a sandbox id and writes it back. */
export function resolveHospitalId(): string {
  const url = new URL(window.location.href);
  const current = url.searchParams.get('h');
  if (current && HOSPITAL_ID_PATTERN.test(current)) return current;
  const id = randomId();
  url.searchParams.set('h', id);
  window.history.replaceState(null, '', url);
  return id;
}

/** Same origin as the page: Vite proxies `/ws` in dev, and the server shares one port in prod. */
export function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}
