import type { ReactNode } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { Palette } from './theme';

/** A typical phone's screen in CSS pixels; the bezel adds its border around it. */
const SCREEN = { width: 390, height: 780 };
const BEZEL = 12;
/** Room the caption and margins need above and below the phone. */
const CHROME = 120;

/**
 * Opened from the console on a desktop, the handheld would fill a wide browser tab and read as
 * one more web page. Wide web viewports get a phone around it and a caption saying whose screen
 * this is; a real phone (or any narrow window) gets the app full screen, unchanged.
 */
export function PhoneFrame({ palette, children }: { palette: Palette; children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  if (Platform.OS !== 'web' || width < 700) return <>{children}</>;

  const screenHeight = Math.max(480, Math.min(SCREEN.height, height - CHROME));
  return (
    <View style={[styles.page, { backgroundColor: palette.bg }]}>
      {/* A landmark of its own: the app inside keeps its `main`, and no text sits outside both. */}
      <View role="banner">
        <Text style={[styles.caption, { color: palette.textMuted }]}>
          What the tech sees on their phone
        </Text>
      </View>
      {/* The rim keeps the dark bezel visible on dark mode's near-black page. */}
      <View style={[styles.bezel, { borderColor: palette.border }]}>
        <View style={[styles.screen, { height: screenHeight, backgroundColor: palette.bg }]}>
          <View style={styles.island} aria-hidden />
          {children}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16 },
  caption: { fontSize: 15, fontWeight: '600' },
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
    // Clears the island, the way a phone's status bar does.
    paddingTop: 34,
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
