import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/env.js';
import { createDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger, type Logger } from './logger.js';
import { EventBus } from './events.js';

import { SettingsRepository } from '../repositories/settings.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import { KeywordRepository } from '../repositories/keyword.repository.js';
import {
  AnswerBankRepository,
  ApplicationRepository,
} from '../repositories/application.repository.js';
import { CoverLetterRepository, ResumeRepository } from '../repositories/resume.repository.js';
import { QueueRepository } from '../repositories/queue.repository.js';
import {
  LlmCallRepository,
  LogRepository,
  PromptTemplateRepository,
} from '../repositories/observability.repository.js';
import {
  BrowserSessionRepository,
  CollectorRunRepository,
  SchedulerStateRepository,
} from '../repositories/browser.repository.js';
import { AnalyticsRepository } from '../repositories/analytics.repository.js';
import { CredentialRepository } from '../repositories/credential.repository.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { SyncRepository } from '../repositories/sync.repository.js';

import { SettingsService } from '../services/settings.service.js';
import { LlmService } from '../services/llm/llm.service.js';
import { LatexService } from '../services/latex/latex.service.js';
import { DocumentService } from '../services/document.service.js';
import { JobService } from '../services/job.service.js';
import { KeywordService } from '../services/keyword.service.js';
import { PipelineService } from '../services/pipeline.service.js';
import { SourceService } from '../services/source.service.js';
import { VpnService } from '../services/vpn/vpn.service.js';
import { CoverLetterService, ResumeService } from '../services/resume.service.js';
import { ApplicationService } from '../services/application.service.js';
import { NotificationService } from '../services/notification.service.js';
import { BackupService } from '../services/backup.service.js';
import { CredentialService } from '../services/credential.service.js';
import { SyncService } from '../services/sync/sync.service.js';
import { CommandRepository, CommandService } from '../services/sync/command.service.js';

import { BrowserManager } from '../browser/browser.manager.js';
import { ApplierRegistry } from '../browser/appliers/index.js';
import { CollectorRegistry } from '../collectors/registry.js';

import { QueueWorker } from '../queue/worker.js';
import { createHandlers } from '../queue/handlers.js';
import { Scheduler, createScheduledTasks } from '../scheduler/scheduler.js';

export interface Container {
  config: AppConfig;
  db: Db;
  sqlite: Database.Database;
  closeDb: () => void;
  logger: Logger;
  events: EventBus;

  repositories: {
    settings: SettingsRepository;
    jobs: JobRepository;
    applications: ApplicationRepository;
    answerBank: AnswerBankRepository;
    resumes: ResumeRepository;
    coverLetters: CoverLetterRepository;
    queue: QueueRepository;
    logs: LogRepository;
    llmCalls: LlmCallRepository;
    promptTemplates: PromptTemplateRepository;
    browserSessions: BrowserSessionRepository;
    collectorRuns: CollectorRunRepository;
    schedulerState: SchedulerStateRepository;
    analytics: AnalyticsRepository;
    credentials: CredentialRepository;
    notifications: NotificationRepository;
    sync: SyncRepository;
    commands: CommandRepository;
    keywords: KeywordRepository;
  };

  services: {
    settings: SettingsService;
    llm: LlmService;
    latex: LatexService;
    documents: DocumentService;
    jobs: JobService;
    keywords: KeywordService;
    pipeline: PipelineService;
    sources: SourceService;
    vpn: VpnService;
    resumes: ResumeService;
    coverLetters: CoverLetterService;
    applications: ApplicationService;
    notifications: NotificationService;
    backups: BackupService;
    credentials: CredentialService;
    sync: SyncService;
    commands: CommandService;
  };

  browser: BrowserManager;
  appliers: ApplierRegistry;
  collectors: CollectorRegistry;
  worker: QueueWorker;
  scheduler: Scheduler;

  shutdown: () => Promise<void>;
}

/**
 * Composition root. Everything is constructed here and injected downward, so
 * modules depend on interfaces rather than on each other's module graph.
 */
