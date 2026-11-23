import { createApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const app = await createApp({ config: cfg, previewJob: cfg.previewJobEnabled });

try {
  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`elib-service listening on ${cfg.host}:${cfg.port}, storageRoot=${cfg.storageRoot}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
