import {
  LLM_PIPELINE_STAGES,
  PIPELINE_STAGES,
  QUEUE_TASK_STAGE,
  STAGE_SETTING_KEY,
  type PipelineControlInput,
  type PipelineSettings,
  type PipelineStage,
  type PipelineStageStatus,
  type PipelineStatus,
} from '@deedy/shared';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { isPipelineStageEnabled, type QueueWorker } from '../queue/worker.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import type { LlmService } from './llm/llm.service.js';
import type { SettingsService } from './settings.service.js';

/** Per-stage pending/failed counts, keyed by stage. */
type StageCounts = Record<PipelineStage, { pending: number; failed: number }>;

/**
 * The dashboard's stop/start surface. Local inference is the scarcest resource
 * on this machine, so every stage is its own switch: the state is persisted in
 * settings (a stopped stage stays stopped across a restart) and stopping also
 * aborts work already running, which is what actually gives the CPU back.
 */
export class PipelineService {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly worker: QueueWorker,
    private readonly queue: QueueRepository,
    private readonly llm: LlmService,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {}

  status(): PipelineStatus {
    const settings = this.settingsService.get();
    const pipeline = settings.pipeline;
    const inFlight = this.worker.inFlightByStage();
    const counts = this.stageCounts();

    const stages: PipelineStageStatus[] = PIPELINE_STAGES.map((stage) => ({
      stage,
      running: isPipelineStageEnabled(pipeline, stage),
      usesLlm: LLM_PIPELINE_STAGES.includes(stage),
      inFlight: inFlight[stage],
      pending: counts[stage].pending,
      failed: counts[stage].failed,
    }));

    return {
      enabled: pipeline.enabled,
      queuePaused: settings.queue.paused,
      schedulerEnabled: settings.scheduler.enabled,
      workerRunning: this.worker.status().running,
      inFlight: this.worker.status().inFlight,
      stages,
      llm: {
        activeCalls: this.activeLlmCalls(),
        model: settings.llm.model,
        activeStages: LLM_PIPELINE_STAGES.filter((stage) =>
          isPipelineStageEnabled(pipeline, stage),
        ),
      },
    };
  }

  /** Start or stop the whole pipeline, or one stage. Stopping aborts in-flight work by default. */
  control(input: PipelineControlInput): PipelineStatus {
    const enabled = input.action === 'start';
    const patch: Partial<PipelineSettings> = {};
    if (input.stage) {
      patch[STAGE_SETTING_KEY[input.stage]] = enabled;
    } else {
      // No stage means the master switch, and it is the only flag start touches:
      // master stop leaves the per-stage flags alone, so master start must not
      // resurrect a stage the user deliberately stopped.
      patch.enabled = enabled;
      if (enabled) {
        // The exception is a pipeline whose every stage is individually off:
        // there the master switch alone would leave nothing running and "start"
        // would be an invisible no-op, so the stages are re-armed too.
        const pipeline = this.settingsService.get().pipeline;
        const allStagesStopped = PIPELINE_STAGES.every(
          (stage) => pipeline[STAGE_SETTING_KEY[stage]] !== true,
        );
        if (allStagesStopped) {
          for (const stage of PIPELINE_STAGES) patch[STAGE_SETTING_KEY[stage]] = true;
        }
      }
    }

    this.settingsService.update({ pipeline: patch });

    // Persist first, then abort: a restart between the two leaves the stage
    // stopped and the job reclaimed, which is the safe order.
    const aborted = !enabled && input.abortInFlight ? this.worker.abort(input.stage) : 0;

    this.logger.info('pipeline control', {
      stage: input.stage ?? 'all',
      action: input.action,
      aborted,
    });
    this.events.emit('pipeline.changed', {
      stage: input.stage ?? null,
      action: input.action,
      enabled,
      aborted,
    });

    return this.status();
  }

  /** True when this stage may run right now. Services call this before expensive work. */
  isStageEnabled(stage: PipelineStage): boolean {
    return isPipelineStageEnabled(this.settingsService.get().pipeline, stage);
  }

  /**
   * `LlmService` is owned elsewhere, so the live call counter is read
   * structurally and treated as zero when that build does not expose one. The
   * number is display-only; nothing here depends on it.
   */
  private activeLlmCalls(): number {
    const counter = (this.llm as { activeCalls?: () => number }).activeCalls;
    return typeof counter === 'function' ? counter.call(this.llm) : 0;
  }

  private stageCounts(): StageCounts {
    const counts = Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage, { pending: 0, failed: 0 }]),
    ) as StageCounts;

    for (const row of this.queue.statsByTask()) {
      const stage = QUEUE_TASK_STAGE[row.task];
      if (!stage) continue;
      // `delayed` rows are retries waiting their turn, so they read as pending.
      if (row.status === 'pending' || row.status === 'delayed') {
        counts[stage].pending += row.value;
      } else if (row.status === 'failed') {
        counts[stage].failed += row.value;
      }
    }
    return counts;
  }
}