export async function createContainer(config: AppConfig): Promise<Container> {
  const { db, sqlite, close: closeDb } = createDb(config.paths.db);
  const migration = runMigrations(sqlite);

  const events = new EventBus();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    sqlite,
    onLog: (entry) =>
      events.emit('log', {
        level: entry.level,
        scope: entry.scope,
        message: entry.message,
        createdAt: entry.createdAt,
      }),
  });

  if (migration.applied.length > 0) {
    logger.info('database migrations applied', { applied: migration.applied });
  }

  const repositories: Container['repositories'] = {
    settings: new SettingsRepository(db),
    jobs: new JobRepository(db),
    applications: new ApplicationRepository(db),
    answerBank: new AnswerBankRepository(db),
    resumes: new ResumeRepository(db),
    coverLetters: new CoverLetterRepository(db),
    queue: new QueueRepository(db),
    logs: new LogRepository(db),
    llmCalls: new LlmCallRepository(db),
    promptTemplates: new PromptTemplateRepository(db),
    browserSessions: new BrowserSessionRepository(db),
    collectorRuns: new CollectorRunRepository(db),
    schedulerState: new SchedulerStateRepository(db),
    analytics: new AnalyticsRepository(db),
    credentials: new CredentialRepository(db),
    notifications: new NotificationRepository(db),
    sync: new SyncRepository(db),
    commands: new CommandRepository(db),
    keywords: new KeywordRepository(db),
  };

  const settingsService = new SettingsService(
    repositories.settings,
    config.encryptionKey,
    logger.child('settings'),
    events,
  );
  const supabaseEnv = {
    url: config.SUPABASE_URL,
    publishableKey: config.SUPABASE_PUBLISHABLE_KEY,
    secretKey: config.SUPABASE_SECRET_KEY,
    userId: config.SUPABASE_USER_ID,
  };
  settingsService.bootstrap({
    'sync.url': supabaseEnv.url,
    'sync.publishableKey': supabaseEnv.publishableKey,
    'sync.secretKey': supabaseEnv.secretKey,
    'sync.userId': supabaseEnv.userId,
  });

  // Adopt environment credentials into any field the user has left blank. This
  // covers adding Supabase to .env after the first boot, which would otherwise
  // silently do nothing because the key already exists as an empty string.
  const currentSync = settingsService.get().sync;
  const adopted = Object.entries(supabaseEnv).filter(
    ([key, value]) => value !== '' && currentSync[key as keyof typeof supabaseEnv] === '',
  );
  if (adopted.length > 0) {
    settingsService.update({ sync: Object.fromEntries(adopted) });
    logger.info('adopted Supabase configuration from the environment', {
      fields: adopted.map(([key]) => key),
    });
  }

  const credentialService = new CredentialService(
    repositories.credentials,
    config.encryptionKey,
    logger.child('credentials'),
    events,
  );

  // Pasted sessions are injected into every persistent context, which is what
  // makes providers that block automated login (LinkedIn, Indeed) reachable.
  const browser = new BrowserManager(
    settingsService,
    repositories.browserSessions,
    config.paths,
    logger.child('browser'),
    credentialService,
  );

  const llmService = new LlmService(
    settingsService,
    repositories.llmCalls,
    repositories.promptTemplates,
    logger.child('llm'),
    events,
  );

  const documentService = new DocumentService(config.paths, browser, logger.child('documents'));
  // Resumes are LaTeX documents compiled on this host; no rendering service and
  // no font ever leaves the machine.
  const latexService = new LatexService(config.paths, logger.child('latex'));
  const syncRepository = repositories.sync;

  // Exit location. Off unless the user configures a backend, so a host with no
  // VPN behaves exactly as before.
  const vpnService = new VpnService(settingsService, logger.child('vpn'));

  const keywordService = new KeywordService(
    repositories.keywords,
    settingsService,
    llmService,
    logger.child('keywords'),
  );

  // Settings is saved far more often than the Keywords screen is opened, so the
  // keyword table is reconciled from the save path rather than from a button.
  settingsService.onSearchKeywordsChanged(() => keywordService.handleSeedsChanged());

  const notificationService = new NotificationService(
    repositories.notifications,
    settingsService,
    logger.child('notifications'),
    { enqueueNotification: (id: number) => syncRepository.enqueue('notification', id) },
  );

  const collectors = new CollectorRegistry(logger.child('collectors'));
  const loadedPlugins = await collectors.loadPlugins(config.paths.plugins);
  if (loadedPlugins > 0) logger.info('collector plugins loaded', { count: loadedPlugins });

  const appliers = new ApplierRegistry(logger.child('appliers'));

  const jobService = new JobService(
    repositories.jobs,
    repositories.resumes,
    repositories.collectorRuns,
    collectors,
    browser,
    settingsService,
    llmService,
    keywordService,
    credentialService,
    vpnService,
    logger.child('jobs'),
    events,
  );

  const resumeService = new ResumeService(
    repositories.resumes,
    repositories.jobs,
    documentService,
    latexService,
    llmService,
    logger.child('resumes'),
  );

  const coverLetterService = new CoverLetterService(
    repositories.coverLetters,
    repositories.resumes,
    repositories.jobs,
    documentService,
    llmService,
    settingsService,
    logger.child('cover-letters'),
  );

  const applicationService = new ApplicationService(
    repositories.applications,
    repositories.answerBank,
    repositories.jobs,
    repositories.resumes,
    repositories.coverLetters,
    resumeService,
    coverLetterService,
    appliers,
    browser,
    llmService,
    settingsService,
    notificationService,
    logger.child('applications'),
    events,
  );

  const syncService = new SyncService(
    repositories.sync,
    repositories.jobs,
    repositories.applications,
    // The sync reader wants the full row shape; the repository's byId projection
    // omits dedupeKey, which never crosses the network anyway.
    { byId: (id: number) => repositories.notifications.rowById(id) },
    repositories.queue,
    settingsService,
    logger.child('sync'),
    events,
  );

  const commandService = new CommandService(
    syncService,
    repositories.commands,
    repositories.queue,
    repositories.jobs,
    repositories.applications,
    settingsService,
    logger.child('commands'),
    events,
    { onFullResync: async () => { await syncService.fullResync(); } },
  );

  // Mirror every pipeline change into the sync outbox. The outbox is durable,
  // so an offline laptop delays the phone's view rather than losing it.
  events.on('job.collected', ({ jobId }) => syncService.enqueueJob(jobId));
  events.on('job.scored', ({ jobId }) => syncService.enqueueJob(jobId));
  events.on('application.created', ({ applicationId }) =>
    syncService.enqueueApplication(applicationId),
  );
  events.on('application.step', ({ applicationId }) =>
    syncService.enqueueApplication(applicationId),
  );
  events.on('application.submitted', ({ applicationId }) =>
    syncService.enqueueApplication(applicationId),
  );
  events.on('application.failed', ({ applicationId }) =>
    syncService.enqueueApplication(applicationId),
  );
  events.on('application.needs_human', ({ applicationId }) =>
    syncService.enqueueApplication(applicationId),
  );

  const backupService = new BackupService(
    sqlite,
    config.paths,
    settingsService,
    logger.child('backups'),
  );

  // Takes the keyword count as a callback rather than the service itself, so the
  // per-source dashboard does not pull the keyword store into its dependencies.
  const sourceService = new SourceService(
    collectors,
    settingsService,
    credentialService,
    repositories.collectorRuns,
    repositories.analytics,
    repositories.queue,
    browser,
    logger.child('sources'),
  );

  const worker = new QueueWorker(
    repositories.queue,
    createHandlers({
      jobService,
      resumeService,
      coverLetterService,
      applicationService,
      backupService,
      settingsService,
      queue: repositories.queue,
      jobs: repositories.jobs,
      logs: repositories.logs,
      llmCalls: repositories.llmCalls,
      logger: logger.child('handlers'),
    }),
    settingsService,
    logger.child('queue'),
    events,
  );

  // Constructed after the worker because stopping a stage has to abort whatever
  // that stage already has in flight, not merely stop queueing more of it.
  const pipelineService = new PipelineService(
    settingsService,
    worker,
    repositories.queue,
    llmService,
    logger.child('pipeline'),
    events,
  );

  const scheduler = new Scheduler(
    repositories.schedulerState,
    settingsService,
    logger.child('scheduler'),
  );
  for (const task of createScheduledTasks({
    queue: repositories.queue,
    jobs: repositories.jobs,
    jobService,
    applicationService,
    settingsService,
    logger: logger.child('scheduler'),
    syncService,
    commandService,
    credentialService,
    notificationService,
  })) {
    scheduler.register(task);
  }

  const container: Container = {
    config,
    db,
    sqlite,
    closeDb,
    logger,
    events,
    repositories,
    services: {
      settings: settingsService,
      llm: llmService,
      latex: latexService,
      documents: documentService,
      jobs: jobService,
      keywords: keywordService,
      pipeline: pipelineService,
      sources: sourceService,
      vpn: vpnService,
      resumes: resumeService,
      coverLetters: coverLetterService,
      applications: applicationService,
      notifications: notificationService,
      backups: backupService,
      credentials: credentialService,
      sync: syncService,
      commands: commandService,
    },
    browser,
    appliers,
    collectors,
    worker,
    scheduler,

    async shutdown() {
      scheduler.stop();
      await worker.stop();
      await browser.closeAll();
      closeDb();
    },
  };

  return container;
}
