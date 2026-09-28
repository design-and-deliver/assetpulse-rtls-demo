import { useColorScheme } from 'react-native';

/**
 * The handheld's palette mirrors `web/src/theme.css` token for token, so the console and the
 * handheld agree in both themes. Change a colour there, change it here. Follows the OS theme.
 */
export interface Palette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  onStatus: string;
  statusInUse: string;
  ok: string;
  alert: string;
  alertSoft: string;
  warn: string;
  warnSoft: string;
}

const LIGHT: Palette = {
  bg: '#f4f6f8',
  surface: '#ffffff',
  border: '#d5dbe1',
  text: '#1c2630',
  textMuted: '#5b6874',
  onStatus: '#ffffff',
  statusInUse: '#3a6ea5',
  ok: '#2f7d6d',
  alert: '#c0392b',
  alertSoft: '#fbeceb',
  warn: '#9a6a2f',
  warnSoft: '#f8efe2',
};

const DARK: Palette = {
  bg: '#11161b',
  surface: '#182028',
  border: '#2d3944',
  text: '#e3e9ee',
  textMuted: '#93a1ad',
  onStatus: '#0f1418',
  statusInUse: '#6a9fd6',
  ok: '#4fae99',
  alert: '#ef6b5b',
  alertSoft: '#3a1f1c',
  warn: '#d6a15e',
  warnSoft: '#2e2519',
};

export function usePalette(): { palette: Palette; dark: boolean } {
  const dark = useColorScheme() === 'dark';
  return { palette: dark ? DARK : LIGHT, dark };
}
