/**
 * ============================================================================
 * SERVER.JS - ENTRY POINT BACKEND WA BOT MULTI-CLIENT (RAILWAY INSTANCE)
 * ============================================================================
 * Mengelola Express Server, Real-Time Socket.IO Server untuk Live QR Streaming,
 * Baileys Multi-Device Engine dengan Session Guard Anti-Loop Reconnect,
 * QR Pairing Push Notification Engine ke Webhook GAS & Web Browser,
 * REST API Dispatcher Pesan, dan Background Broadcast Worker.
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
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
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
let isInitializing = false;
let lastQrNotificationTime = 0;
const serverStartTime = Date.now();

// Logger Silent agar log output Railway tetap bersih dari noise data stream Baileys
const logger = pino({ level: 'silent' });

/**
 * Memeriksa apakah kredensial autentikasi WhatsApp yang sah sudah tersimpan di disk.
 * Mengembalikan true hanya jika creds.json ada dan akun telah terdaftar (registered).
 */
function hasExistingSession() {
  try {
    const credsPath = path.join(SESSION_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;
    const rawData = fs.readFileSync(credsPath, 'utf8');
    const parsed = JSON.parse(rawData);
    return Boolean(parsed && (parsed.registered === true || parsed.me));
  } catch (err) {
    return false;
  }
}

/**
 * Membersihkan folder kredensial sesi jika terjadi logout atau reset manual.
 */
function cleanSessionDirectory() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log('[Auth Sesi]: Direktori kredensial lama berhasil dibersihkan.');
    }
  } catch (err) {
    console.error('[Auth Sesi]: Gagal membersihkan direktori sesi:', err.message);
  }
}

/**
 * Mengirimkan Push Notification asinkron ke Google Apps Script (GAS) saat ada event sistem krusial
 * (misal: QR Code baru siap dipindai, bot berhasil terhubung, atau sesi logout).
 */
async function notifyGasSystem(action, payload) {
  if (!GAS_API_URL) return;
  try {
    fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: action,
        clientId: CLIENT_ID,
        timestamp: new Date().toISOString(),
        ...payload
      })
    }).catch(() => {});
  } catch (e) {
    // Abaikan kegagalan jaringan push log agar operasional socket Baileys tidak tertahan
  }
}

io.on('connection', (socket) => {
  const sessionExists = hasExistingSession();

  if (botStatus === 'CONNECTED') {
    socket.emit('ready', {
      clientId: CLIENT_ID,
      status: 'CONNECTED',
      message: 'WhatsApp Bot aktif dan terautentikasi',
      user: sock?.user
    });
  } else if (botStatus === 'SCAN_QR' && currentQrDataUrl) {
    socket.emit('qr', {
      qrDataUrl: currentQrDataUrl,
      qrRaw: currentQrRaw,
      clientId: CLIENT_ID,
      timestamp: Date.now()
    });
  } else {
    socket.emit('status', {
      botStatus: botStatus,
      status: botStatus,
      clientId: CLIENT_ID,
      hasSession: sessionExists
    });
  }

  // Listener ketika web portal meminta refresh atau pembuatan QR baru
  socket.on('request_qr', () => {
    if (botStatus === 'CONNECTED') {
      socket.emit('ready', { clientId: CLIENT_ID, status: 'CONNECTED' });
    } else if (currentQrDataUrl) {
      socket.emit('qr', {
        qrDataUrl: currentQrDataUrl,
        qrRaw: currentQrRaw,
        clientId: CLIENT_ID,
        timestamp: Date.now()
      });
    } else {
      connectToWhatsApp(false, true);
    }
  });

  socket.on('disconnect', () => {
    // Client websocket terputus secara normal
  });
});

/**
 * Inisialisasi engine Baileys dengan proteksi Session Guard Anti-Loop Reconnect
 * dan modul QR Pairing Push Notification.
 */
