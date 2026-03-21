const KODI_TRAINING_URL = process.env.KODI_TRAINING_URL;

export async function fireWebhook(trigger, results) {
  if (!KODI_TRAINING_URL) return;

  const payload = {
    event: 'recording_stopped',
    trigger,
    stoppedAt: new Date().toISOString(),
    results,
  };

  try {
    await fetch(`${KODI_TRAINING_URL}/api/webhook/recording-stopped`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[webhook] Fired recording_stopped (${trigger})`);
  } catch (err) {
    console.warn(`[webhook] Failed to notify KodiTraining: ${err.message}`);
  }
}
