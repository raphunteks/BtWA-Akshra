/**
 * ============================================================================
 * 1. SERVER.JS - ENTRY POINT BACKEND WA BOT MULTI-CLIENT (RAILWAY INSTANCE)
 * ============================================================================
 * Mengelola Express Server, HTTP & Socket.IO Real-Time Server, Koneksi Baileys
 * Multi-Device yang Tangguh, Endpoint Live QR Scanner SPA, & Queue Worker.
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
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
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const { handleIncomingMessage, sanitizeNumber } = require('./messageHandler');

// Konfigurasi Environment
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || 'CLI-0001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GAS_API_URL = process.env.GAS_API_URL || '';
const SYNC_SECRET_TOKEN = process.env.SYNC_SECRET_TOKEN || 'ZETTBOS_CLINIC_SECRET_2026';
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'auth_info_baileys');

// Inisialisasi Express & HTTP Server untuk Socket.IO
const app = express();
const server = http.createServer(app);

// Inisialisasi Socket.IO Server
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Variabel State Internal Bot
let sock = null;
let botStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTED'
let currentQrRaw = null;
let currentQrDataUrl = null;
let isConnecting = false;
const serverStartTime = Date.now();

// Logger Silent agar Terminal Railway bersih dari log binary Baileys
const logger = pino({ level: 'silent' });

/**
 * Membersihkan Folder Kredensial Sesi Baileys
 */
function cleanSessionDirectory() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log('[Auth Sesi]: Direktori sesi lama berhasil dibersihkan.');
    }
  } catch (err) {
    console.error('[Auth Sesi]: Gagal membersihkan folder sesi:', err.message);
  }
}

/**
 * Inisialisasi dan Manajemen Koneksi Baileys yang Tangguh
 */
async function connectToWhatsApp(forceReset = false) {
  if (isConnecting) {
    console.log('[Baileys Init]: Proses inisialisasi sedang berlangsung, melewati antrean...');
    return;
  }
  isConnecting = true;

  try {
    if (forceReset) {
      cleanSessionDirectory();
    }

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    // Ambil versi Baileys terbaru dengan fallback aman
    let version = [2, 3000, 1015901307];
    try {
      const fetchedVersion = await fetchLatestBaileysVersion();
      if (fetchedVersion && fetchedVersion.version) {
        version = fetchedVersion.version;
      }
    } catch (vErr) {
      console.log('[Baileys Version]: Menggunakan fallback versi default:', version.join('.'));
    }

    // Inisialisasi Socket Baileys dengan Browser Signature yang Diakui WA Web
    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 15000,
      emitOwnEvents: true,
      fireInitQueries: true,
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    // Simpan Pembaharuan Kredensial
    sock.ev.on('creds.update', saveCreds);

    // Pemantau Koneksi & QR Code Event
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // 1. QR Code Baru Terdeteksi
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

          console.log('[QR Code Event]: QR Code baru berhasil di-generate. Memancarkan ke socket client...');
          
          // Pancarkan QR ke seluruh website/client yang terhubung
          io.emit('qr', {
            qrDataUrl: currentQrDataUrl,
            qrRaw: currentQrRaw,
            clientId: CLIENT_ID,
            timestamp: Date.now()
          });
        } catch (qrErr) {
          console.error('[QR Generation Error]:', qrErr.message);
        }
      }

      // 2. Koneksi Terputus
      if (connection === 'close') {
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        botStatus = 'DISCONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;

        console.log('[Connection Closed]: Kode status:', statusCode, '| Auto-Reconnect:', shouldReconnect);
        io.emit('status', { botStatus: 'DISCONNECTED', clientId: CLIENT_ID });

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Logged Out]: Sesi kadaluarsa. Mereset sesi untuk memicu QR baru...');
          cleanSessionDirectory();
          setTimeout(() => connectToWhatsApp(true), 3000);
        } else if (shouldReconnect) {
          // Reconnect otomatis dengan interval 5 detik
          setTimeout(() => connectToWhatsApp(false), 5000);
        }
      } 
      // 3. Koneksi Berhasil Terbuka (Connected)
      else if (connection === 'open') {
        isConnecting = false;
        botStatus = 'CONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;

        console.log('====================================================');
        console.log(' [Connection Open]: WhatsApp Zettbos Clinic ONLINE!');
        console.log(' Client ID  :', CLIENT_ID);
        console.log(' Phone      :', sock?.user?.id || 'Connected');
        console.log('====================================================');

        // Pancarkan event ready ke modal index.html & halaman /qr
        io.emit('ready', {
          clientId: CLIENT_ID,
          status: 'CONNECTED',
          user: sock?.user
        });
      }
    });

    // Penanganan Pesan Masuk
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
    isConnecting = false;
    console.error('[Baileys Fatal Error]:', error);
    setTimeout(() => connectToWhatsApp(false), 10000);
  }
}

/**
 * ============================================================================
 * SOCKET.IO CLIENT CONNECTION HANDLER
 * ============================================================================
 */