async function connectToWhatsApp(forceClean = false, isUserTriggered = false) {
  if (isInitializing) {
    console.log('[Baileys Init]: Inisialisasi sedang berjalan, melewati pemanggilan duplikat.');
    return;
  }

  const sessionAlreadyExists = hasExistingSession();

  // GUARD UTAMA: Jika tidak ada sesi tersimpan dan BUKAN dipicu oleh aksi pengguna,
  // jangan lakukan inisialisasi background untuk mencegah perulangan reconnect.
  if (!sessionAlreadyExists && !isUserTriggered && !forceClean) {
    console.log(`[Session Guard]: Client ID [${CLIENT_ID}] belum memiliki sesi terdaftar. Siaga menunggu trigger scan QR.`);
    botStatus = 'DISCONNECTED';
    return;
  }

  isInitializing = true;

  try {
    if (forceClean) {
      cleanSessionDirectory();
    }

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    let version = [2, 3000, 1015901307];
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched && fetched.version) version = fetched.version;
    } catch (vErr) {
      console.log('[Baileys Version]: Menggunakan versi stabil bawaan:', version.join('.'));
    }

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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // 1. QR Code Baru Dihasilkan dari Baileys
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

          console.log('[QR Baileys]: Kode QR asli berhasil dibuat. Mengirimkan Push Notification & Socket Event...');

          // A. Pancarkan data QR ke browser dashboard secara real-time
          io.emit('qr', {
            qrDataUrl: currentQrDataUrl,
            qrRaw: qr,
            clientId: CLIENT_ID,
            timestamp: Date.now()
          });

          // B. Pancarkan Event QR Pairing Push Notification ke seluruh browser dashboard
          io.emit('qr_push_notification', {
            type: 'QR_READY',
            title: 'Kode QR WhatsApp Siap Di-scan!',
            message: `Instance [${CLIENT_ID}] memerlukan pemindaian WhatsApp untuk pairing.`,
            clientId: CLIENT_ID,
            timestamp: Date.now(),
            hasAudioAlert: true
          });

          // C. Laporkan ke Google Apps Script (Throttled per 30 detik agar tidak spam)
          const now = Date.now();
          if (now - lastQrNotificationTime > 30000) {
            lastQrNotificationTime = now;
            notifyGasSystem('syncChatLog', {
              senderNumber: 'SYSTEM_' + CLIENT_ID,
              receiverNumber: 'ADMIN',
              messageType: 'SYSTEM_ALERT',
              content: `[QR PUSH NOTIFICATION] Kode QR WhatsApp baru tersedia untuk instance [${CLIENT_ID}]. Silakan scan di dashboard.`,
              status: 'READY'
            });
          }

        } catch (err) {
          console.error('[QR Generation Error]:', err.message);
        }
      }

      // 2. Event Koneksi Terputus
      if (connection === 'close') {
        isInitializing = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const sessionRegistered = hasExistingSession();

        botStatus = 'DISCONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;

        console.log(`[Connection Closed]: Kode status: ${statusCode} | Sesi terdaftar: ${sessionRegistered}`);

        io.emit('status', {
          botStatus: 'DISCONNECTED',
          status: 'DISCONNECTED',
          clientId: CLIENT_ID,
          hasSession: sessionRegistered
        });

        // KASUS A: Belum pernah ada sesi tersimpan (Client baru / belum scan)
        if (!sessionRegistered) {
          console.log('[Session Guard]: Instance belum terautentikasi. Menghentikan reconnect otomatis.');
          return;
        }

        // KASUS B: Sesi resmi di-logout dari ponsel (HTTP 401)
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Logged Out]: Kredensial telah logout dari perangkat ponsel. Membersihkan sesi...');
          cleanSessionDirectory();
          
          io.emit('qr_push_notification', {
            type: 'SESSION_LOGGED_OUT',
            title: 'Sesi WhatsApp Terputus',
            message: `Instance [${CLIENT_ID}] telah logout dari perangkat. Klik Pindai QR untuk menghubungkan kembali.`,
            clientId: CLIENT_ID,
            timestamp: Date.now()
          });

          notifyGasSystem('syncChatLog', {
            senderNumber: 'SYSTEM_' + CLIENT_ID,
            receiverNumber: 'ADMIN',
            messageType: 'SYSTEM_ALERT',
            content: `[SESSION LOGOUT] Instance [${CLIENT_ID}] terputus dari ponsel. Menunggu pendaftaran ulang.`,
            status: 'DISCONNECTED'
          });
          return;
        }

        // KASUS C: Sesi valid ada, koneksi terputus sementara
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect && sessionRegistered) {
          console.log('[Auto-Reconnect]: Sesi valid terdeteksi. Menghubungkan ulang dalam 5 detik...');
          setTimeout(() => connectToWhatsApp(false, false), 5000);
        }
      }
      // 3. Event Koneksi Berhasil Terbuka (Connected)
      else if (connection === 'open') {
        isInitializing = false;
        botStatus = 'CONNECTED';
        currentQrRaw = null;
        currentQrDataUrl = null;

        console.log('====================================================');
        console.log(' [Connection Open]: WhatsApp Bot NovaCare Clinic ONLINE!');
        console.log(' Client ID  :', CLIENT_ID);
        console.log(' Phone      :', sock?.user?.id || 'Connected');
        console.log('====================================================');

        // Pancarkan Push Notification Sukses Pairing ke browser dashboard
        io.emit('ready', {
          clientId: CLIENT_ID,
          status: 'CONNECTED',
          message: 'Sesi WhatsApp Baileys aktif dan terverifikasi',
          user: sock?.user
        });

        io.emit('qr_push_notification', {
          type: 'PAIRING_SUCCESS',
          title: 'WhatsApp Berhasil Terhubung!',
          message: `Instance [${CLIENT_ID}] aktif melayani konsultasi pasien.`,
          clientId: CLIENT_ID,
          timestamp: Date.now()
        });

        notifyGasSystem('syncChatLog', {
          senderNumber: 'SYSTEM_' + CLIENT_ID,
          receiverNumber: 'ADMIN',
          messageType: 'SYSTEM_ALERT',
          content: `[BOT CONNECTED] Instance [${CLIENT_ID}] sukses terhubung ke WhatsApp nomor: ${sock?.user?.id || 'Aktif'}.`,
          status: 'CONNECTED'
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
    isInitializing = false;
    console.error('[Baileys Init Error]:', error);
    if (hasExistingSession()) {
      setTimeout(() => connectToWhatsApp(false, false), 10000);
    }
  }
}

app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const sessionExists = hasExistingSession();
  res.status(200).json({
    status: 'success',
    clientId: CLIENT_ID,
    botStatus: botStatus,
    hasSession: sessionExists,
    uptime: uptimeSeconds + 's',
    model: GEMINI_MODEL,
    hasActiveQr: Boolean(currentQrDataUrl),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/qr', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // Trigger pembuatan QR jika bot berstatus DISCONNECTED dan belum ada QR
  if (botStatus === 'DISCONNECTED' && !currentQrDataUrl && !isInitializing) {
    connectToWhatsApp(false, true);
  }

  res.status(200).json({
    success: true,
    status: 'success',
    clientId: CLIENT_ID,
    botStatus: botStatus,
    hasSession: hasExistingSession(),
    hasQr: Boolean(currentQrDataUrl),
    qrDataUrl: currentQrDataUrl,
    qrRaw: currentQrRaw,
    timestamp: Date.now()
  });
});

app.all(['/reset', '/api/reset-session'], async (req, res) => {
  console.log('[Manual Reset Triggered]: Membersihkan sesi dan meminta QR baru...');
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) {}
      sock = null;
    }
    cleanSessionDirectory();
    botStatus = 'DISCONNECTED';
    currentQrRaw = null;
    currentQrDataUrl = null;
    isInitializing = false;

    io.emit('status', { botStatus: 'DISCONNECTED', status: 'DISCONNECTED', clientId: CLIENT_ID, hasSession: false });
    setTimeout(() => connectToWhatsApp(true, true), 1500);

    if (req.path.startsWith('/api/')) {
      return res.status(200).json({
        success: true,
        message: 'Sesi berhasil dibersihkan. Memulai ulang Baileys untuk menghasilkan QR baru...'
      });
    }
    return res.redirect('/qr');
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ success: false, error: err.message });
    }
    return res.status(500).send('Gagal mereset sesi: ' + err.message);
  }
});

