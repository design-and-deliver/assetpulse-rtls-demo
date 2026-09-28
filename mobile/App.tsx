import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { OrderCard } from './src/OrderCard';
import { useTechSession, type Status } from './src/useTechSession';

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
  const session = useTechSession();
  const { status, hospitalId, techId, orders, notice } = session;
  const live = status === 'open';

  if (!hospitalId) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.title}>AssetPulse · Tech</Text>
        <Text style={styles.status}>{LABEL[status]}</Text>
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {DROPPED.has(status) && (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>
            {LABEL[status]} Actions resume when the link is back.
          </Text>
        </View>
      )}
      <View style={styles.header}>
        <Text style={styles.title}>AssetPulse · Tech</Text>
        <Text style={styles.meta}>
          {techId} · Hospital {hospitalId} ·{' '}
          <Text style={live ? styles.live : styles.status}>{LABEL[status]}</Text>
        </Text>
      </View>
      {notice && (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={styles.list}>
        {orders.length === 0 ? (
          <Text style={styles.meta}>Nothing to restock. A PAR breach will show up here.</Text>
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
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f1419' },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  header: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8, gap: 4 },
  title: { color: '#e6edf3', fontSize: 22, fontWeight: '600' },
  meta: { color: '#8b949e', fontSize: 14 },
  status: { color: '#d29922', fontSize: 14, textAlign: 'center' },
  live: { color: '#3fb950' },
  banner: { backgroundColor: '#d29922', paddingVertical: 8, paddingHorizontal: 16 },
  bannerText: { color: '#0f1419', fontWeight: '600', textAlign: 'center' },
  notice: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#3d1d1d',
  },
  noticeText: { color: '#ff7b72', fontSize: 14 },
  list: { padding: 16, gap: 12 },
});
