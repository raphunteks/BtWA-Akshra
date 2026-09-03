/**
 * ============================================================================
 * MESSAGEHANDLER.JS - LOGIC DISPATCHER & GEMINI AI CLINIC ASSISTANT
 * ============================================================================
 * Menangani parsing pesan masuk, simulasi pengetikan natural, session multi-turn
 * in-memory per kontak, preset perintah klinis, dan sinkronisasi log dua arah ke GAS.
 * ============================================================================
 */

const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

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

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [phone, session] of conversationSessions.entries()) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      conversationSessions.delete(phone);
    }
  }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

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
    }).catch(() => {});
  } catch (err) {
    // Abaikan error jaringan logging agar alur percakapan bot tidak terhambat
  }
}

async function askGeminiClinic(apiKey, model, conversationHistory) {
  const selectedModel = model || 'gemini-3.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(selectedModel) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const systemInstructionText = 
    'Anda adalah Asisten Medis Virtual Resmi Klinik Pintar NovaCare. ' +
    'Karakter Anda: Sangat santun, empatik, berbasis data medis modern, dan responsif. ' +
    'Pedoman Konsultasi Pasien:\n' +
    '1. Berikan edukasi kesehatan awal serta arahan pemeriksaan yang jelas dan menenangkan.\n' +
    '2. Selalu sertakan catatan etis bahwa anjuran ini merupakan panduan triase awal dan BUKAN pengganti diagnosis langsung dari dokter spesialis.\n' +
    '3. Jika pasien mengalami kondisi darurat (nyeri dada hebat, sesak nafas akut, pendarahan), anjurkan segera ke Unit Gawat Darurat (UGD) terdekat.\n' +
    '4. Layanan klinik: Poli Spesialis Jantung Bionik, Bed Pod Rawat Inap Pintar, Saraf, Anak, Laboratorium Digital, dan Farmasi Siaga 24 Jam.';

  const requestBody = {
    contents: conversationHistory,
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    },
    generationConfig: {
      temperature: 0.65,
      maxOutputTokens: 850
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
    throw new Error('Respon teks Gemini kosong');
  }
  return reply.trim();
}

