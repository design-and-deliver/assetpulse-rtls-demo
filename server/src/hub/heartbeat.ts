import { HEARTBEAT_MS } from '@assetpulse/protocol';

/** The slice of a `ws` socket the heartbeat touches — small enough to fake in tests. */
export interface Pingable {
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
}

/**
 * Pings every socket each `intervalMs`; a socket that has not answered the previous ping by
 * the next one is terminated. The server only reaps — clients measure their own RTT.
 * Returns a function that stops the heartbeat.
 */
export function startHeartbeat(
  sockets: () => Iterable<Pingable>,
  intervalMs = HEARTBEAT_MS,
): () => void {
  const watched = new WeakSet<Pingable>();
  const awaitingPong = new WeakSet<Pingable>();

  const beat = () => {
    for (const socket of sockets()) {
      if (!watched.has(socket)) {
        watched.add(socket);
        socket.on('pong', () => awaitingPong.delete(socket));
      }
      if (awaitingPong.has(socket)) {
        socket.terminate();
        continue;
      }
      awaitingPong.add(socket);
      socket.ping();
    }
  };

  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
