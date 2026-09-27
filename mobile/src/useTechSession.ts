import { createClient, type AssetPulseClient, type ConnectionState } from '@assetpulse/client';
import type { WorkOrder } from '@assetpulse/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';
import { resolveTarget } from './connection';

export type Status = ConnectionState | 'no-hospital';

/** How long a freshly arrived order stays highlighted, and a lost race stays on screen. */
const FLASH_MS = 1500;
const NOTICE_MS = 3000;

export interface TechSession {
  status: Status;
  hospitalId: string | null;
  techId: string;
  /** Orders this tech can act on: open ones, plus the ones they accepted. Newest first. */
  orders: WorkOrder[];
  fresh: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  notice: string | null;
  accept(orderNumber: string): void;
  deliver(orderNumber: string): void;
}

function visibleOrders(orders: Map<string, WorkOrder>, techId: string): WorkOrder[] {
  return [...orders.values()]
    .filter((o) => o.state === 'open' || (o.state === 'accepted' && o.assigned_to === techId))
    .sort((a, b) => b.opened_at - a.opened_at);
}

/** iOS Safari has no Vibration API and some browsers throw without a user gesture. */
function buzz(): void {
  try {
    Vibration.vibrate(200);
  } catch {
    // The visual flash still carries the alert.
  }
}

function withItem(set: ReadonlySet<string>, item: string): Set<string> {
  return new Set(set).add(item);
}

function withoutItem(set: ReadonlySet<string>, item: string): Set<string> {
  const next = new Set(set);
  next.delete(item);
  return next;
}

function useOrders(client: AssetPulseClient | null) {
  const [orders, setOrders] = useState<Map<string, WorkOrder>>(new Map());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  /** Order numbers already seen, so only genuinely new orders buzz (not snapshot replays). */
  const known = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;
    const reset = (list: WorkOrder[]) => {
      known.current = new Set(list.map((o) => o.number));
      setOrders(new Map(list.map((o) => [o.number, o])));
    };
    const offHello = client.on('hello', (f) => reset(f.snapshot.workOrders));
    const offResync = client.on('resync', (f) => reset(f.snapshot.workOrders));
    const offOrder = client.on('work_order', ({ order }) => {
      if (order.state === 'open' && !known.current.has(order.number)) {
        buzz();
        setFresh((s) => withItem(s, order.number));
        setTimeout(() => setFresh((s) => withoutItem(s, order.number)), FLASH_MS);
      }
      known.current.add(order.number);
      setOrders((prev) => new Map(prev).set(order.number, order));
    });
    return () => {
      offHello();
      offResync();
      offOrder();
    };
  }, [client]);

  return { orders, fresh };
}

function useClient(): {
  client: AssetPulseClient | null;
  status: Status;
  hospitalId: string | null;
} {
  const [status, setStatus] = useState<Status>('connecting');
  const [hospitalId, setHospitalId] = useState<string | null>(null);
  const [client, setClient] = useState<AssetPulseClient | null>(null);

  useEffect(() => {
    let dispose = () => {};
    let cancelled = false;
    void resolveTarget().then(({ url, hospitalId: id }) => {
      if (cancelled) return;
      if (!id) return setStatus('no-hospital');
      setHospitalId(id);
      const c = createClient({ url, hospitalId: id, topics: ['role:tech'] });
      const unsubscribe = c.state$.subscribe(setStatus);
      setStatus(c.state$.value);
      setClient(c);
      dispose = () => {
        unsubscribe();
        c.close();
      };
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  return { client, status, hospitalId };
}

export function useTechSession(): TechSession {
  const { client, status, hospitalId } = useClient();
  const { orders, fresh } = useOrders(client);
  const [techId] = useState(() => `tech-${Math.floor(1000 + Math.random() * 9000)}`);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flashNotice = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const run = useCallback(
    async (
      orderNumber: string,
      send: (c: AssetPulseClient) => ReturnType<AssetPulseClient['send']>,
    ) => {
      if (!client) return;
      setPending((s) => withItem(s, orderNumber));
      try {
        const ack = await send(client);
        if (ack.error === 'ALREADY_ASSIGNED') flashNotice(`${orderNumber}: Taken by another tech`);
        else if (!ack.ok) flashNotice(`${orderNumber}: ${ack.error ?? 'rejected'}`);
      } catch {
        flashNotice(`${orderNumber}: not sent, you're offline`);
      } finally {
        setPending((s) => withoutItem(s, orderNumber));
      }
    },
    [client, flashNotice],
  );

  const accept = useCallback(
    (orderNumber: string) =>
      void run(orderNumber, (c) => c.send({ name: 'accept_wo', args: { orderNumber, techId } })),
    [run, techId],
  );
  const deliver = useCallback(
    (orderNumber: string) =>
      void run(orderNumber, (c) => c.send({ name: 'deliver_wo', args: { orderNumber } })),
    [run],
  );

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  return {
    status,
    hospitalId,
    techId,
    orders: visibleOrders(orders, techId),
    fresh,
    pending,
    notice,
    accept,
    deliver,
  };
}
