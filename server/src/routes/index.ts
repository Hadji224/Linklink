import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../auth.js';
import { accessLogger } from '../logger.js';
import { HttpError } from '../http.js';
import { serializeWrites } from '../writelock.js';
import { accountApi, publicApi } from './auth.js';
import { brandingApi, brandingPublicApi } from './branding.js';
import { channelsApi } from './channels.js';
import { communicationsApi } from './communications.js';
import { expensesApi } from './expenses.js';
import { governanceApi } from './governance.js';
import { filesApi } from './files.js';
import { meetingsApi } from './meetings.js';
import { miscApi } from './misc.js';
import { projectsApi } from './projects.js';
import { tasksApi } from './tasks.js';

export const api = Router();

api.use(serializeWrites);
api.use(publicApi);
api.use(brandingPublicApi);
api.use(requireAuth);
api.use(accessLogger);
for (const r of [accountApi, brandingApi, governanceApi, projectsApi, tasksApi, expensesApi, communicationsApi, channelsApi, filesApi, meetingsApi, miscApi]) api.use(r);

api.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'Requête mal formée.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
}
