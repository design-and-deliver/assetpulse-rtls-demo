import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { LockScreen, monogram } from './src/LockScreen';
import { OrderCard } from './src/OrderCard';
import { PhoneFrame } from './src/PhoneFrame';
import { usePalette, type Palette } from './src/theme';
import { useTechSession, type Status, type TechSession } from './src/useTechSession';

const LABEL: Record<Status, string> = {
  connecting: 'connecting…',
  open: 'connected',
  reconnecting: 'reconnecting…',
  killed: 'offline',
  closed: 'closed',
  'no-hospital': 'Scan the QR code on the ops console to join a hospital.',
};

/** States where the socket dropped after working: say so loudly, above the inbox. */
const DROPPED = new Set<Status>(['reconnecting', 'killed']);

export default function App() {
  const { palette } = usePalette();
  // One session for both screens, so locking the phone never drops the socket or the orders.
  const session = useTechSession();
  const paged = session.orders.filter((o) => o.state === 'open').length;
  return (
    <PhoneFrame
      palette={palette}
      paged={paged}
      lockScreen={(unlock) => <LockScreen owner={session.techId} orders={session.orders} onOpen={unlock} />}
    >
      <TechApp session={session} />
    </PhoneFrame>
  );
}

function TechApp({ session }: { session: TechSession }) {
  const { status, hospitalId, techId, orders, notice } = session;
  const live = status === 'open';
  const { palette, dark } = usePalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const bar = dark ? 'light' : 'dark';

  if (!hospitalId) {
    return (
      <View style={[styles.container, styles.centered]} role="main">
        <Text style={styles.title} role="heading" aria-level={1}>
          AssetPulse · Tech
        </Text>
        <Text style={styles.status}>{LABEL[status]}</Text>
        <StatusBar style={bar} />
      </View>
    );
  }

  return (
    <View style={styles.container} role="main">
      <View style={styles.appBar}>
        <View style={styles.brand}>
          <View style={styles.logo} aria-hidden>
            <Text style={styles.logoText}>A</Text>
          </View>
          <Text style={styles.brandText} role="heading" aria-level={1}>
            AssetPulse
          </Text>
        </View>
        <View style={[styles.pill, live ? styles.pillLive : styles.pillDown]}>
          <View style={[styles.dot, { backgroundColor: live ? palette.ok : palette.warn }]} />
          <Text style={[styles.pillText, { color: live ? palette.ok : palette.warn }]}>
            {live ? 'Live' : LABEL[status]}
          </Text>
        </View>
      </View>
      {DROPPED.has(status) && (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>
            {LABEL[status]} Actions resume when the link is back.
          </Text>
        </View>
      )}
      <View style={styles.who}>
        <View style={styles.avatar} aria-hidden>
          <Text style={styles.avatarText}>{monogram(techId)}</Text>
        </View>
        <View>
          <Text style={styles.whoName}>{techId}</Text>
          <Text style={styles.meta}>Biomed tech · Hospital {hospitalId}</Text>
        </View>
      </View>
      {notice && (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={styles.list}>
        <View style={styles.sectionRow}>
          <Text style={styles.section} role="heading" aria-level={2}>
            Work orders
          </Text>
          {orders.length > 0 && (
            <Text style={styles.count}>{orders.length}</Text>
          )}
        </View>
        {orders.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon} aria-hidden>
              <Text style={styles.emptyIconText}>✓</Text>
            </View>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptyText}>
              We’ll let you know when it’s time to restock.
            </Text>
          </View>
        ) : (
          orders.map((o) => (
            <OrderCard
              key={o.number}
              order={o}
              fresh={session.fresh.has(o.number)}
              busy={session.pending.has(o.number)}
              live={live}
              onAccept={() => session.accept(o.number)}
              onDeliver={() => session.deliver(o.number)}
            />
          ))
        )}
      </ScrollView>
      <StatusBar style={bar} />
    </View>
  );
}


function makeStyles(c: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    centered: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
    appBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    logo: {
      width: 28,
      height: 28,
      borderRadius: 8,
      backgroundColor: c.statusInUse,
      alignItems: 'center',
      justifyContent: 'center',
    },
    logoText: { color: c.onStatus, fontSize: 16, fontWeight: '800' },
    brandText: { color: c.text, fontSize: 18, fontWeight: '700' },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: 1,
    },
    pillLive: { borderColor: c.ok },
    pillDown: { borderColor: c.warn },
    dot: { width: 8, height: 8, borderRadius: 4 },
    pillText: { fontSize: 13, fontWeight: '600' },
    who: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.okSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: c.ok, fontSize: 15, fontWeight: '700' },
    whoName: { color: c.text, fontSize: 17, fontWeight: '700' },
    title: { color: c.text, fontSize: 22, fontWeight: '600' },
    meta: { color: c.textMuted, fontSize: 14 },
    status: { color: c.warn, fontSize: 14, textAlign: 'center' },
    sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    section: { color: c.text, fontSize: 15, fontWeight: '700' },
    count: {
      color: c.onStatus,
      backgroundColor: c.warn,
      fontSize: 12,
      fontWeight: '700',
      paddingHorizontal: 8,
      paddingVertical: 1,
      borderRadius: 999,
      overflow: 'hidden',
    },
    empty: {
      alignItems: 'center',
      gap: 8,
      paddingVertical: 40,
      paddingHorizontal: 24,
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
    },
    emptyIcon: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.okSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyIconText: { color: c.ok, fontSize: 24, fontWeight: '700' },
    emptyTitle: { color: c.text, fontSize: 17, fontWeight: '700' },
    emptyText: { color: c.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
    banner: { backgroundColor: c.warn, paddingVertical: 8, paddingHorizontal: 16 },
    bannerText: { color: c.onStatus, fontWeight: '600', textAlign: 'center' },
    notice: {
      marginHorizontal: 16,
      marginBottom: 8,
      padding: 10,
      borderRadius: 8,
      backgroundColor: c.alertSoft,
    },
    noticeText: { color: c.alert, fontSize: 14 },
    list: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  });
}