app.get('/qr', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (botStatus === 'DISCONNECTED' && !currentQrDataUrl && !isInitializing) {
    connectToWhatsApp(false, true);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pindai QR WhatsApp - NovaCare Medical Bot</title>
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
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.95);
          border-radius: 24px;
          padding: 35px 30px;
          max-width: 420px;
          width: 100%;
          text-align: center;
          box-shadow: 0 16px 40px rgba(0, 180, 216, 0.12);
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
        .btn-outline { background: #f8fafc; color: #475569; border: 1px solid #cbd5e1; }
        .btn-outline:hover { background: #f1f5f9; color: #0f172a; }
        .btn-danger { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
        .btn-danger:hover { background: #fecaca; }
        .success-box {
          display: none;
          padding: 24px 20px;
          background: #ecfdf5;
          border-radius: 18px;
          border: 1px solid #a7f3d0;
          color: #065f46;
          margin-bottom: 20px;
        }
        .success-box svg { width: 56px; height: 56px; fill: #10b981; margin-bottom: 10px; }
        .notif-banner {
          display: none;
          background: #e0f2fe;
          border: 1px solid #bae6fd;
          color: #0369a1;
          font-size: 12px;
          padding: 8px 12px;
          border-radius: 10px;
          margin-bottom: 14px;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge" id="statusBadge"><span class="dot" id="statusDot"></span> <span id="statusText">Memuat Status...</span></div>
        <div class="notif-banner" id="notifBanner">🔔 Push Notification Aktif</div>
        
        <h2 id="mainTitle">Pindai Kode QR</h2>
        <p class="desc" id="subTitle">Buka WhatsApp di ponsel &gt; Perangkat Tertaut &gt; Tautkan Perangkat.</p>

        <div class="success-box" id="successBox">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          <h3 style="font-size:18px; margin-bottom:4px;">Bot Telah Terhubung!</h3>
          <p style="font-size:13px; color:#047857;">Instance <strong>${CLIENT_ID}</strong> telah aktif dan siap melayani pasien.</p>
        </div>

        <div class="qr-wrapper" id="qrWrapper">
          <div id="loadingBox">
            <div class="spinner"></div>
            <p style="font-size:13px; color:#64748b;" id="loadingText">Menghubungkan ke Baileys di Railway...</p>
          </div>
          <img id="qrImg" src="${currentQrDataUrl || ''}" style="${currentQrDataUrl ? 'display:block;' : 'display:none;'}" alt="WhatsApp QR Code">
        </div>

        <div class="btn-group">
          <a href="/reset" class="btn btn-danger">🔄 Reset Sesi</a>
          <button class="btn btn-outline" onclick="window.location.reload()">Refresh</button>
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
        const notifBanner = document.getElementById('notifBanner');

        socket.on('qr', function(data) {
          if (data && data.qrDataUrl) {
            loadingBox.style.display = 'none';
            qrImg.src = data.qrDataUrl;
            qrImg.style.display = 'block';
            statusDot.className = 'dot';
            statusText.innerText = 'Siap Di-scan';
            mainTitle.innerText = 'Pindai Kode QR WhatsApp';
            subTitle.innerText = 'Arahkan kamera WhatsApp ponsel Anda ke kode di bawah:';
          }
        });

        socket.on('qr_push_notification', function(notif) {
          if (notif) {
            notifBanner.style.display = 'block';
            notifBanner.innerText = '🔔 ' + notif.title + ' - ' + notif.message;
            setTimeout(() => { notifBanner.style.display = 'none'; }, 6000);
          }
        });

        socket.on('ready', function(data) {
          qrWrapper.style.display = 'none';
          loadingBox.style.display = 'none';
          successBox.style.display = 'block';
          statusDot.className = 'dot connected';
          statusText.innerText = 'Online & Terhubung';
          mainTitle.innerText = 'Bot WhatsApp Aktif';
          subTitle.innerText = 'Koneksi dengan server WhatsApp stabil.';
        });

        socket.on('status', function(data) {
          if (data.botStatus === 'CONNECTED' || data.status === 'CONNECTED') {
            qrWrapper.style.display = 'none';
            successBox.style.display = 'block';
            statusDot.className = 'dot connected';
            statusText.innerText = 'Online & Terhubung';
          } else if (data.botStatus === 'DISCONNECTED') {
            statusDot.className = 'dot disconnected';
            statusText.innerText = data.hasSession ? 'Menghubungkan Ulang...' : 'Standby (Menunggu Scan)';
            loadingText.innerText = 'Menunggu pembuatan kode QR Baileys...';
          }
        });

        // Polling HTTP Fallback ke /api/qr
        setInterval(function() {
          fetch('/api/qr?t=' + Date.now())
            .then(r => r.json())
            .then(res => {
              if (res.botStatus === 'CONNECTED') {
                qrWrapper.style.display = 'none';
                successBox.style.display = 'block';
                statusDot.className = 'dot connected';
                statusText.innerText = 'Online & Terhubung';
              } else if (res.hasQr && res.qrDataUrl && qrImg.src !== res.qrDataUrl) {
                loadingBox.style.display = 'none';
                qrImg.src = res.qrDataUrl;
                qrImg.style.display = 'block';
              }
            }).catch(function(){});
        }, 4000);
      </script>
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

          // Jitter Delay acak 6 - 11 detik untuk proteksi anti-banned WhatsApp
          const delayMs = Math.floor(Math.random() * (11000 - 6000 + 1)) + 6000;
          await new Promise((r) => setTimeout(r, delayMs));

          try {
            await sock.sendMessage(target, { text: content });

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
      // Abaikan request timeout
    }
  }, 60000);
}

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(' NOVACARE CLINIC WA BOT & SOCKET.IO ENGINE RUNNING');
  console.log(' Port       :', PORT);
  console.log(' Client ID  :', CLIENT_ID);
  console.log(' AI Model   :', GEMINI_MODEL);
  console.log(' Push Alert : Active via Webhook & Socket.IO');
  console.log(' Live QR    : http://localhost:' + PORT + '/qr');
  console.log('====================================================');

  const existingSession = hasExistingSession();
  if (existingSession) {
    console.log(`[Session Startup]: Sesi terdaftar ditemukan untuk [${CLIENT_ID}]. Memulihkan koneksi WhatsApp...`);
    connectToWhatsApp(false, false);
  } else {
    console.log(`[Session Startup]: Belum ada sesi terdaftar untuk [${CLIENT_ID}]. Bot siaga menunggu pemindaian QR.`);
    botStatus = 'DISCONNECTED';
  }

  startBroadcastQueueWorker();
});
