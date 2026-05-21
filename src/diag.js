import https from 'node:https';
import { config } from './config.js';

// Agente persistente con keep-alive → mide RTT puro (sin handshake TCP/TLS).
const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });

// GET ligero contra api.telegram.org/bot<TOKEN>/getMe. Devuelve duración en ms.
function pingTelegram(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = https.request({
      method: 'GET',
      host: 'api.telegram.org',
      path: `/bot${config.botToken}/getMe`,
      agent,
      timeout: timeoutMs,
    }, (res) => {
      // Drenamos el cuerpo (corto). El tiempo cuenta hasta el último byte.
      res.on('data', () => {});
      res.on('end', () => resolve(performance.now() - t0));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function stats(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const avg = a.reduce((s, v) => s + v, 0) / a.length;
  return {
    n: a.length,
    avg: Math.round(avg),
    min: Math.round(a[0]),
    max: Math.round(a[a.length - 1]),
    p50: Math.round(a[Math.floor(a.length / 2)]),
  };
}

export async function runLatencyProbe({ telegram, ownerId, runs = 10 } = {}) {
  console.log('\n=========== ⏱  LATENCIA → TELEGRAM ===========');

  // 1 warmup (paga el handshake la primera vez con keep-alive).
  try { await pingTelegram(); }
  catch (e) { console.log('❌ Telegram inalcanzable:', e.message); console.log('==============================================\n'); return; }

  const times = [];
  for (let i = 0; i < runs; i++) {
    try {
      const ms = await pingTelegram();
      times.push(ms);
      process.stdout.write(`  ping ${String(i + 1).padStart(2, ' ')}/${runs}: ${Math.round(ms).toString().padStart(4)} ms\n`);
    } catch (e) {
      console.log(`  ping ${i + 1}/${runs}: ERROR ${e.message}`);
    }
  }
  if (!times.length) { console.log('==============================================\n'); return; }

  const s = stats(times);
  console.log('\n📊 Resumen (HTTPS con keep-alive — RTT puro):');
  console.log(`   avg ${s.avg}ms · p50 ${s.p50}ms · min ${s.min}ms · max ${s.max}ms · (${s.n} muestras)`);

  // Bonus: sendMessage real al OWNER (un único shot, mensaje se autoborra).
  if (telegram && ownerId) {
    try {
      const t0 = performance.now();
      const m = await telegram.sendMessage(ownerId, '⏱ latency probe');
      const dt = Math.round(performance.now() - t0);
      telegram.deleteMessage(ownerId, m.message_id).catch(() => {});
      console.log(`   sendMessage real (vía Telegraf): ${dt}ms`);
    } catch (e) {
      console.log(`   sendMessage real: ERROR ${e.message}`);
    }
  }

  console.log('==============================================\n');
}
