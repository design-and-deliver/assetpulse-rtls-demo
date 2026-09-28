import { HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';
import { Linking, Platform } from 'react-native';

/**
 * Where the AssetPulse server lives when it is not the page's own origin: native builds, and
 * `expo start --web` (Metro serves the page on :8081, the socket is on :8787).
 */
const SERVER_OVERRIDE = process.env.EXPO_PUBLIC_SERVER_URL;
const NATIVE_DEFAULT = 'http://localhost:8787';

export interface Target {
  url: string;
  hospitalId: string | null;
}

function hospitalFrom(link: string | null): string | null {
  if (!link) return null;
  const h = new URL(link).searchParams.get('h');
  return h && HOSPITAL_ID_PATTERN.test(h) ? h : null;
}

function socketUrl(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

/**
 * On web the handheld is served from the same origin as the socket and reads `?h=` from the page
 * URL (the console's QR code). On native it reads `h` from the deep link that opened it.
 */
export async function resolveTarget(): Promise<Target> {
  if (Platform.OS === 'web') {
    return {
      url: socketUrl(SERVER_OVERRIDE ?? window.location.origin),
      hospitalId: hospitalFrom(window.location.href),
    };
  }
  return {
    url: socketUrl(SERVER_OVERRIDE ?? NATIVE_DEFAULT),
    hospitalId: hospitalFrom(await Linking.getInitialURL()),
  };
}
