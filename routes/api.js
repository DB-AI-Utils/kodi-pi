import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import * as recorder from '../services/recorder.js';
import * as autoRecordService from '../services/auto-record.js';
import { fireWebhook } from '../services/webhook.js';

const router = Router();
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || './recordings');
const FILENAME_PATTERN = /^camera_[ab]_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.mp4$/;

const GO2RTC_API = process.env.GO2RTC_API || 'http://localhost:1984';
const CAMERA_WAIT_TIMEOUT_MS = 30_000;
const CAMERA_POLL_INTERVAL_MS = 2_000;

async function checkCamerasConnected() {
  const res = await fetch(`${GO2RTC_API}/api/streams`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('go2rtc API unreachable');
  const streams = await res.json();

  const missing = [];
  for (const cam of ['camera_a', 'camera_b']) {
    const stream = streams[cam];
    if (!stream?.producers?.length) {
      missing.push(cam);
    }
  }
  return missing;
}

async function waitForCameras() {
  const deadline = Date.now() + CAMERA_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const missing = await checkCamerasConnected();
      if (missing.length === 0) return;
    } catch {
      // go2rtc not reachable yet, keep trying
    }
    await new Promise(r => setTimeout(r, CAMERA_POLL_INTERVAL_MS));
  }

  const missing = await checkCamerasConnected();
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Camera not connected: ${missing.join(', ')}`),
      { cameras: missing }
    );
  }
}

router.get('/status', async (req, res) => {
  try {
    const status = await recorder.getStatus();
    status.autoRecord = autoRecordService.getState();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auto-record', (req, res) => {
  res.json(autoRecordService.getState());
});

router.post('/auto-record', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    await autoRecordService.setEnabled(enabled);
    res.json(autoRecordService.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/record/start', async (req, res) => {
  try {
    autoRecordService.disableFromManual();
    await waitForCameras();
    const results = await recorder.startAll();
    res.json(results);
  } catch (err) {
    const status = err.cameras ? 503 : 500;
    res.status(status).json({ error: err.message, cameras: err.cameras });
  }
});

router.post('/record/stop', async (req, res) => {
  try {
    autoRecordService.disableFromManual();
    const results = await recorder.stopAll();
    fireWebhook('manual', results);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recordings', async (req, res) => {
  try {
    const recordings = await recorder.listRecordings();
    res.json(recordings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recordings/:filename', (req, res) => {
  const { filename } = req.params;

  if (!FILENAME_PATTERN.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.sendFile(filePath, {
    headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
  });
});

router.delete('/recordings', (req, res) => {
  try {
    const result = recorder.deleteAllRecordings();
    res.json(result);
  } catch (err) {
    if (err.message.includes('recording is active')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recordings/:filename', (req, res) => {
  const { filename } = req.params;

  try {
    const result = recorder.deleteRecording(filename);
    res.json(result);
  } catch (err) {
    if (err.message.includes('Invalid filename')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