async function handleIncomingMessage(sock, msgUpdate, config) {
  try {
    const message = msgUpdate.messages[0];
    if (!message || !message.message) return;

    // Abaikan pesan dari akun bot sendiri (fromMe) dan broadcast status
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
    console.log('[Pesan Masuk]: Dari:', senderPhone, '| Konten:', text);

    syncLogToGAS(config.gasApiUrl, {
      clientId: config.clientId,
      senderNumber: senderPhone,
      receiverNumber: 'BOT_' + config.clientId,
      messageType: 'INCOMING',
      content: text,
      status: 'DELIVERED'
    });

    await sock.sendPresenceUpdate('composing', remoteJid);

    const lowerText = text.toLowerCase();
    let commandReply = null;

    if (lowerText === '#menu') {
      commandReply = 
        '*LAYANAN KLINIK MEDIS PINTAR NOVACARE*\n' +
        'Silakan ketik perintah cepat di bawah ini:\n\n' +
        '• *#jadwal* : Informasi praktek dokter & poliklinik\n' +
        '• *#layanan* : Fasilitas Rawat Inap Pod & Lab Bionik\n' +
        '• *#lokasi* : Alamat sentra medis & peta digital\n' +
        '• *#bantuan* : Petunjuk pemakaian asisten AI klinik\n\n' +
        '_Atau ketik keluhan kesehatan Anda langsung untuk berkonsultasi interaktif dengan Asisten AI Medis kami._';
    } else if (lowerText === '#jadwal') {
      commandReply = 
        '*JADWAL OPERASIONAL & PRAKTEK DOKTER NOVACARE*\n\n' +
        '🏥 *Poli Umum & Ranap Pod*: Siaga 24 Jam Non-Stop\n' +
        '🩺 *Spesialis Jantung Bionik*: Senin - Sabtu (08.00 - 18.00 WITA)\n' +
        '🧠 *Spesialis Saraf & Telemetri*: Senin - Jumat (09.00 - 16.00 WITA)\n' +
        '💊 *Farmasi Dispenser Digital*: Buka 24 Jam.';
    } else if (lowerText === '#layanan') {
      commandReply = 
        '*FASILITAS MEDIS UNGGULAN NOVACARE*\n\n' +
        '1. Smart Bed Pod (Ruang Rawat Inap Isolasi Digital)\n' +
        '2. Telemetri Klinis Real-Time Terhubung WhatsApp\n' +
        '3. Laboratorium Analisis Darah & Bionik Cepat\n' +
        '4. Konsultasi AI Generatif Pre-Triage 24 Jam\n' +
        '5. Layanan E-Billing & Antar Resep Farmasi';
    } else if (lowerText === '#lokasi') {
      commandReply = 
        '*LOKASI & KONTAK RESMI NOVACARE CLINIC*\n\n' +
        '📍 Alamat: Jl. Cyber Medika Hub No. 88, Makassar, Sulawesi Selatan\n' +
        '🌐 Website Resmi: https://novacare-clinic.med.id\n' +
        '📞 Hotline Darurat: +62 812-3456-7890';
    } else if (lowerText === '#bantuan') {
      commandReply = 
        '*PANDUAN ASISTEN AI MEDIS NOVACARE*\n\n' +
        'Tanyakan gejala sakit, aturan minum vitamin, atau informasi persiapan rawat inap secara bebas.\n\n' +
        '_Catatan: Seluruh data percakapan dilindungi enkripsi standar privasi pasien._';
    }

    if (commandReply) {
      await new Promise((r) => setTimeout(r, 1000));
      await sock.sendMessage(remoteJid, { text: commandReply });
      await sock.sendPresenceUpdate('paused', remoteJid);

      syncLogToGAS(config.gasApiUrl, {
        clientId: config.clientId,
        senderNumber: 'BOT_' + config.clientId,
        receiverNumber: senderPhone,
        messageType: 'OUTGOING',
        content: commandReply,
        status: 'SENT'
      });
      return;
    }

    if (!config.geminiApiKey) {
      const noKeyMsg = 'Mohon maaf, integrasi Google AI Studio belum dikonfigurasi pada instance ini.';
      await sock.sendMessage(remoteJid, { text: noKeyMsg });
      await sock.sendPresenceUpdate('paused', remoteJid);
      return;
    }

    let userSession = conversationSessions.get(senderPhone);
    if (!userSession) {
      userSession = { history: [], lastSeen: Date.now() };
      conversationSessions.set(senderPhone, userSession);
    }
    userSession.lastSeen = Date.now();

    userSession.history.push({
      role: 'user',
      parts: [{ text: text }]
    });

    // Batasi riwayat maksimal 10 giliran pesan terakhir agar hemat memori RAM
    if (userSession.history.length > 10) {
      userSession.history = userSession.history.slice(-10);
    }

    let aiReply = '';
    try {
      aiReply = await askGeminiClinic(config.geminiApiKey, config.geminiModel, userSession.history);
      
      userSession.history.push({
        role: 'model',
        parts: [{ text: aiReply }]
      });
    } catch (aiErr) {
      console.error('[Gemini AI Processing Error]:', aiErr.message);
      aiReply = 'Mohon maaf, asisten AI kami sedang memproses lonjakan antrean. Silakan ketik kembali keluhan Anda.';
    }

    await new Promise((r) => setTimeout(r, 1400));
    await sock.sendMessage(remoteJid, { text: aiReply });
    await sock.sendPresenceUpdate('paused', remoteJid);

    syncLogToGAS(config.gasApiUrl, {
      clientId: config.clientId,
      senderNumber: 'BOT_' + config.clientId,
      receiverNumber: senderPhone,
      messageType: 'OUTGOING',
      content: aiReply,
      status: 'SENT'
    });

  } catch (error) {
    console.error('[Message Handler Fatal Error]:', error);
  }
}

module.exports = {
  handleIncomingMessage,
  sanitizeNumber
};
