import { RESTOCK_QUANTITY, type WorkOrder } from '@assetpulse/protocol';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  order: WorkOrder;
  fresh: boolean;
  busy: boolean;
  live: boolean;
  onAccept(): void;
  onDeliver(): void;
}

export function OrderCard({ order, fresh, busy, live, onAccept, onDeliver }: Props) {
  const open = order.state === 'open';
  const disabled = busy || !live;
  return (
    <View style={[styles.card, fresh && styles.fresh]}>
      <View style={styles.top}>
        <Text style={styles.number}>{order.number}</Text>
        <Text style={[styles.state, !open && styles.mine]}>{open ? 'Open' : 'Yours'}</Text>
      </View>
      <Text style={styles.body}>{order.short_description}</Text>
      <Text style={styles.meta}>
        Qty {order.quantity} · {order.location}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={open ? onAccept : onDeliver}
        style={[styles.button, open ? styles.accept : styles.deliver, disabled && styles.disabled]}
      >
        <Text style={styles.buttonText}>
          {open ? 'Accept' : `Complete restock (+${RESTOCK_QUANTITY})`}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#161b22',
    borderColor: '#30363d',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  fresh: { borderColor: '#d29922', backgroundColor: '#2b2111' },
  top: { flexDirection: 'row', justifyContent: 'space-between' },
  number: { color: '#e6edf3', fontSize: 16, fontWeight: '600' },
  state: { color: '#d29922', fontSize: 14 },
  mine: { color: '#3fb950' },
  body: { color: '#e6edf3', fontSize: 15 },
  meta: { color: '#8b949e', fontSize: 14 },
  button: { marginTop: 6, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  accept: { backgroundColor: '#1f6feb' },
  deliver: { backgroundColor: '#238636' },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
