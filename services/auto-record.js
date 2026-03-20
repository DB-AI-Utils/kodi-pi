import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as recorder from './recorder.js';

const CONFIG_PATH = path.resolve('auto-record-config.json');
const RTSP_BASE = process.env.RTSP_BASE || 'rtsp://localhost:8554';
const PROBE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 10_000;
const DEBOUNCE_INTERVAL_MS = 5000;
const AWAKE_THRESHOLD = 2;
const DEBOUNCE_THRESHOLD = 3;

let enabled = true;
let stateName = 'idle';
let consecutiveAwake = 0;
let debounceCount = 0;
let pollTimeout = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    if (typeof config.enabled === 'boolean') return config;
  } catch { /* missing or corrupt */ }
  return { enabled: true };
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2));
  } catch (err) {
    console.error(`[auto-record] Failed to save config: ${err.message}`);
  }
}

function transition(newState) {
  if (newState !== stateName) {
    console.log(`[auto-record] ${stateName} -> ${newState}`);
    stateName = newState;
  }
}

function probeCamera(camera) {
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn('ffprobe', [
      '-rtsp_transport', 'tcp',
      '-i', `${RTSP_BASE}/${camera}`,
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
    ]);

    const killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGKILL');
        resolve(false);
      }
    }, PROBE_TIMEOUT_MS);

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        console.error(`[auto-record] ffprobe error for ${camera}: ${err.message}`);
        resolve(false);
      }
    });

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        resolve(code === 0);
      }
    });

    proc.stdin.end();
  });
}

async function probeBothCameras() {
  const [a, b] = await Promise.all([
    probeCamera('camera_a'),
    probeCamera('camera_b'),
  ]);
  return { a, b };
}

function bothAwake(result) {
  return result.a && result.b;
}

function schedulePoll(fn, delayMs) {
  cancelPoll();
  pollTimeout = setTimeout(fn, delayMs);
}

function cancelPoll() {
  if (pollTimeout !== null) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

async function isRecording() {
  const status = await recorder.getStatus();
  return status.camera_a?.status === 'recording' || status.camera_b?.status === 'recording';
}

async function pollIdle() {
  if (!enabled) return;

  const result = await probeBothCameras();

  if (!enabled) return;

  if (bothAwake(result)) {
    consecutiveAwake++;
    console.log(`[auto-record] Both awake (${consecutiveAwake}/${AWAKE_THRESHOLD})`);
    if (consecutiveAwake >= AWAKE_THRESHOLD) {
      consecutiveAwake = 0;
      await enterStarting();
      return;
    }
  } else {
    if (consecutiveAwake > 0) {
      console.log(`[auto-record] Camera(s) sleeping, reset awake count`);
    }
    consecutiveAwake = 0;
  }

  schedulePoll(pollIdle, POLL_INTERVAL_MS);
}

async function enterStarting() {
  transition('starting');

  if (await isRecording()) {
    transition('recording');
    schedulePoll(pollRecording, POLL_INTERVAL_MS);
    return;
  }

  try {
    const results = await recorder.startAll();
    const aErr = results.camera_a?.error;
    const bErr = results.camera_b?.error;

    if (aErr || bErr) {
      console.error(`[auto-record] Start failed: ${aErr || ''} ${bErr || ''}`);
      try { await recorder.stopAll(); } catch { /* rollback best-effort */ }
      transition('idle');
      consecutiveAwake = 0;
      schedulePoll(pollIdle, POLL_INTERVAL_MS);
      return;
    }

    transition('recording');
    schedulePoll(pollRecording, POLL_INTERVAL_MS);
  } catch (err) {
    console.error(`[auto-record] Start error: ${err.message}`);
    try { await recorder.stopAll(); } catch { /* rollback best-effort */ }
    transition('idle');
    consecutiveAwake = 0;
    schedulePoll(pollIdle, POLL_INTERVAL_MS);
  }
}

async function pollRecording() {
  if (!enabled) return;

  const result = await probeBothCameras();

  if (!enabled) return;

  if (bothAwake(result)) {
    schedulePoll(pollRecording, POLL_INTERVAL_MS);
  } else {
    debounceCount = 1;
    transition('debounce');
    console.log(`[auto-record] Camera(s) sleeping, debounce ${debounceCount}/${DEBOUNCE_THRESHOLD}`);
    schedulePoll(pollDebounce, DEBOUNCE_INTERVAL_MS);
  }
}

async function pollDebounce() {
  if (!enabled) return;

  const result = await probeBothCameras();

  if (!enabled) return;

  if (bothAwake(result)) {
    debounceCount = 0;
    transition('recording');
    schedulePoll(pollRecording, POLL_INTERVAL_MS);
  } else {
    debounceCount++;
    console.log(`[auto-record] Still sleeping, debounce ${debounceCount}/${DEBOUNCE_THRESHOLD}`);
    if (debounceCount >= DEBOUNCE_THRESHOLD) {
      console.log(`[auto-record] Debounce threshold reached, stopping recording`);
      try { await recorder.stopAll(); } catch (err) {
        console.error(`[auto-record] Stop error: ${err.message}`);
      }
      debounceCount = 0;
      transition('idle');
      consecutiveAwake = 0;
      schedulePoll(pollIdle, POLL_INTERVAL_MS);
    } else {
      schedulePoll(pollDebounce, DEBOUNCE_INTERVAL_MS);
    }
  }
}

function startPolling(fromState) {
  consecutiveAwake = 0;
  debounceCount = 0;

  if (fromState === 'recording') {
    transition('recording');
    schedulePoll(pollRecording, POLL_INTERVAL_MS);
  } else {
    transition('idle');
    schedulePoll(pollIdle, POLL_INTERVAL_MS);
  }
}

export async function init() {
  try {
    const config = loadConfig();
    enabled = config.enabled;
    console.log(`[auto-record] Initialized (enabled: ${enabled})`);

    if (enabled) {
      startPolling('idle');
    }
  } catch (err) {
    console.error(`[auto-record] Init failed: ${err.message}`);
    enabled = false;
  }
}

export function shutdown() {
  cancelPoll();
  console.log('[auto-record] Shut down');
}

export function getState() {
  return { enabled, state: stateName, consecutiveAwake, debounceCount };
}

export async function setEnabled(value) {
  enabled = value;
  saveConfig();

  if (enabled) {
    const recording = await isRecording();
    startPolling(recording ? 'recording' : 'idle');
  } else {
    cancelPoll();
    transition('idle');
    consecutiveAwake = 0;
    debounceCount = 0;
  }
}

export function disableFromManual() {
  enabled = false;
  saveConfig();
  cancelPoll();
  transition('idle');
  consecutiveAwake = 0;
  debounceCount = 0;
  console.log('[auto-record] Disabled (manual override)');
}
