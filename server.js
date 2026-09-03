/**
 * ============================================================================
 * SERVER.JS - ENTRY POINT BACKEND WA BOT MULTI-CLIENT (RAILWAY INSTANCE)
 * ============================================================================
 * Mengelola Express Server, Sesi Koneksi Baileys Multi-Device,
 * Rendering Live QR Scanner, Endpoint Dispatcher Pesan, dan Queue Worker.
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { handleIncomingMessage, sanitizeNumber } = require('./messageHandler');

// Konfigurasi Environment & Konfigurasi Default
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || 'CLI-0001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GAS_API_URL = process.env.GAS_API_URL || '';
const SYNC_SECRET_TOKEN = process.env.SYNC_SECRET_TOKEN || 'ZETTBOS_CLINIC_SECRET_2026';
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'auth_info_baileys');

// Inisialisasi Express
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Variabel Status Internal Bot
let sock = null;
let botStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTED'
let currentQrRaw = null;
let currentQrDataUrl = null;
const serverStartTime = Date.now();

// Logger Silent agar Terminal Railway tetap bersih
const logger = pino({ level: 'silent' });

/**
 * Inisialisasi dan Manajemen Koneksi Baileys
 */
async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: ['Zettbos Medical Clinic', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    // Event Credential Update
    sock.ev.on('creds.update', saveCreds);

    // Event Connection Update (QR Code, Connect, Disconnect)
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        botStatus = 'SCAN_QR';
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            scale: 8,
            color: {
              dark: '#0077b6',
              light: '#ffffff'
            }
          });
        } catch (err) {
          console.error('[QR Generation Error]:', err.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        botStatus = 'DISCONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;

        console.log('[Connection Closed]: Alasan code:', statusCode, '| Reconnect:', shouldReconnect);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Logged Out]: Membersihkan kredensial lama...');
          try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          } catch (e) {
            console.error('[Clean Sesi Gagal]:', e.message);
          }
          // Restart koneksi untuk memicu QR baru
          setTimeout(connectToWhatsApp, 3000);
        } else if (shouldReconnect) {
          // Exponential backoff reconnect
          setTimeout(connectToWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        botStatus = 'CONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;
        console.log('[Connection Open]: Bot WA Zettbos Clinic Terhubung Penuh!');
      }
    });

    // Event Pesan Masuk
    sock.ev.on('messages.upsert', async (m) => {
      await handleIncomingMessage(sock, m, {
        clientId: CLIENT_ID,
        geminiApiKey: GEMINI_API_KEY,
        geminiModel: GEMINI_MODEL,
        gasApiUrl: GAS_API_URL,
        syncSecretToken: SYNC_SECRET_TOKEN
      });
    });

  } catch (error) {
    console.error('[Baileys Init Error]:', error);
    setTimeout(connectToWhatsApp, 10000);
  }
}

/**
 * ============================================================================
 * REST API ENDPOINTS
 * ============================================================================
 */

// 1. Health-Check Monitor Endpoint
app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  res.status(200).json({
    status: 'success',
    clientId: CLIENT_ID,
    botStatus: botStatus,
    uptime: uptimeSeconds + 's',
    model: GEMINI_MODEL,
    timestamp: new Date().toISOString()
  });
});

