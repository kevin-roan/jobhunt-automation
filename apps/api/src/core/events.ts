import { EventEmitter } from 'node:events';

export interface AppEvents {
  'job.collected': { jobId: number; source: string; title: string; company: string };
  'job.scored': { jobId: number; score: number; recommendation: string };
  'application.created': { applicationId: number; jobId: number };
  'application.step': {
    applicationId: number;
    step: string;
    status: string;
    attempt: number;
    message?: string;
  };
  'application.submitted': { applicationId: number; jobId: number; dryRun: boolean };
  'application.failed': { applicationId: number; jobId: number; error: string };
  'application.needs_human': { applicationId: number; jobId: number; question: string };
  'queue.enqueued': { id: number; task: string };
  'queue.started': { id: number; task: string; attempt: number };
  'queue.completed': { id: number; task: string; durationMs: number };
  'queue.failed': { id: number; task: string; error: string; willRetry: boolean };
  'llm.call': { task: string; model: string; success: boolean; totalTokens: number | null };
  'collector.run': { collectorId: string; found: number; inserted: number; duplicates: number };
  'settings.updated': { sections: string[] };
  log: { level: string; scope: string; message: string; createdAt: string };
}

export type AppEventName = keyof AppEvents;

/**
 * Typed, in-process event bus. Events are for live UI updates only — every
 * consumer of durable state reads SQLite, so a missed event is never data loss.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit<E extends AppEventName>(event: E, payload: AppEvents[E]): void {
    this.emitter.emit(event, payload);
    this.emitter.emit('*', { event, payload });
  }

  on<E extends AppEventName>(event: E, listener: (payload: AppEvents[E]) => void): () => void {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return () => this.emitter.off(event, listener as (payload: unknown) => void);
  }

  onAny(listener: (envelope: { event: AppEventName; payload: unknown }) => void): () => void {
    this.emitter.on('*', listener as (payload: unknown) => void);
    return () => this.emitter.off('*', listener as (payload: unknown) => void);
  }
}