io.on('connection', (socket) => {
  console.log('[Socket.IO]: Klien baru tersambung. ID:', socket.id);

  // Langsung kirimkan status terkini ke klien
  if (botStatus === 'CONNECTED') {
    socket.emit('ready', { clientId: CLIENT_ID, status: 'CONNECTED' });
  } else if (botStatus === 'SCAN_QR' && currentQrDataUrl) {
    socket.emit('qr', {
      qrDataUrl: currentQrDataUrl,
      qrRaw: currentQrRaw,
      clientId: CLIENT_ID
    });
  } else {
    socket.emit('status', {
      botStatus: botStatus,
      clientId: CLIENT_ID
    });
  }

  // Listener jika klien meminta generate ulang QR
  socket.on('request_qr', () => {
    if (botStatus === 'SCAN_QR' && currentQrDataUrl) {
      socket.emit('qr', { qrDataUrl: currentQrDataUrl, qrRaw: currentQrRaw, clientId: CLIENT_ID });
    } else {
      socket.emit('status', { botStatus: botStatus, clientId: CLIENT_ID });
    }
  });

  socket.on('disconnect', () => {
    // Selesai koneksi socket
  });
});

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
    hasActiveQr: Boolean(currentQrDataUrl),
    timestamp: new Date().toISOString()
  });
});

// 2. Endpoint Reset Sesi WhatsApp (Anti-Stuck Session)
app.all('/reset', async (req, res) => {
  console.log('[Manual Reset Triggered]: Mereset sesi Baileys...');
  try {
    if (sock) {
      try { sock.end(new Error('Reset by user')); } catch (e) {}
    }
    cleanSessionDirectory();
    setTimeout(() => connectToWhatsApp(true), 2000);
    return res.redirect('/qr');
  } catch (err) {
    return res.status(500).send('Gagal mereset sesi: ' + err.message);
  }
});

