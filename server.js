import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as recorder from './services/recorder.js';
import * as autoRecord from './services/auto-record.js';
import apiRouter from './routes/api.js';

const PORT = process.env.PORT || 8085;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/api', apiRouter);

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, stopping recordings...`);
  autoRecord.shutdown();
  try {
    await recorder.stopAll();
  } catch { /* already idle */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await recorder.cleanupOrphans();
await autoRecord.init();

app.listen(PORT, () => {
  console.log(`[server] kodi-pi listening on port ${PORT}`);
});
