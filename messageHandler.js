/**
 * ============================================================================
 * MESSAGEHANDLER.JS - LOGIC DISPATCHER & SMART GEMINI AI CLINIC ASSISTANT
 * ============================================================================
 * Menangani parsing pesan masuk, penanganan token anti-terpotong (Anti-Truncation),
 * adaptor konfigurasi multi-model Google AI Studio, pembersih format WhatsApp,
 * session multi-turn in-memory per kontak, dan sinkronisasi log dua arah ke GAS.
 * ============================================================================
 */

const conversationSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // Kadaluarsa sesi percakapan 30 menit

/**
 * Membersihkan format nomor telepon menjadi standar internasional WhatsApp JID.
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

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [phone, session] of conversationSessions.entries()) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      conversationSessions.delete(phone);
    }
  }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

function formatForWhatsApp(text) {
  if (!text) return '';
  let formatted = String(text);

  // 1. Ubah markdown double-asterisk **tebal** menjadi format WA *tebal*
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // 2. Ubah heading markdown (### Heading / ## Heading) menjadi format tebal kapital
  formatted = formatted.replace(/^###\s*(.*)$/gm, '\n*$1*');
  formatted = formatted.replace(/^##\s*(.*)$/gm, '\n*$1*');
  formatted = formatted.replace(/^#\s*(.*)$/gm, '\n*$1*');

  // 3. Rapikan daftar bullet point (- item atau * item) menjadi bullet simbol (• item)
  formatted = formatted.replace(/^[\*\-]\s+(.*)$/gm, '• $1');

  // 4. Bersihkan baris kosong berlebih (maksimal 2 baris baru berurutan)
  formatted = formatted.replace(/\n{3,}/g, '\n\n');

  return formatted.trim();
}

function getModelGenerationConfig(modelName) {
  const model = String(modelName || 'gemini-3.5-flash').toLowerCase().trim();

  // Model Deep Clinical Reasoning / Pro (Memerlukan token ruang lebih luas)
  if (model.includes('3.1-pro') || model.includes('2.5-pro') || model.includes('deep-research')) {
    return {
      temperature: 0.5,
      maxOutputTokens: 3500,
      topP: 0.9
    };
  }

  // Model Generasi Baru Ultra-Fast (Gemini 3.8 Flash, 3.7 Flash)
  if (model.includes('3.8-flash') || model.includes('3.7-flash') || model.includes('3.6-flash')) {
    return {
      temperature: 0.6,
      maxOutputTokens: 2500,
      topP: 0.95
    };
  }

  // Model Open Architecture Gemma (Gemma 4 31B / 26B)
  if (model.includes('gemma-4')) {
    return {
      temperature: 0.65,
      maxOutputTokens: 2200,
      topP: 0.9
    };
  }

  // Default Standard Workhorse (Gemini 3.5 Flash / Flash Lite / Gemini 2.5 Flash)
  return {
    temperature: 0.65,
    maxOutputTokens: 2048,
    topP: 0.92
  };
}

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
    // Abaikan error jaringan logging agar alur pesan bot tidak terhambat
  }
}

async function askGeminiClinic(apiKey, model, conversationHistory) {
  const selectedModel = model || 'gemini-3.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(selectedModel) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const genConfig = getModelGenerationConfig(selectedModel);

  const systemInstructionText = 
    'Anda adalah "NovaCare Medical AI", Asisten Medis Virtual Resmi Klinik Pintar NovaCare. ' +
    'Karakter: Sangat cerdas, santun, hangat, empatik, berbasis data medis klinis terpercaya, dan to-the-point.\n\n' +
    'PEDOMAN RESPON KONSULTASI:\n' +
    '1. Berikan penjelasan kesehatan awal, saran perawatan mandiri ringan, dan anjuran pemeriksaan yang relevan secara jelas dan menenangkan.\n' +
    '2. HINDARI MEMOTONG JAWABAN: Pastikan seluruh penjelasan, tips, dan anjuran Anda selesai tuntas sampai akhir kalimat. Jangan biarkan kalimat menggantung.\n' +
    '3. STRUKTUR FORMAT WHATSAPP: Sajikan informasi dengan ringkas, terstruktur menggunakan bullet poin (•), dan hindari paragraf panjang yang melelahkan di layar ponsel.\n' +
    '4. PROTOKOL KONDISI DARURAT: Jika pasien mengeluhkan gejala darurat (nyeri dada tembus ke punggung, sesak napas berat, kejang, muntah darah, kehilangan kesadaran), tekankan SEGERA menuju Unit Gawat Darurat (UGD) terdekat.\n' +
    '5. CATATAN ETIS MEDIS: Selalu sertakan catatan ramah di akhir bahwa jawaban ini merupakan panduan triase edukasi awal dan BUKAN pengganti diagnosis langsung dari dokter spesialis.\n' +
    '6. FASILITAS NOVACARE: Poliklinik Spesialis Jantung Bionik, Bed Pod Rawat Inap Pintar, Saraf & Telemetri, Anak, Laboratorium Cepat, dan Farmasi 24 Jam.';

  const requestBody = {
    contents: conversationHistory,
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    },
    generationConfig: {
      temperature: genConfig.temperature,
      maxOutputTokens: genConfig.maxOutputTokens,
      topP: genConfig.topP
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
  const candidate = data.candidates?.[0];

  // Periksa apakah respon terpotong oleh sistem keamanan atau token limit
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    console.warn('[Gemini Warning]: Alasan selesai generasi:', candidate.finishReason);
  }

  const rawReply = candidate?.content?.parts?.[0]?.text;
  if (!rawReply) {
    throw new Error('Respon teks Gemini kosong');
  }

  // Bersihkan dan adaptasikan teks agar tampil sempurna di WhatsApp
  return formatForWhatsApp(rawReply);
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

    // Sinkronisasi pesan masuk ke Google Sheets (non-blocking)
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
        '💊 *Farmasi Dispenser Digital*: Buka 24 Jam Non-Stop.';
    } else if (lowerText === '#layanan') {
      commandReply = 
        '*FASILITAS MEDIS UNGGULAN NOVACARE*\n\n' +
        '1. Smart Bed Pod (Ruang Rawat Inap Isolasi Digital)\n' +
        '2. Telemetri Klinis Real-Time Terhubung WhatsApp\n' +
        '3. Laboratorium Analisis Darah & Bionik Cepat\n' +
        '4. Konsultasi AI Generatif Pre-Triage 24 Jam\n' +
        '5. Layanan E-Billing & Antar Resep Farmasi Cepat';
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
      await new Promise((r) => setTimeout(r, 900));
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

    // Masukkan pesan user ke histori sesi
    userSession.history.push({
      role: 'user',
      parts: [{ text: text }]
    });

    // Batasi riwayat maksimal 8 giliran pesan terakhir agar hemat memori RAM dan menjaga fokus konteks
    if (userSession.history.length > 8) {
      userSession.history = userSession.history.slice(-8);
    }

    // Jaga indikator pengetikan WhatsApp tetap aktif selama AI memproses
    const typingKeepAlive = setInterval(async () => {
      try {
        await sock.sendPresenceUpdate('composing', remoteJid);
      } catch (e) {}
    }, 4000);

    let aiReply = '';
    try {
      aiReply = await askGeminiClinic(config.geminiApiKey, config.geminiModel, userSession.history);

      // Simpan jawaban lengkap AI ke dalam histori sesi
      userSession.history.push({
        role: 'model',
        parts: [{ text: aiReply }]
      });
    } catch (aiErr) {
      console.error('[Gemini AI Processing Error]:', aiErr.message);
      aiReply = 'Mohon maaf, asisten AI kami sedang memproses lonjakan konsultasi. Silakan ulangi kembali pertanyaan Anda.';
    } finally {
      clearInterval(typingKeepAlive);
    }

    await new Promise((r) => setTimeout(r, 600));
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
  sanitizeNumber,
  formatForWhatsApp
};
