/**
 * ============================================================================
 * SERVER.JS - ENTRY POINT BACKEND WA BOT MULTI-CLIENT (RAILWAY INSTANCE)
 * ============================================================================
 * Mengelola Express Server, Real-Time Socket.IO Server untuk Live QR Streaming,
 * Sesi Koneksi Baileys Multi-Device, Endpoint Dispatcher Pesan, dan Queue Worker.
 * ============================================================================
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { handleIncomingMessage, sanitizeNumber } = require('./messageHandler');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || 'CLI-0001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GAS_API_URL = process.env.GAS_API_URL || '';
const SYNC_SECRET_TOKEN = process.env.SYNC_SECRET_TOKEN || 'ZETTBOS_CLINIC_SECRET_2026';
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'auth_info_baileys');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

let sock = null;
let botStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTED'
let currentQrRaw = null;
let currentQrDataUrl = null;
const serverStartTime = Date.now();

// Logger Silent agar output log di terminal Railway tetap rapi dan terukur
const logger = pino({ level: 'silent' });

io.on('connection', (socket) => {
  // Kirim status saat ini ke client frontend (index.html) yang baru terhubung
  if (botStatus === 'CONNECTED') {
    socket.emit('ready', {
      clientId: CLIENT_ID,
      status: 'CONNECTED',
      message: 'WhatsApp Bot sudah aktif dan terautentikasi'
    });
  } else if (botStatus === 'SCAN_QR' && currentQrDataUrl) {
    socket.emit('qr', {
      qrDataUrl: currentQrDataUrl,
      qrRaw: currentQrRaw,
      clientId: CLIENT_ID
    });
  } else {
    socket.emit('status', {
      status: botStatus,
      clientId: CLIENT_ID
    });
  }

  socket.on('disconnect', () => {
    // Sesi socket client ditutup dengan aman
  });
});

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

    sock.ev.on('creds.update', saveCreds);

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

          // Pancarkan event 'qr' secara instan ke browser frontend via Socket.IO
          io.emit('qr', {
            qrDataUrl: currentQrDataUrl,
            qrRaw: qr,
            clientId: CLIENT_ID
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

        console.log('[Connection Closed]: Kode status:', statusCode, '| Reconnect:', shouldReconnect);
        io.emit('status', { status: 'DISCONNECTED', clientId: CLIENT_ID });

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Logged Out]: Membersihkan kredensial sesi lama...');
          try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          } catch (e) {
            console.error('[Clean Sesi Gagal]:', e.message);
          }
          setTimeout(connectToWhatsApp, 3000);
        } else if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        botStatus = 'CONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;

        console.log('[Connection Open]: Bot WA Zettbos Clinic Terhubung Penuh!');

        // Pancarkan event 'ready' ke seluruh client frontend (index.html)
        io.emit('ready', {
          clientId: CLIENT_ID,
          status: 'CONNECTED',
          message: 'Sesi WhatsApp Baileys aktif dan terverifikasi'
        });
      }
    });

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

app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  res.status(200).json({
    status: 'success',
    clientId: CLIENT_ID,
    botStatus: botStatus,
    uptime: uptimeSeconds + 's',
    model: GEMINI_MODEL,
    hasSocketIo: true,
    timestamp: new Date().toISOString()
  });
});

app.get('/qr', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (botStatus === 'CONNECTED') {
    return res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bot Connected - NovaCare Clinic</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #f0f7fa; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(255, 255, 255, 0.88); backdrop-filter: blur(16px); padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 180, 216, 0.15); text-align: center; border: 1px solid rgba(255, 255, 255, 0.9); max-width: 360px; width: 90%; }
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
        <title>Scan QR Code - NovaCare Medical Bot</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #f0f7fa; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(255, 255, 255, 0.88); backdrop-filter: blur(16px); padding: 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 180, 216, 0.15); text-align: center; border: 1px solid rgba(255, 255, 255, 0.9); max-width: 360px; width: 90%; }
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

  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="refresh" content="5">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Menginisialisasi - NovaCare Medical Bot</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; background: #f0f7fa; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: rgba(255, 255, 255, 0.88); backdrop-filter: blur(16px); padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0, 180, 216, 0.15); text-align: center; border: 1px solid rgba(255, 255, 255, 0.9); max-width: 360px; width: 90%; }
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

async function startBroadcastQueueWorker() {
  setInterval(async () => {
    if (botStatus !== 'CONNECTED' || !sock || !GAS_API_URL) return;

    try {
      const fetchUrl = GAS_API_URL + '?action=getBroadcastQueue&page=1&limit=5&status=PENDING';
      const response = await fetch(fetchUrl);
      const json = await response.json();

      if (json.status === 'success' && Array.isArray(json.data) && json.data.length > 0) {
        for (const item of json.data) {
          const queueId = item.queueId;
          const target = sanitizeNumber(item.targetNumber);
          const content = item.content;

          // Jitter Delay acak 6 - 11 detik per pesan untuk pencegahan banned WhatsApp
          const delayMs = Math.floor(Math.random() * (11000 - 6000 + 1)) + 6000;
          await new Promise((r) => setTimeout(r, delayMs));

          try {
            await sock.sendMessage(target, { text: content });

            // Beritahu Google Apps Script bahwa pesan berhasil terkirim
            await fetch(GAS_API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({
                action: 'sendBroadcastNow',
                queueId: queueId
              })
            });
            console.log('[Broadcast Sent]: Sukses mengirim antrean ID:', queueId, 'ke:', target);
          } catch (sendErr) {
            console.error('[Broadcast Item Failed]:', queueId, sendErr.message);
          }
        }
      }
    } catch (workerErr) {
      // Silent catch jika request jaringan mengalami interupsi sementara
    }
  }, 60000);
}

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(' NOVACARE CLINIC WA BOT & SOCKET.IO ENGINE RUNNING');
  console.log(' Port       :', PORT);
  console.log(' Client ID  :', CLIENT_ID);
  console.log(' AI Model   :', GEMINI_MODEL);
  console.log(' WebSocket  : Enabled (Socket.IO v4)');
  console.log('====================================================');
  connectToWhatsApp();
  startBroadcastQueueWorker();
});
