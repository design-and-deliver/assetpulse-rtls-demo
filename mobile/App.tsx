import { createClient, type ConnectionState } from '@assetpulse/client';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { resolveTarget } from './src/connection';

type Status = ConnectionState | 'no-hospital';

const LABEL: Record<Status, string> = {
  connecting: 'connecting…',
  open: 'connected',
  reconnecting: 'reconnecting…',
  killed: 'offline',
  closed: 'closed',
  'no-hospital': 'Scan the QR code on the ops console to join a hospital.',
};

function useConnection(): { status: Status; hospitalId: string | null } {
  const [status, setStatus] = useState<Status>('connecting');
  const [hospitalId, setHospitalId] = useState<string | null>(null);

  useEffect(() => {
    let dispose = () => {};
    let cancelled = false;
    void resolveTarget().then(({ url, hospitalId: id }) => {
      if (cancelled) return;
      if (!id) return setStatus('no-hospital');
      setHospitalId(id);
      const client = createClient({ url, hospitalId: id, topics: ['role:tech'] });
      const unsubscribe = client.state$.subscribe(setStatus);
      setStatus(client.state$.value);
      dispose = () => {
        unsubscribe();
        client.close();
      };
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  return { status, hospitalId };
}

export default function App() {
  const { status, hospitalId } = useConnection();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>AssetPulse · Tech</Text>
      {hospitalId && <Text style={styles.meta}>Hospital {hospitalId}</Text>}
      <Text style={[styles.status, status === 'open' && styles.live]}>{LABEL[status]}</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1419',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
  },
  title: { color: '#e6edf3', fontSize: 22, fontWeight: '600' },
  meta: { color: '#8b949e', fontSize: 14 },
  status: { color: '#d29922', fontSize: 16, textAlign: 'center' },
  live: { color: '#3fb950' },
});
