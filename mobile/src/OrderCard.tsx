import { RESTOCK_QUANTITY, type WorkOrder } from '@assetpulse/protocol';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette, type Palette } from './theme';

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
  const { palette } = usePalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
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

function makeStyles(c: Palette) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 14,
      gap: 6,
    },
    fresh: { borderColor: c.warn, backgroundColor: c.warnSoft },
    top: { flexDirection: 'row', justifyContent: 'space-between' },
    number: { color: c.text, fontSize: 16, fontWeight: '600' },
    state: { color: c.warn, fontSize: 14 },
    mine: { color: c.ok },
    body: { color: c.text, fontSize: 15 },
    meta: { color: c.textMuted, fontSize: 14 },
    button: { marginTop: 6, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
    accept: { backgroundColor: c.statusInUse },
    deliver: { backgroundColor: c.ok },
    disabled: { opacity: 0.5 },
    buttonText: { color: c.onStatus, fontSize: 16, fontWeight: '600' },
  });
}
