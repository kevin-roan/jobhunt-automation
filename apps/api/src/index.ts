import { loadConfig } from './config/env.js';
import { createContainer } from './core/container.js';
import { toErrorMessage } from './core/errors.js';
import { createServer } from './api/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);
  const logger = container.logger.child('bootstrap');

  logger.info('starting Deedy Automation', {
    version: config.version,
    dataDir: config.paths.root,
    nodeEnv: config.NODE_ENV,
    workersEnabled: !config.DISABLE_WORKERS,
  });

  // Anything a previous process left mid-flight becomes runnable again.
  const recovered = container.services.applications.recoverStuck();
  const reclaimed = container.repositories.queue.reclaimStalled();
  if (recovered > 0 || reclaimed > 0) {
    logger.info('recovered interrupted work', { applications: recovered, queueJobs: reclaimed });
  }

  if (!config.DISABLE_WORKERS) {
    container.worker.start();
    container.scheduler.start();
  }

  const app = await createServer(container);
  await app.listen({ host: config.HOST, port: config.PORT });

  logger.info('server listening', {
    url: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`,
    docs: `/docs`,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      await app.close();
      await container.shutdown();
      logger.info('shutdown complete');
    } catch (error) {
      logger.error('error during shutdown', { error: toErrorMessage(error) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { error: toErrorMessage(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.fatal('uncaught exception', { error: toErrorMessage(error), stack: error.stack });
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so fall back to stderr.
  console.error('Fatal startup error:', error);
  process.exit(1);
});