// 2. Live QR Scanner Endpoint (Menyajikan visual QR atau status terkoneksi)
app.get('/qr', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (botStatus === 'CONNECTED') {
    return res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bot Connected - Zettbos Medical</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #f0f7fa; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(16px); padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 180, 216, 0.15); text-align: center; border: 1px solid rgba(255, 255, 255, 0.9); max-width: 360px; width: 90%; }
          .badge { display: inline-flex; align-items: center; gap: 8px; background: #e0f2fe; color: #0077b6; padding: 6px 16px; border-radius: 50px; font-weight: 600; font-size: 13px; margin-bottom: 15px; }
          .dot { width: 10px; height: 10px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; }
          h2 { margin: 0 0 10px; font-size: 20px; color: #0f172a; }
          p { margin: 0; color: #64748b; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge"><span class="dot"></span> Online & Terhubung</div>
          <h2>Bot WhatsApp Aktif</h2>
          <p>Instance <strong>${CLIENT_ID}</strong> telah terhubung dengan server WhatsApp.</p>
        </div>
      </body>
      </html>
    `);
  }

  if (botStatus === 'SCAN_QR' && currentQrDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="20">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Scan QR Code - Zettbos Medical Bot</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #f0f7fa; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(16px); padding: 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 180, 216, 0.15); text-align: center; border: 1px solid rgba(255, 255, 255, 0.9); max-width: 360px; width: 90%; }
          .qr-box { background: #ffffff; padding: 15px; border-radius: 14px; display: inline-block; border: 1px solid #e2e8f0; margin: 15px 0; }
          .qr-box img { width: 220px; height: 220px; display: block; }
          h2 { margin: 0 0 5px; font-size: 19px; color: #0f172a; }
          p { margin: 0; color: #64748b; font-size: 13px; line-height: 1.4; }
          .hint { margin-top: 10px; font-size: 11px; color: #0077b6; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Pindai QR WhatsApp</h2>
          <p>Buka WhatsApp > Perangkat Tertaut > Tautkan Perangkat</p>
          <div class="qr-box">
            <img src="${currentQrDataUrl}" alt="QR Code WhatsApp">
          </div>
          <p class="hint">Halaman otomatis memperbarui QR setiap 20 detik</p>
        </div>
      </body>
      </html>
    `);
  }

  // Jika status sedang DISCONNECTED / Menginisialisasi
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="refresh" content="5">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Menginisialisasi - Zettbos Medical Bot</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; background: #f0f7fa; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(16px); padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 180, 216, 0.15); text-align: center; border: 1px solid rgba(255, 255, 255, 0.9); max-width: 360px; width: 90%; }
        h2 { margin: 0 0 10px; font-size: 18px; color: #0f172a; }
        p { margin: 0; color: #64748b; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Menghubungkan ke WhatsApp...</h2>
        <p>Mohon tunggu sebentar, server sedang memuat sesi koneksi.</p>
      </div>
    </body>
    </html>
  `);
});

// 3. Endpoint Dispatcher Pengiriman Pesan (Dihubungi oleh GAS)
app.post('/api/send-message', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['x-sync-token'];
    const token = authHeader ? authHeader.replace('Bearer ', '').trim() : '';

    if (token !== SYNC_SECRET_TOKEN) {
      return res.status(401).json({ success: false, message: 'Autentikasi token tidak valid' });
    }

    const { target, message } = req.body;
    if (!target || !message) {
      return res.status(400).json({ success: false, message: 'Parameter target dan message wajib diisi' });
    }

    if (botStatus !== 'CONNECTED' || !sock) {
      return res.status(503).json({ success: false, message: 'Bot WhatsApp belum dalam status CONNECTED' });
    }

    const formattedJid = sanitizeNumber(target);
    await sock.sendMessage(formattedJid, { text: String(message) });

    return res.status(200).json({
      success: true,
      message: 'Pesan berhasil dikirim',
      target: formattedJid
    });
  } catch (error) {
    console.error('[Send Message API Error]:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ============================================================================
 * BACKGROUND QUEUE WORKER (ANTREAN BROADCAST AUTO-DISPATCHER)
 * ============================================================================
 */
async function startBroadcastQueueWorker() {
  setInterval(async () => {
    if (botStatus !== 'CONNECTED' || !sock || !GAS_API_URL) return;

    try {
      // Ambil antrean broadcast berstatus PENDING dari Google Apps Script
      const fetchUrl = GAS_API_URL + '?action=getBroadcastQueue&page=1&limit=5&status=PENDING';
      const response = await fetch(fetchUrl);
      const json = await response.json();

      if (json.status === 'success' && Array.isArray(json.data) && json.data.length > 0) {
        for (const item of json.data) {
          const queueId = item.queueId;
          const target = sanitizeNumber(item.targetNumber);
          const content = item.content;

          // Jitter Delay acak 6 - 11 detik agar aman dari deteksi spam/banned
          const delayMs = Math.floor(Math.random() * (11000 - 6000 + 1)) + 6000;
          await new Promise((r) => setTimeout(r, delayMs));

          try {
            await sock.sendMessage(target, { text: content });

            // Beritahu GAS bahwa pesan telah berhasil dikirim
            await fetch(GAS_API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({
                action: 'sendBroadcastNow',
                queueId: queueId
              })
            });
            console.log('[Broadcast Sent]: Sukses kirim antrean ID:', queueId, 'ke:', target);
          } catch (sendErr) {
            console.error('[Broadcast Item Failed]:', queueId, sendErr.message);
          }
        }
      }
    } catch (workerErr) {
      // Silent pass jika request timeout
    }
  }, 60000); // Eksekusi setiap 60 detik
}

// Menjalankan Server & Koneksi Baileys
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(' ZETTBOS MEDICAL CLINIC WA BOT ENGINE IS RUNNING');
  console.log(' Port       :', PORT);
  console.log(' Client ID  :', CLIENT_ID);
  console.log(' AI Model   :', GEMINI_MODEL);
  console.log('====================================================');
  connectToWhatsApp();
  startBroadcastQueueWorker();
});