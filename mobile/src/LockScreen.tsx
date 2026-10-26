import { ZONES, type WorkOrder } from '@assetpulse/protocol';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { WALLPAPER } from './PhoneFrame';

const ZONE_LABEL = new Map(ZONES.map((z) => [z.id, z.label]));

/** Phone clocks show "12:53", not "12:53 AM". */
function clock(now: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    .formatToParts(now)
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim();
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A breathing dot: the phone is on shift and listening. */
function Pulse({ color }: { color: string }) {
  const beat = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(beat, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(beat, { toValue: 0, duration: 900, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [beat]);
  return (
    <View style={styles.pulse} aria-hidden>
      <Animated.View
        style={[
          styles.pulseRing,
          {
            backgroundColor: color,
            opacity: beat.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
            transform: [{ scale: beat.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
          },
        ]}
      />
      <View style={[styles.pulseDot, { backgroundColor: color }]} />
    </View>
  );
}

/** "Tech 1" → "T1". */
function monogram(name: string): string {
  const [first = '', second = ''] = name.split(' ');
  return (first.charAt(0) + second).slice(0, 3).toUpperCase();
}

/** Whose phone this is and what it is doing, as a lock-screen widget under the clock. */
function OwnerWidget({ owner, paged }: { owner: string; paged: number }) {
  const status =
    paged === 0 ? 'On shift · waiting for pages' : `${paged} new page${paged === 1 ? '' : 's'}`;
  return (
    <View style={styles.widget}>
      <View style={styles.avatar} aria-hidden>
        <Text style={styles.avatarText}>{monogram(owner)}</Text>
      </View>
      <View style={styles.widgetText}>
        <Text style={styles.widgetTitle}>{owner}’s phone</Text>
        <View style={styles.widgetStatus}>
          <Pulse color={paged === 0 ? '#4fae99' : '#d6a15e'} />
          <Text style={styles.widgetSub}>{status}</Text>
        </View>
      </View>
    </View>
  );
}

/** Drops in from above, the way a notification lands on a lock screen. */
function Notification({ order, onOpen }: { order: WorkOrder; onOpen: () => void }) {
  const drop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(drop, { toValue: 1, useNativeDriver: false }).start();
  }, [drop]);
  const where = ZONE_LABEL.get(order.location) ?? order.location;
  return (
    <Animated.View
      style={{
        opacity: drop,
        transform: [{ translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }],
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={styles.note}
      >
        <View style={styles.noteHead}>
          <View style={styles.noteIcon}>
            <Text style={styles.noteIconText}>A</Text>
          </View>
          <Text style={styles.noteApp}>ASSETPULSE</Text>
          <Text style={styles.noteWhen}>now</Text>
        </View>
        <Text style={styles.noteTitle}>New work order</Text>
        <Text style={styles.noteBody}>
          {order.short_description.split(' to ')[0]} · {where} · {order.quantity} pumps
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * What a paged tech's phone looks like in their pocket: locked, then a notification drops in.
 * Shown only inside the desktop phone frame, to stand in for a real push notification.
 */
export function LockScreen({
  owner,
  orders,
  onOpen,
}: {
  /** "Tech 2": named under the clock, so a visitor knows whose phone this is. */
  owner: string;
  orders: WorkOrder[];
  onOpen: () => void;
}) {
  const now = useNow();
  const paged = orders.filter((o) => o.state === 'open');
  return (
    <View style={styles.screen} role="main" aria-label="Lock screen">
      <View style={styles.time}>
        <Text style={styles.date}>
          {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </Text>
        <Text style={styles.clock}>{clock(now)}</Text>
      </View>
      <OwnerWidget owner={owner} paged={paged.length} />
      <View style={styles.notes} aria-live="polite">
        {paged.map((o) => (
          <Notification key={o.number} order={o} onOpen={onOpen} />
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={onOpen} style={styles.open}>
        <Text style={styles.openText}>
          {paged.length > 0 ? 'Tap a notification, or here, to open' : 'Tap to open AssetPulse'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: WALLPAPER,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 24,
  },
  time: { alignItems: 'center', gap: 2, marginBottom: 20 },
  date: { color: '#dbe6f0', fontSize: 16, fontWeight: '600' },
  clock: { color: '#ffffff', fontSize: 76, fontWeight: '700', letterSpacing: -2 },
  widget: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    marginBottom: 14,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#3a6ea5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#ffffff', fontSize: 18, fontWeight: '800' },
  widgetText: { flex: 1, gap: 4 },
  widgetTitle: { color: '#ffffff', fontSize: 22, fontWeight: '700' },
  widgetStatus: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  widgetSub: { color: '#dbe6f0', fontSize: 14 },
  pulse: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  pulseRing: { position: 'absolute', width: 10, height: 10, borderRadius: 5 },
  pulseDot: { width: 10, height: 10, borderRadius: 5 },
  notes: { flex: 1, gap: 10 },
  note: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 2,
  },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  noteIcon: {
    width: 20,
    height: 20,
    borderRadius: 5,
    backgroundColor: '#3a6ea5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteIconText: { color: '#ffffff', fontSize: 12, fontWeight: '800' },
  noteApp: { flex: 1, color: '#4a5560', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  noteWhen: { color: '#4a5560', fontSize: 12 },
  noteTitle: { color: '#1c2630', fontSize: 15, fontWeight: '700' },
  noteBody: { color: '#1c2630', fontSize: 14 },
  open: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 18 },
  openText: { color: '#dbe6f0', fontSize: 14, fontWeight: '600' },
});
