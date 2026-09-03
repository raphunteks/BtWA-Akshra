/**
 * ============================================================================
 * MESSAGEHANDLER.JS - LOGIC DISPATCHER & GEMINI AI CLINIC ASSISTANT
 * ============================================================================
 * Menangani parsing pesan masuk, simulasi typing natural, session multi-turn
 * in-memory, command cepat klinik, dan sinkronisasi log 2-arah ke GAS.
 * ============================================================================
 */

// In-Memory Conversation History Cache (Multi-Turn Chat)
// Struktur per nomor: { history: [ { role: 'user'|'model', parts: [{ text }] } ], lastSeen: timestamp }
const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // Kadaluarsa sesi 30 menit

/**
 * Sanitasi nomor HP ke format WhatsApp Internasional (628xxx@s.whatsapp.net)
 */
function sanitizeNumber(rawNumber) {
  let cleaned = String(rawNumber).replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '62' + cleaned;
  }
  if (!cleaned.endsWith('@s.whatsapp.net')) {
    cleaned = cleaned + '@s.whatsapp.net';
  }
  return cleaned;
}

/**
 * Pembersihan sesi chat yang sudah tidak aktif (Garbage Collector Memory)
 */
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [phone, session] of conversationSessions.entries()) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      conversationSessions.delete(phone);
    }
  }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

/**
 * Kirimkan Log Chat ke Google Apps Script secara Asinkron (Non-blocking)
 */
async function syncLogToGAS(gasApiUrl, payload) {
  if (!gasApiUrl) return;
  try {
    fetch(gasApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'syncChatLog',
        ...payload
      })
    }).catch(() => {}); // Hindari unhandled promise rejection
  } catch (err) {
    // Abaikan error logging di terminal
  }
}

/**
 * Integrasi Multi-Turn Google AI Studio REST API
 */
async function askGeminiClinic(apiKey, model, conversationHistory) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const systemInstructionText = 
    'Anda adalah Asisten Medis Virtual Resmi Klinik Pintar Zettbos. ' +
    'Karakter Anda: Sangat sopan, empatik, berbasis fakta klinis modern, dan responsif. ' +
    'Pedoman Menjawab:\n' +
    '1. Berikan edukasi kesehatan awal dan panduan konsultasi secara ringkas dan bersahabat.\n' +
    '2. Selalu sertakan disclaimer etis bahwa saran ini merupakan triase awal dan BUKAN pengganti diagnosis medis resmi oleh dokter spesialis.\n' +
    '3. Jika pasien dalam kondisi gawat darurat, anjurkan untuk segera menuju Unit Gawat Darurat (UGD) terdekat.\n' +
    '4. Informasi poli klinik: Poli Umum, Poli Gigi, Poli Anak, Poli Spesialis Penyakit Dalam, Rawat Inap (Ranap), Laboratorium, dan Farmasi 24 Jam.';

  const requestBody = {
    contents: conversationHistory,
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    },
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 800
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Gemini API Error ' + res.status + ': ' + errText);
  }

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) {
    throw new Error('Respon Gemini kosong');
  }
  return reply.trim();
}

/**
 * Main Message Dispatcher
 */
