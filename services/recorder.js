import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const VALID_CAMERAS = ['camera_a', 'camera_b'];
const FILENAME_PATTERN = /^camera_[ab]_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.mp4$/;
const MIN_DISK_SPACE_BYTES = 1024 * 1024 * 1024; // 1 GB

const RTSP_BASE = process.env.RTSP_BASE || 'rtsp://localhost:8554';
const GO2RTC_API = process.env.GO2RTC_API || 'http://localhost:1984';
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || './recordings');

const cameras = new Map(
  VALID_CAMERAS.map(name => [name, { status: 'idle', process: null, startTime: null, outputPath: null }])
);

function validateCamera(camera) {
  if (!VALID_CAMERAS.includes(camera)) {
    throw new Error(`Invalid camera: ${camera}. Must be one of: ${VALID_CAMERAS.join(', ')}`);
  }
}

function checkDiskSpace() {
  const output = execSync(`df -k "${RECORDINGS_DIR}"`).toString();
  const lines = output.trim().split('\n');
  const columns = lines[1].split(/\s+/);
  // df -k column 3 = available blocks (1K each)
  const availableBytes = parseInt(columns[3], 10) * 1024;
  if (availableBytes < MIN_DISK_SPACE_BYTES) {
    throw new Error(`Insufficient disk space: ${Math.round(availableBytes / 1024 / 1024)}MB available, need at least 1GB`);
  }
}

function buildOutputPath(camera) {
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const filename = `${camera}_${ts}.mp4`;
  return path.join(RECORDINGS_DIR, filename);
}

export function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        resolve({
          duration: parseFloat(info.format?.duration) || 0,
          codec: videoStream?.codec_name || 'unknown',
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
        });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });
  });
}

function writeSidecar(outputPath, probeData) {
  const jsonPath = outputPath.replace(/\.mp4$/, '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(probeData, null, 2));
}

export function startRecording(camera) {
  validateCamera(camera);

  const state = cameras.get(camera);
  if (state.status === 'recording') {
    throw new Error(`${camera} is already recording`);
  }

  checkDiskSpace();

  const outputPath = buildOutputPath(camera);
  const rtspUrl = `${RTSP_BASE}/${camera}`;

  const proc = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c', 'copy',
    '-movflags', '+frag_keyframe+empty_moov',
    outputPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const startTime = new Date().toISOString();

  proc.stderr.on('data', data => {
    const msg = data.toString();
    if (msg.includes('error') || msg.includes('Error')) {
      console.error(`[${camera}] ffmpeg: ${msg.trim()}`);
    }
  });

  proc.on('error', err => {
    console.error(`[${camera}] ffmpeg process error: ${err.message}`);
    Object.assign(state, { status: 'idle', process: null, startTime: null, outputPath: null });
  });

  proc.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGINT') {
      console.error(`[${camera}] ffmpeg exited with code=${code} signal=${signal}`);
    }
    Object.assign(state, { status: 'idle', process: null, startTime: null, outputPath: null });
  });

  Object.assign(state, { status: 'recording', process: proc, startTime, outputPath });

  return { camera, status: 'recording', startTime, outputPath };
}

export async function stopRecording(camera) {
  validateCamera(camera);

  const state = cameras.get(camera);
  if (state.status !== 'recording' || !state.process) {
    throw new Error(`${camera} is not recording`);
  }

  const { process: proc, outputPath, startTime } = state;

  await new Promise((resolve) => {
    const killTimeout = setTimeout(() => {
      console.warn(`[${camera}] ffmpeg did not exit after SIGINT, sending SIGKILL`);
      proc.kill('SIGKILL');
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(killTimeout);
      resolve();
    });

    proc.kill('SIGINT');
  });

  let fileInfo = { filename: path.basename(outputPath), duration: 0, size: 0 };

  try {
    const stat = fs.statSync(outputPath);
    fileInfo.size = stat.size;

    const probeData = await probeDuration(outputPath);
    fileInfo.duration = probeData.duration;
    writeSidecar(outputPath, probeData);
  } catch (err) {
    console.error(`[${camera}] failed to probe output file: ${err.message}`);
  }

  return { camera, status: 'idle', file: fileInfo };
}

export async function startAll() {
  const results = {};
  for (const camera of VALID_CAMERAS) {
    try {
      results[camera] = startRecording(camera);
    } catch (err) {
      results[camera] = { camera, error: err.message };
    }
  }
  return results;
}

