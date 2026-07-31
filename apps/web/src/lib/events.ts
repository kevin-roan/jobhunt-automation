import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { eventsUrl } from './api';

export interface LiveEvent {
  event: string;
  payload: unknown;
  receivedAt: string;
}

/** Query keys invalidated when a given server event arrives. */
const INVALIDATION_MAP: Record<string, string[][]> = {
  'job.collected': [['jobs'], ['analytics']],
  'job.scored': [['jobs'], ['analytics']],
  'application.created': [['applications'], ['analytics']],
  'application.step': [['applications']],
  'application.submitted': [['applications'], ['jobs'], ['analytics']],
  'application.failed': [['applications'], ['analytics']],
  'application.needs_human': [['applications']],
  'queue.enqueued': [['queue']],
  'queue.started': [['queue']],
  'queue.completed': [['queue'], ['analytics']],
  'queue.failed': [['queue']],
  'llm.call': [['llm-calls'], ['analytics']],
  'collector.run': [['collectors'], ['jobs']],
  'settings.updated': [['settings']],
};

const TRACKED_EVENTS = Object.keys(INVALIDATION_MAP);

/**
 * Subscribes to the server's SSE stream and invalidates the affected queries so
 * the dashboard reflects background work without polling.
 */
export function useLiveEvents(limit = 60): LiveEvent[] {
  const queryClient = useQueryClient();
  const [events, setEvents] = React.useState<LiveEvent[]>([]);

  React.useEffect(() => {
    const source = new EventSource(eventsUrl);

    const handle = (name: string) => (message: MessageEvent<string>) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(message.data) as unknown;
      } catch {
        payload = message.data;
      }

      setEvents((current) =>
        [{ event: name, payload, receivedAt: new Date().toISOString() }, ...current].slice(0, limit),
      );

      for (const key of INVALIDATION_MAP[name] ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const listeners = TRACKED_EVENTS.map((name) => {
      const listener = handle(name) as EventListener;
      source.addEventListener(name, listener);
      return [name, listener] as const;
    });

    const logListener = handle('log') as EventListener;
    source.addEventListener('log', logListener);

    return () => {
      for (const [name, listener] of listeners) source.removeEventListener(name, listener);
      source.removeEventListener('log', logListener);
      source.close();
    };
  }, [queryClient, limit]);

  return events;
}
