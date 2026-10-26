import { RESTOCK_QUANTITY, ZONES, type WorkOrder } from '@assetpulse/protocol';
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

/** The order's life as the tech sees it: paged to them, taken, then pumps on the shelf. */
const STEPS = ['Paged', 'Accepted', 'Delivered'] as const;

const ZONE_LABEL = new Map(ZONES.map((z) => [z.id, z.label]));

function openedAt(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function OrderCard({ order, fresh, busy, live, onAccept, onDeliver }: Props) {
  const open = order.state === 'open';
  const disabled = busy || !live;
  const { palette } = usePalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const reached = open ? 1 : 2;
  const action = open ? 'Accept order' : `Mark ${RESTOCK_QUANTITY} pumps delivered`;

  return (
    <View style={[styles.card, fresh && styles.fresh]}>
      <View style={styles.top}>
        <Text style={[styles.chip, open ? styles.chipNew : styles.chipMine]}>
          {open ? 'New' : 'Yours'}
        </Text>
        <Text style={styles.time}>Opened {openedAt(order.opened_at)}</Text>
      </View>

      <Text style={styles.title}>{order.short_description.split(' to ')[0]}</Text>
      <Text style={styles.number}>{order.number}</Text>

      <View style={styles.facts}>
        <Fact styles={styles} label="Where" value={ZONE_LABEL.get(order.location) ?? order.location} />
        <Fact styles={styles} label="Bring" value={`${order.quantity} clean pumps`} />
      </View>

      <View
        style={styles.steps}
        role="progressbar"
        aria-label={`Step ${reached} of ${STEPS.length}: ${STEPS[reached - 1]}`}
      >
        {STEPS.map((step, i) => (
          <View key={step} style={styles.step}>
            <View style={[styles.bar, i < reached && styles.barDone]} />
            <Text style={[styles.stepText, i < reached && styles.stepTextDone]}>{step}</Text>
          </View>
        ))}
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={open ? onAccept : onDeliver}
        style={[styles.button, open ? styles.accept : styles.deliver, disabled && styles.disabled]}
      >
        <Text style={styles.buttonText}>{busy ? 'Sending…' : action}</Text>
      </Pressable>
    </View>
  );
}

function Fact({
  styles,
  label,
  value,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 16,
      gap: 4,
    },
    fresh: { borderColor: c.warn, borderWidth: 2 },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    chip: {
      fontSize: 12,
      fontWeight: '700',
      paddingVertical: 3,
      paddingHorizontal: 10,
      borderRadius: 999,
      overflow: 'hidden',
    },
    chipNew: { color: c.warn, backgroundColor: c.warnSoft },
    chipMine: { color: c.ok, backgroundColor: c.bg },
    time: { color: c.textMuted, fontSize: 13 },
    title: { color: c.text, fontSize: 20, fontWeight: '700', marginTop: 8 },
    number: { color: c.textMuted, fontSize: 13, fontFamily: 'monospace' },
    facts: { flexDirection: 'row', gap: 10, marginTop: 10 },
    fact: { flex: 1, backgroundColor: c.bg, borderRadius: 10, padding: 10, gap: 2 },
    factLabel: { color: c.textMuted, fontSize: 12 },
    factValue: { color: c.text, fontSize: 15, fontWeight: '600' },
    steps: { flexDirection: 'row', gap: 6, marginTop: 14 },
    step: { flex: 1, gap: 4 },
    bar: { height: 4, borderRadius: 2, backgroundColor: c.border },
    barDone: { backgroundColor: c.ok },
    stepText: { color: c.textMuted, fontSize: 12 },
    stepTextDone: { color: c.text, fontWeight: '600' },
    button: { marginTop: 14, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
    accept: { backgroundColor: c.statusInUse },
    deliver: { backgroundColor: c.ok },
    disabled: { opacity: 0.5 },
    buttonText: { color: c.onStatus, fontSize: 16, fontWeight: '700' },
  });
}
