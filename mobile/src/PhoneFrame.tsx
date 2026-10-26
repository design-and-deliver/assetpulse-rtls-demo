import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import type { Palette } from './theme';

/** A typical phone's screen in CSS pixels; the bezel adds its border around it. */
const SCREEN = { width: 390, height: 780 };
const BEZEL = 12;
/** Room the caption and margins need above and below the phone. */
const CHROME = 120;
/** Bezel plus rim on both sides, and the room the buzz and the side button need around it. */
const FRAME_WIDTH = SCREEN.width + 2 * BEZEL + 4;
const EMBED_PAD = 10;

/**
 * `?embed=1`: the console shows this page in an iframe beside the floor. The iframe is sized to
 * the phone, so frame whenever it fits, and leave the caption and backdrop to the console.
 */
const EMBED =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('embed');

// Chrome paints an iframe opaque (white) when its page's color-scheme differs from the parent's.
// The console declares "light dark", so match it and the phone floats on the console's backdrop.
if (EMBED) document.documentElement.style.colorScheme = 'light dark';

/** The lock screen's wallpaper; the status strip above it takes the same colour. */
export const WALLPAPER = '#14263a';

interface Props {
  palette: Palette;
  /** Rendered instead of the app while the phone is locked; `unlock` opens the app. */
  lockScreen: (unlock: () => void) => ReactNode;
  /** Orders currently paging the tech: the phone buzzes when this goes up. */
  paged: number;
  children: ReactNode;
}

/** A short side-to-side shake: the visual stand-in for a phone vibrating on a page. */
function useBuzz(paged: number) {
  const shake = useRef(new Animated.Value(0)).current;
  const last = useRef(paged);
  useEffect(() => {
    if (paged > last.current) {
      const step = (toValue: number) =>
        Animated.timing(shake, { toValue, duration: 45, useNativeDriver: false });
      Animated.sequence([step(6), step(-6), step(5), step(-5), step(3), step(0)]).start();
    }
    last.current = paged;
  }, [paged, shake]);
  return shake;
}

/**
 * Opened from the console on a desktop, the handheld would fill a wide browser tab and read as
 * one more web page. Wide web viewports get a phone around it and a caption saying whose screen
 * this is; a real phone (or any narrow window) gets the app full screen, unchanged.
 */
export function PhoneFrame({ palette, lockScreen, paged, children }: Props) {
  const { width, height } = useWindowDimensions();
  // A pocketed phone starts locked, so the first page arrives the way a push notification does.
  const [locked, setLocked] = useState(true);
  const shake = useBuzz(paged);
  const fits = EMBED ? width >= FRAME_WIDTH + 2 * EMBED_PAD : width >= 700;
  if (Platform.OS !== 'web' || !fits) return <>{children}</>;

  const screenHeight = EMBED
    ? Math.max(400, height - 2 * (BEZEL + 2 + EMBED_PAD))
    : Math.max(480, Math.min(SCREEN.height, height - CHROME));
  return (
    <View style={EMBED ? styles.embed : [styles.page, { backgroundColor: palette.bg }]}>
      {/* A landmark of its own: the app inside keeps its `main`, and no text sits outside both.
          Embedded, the console captions the phone, and a second banner would clash with its own. */}
      {!EMBED && (
        <View role="banner">
          {/* The framed page's title, so the lock screen (which has no heading) still has one. */}
          <Text style={[styles.caption, { color: palette.textMuted }]} role="heading" aria-level={1}>
            What the tech sees on their phone
          </Text>
        </View>
      )}
      {/* The rim keeps the dark bezel visible on dark mode's near-black page. */}
      <Animated.View
        style={[
          styles.bezel,
          { borderColor: palette.border, transform: [{ translateX: shake }] },
          // The iframe's edges would clip a soft shadow into a grey box.
          EMBED && styles.flat,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          aria-label="Lock phone"
          disabled={locked}
          onPress={() => setLocked(true)}
          hitSlop={10}
          style={styles.sideButton}
        />
        <View
          style={[
            styles.screen,
            { height: screenHeight, backgroundColor: locked ? WALLPAPER : palette.surface },
          ]}
        >
          <View style={styles.island} aria-hidden />
          {locked ? lockScreen(() => setLocked(false)) : children}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16 },
  caption: { fontSize: 15, fontWeight: '600' },
  flat: { boxShadow: 'none' },
  embed: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: EMBED_PAD },
  bezel: {
    padding: BEZEL,
    borderRadius: 52,
    borderWidth: 2,
    backgroundColor: '#0d1115',
    boxShadow: '0 18px 50px rgba(0, 0, 0, 0.25)',
  },
  screen: {
    width: SCREEN.width,
    borderRadius: 40,
    overflow: 'hidden',
    // Clears the island, the way a phone's status bar does; it shares the app bar's colour.
    paddingTop: 34,
  },
  // The power button: locks the phone again, like pocketing it.
  sideButton: {
    position: 'absolute',
    right: -6,
    top: 150,
    width: 5,
    height: 70,
    borderRadius: 3,
    backgroundColor: '#0d1115',
  },
  island: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    width: 110,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#0d1115',
    zIndex: 1,
  },
});