async function handleIncomingMessage(sock, msgUpdate, config) {
  try {
    const message = msgUpdate.messages[0];
    if (!message || !message.message) return;

    // Abaikan pesan dari diri sendiri (fromMe) dan broadcast WhatsApp
    if (message.key.fromMe) return;
    const remoteJid = message.key.remoteJid;
    if (!remoteJid || remoteJid.includes('@broadcast')) return;

    // Ekstraksi Teks Pesan Masuk
    const messageContent = 
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      message.message.imageMessage?.caption ||
      '';

    const text = messageContent.trim();
    if (!text) return;

    const senderPhone = remoteJid.replace('@s.whatsapp.net', '');
    console.log('[Pesan Masuk]: Dari:', senderPhone, '| Isi:', text);

    // 1. Simpan Chat Masuk ke Log Spreadsheet Google Apps Script
    syncLogToGAS(config.gasApiUrl, {
      clientId: config.clientId,
      senderNumber: senderPhone,
      receiverNumber: 'BOT_' + config.clientId,
      messageType: 'INCOMING',
      content: text,
      status: 'RECEIVED'
    });

    // 2. Simulasi Indikator Mengetik (Typing Indicator)
    await sock.sendPresenceUpdate('composing', remoteJid);

    // 3. Command Cepat Medis Klinis
    const lowerText = text.toLowerCase();
    let commandReply = null;

    if (lowerText === '#menu') {
      commandReply = 
        '*LAYANAN KLINIK MEDIS ZETTBOS*\n' +
        'Silakan ketik perintah cepat di bawah ini:\n\n' +
        '• *#jadwal* : Informasi jam operasional & dokter\n' +
        '• *#layanan* : Daftar poliklinik & fasilitas rawat inap\n' +
        '• *#lokasi* : Alamat & peta klinik\n' +
        '• *#bantuan* : Panduan pemakaian bot\n\n' +
        '_Atau ketik keluhan kesehatan Anda langsung untuk berkonsultasi dengan Asisten AI Medis kami._';
    } else if (lowerText === '#jadwal') {
      commandReply = 
        '*JADWAL OPERASIONAL & PRAKTEK DOKTER*\n\n' +
        '🏥 *Poli Umum*: Setiap Hari (24 Jam)\n' +
        '🩺 *Poli Gigi*: Senin - Sabtu (09.00 - 17.00 WITA)\n' +
        '👶 *Poli Anak*: Senin - Jumat (10.00 - 15.00 WITA)\n' +
        '💊 *Farmasi & Laboratorium*: Siaga 24 Jam Non-stop.';
    } else if (lowerText === '#layanan') {
      commandReply = 
        '*FASILITAS & LAYANAN MEDIS KLINIK*\n\n' +
        '1. Rawat Inap Modern (Ranap Suite & Deluxe)\n' +
        '2. Poliklinik Rawat Jalan & Spesialis\n' +
        '3. Layanan Hemodialisa Terpadu\n' +
        '4. Medical Check Up (MCU) Digital\n' +
        '5. Layanan Antar Obat Farmasi Cepat';
    } else if (lowerText === '#lokasi') {
      commandReply = 
        '*LOKASI & KONTAK RESMI KLINIK*\n\n' +
        '📍 Alamat: Jl. Boulevard Cyber Medical No. 88, Makassar\n' +
        '🌐 Portal Reservasi: Kunjungi web klinik kami\n' +
        '📞 Telepon Darurat: (0411) 889-2122';
    } else if (lowerText === '#bantuan') {
      commandReply = 
        '*PANDUAN PENGGUNAAN BOT*\n\n' +
        'Anda dapat berkonsultasi kesehatan langsung secara interaktif. Tanyakan gejala, dosis vitamin umum, atau persiapan rawat inap.\n\n' +
        '_Peringatan: Seluruh data percakapan dilindungi etika kerahasiaan medis internal._';
    }

    // Jika pesan sesuai dengan Command Preset
    if (commandReply) {
      await new Promise((r) => setTimeout(r, 1200)); // Delay natural
      await sock.sendMessage(remoteJid, { text: commandReply });
      await sock.sendPresenceUpdate('paused', remoteJid);

      syncLogToGAS(config.gasApiUrl, {
        clientId: config.clientId,
        senderNumber: 'BOT_' + config.clientId,
        receiverNumber: senderPhone,
        messageType: 'OUTGOING',
        content: commandReply,
        status: 'DELIVERED'
      });
      return;
    }

    // 4. Jika bukan Command, Alihkan ke Google Gemini AI Assistant (Multi-Turn)
    if (!config.geminiApiKey) {
      const noKeyMsg = 'Mohon maaf, layanan konsultasi AI sedang dalam perbaikan konfigurasi.';
      await sock.sendMessage(remoteJid, { text: noKeyMsg });
      await sock.sendPresenceUpdate('paused', remoteJid);
      return;
    }

    // Ambil atau inisialisasi riwayat percakapan user
    let userSession = conversationSessions.get(senderPhone);
    if (!userSession) {
      userSession = { history: [], lastSeen: Date.now() };
      conversationSessions.set(senderPhone, userSession);
    }
    userSession.lastSeen = Date.now();

    // Masukkan pesan user ke history
    userSession.history.push({
      role: 'user',
      parts: [{ text: text }]
    });

    // Batasi history maksimal 10 pertukaran pesan terakhir agar hemat memori & token
    if (userSession.history.length > 10) {
      userSession.history = userSession.history.slice(-10);
    }

    let aiReply = '';
    try {
      aiReply = await askGeminiClinic(config.geminiApiKey, config.geminiModel, userSession.history);
      
      // Simpan jawaban AI ke riwayat percakapan
      userSession.history.push({
        role: 'model',
        parts: [{ text: aiReply }]
      });
    } catch (aiErr) {
      console.error('[Gemini AI Processing Error]:', aiErr.message);
      aiReply = 'Mohon maaf, sistem AI kami sedang mengalami kepadatan antrean. Silakan ulangi pertanyaan Anda beberapa saat lagi.';
    }

    // Kirim Balasan AI ke Pasien via WhatsApp
    await new Promise((r) => setTimeout(r, 1500));
    await sock.sendMessage(remoteJid, { text: aiReply });
    await sock.sendPresenceUpdate('paused', remoteJid);

    // Simpan Respon AI ke Log Spreadsheet Google Apps Script
    syncLogToGAS(config.gasApiUrl, {
      clientId: config.clientId,
      senderNumber: 'BOT_' + config.clientId,
      receiverNumber: senderPhone,
      messageType: 'OUTGOING',
      content: aiReply,
      status: 'DELIVERED'
    });

  } catch (error) {
    console.error('[Message Handler Fatal Error]:', error);
  }
}

module.exports = {
  handleIncomingMessage,
  sanitizeNumber
};