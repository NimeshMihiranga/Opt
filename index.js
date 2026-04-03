/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         MEZUKA MD  –  Web Server & Pair Entry            ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  GET  /              → main.html (Home Page)             ║
 * ║  GET  /pair          → pair.html (Pairing UI)            ║
 * ║  GET  /connect       → connect.html (Dashboard/Status)   ║
 * ║  GET  /code?number=  → JSON pair code                    ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs-extra');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const P        = require('pino');
const { Boom } = require('@hapi/boom');

const { registerOtpRoutes, initOtpService } = require('./main');

const API_PORT = Number(process.env.API_PORT) || 3000;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pairingSockets = new Map();

// ══════════════════════════════════════════════════════════════════════════════
//  PAGE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// 1. Root Domain -> Main Page (main.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// 2. Pair Page (pair.html)
app.get('/pair', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

// 3. Connect Page (connect.html)
app.get('/connect', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connect.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
//  LOGIC ROUTE: GET /code?number=...
// ══════════════════════════════════════════════════════════════════════════════
app.get('/code', async (req, res) => {
  const { number } = req.query;

  if (!number) {
    return res.status(400).json({
      success: false,
      error:   'NUMBER_REQUIRED',
      message: 'Usage: /code?number=94712345678',
    });
  }

  const sanitizedNumber = number.replace(/[^0-9]/g, '');

  if (!sanitizedNumber || sanitizedNumber.length < 7) {
    return res.status(400).json({
      success: false,
      error:   'INVALID_PHONE',
      message: 'Invalid phone number.',
    });
  }

  if (global.WA_SESSIONS && global.WA_SESSIONS.has(sanitizedNumber)) {
    return res.status(200).json({
      success: true,
      status:  'already_connected',
      message: 'This number is already connected.',
      number:  sanitizedNumber,
    });
  }

  if (pairingSockets.has(sanitizedNumber)) {
    return res.status(200).json({
      success: false,
      status:  'pairing_in_progress',
      message: 'Pairing is already in progress for this number.',
      number:  sanitizedNumber,
    });
  }

  try {
    const sessionFolder = path.join(__dirname, 'auth_info_baileys', sanitizedNumber);
    await fs.ensureDir(sessionFolder);

    const credsFile = path.join(sessionFolder, 'creds.json');
    if (await fs.pathExists(credsFile)) {
      await fs.remove(credsFile);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const logger = P({ level: 'silent' });

    const pairSocket = makeWASocket({
      version: [2, 3000, 1033105955],
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    pairingSockets.set(sanitizedNumber, pairSocket);
    pairSocket.ev.on('creds.update', saveCreds);

    const pairCode = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error(`❌ [PAIR] Timeout for ${sanitizedNumber}`);
        reject(new Error('PAIR_CODE_TIMEOUT'));
      }, 60000);
      try {
        console.log(`⏳ [PAIR] Waiting 5s before requesting code for ${sanitizedNumber}…`);
        await new Promise(r => setTimeout(r, 5000));
        console.log(`📲 [PAIR] Requesting pairing code for ${sanitizedNumber}…`);
        const code = await pairSocket.requestPairingCode(sanitizedNumber);
        clearTimeout(timeout);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(`✅ [PAIR] Code for ${sanitizedNumber}: ${formatted}`);
        resolve(formatted);
      } catch (err) {
        clearTimeout(timeout);
        console.error(`❌ [PAIR] requestPairingCode failed for ${sanitizedNumber}:`, err.message);
        reject(err);
      }
    });

    pairSocket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'connecting') {
        console.log(`🔗 [PAIR] Connecting socket for ${sanitizedNumber}…`);
      }
      if (connection === 'open') {
        console.log(`✅ [PAIR] Bot connected successfully for ${sanitizedNumber}`);
        pairingSockets.delete(sanitizedNumber);
        if (!global.WA_SESSIONS) global.WA_SESSIONS = new Map();
        global.WA_SESSIONS.set(sanitizedNumber, pairSocket);
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.message || 'unknown';
        console.log(`🔌 [PAIR] Connection closed for ${sanitizedNumber} — reason: ${reason}`);
        pairingSockets.delete(sanitizedNumber);
      }
    });

    return res.status(200).json({
      success: true,
      code:    pairCode,
      number:  sanitizedNumber
    });

  } catch (err) {
    pairingSockets.delete(sanitizedNumber);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Register other API routes
registerOtpRoutes(app);

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, error: 'NOT_FOUND' }));

// Start Server
(async () => {
  await initOtpService();
  app.listen(API_PORT, () => {
    console.log(`\n✅ [SERVER] Running on http://localhost:${API_PORT}`);
    console.log(`🏠 Home: /`);
    console.log(`🔗 Pair: /pair`);
    console.log(`📊 Status: /connect`);
  });
})();
