import type { Container } from '../../core/container.js';
import type { ApiInstance } from '../types.js';
import { healthRoutes } from './health.routes.js';
import { settingsRoutes } from './settings.routes.js';
import { jobRoutes } from './jobs.routes.js';
import { applicationRoutes } from './applications.routes.js';
import { documentRoutes } from './documents.routes.js';
import { operationsRoutes } from './operations.routes.js';
import { observabilityRoutes } from './observability.routes.js';
import { credentialsRoutes } from './credentials.routes.js';
import { notificationRoutes } from './notifications.routes.js';
import { syncRoutes } from './sync.routes.js';

export async function registerRoutes(app: ApiInstance, container: Container): Promise<void> {
  await healthRoutes(app, container);
  await settingsRoutes(app, container);
  await jobRoutes(app, container);
  await applicationRoutes(app, container);
  await documentRoutes(app, container);
  await operationsRoutes(app, container);
  await observabilityRoutes(app, container);
  await credentialsRoutes(app, container);
  await notificationRoutes(app, container);
  await syncRoutes(app, container);
}
