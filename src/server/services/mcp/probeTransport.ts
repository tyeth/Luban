// Shared vocabulary of the external probe sensor feed, in its own module so
// the orchestrator (probeFeed.ts) and the transport backends (MQTT in
// probeFeed.ts, Blinka GPIO in gpioFeed.ts) can all import it without cycles.

export type ProbeChannel = 'toolsetter' | 'overtravel' | 'probe';

export const PROBE_CHANNELS: ProbeChannel[] = ['toolsetter', 'overtravel', 'probe'];

export type ProbeTransportKind = 'mqtt' | 'gpio';

/**
 * A probe feed transport delivers raw sensor values per channel; the
 * ProbeFeedService owns everything downstream (polarity, the reading cache,
 * the overtravel/crash latch, reconnection). Implementations extend
 * EventEmitter and emit:
 *
 *   'reading' (channel: ProbeChannel, value: string) - the sensor CHANGED
 *   'refresh' (channel: ProbeChannel, value: string) - polled, unchanged
 *             (freshness only; MQTT never emits it, polling GPIO does)
 *   'error'   (err: Error)  - after connect() resolved; connect failures reject
 *   'close'   ()            - the transport is dead; the service reconnects
 *
 * A closed transport is not reusable - the service builds a new one from
 * freshly resolved configuration on every (re)connect.
 */
export interface ProbeTransport {
    connect(): Promise<void>;
    end(): void;
    isConnected(): boolean;
    /** Transport-specific fields merged into get_probe_feed_status. */
    describe(): object;
    on(event: string, listener: (...args: unknown[]) => void): this;
}