// 3. Live QR Scanner Web Page (Single Page Application dengan Socket.IO Terintegrasi)
app.get('/qr', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Live QR Code - Zettbos Medical Bot</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
      <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body {
          background: linear-gradient(135deg, #f0f7fa 0%, #e0f2fe 50%, #ffffff 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          color: #0f172a;
        }
        .card {
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.9);
          border-radius: 24px;
          padding: 35px 30px;
          max-width: 420px;
          width: 100%;
          text-align: center;
          box-shadow: 0 16px 40px rgba(0, 180, 216, 0.12);
          transition: all 0.3s ease;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: #e0f2fe;
          color: #0077b6;
          padding: 6px 16px;
          border-radius: 50px;
          font-weight: 600;
          font-size: 13px;
          margin-bottom: 18px;
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #00b4d8;
          box-shadow: 0 0 10px #00b4d8;
          animation: pulse 1.8s infinite;
        }
        .dot.connected { background: #10b981; box-shadow: 0 0 10px #10b981; }
        .dot.disconnected { background: #ef4444; box-shadow: 0 0 10px #ef4444; }
        @keyframes pulse {
          0% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(0.95); opacity: 0.8; }
        }
        h2 { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
        p.desc { font-size: 14px; color: #64748b; line-height: 1.5; margin-bottom: 20px; }
        .qr-wrapper {
          background: #ffffff;
          padding: 16px;
          border-radius: 20px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #e2e8f0;
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
          margin-bottom: 20px;
          min-width: 250px;
          min-height: 250px;
          position: relative;
        }
        .qr-wrapper img {
          width: 220px;
          height: 220px;
          display: block;
          border-radius: 8px;
        }
        .spinner {
          width: 42px;
          height: 42px;
          border: 4px solid #e0f2fe;
          border-top: 4px solid #00b4d8;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin: 0 auto 12px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .btn-group {
          display: flex;
          gap: 10px;
          justify-content: center;
          margin-top: 10px;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 10px 18px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          text-decoration: none;
          transition: all 0.2s;
          border: none;
        }
        .btn-primary { background: linear-gradient(135deg, #00b4d8, #0077b6); color: #ffffff; }
        .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn-outline { background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; }
        .btn-outline:hover { background: #f1f5f9; color: #0f172a; }
        .btn-danger { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
        .btn-danger:hover { background: #fecaca; }
        .success-box {
          display: none;
          padding: 20px;
          background: #ecfdf5;
          border-radius: 16px;
          border: 1px solid #a7f3d0;
          color: #065f46;
          margin-bottom: 20px;
        }
        .success-box svg { width: 54px; height: 54px; fill: #10b981; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge" id="statusBadge"><span class="dot" id="statusDot"></span> <span id="statusText">Memuat Status...</span></div>
        
        <h2 id="mainTitle">Pindai Kode QR</h2>
        <p class="desc" id="subTitle">Buka WhatsApp di ponsel &gt; Perangkat Tertaut &gt; Tautkan Perangkat.</p>

        <!-- Kotak Berhasil Terkoneksi -->
        <div class="success-box" id="successBox">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          <h3 style="font-size:18px; margin-bottom:4px;">Bot Telah Terhubung!</h3>
          <p style="font-size:13px; color:#047857;">Instance ${CLIENT_ID} telah aktif dan siap melayani pasien.</p>
        </div>

        <!-- Container QR Code -->
        <div class="qr-wrapper" id="qrWrapper">
          <div id="loadingBox">
            <div class="spinner"></div>
            <p style="font-size:13px; color:#64748b;" id="loadingText">Menghubungkan ke WhatsApp...</p>
          </div>
          <img id="qrImg" src="" alt="WhatsApp QR Code" style="display:none;">
        </div>

        <!-- Tombol Aksi Cepat -->
        <div class="btn-group">
          <a href="/reset" class="btn btn-danger" onclick="return confirm('Apakah Anda yakin ingin mereset sesi WhatsApp dan membuat QR baru?')">🔄 Reset Sesi</a>
          <button class="btn btn-outline" onclick="window.location.reload()">Refresh Halaman</button>
        </div>
      </div>

      <script>
        const socket = io();
        const statusBadge = document.getElementById('statusBadge');
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const mainTitle = document.getElementById('mainTitle');
        const subTitle = document.getElementById('subTitle');
        const loadingBox = document.getElementById('loadingBox');
        const loadingText = document.getElementById('loadingText');
        const qrImg = document.getElementById('qrImg');
        const qrWrapper = document.getElementById('qrWrapper');
        const successBox = document.getElementById('successBox');

        // 1. Terima QR Real-time dari Socket.IO
        socket.on('qr', function(data) {
          if (data && data.qrDataUrl) {
            loadingBox.style.display = 'none';
            qrImg.src = data.qrDataUrl;
            qrImg.style.display = 'block';
            statusDot.className = 'dot';
            statusText.innerText = 'Siap Di-scan';
            mainTitle.innerText = 'Pindai Kode QR WhatsApp';
            subTitle.innerText = 'Arahkan kamera pemindai WhatsApp ke kode di bawah:';
          }
        });

        // 2. Terima Event Berhasil Terkoneksi
        socket.on('ready', function(data) {
          qrWrapper.style.display = 'none';
          loadingBox.style.display = 'none';
          successBox.style.display = 'block';
          statusDot.className = 'dot connected';
          statusText.innerText = 'Online & Terhubung';
          mainTitle.innerText = 'Bot WhatsApp Aktif';
          subTitle.innerText = 'Koneksi dengan server WhatsApp stabil.';
        });

        // 3. Terima Event Status Umum
        socket.on('status', function(data) {
          if (data.botStatus === 'CONNECTED') {
            qrWrapper.style.display = 'none';
            successBox.style.display = 'block';
            statusDot.className = 'dot connected';
            statusText.innerText = 'Online & Terhubung';
          } else if (data.botStatus === 'DISCONNECTED') {
            statusDot.className = 'dot disconnected';
            statusText.innerText = 'Menghubungkan Ulang...';
            loadingText.innerText = 'Menunggu server membuat kode QR baru...';
          }
        });

        // Fallback polling ke server setiap 6 detik jika websocket lambat
        setInterval(function() {
          fetch('/?t=' + Date.now())
            .then(r => r.json())
            .then(res => {
              if (res.botStatus === 'CONNECTED') {
                qrWrapper.style.display = 'none';
                successBox.style.display = 'block';
                statusDot.className = 'dot connected';
                statusText.innerText = 'Online & Terhubung';
              }
            }).catch(function(){});
        }, 6000);
      </script>
    </body>
    </html>
  `);
});

// 4. Endpoint Dispatcher Pengiriman Pesan (Dihubungi oleh GAS)
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
      const fetchUrl = GAS_API_URL + '?action=getBroadcastQueue&page=1&limit=5&status=PENDING';
      const response = await fetch(fetchUrl);
      const json = await response.json();

      if (json.status === 'success' && Array.isArray(json.data) && json.data.length > 0) {
        for (const item of json.data) {
          const queueId = item.queueId;
          const target = sanitizeNumber(item.targetNumber);
          const content = item.content;

          // Jitter Delay acak 6 - 11 detik agar anti-ban
          const delayMs = Math.floor(Math.random() * (11000 - 6000 + 1)) + 6000;
          await new Promise((r) => setTimeout(r, delayMs));

          try {
            await sock.sendMessage(target, { text: content });

            // Beritahu GAS bahwa antrean terkirim
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
      // Abaikan jika network timeout
    }
  }, 60000); // Interval 60 detik
}

// Menjalankan HTTP & Socket Server
server.listen(PORT, () => {
  console.log('====================================================');
  console.log(' ZETTBOS MEDICAL CLINIC WA BOT ENGINE IS RUNNING');
  console.log(' Port       :', PORT);
  console.log(' Client ID  :', CLIENT_ID);
  console.log(' AI Model   :', GEMINI_MODEL);
  console.log(' Live QR    : http://localhost:' + PORT + '/qr');
  console.log('====================================================');
  connectToWhatsApp(false);
  startBroadcastQueueWorker();
});