export async function stopAll() {
  // Send SIGINT to all cameras simultaneously so they stop at the same moment
  const toStop = [];
  for (const camera of VALID_CAMERAS) {
    const state = cameras.get(camera);
    if (state.status === 'recording' && state.process) {
      const { process: proc, outputPath } = state;
      const exitPromise = new Promise((resolve) => {
        const killTimeout = setTimeout(() => {
          console.warn(`[${camera}] ffmpeg did not exit after SIGINT, sending SIGKILL`);
          proc.kill('SIGKILL');
        }, 5000);

        proc.on('exit', () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
      proc.kill('SIGINT');
      toStop.push({ camera, exitPromise, outputPath });
    }
  }

  // Await all exits in parallel, then probe files
  const results = {};
  await Promise.all(toStop.map(async ({ camera, exitPromise, outputPath }) => {
    try {
      await exitPromise;
      let fileInfo = { filename: path.basename(outputPath), duration: 0, size: 0 };
      try {
        const stat = fs.statSync(outputPath);
        fileInfo.size = stat.size;
        const probeData = await probeDuration(outputPath);
        fileInfo.duration = probeData.duration;
        writeSidecar(outputPath, probeData);
      } catch (err) {
        console.error(`[${camera}] failed to probe output file: ${err.message}`);
      }
      results[camera] = { camera, status: 'idle', file: fileInfo };
    } catch (err) {
      results[camera] = { camera, error: err.message };
    }
  }));

  // Include cameras that weren't recording
  for (const camera of VALID_CAMERAS) {
    if (!results[camera]) {
      results[camera] = { camera, error: `${camera} is not recording` };
    }
  }

  return results;
}

export async function getStatus() {
  const status = {};
  for (const [camera, state] of cameras) {
    status[camera] = { status: state.status };
    if (state.status === 'recording' && state.startTime) {
      status[camera].startTime = state.startTime;
      status[camera].elapsed = (Date.now() - new Date(state.startTime).getTime()) / 1000;
    }
  }

  try {
    const res = await fetch(`${GO2RTC_API}/api/streams`);
    if (res.ok) {
      status.streams = await res.json();
    }
  } catch {
    status.streams = null;
  }

  return status;
}

export async function listRecordings() {
  if (!fs.existsSync(RECORDINGS_DIR)) return [];

  const files = fs.readdirSync(RECORDINGS_DIR).filter(f => FILENAME_PATTERN.test(f));

  const recordings = await Promise.all(files.map(async filename => {
    const filePath = path.join(RECORDINGS_DIR, filename);
    const stat = fs.statSync(filePath);

    const [, cam, timestamp] = filename.match(/^(camera_[ab])_(.+)\.mp4$/);

    let duration = null;
    const sidecarPath = filePath.replace(/\.mp4$/, '.json');
    if (fs.existsSync(sidecarPath)) {
      try {
        const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
        duration = sidecar.duration;
      } catch { /* sidecar corrupt, skip */ }
    }

    // Filename timestamp is ISO-like with dashes: 2026-03-13T14-30-00
    // Restore colons in the time portion (after the T)
    const tIdx = timestamp.indexOf('T');
    const restored = tIdx >= 0
      ? timestamp.slice(0, tIdx + 1) + timestamp.slice(tIdx + 1).replace(/-/g, ':')
      : timestamp;

    return {
      filename,
      camera: cam,
      timestamp: restored,
      duration,
      size: stat.size,
    };
  }));

  recordings.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return recordings;
}

export function deleteAllRecordings() {
  for (const [name, state] of cameras) {
    if (state.status === 'recording') {
      throw new Error('Cannot delete while recording is active');
    }
  }

  if (!fs.existsSync(RECORDINGS_DIR)) return { deleted: 0 };

  const files = fs.readdirSync(RECORDINGS_DIR).filter(f => FILENAME_PATTERN.test(f));
  let count = 0;

  for (const filename of files) {
    const filePath = path.join(RECORDINGS_DIR, filename);
    fs.unlinkSync(filePath);
    count++;

    const sidecarPath = filePath.replace(/\.mp4$/, '.json');
    if (fs.existsSync(sidecarPath)) {
      fs.unlinkSync(sidecarPath);
    }
  }

  return { deleted: count };
}

export function deleteRecording(filename) {
  if (!FILENAME_PATTERN.test(filename)) {
    throw new Error(`Invalid filename: ${filename}`);
  }

  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filename}`);
  }

  fs.unlinkSync(filePath);

  const sidecarPath = filePath.replace(/\.mp4$/, '.json');
  if (fs.existsSync(sidecarPath)) {
    fs.unlinkSync(sidecarPath);
  }

  return { deleted: filename };
}

export async function cleanupOrphans() {
  console.log('[cleanup] Scanning for orphaned processes and files...');

  // Kill any lingering FFmpeg processes recording to our directory
  try {
    const ps = execSync('ps aux', { encoding: 'utf-8' });
    const orphans = ps.split('\n').filter(line =>
      line.includes('ffmpeg') && line.includes(RECORDINGS_DIR)
    );
    for (const line of orphans) {
      const pid = parseInt(line.split(/\s+/)[1], 10);
      if (pid) {
        console.log(`[cleanup] Killing orphaned ffmpeg process PID=${pid}`);
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch (err) {
    console.error(`[cleanup] Failed to scan for orphan processes: ${err.message}`);
  }

  // Create sidecar JSON for any .mp4 files that lack one
  if (!fs.existsSync(RECORDINGS_DIR)) return;

  const mp4Files = fs.readdirSync(RECORDINGS_DIR).filter(f => FILENAME_PATTERN.test(f));
  for (const filename of mp4Files) {
    const filePath = path.join(RECORDINGS_DIR, filename);
    const sidecarPath = filePath.replace(/\.mp4$/, '.json');

    if (!fs.existsSync(sidecarPath)) {
      console.log(`[cleanup] Probing orphaned file: ${filename}`);
      try {
        const probeData = await probeDuration(filePath);
        writeSidecar(filePath, probeData);
        console.log(`[cleanup] Created sidecar for ${filename} (${probeData.duration}s)`);
      } catch (err) {
        console.error(`[cleanup] Failed to probe ${filename}: ${err.message}`);
      }
    }
  }
}
