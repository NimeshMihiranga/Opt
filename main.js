/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║       MEZUKA OPT SERVICE – by Black Cat Ofc              ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  GET  /api/requestotp/:phone                             ║
 * ║  GET  /api/verifyotp/:phone/:otp                         ║
 * ║  POST /api/refresh          (body: {refreshToken})       ║
 * ║  GET  /api/optstatus/:phone                              ║
 * ║  GET  /api/optout/:phone    (Bearer accessToken)         ║
 * ║  GET  /api/health                                        ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  OTP      : 6-digit, expires in 5 minutes               ║
 * ║  Auth     : Access Token (15 min) + Refresh (30 days)   ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

const { MongoClient }  = require('mongodb');
const crypto           = require('crypto');
const jwt              = require('jsonwebtoken');
const fs               = require('fs-extra');
const path             = require('path');
const axios            = require('axios');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const P        = require('pino');
const { Boom } = require('@hapi/boom');

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const MONGODB_URI    = process.env.MONGODB_URI;
const ACCESS_SECRET  = process.env.JWT_SECRET         || crypto.randomBytes(32).toString('hex');
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex');

const OTP_EXPIRE_SECS   = 5 * 60;
const OTP_COOLDOWN_SECS = 60;
const ACCESS_TTL        = '15m';
const REFRESH_TTL       = '30d';
const REFRESH_TTL_MS    = 30 * 24 * 3600 * 1000;

const WA_SESSION_DIR = path.join(__dirname, 'auth_info_baileys', 'otp_sender');

// ── Channel forward info (forwardedNewsletterMessageInfo) ─────────────────────
const CHANNEL_CONTEXT = {
  forwardingScore: 1,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid:     '120363424190766692@newsletter',
    newsletterName:    '𝐌ᴇᴢᴜᴋᴀ 𝐎ᴘᴛ',
    serverMessageId:   999,
  },
};

// OTP banner image URL – set OTP_IMAGE_URL in .env or replace below
// Must be a public direct-link image (jpg/png/webp)
const OTP_IMAGE_URL = process.env.OTP_IMAGE_URL || 'https://i.ibb.co/placeholder/mezuka-otp.jpg';

// ══════════════════════════════════════════════════════════════════════════════
//  MONGODB
// ══════════════════════════════════════════════════════════════════════════════
let _db        = null;
let otpCol     = null;
let optInCol   = null;
let refreshCol = null;

async function initDB() {
  if (_db) return;
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
  await client.connect();
  _db        = client.db('MEZUKADB');
  otpCol     = _db.collection('otp_requests');
  optInCol   = _db.collection('opt_in_users');
  refreshCol = _db.collection('refresh_tokens');

  await otpCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: OTP_EXPIRE_SECS }).catch(() => {});
  await refreshCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: REFRESH_TTL_MS / 1000 }).catch(() => {});
  await optInCol.createIndex({ phone: 1 }, { unique: true }).catch(() => {});
  await refreshCol.createIndex({ tokenHash: 1 }, { unique: true }).catch(() => {});

  console.log('✅ [DB] OTP collections ready');
}

// ══════════════════════════════════════════════════════════════════════════════
//  WHATSAPP OTP SENDER SESSION
// ══════════════════════════════════════════════════════════════════════════════
let waConn  = null;
let waReady = false;

async function initWaSender() {
  try {
    await fs.ensureDir(WA_SESSION_DIR);
    const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
      },
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        waConn  = conn;
        waReady = true;
        console.log('✅ [OTP-SENDER] WhatsApp connected & ready');
      }
      if (connection === 'close') {
        waReady = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('🔄 [OTP-SENDER] Reconnecting in 5s…');
          setTimeout(initWaSender, 5000);
        } else {
          console.warn('🚪 [OTP-SENDER] Logged out. Restart server to re-pair.');
          await fs.remove(WA_SESSION_DIR).catch(() => {});
        }
      }
    });

    // If not yet registered → request pairing code (no QR)
    if (!conn.authState.creds.registered) {
      const senderNumber = process.env.OTP_SENDER_NUMBER;
      if (!senderNumber) {
        console.error('❌ [OTP-SENDER] OTP_SENDER_NUMBER not set in .env (e.g. 94712345678)');
        return;
      }
      const cleanNumber = senderNumber.replace(/\D/g, '');
      console.log('\n⏳ [OTP-SENDER] Waiting 5s before requesting pairing code…');
      await new Promise(r => setTimeout(r, 5000));
      try {
        const pairCode = await conn.requestPairingCode(cleanNumber);
        const formatted = pairCode?.match(/.{1,4}/g)?.join('-') || pairCode;
        console.log('\n╔══════════════════════════════════════╗');
        console.log('║  🔑 OTP SENDER PAIRING CODE           ║');
        console.log('║                                       ║');
        console.log(`║  Code : ${formatted.padEnd(29)}║`);
        console.log('║                                       ║');
        console.log('║  Steps:                               ║');
        console.log('║  1. WhatsApp → Settings               ║');
        console.log('║  2. Linked Devices → Link a device    ║');
        console.log('║  3. Tap "Link with phone number"      ║');
        console.log('║  4. Enter the code above              ║');
        console.log('╚══════════════════════════════════════╝\n');
      } catch (pairErr) {
        console.error('❌ [OTP-SENDER] Pairing code request failed:', pairErr.message);
        setTimeout(initWaSender, 10000);
      }
    }

  } catch (err) {
    console.error('❌ [OTP-SENDER] Init error:', err.message);
    setTimeout(initWaSender, 10000);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const normalizePhone = (r) => String(r).replace(/\D/g, '');
const isValidPhone   = (p) => /^\d{7,15}$/.test(p);
const generateOtp    = ()  => String(crypto.randomInt(100000, 999999));
const sha256         = (v) => crypto.createHash('sha256').update(v).digest('hex');

function issueAccessToken(phone) {
  return jwt.sign({ phone, type: 'access', optedIn: true }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

async function issueRefreshToken(phone) {
  const raw = jwt.sign(
    { phone, type: 'refresh', jti: crypto.randomBytes(16).toString('hex') },
    REFRESH_SECRET,
    { expiresIn: REFRESH_TTL }
  );
  await refreshCol.insertOne({ phone, tokenHash: sha256(raw), createdAt: new Date(), revoked: false });
  return raw;
}

// ── Download image as buffer for WhatsApp ─────────────────────────────────────
async function fetchImageBuffer(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SEND OTP  –  image + text + channel forward context
// ══════════════════════════════════════════════════════════════════════════════
async function sendOtpWhatsApp(phone, otp) {
  if (!waReady || !waConn) throw new Error('OTP_SENDER_NOT_READY');

  const jid = `${phone}@s.whatsapp.net`;

  const otpText =
`🌸✨ 𝑴𝑬𝒁𝑼𝑲𝑨 𝑶𝑻𝑷 𝑺𝑬𝑹𝑽𝑰𝑪𝑬 ✨🌸
      ʙʏ ʙʟᴀᴄᴋ ᴄᴀᴛ ᴏғᴄ 🐾

💌 ʏᴏᴜʀ ᴏᴛᴘ :
   ✧ ${otp} ✧

⏳ ᴠᴀʟɪᴅ ғᴏʀ 5 ᴍɪɴᴜᴛᴇs  
🚫 ᴅᴏɴ'ᴛ sʜᴀʀᴇ ɪᴛ

🌷 ᴍᴇᴢᴜᴋᴀ ᴍᴅ v4 ✻
> © ʙʟᴀᴄᴋ ᴄᴀᴛ ᴏғᴄ 🧃🌸`;

  // Try to send with image first
  const imgBuffer = await fetchImageBuffer(OTP_IMAGE_URL);

  if (imgBuffer) {
    // Send image with OTP text as caption + channel forward context
    await waConn.sendMessage(jid, {
      image: imgBuffer,
      caption: otpText,
      contextInfo: CHANNEL_CONTEXT,
    });
  } else {
    // Fallback: text only + channel forward context
    await waConn.sendMessage(jid, {
      text: otpText,
      contextInfo: CHANNEL_CONTEXT,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  REGISTER ALL OPT API ROUTES onto an Express app instance
// ══════════════════════════════════════════════════════════════════════════════

// Per-IP rate limiter (shared across routes)
const ipMap = new Map();
setInterval(() => ipMap.clear(), 60_000);

function rateLimit(req, res, max = 30) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const n  = (ipMap.get(ip) || 0) + 1;
  ipMap.set(ip, n);
  if (n > max) {
    res.status(429).json({ success: false, error: 'TOO_MANY_REQUESTS' });
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer '))
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  try {
    req.user = jwt.verify(auth.slice(7), ACCESS_SECRET);
    if (req.user.type !== 'access') throw new Error();
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'INVALID_OR_EXPIRED_TOKEN' });
  }
}

/**
 * Call this from index.js:
 *   const { registerOtpRoutes, initOtpService } = require('./main');
 *   registerOtpRoutes(app);
 *   await initOtpService();
 */
function registerOtpRoutes(app) {

  // ── ROUTE 1: Request OTP ────────────────────────────────────────────────────
  app.get('/api/requestotp/:phone', async (req, res) => {
    if (!rateLimit(req, res)) return;
    try {
      await initDB();
      const phone = normalizePhone(req.params.phone);

      if (!isValidPhone(phone))
        return res.status(400).json({ success: false, error: 'INVALID_PHONE',
          message: 'Phone must be 7–15 digits, international format e.g. 94771234567' });

      // Spam guard: 1 request per phone per 60s
      const recent = await otpCol.findOne({
        phone, createdAt: { $gt: new Date(Date.now() - OTP_COOLDOWN_SECS * 1000) }
      });
      if (recent) {
        const wait = Math.ceil(OTP_COOLDOWN_SECS - (Date.now() - recent.createdAt.getTime()) / 1000);
        return res.status(429).json({ success: false, error: 'COOLDOWN',
          message: `Wait ${wait}s before requesting another OTP`, retryAfterSeconds: wait });
      }

      const otp = generateOtp();
      await otpCol.deleteMany({ phone });
      await otpCol.insertOne({ phone, otpHash: sha256(otp), createdAt: new Date(), attempts: 0, verified: false });

      await sendOtpWhatsApp(phone, otp);
      console.log(`📤 [OTP] Sent to ${phone}`);

      return res.json({ success: true, message: `OTP sent to WhatsApp +${phone}`, expiresInSeconds: OTP_EXPIRE_SECS });

    } catch (err) {
      console.error('❌ [requestotp]', err.message);
      if (err.message === 'OTP_SENDER_NOT_READY')
        return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE',
          message: 'WhatsApp OTP sender is not ready. Try again shortly.' });
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── ROUTE 2: Verify OTP → issue tokens ─────────────────────────────────────
  app.get('/api/verifyotp/:phone/:otp', async (req, res) => {
    if (!rateLimit(req, res)) return;
    try {
      await initDB();
      const phone = normalizePhone(req.params.phone);
      const otp   = String(req.params.otp).replace(/\D/g, '');

      if (!isValidPhone(phone))
        return res.status(400).json({ success: false, error: 'INVALID_PHONE' });
      if (!/^\d{6}$/.test(otp))
        return res.status(400).json({ success: false, error: 'INVALID_OTP_FORMAT', message: 'OTP must be 6 digits' });

      const record = await otpCol.findOne({ phone });

      if (!record)
        return res.status(404).json({ success: false, error: 'OTP_NOT_FOUND',
          message: 'No active OTP found. It may have expired (5 min). Request a new one.' });

      if (record.verified)
        return res.status(409).json({ success: false, error: 'OTP_ALREADY_USED' });

      if (record.attempts >= 5) {
        await otpCol.deleteOne({ phone });
        return res.status(429).json({ success: false, error: 'TOO_MANY_ATTEMPTS',
          message: 'Too many wrong attempts. Please request a new OTP.' });
      }

      if (sha256(otp) !== record.otpHash) {
        await otpCol.updateOne({ phone }, { $inc: { attempts: 1 } });
        const left = 5 - (record.attempts + 1);
        return res.status(401).json({ success: false, error: 'INVALID_OTP',
          message: `Wrong OTP. ${left} attempt(s) remaining.`, attemptsRemaining: left });
      }

      // OTP correct ✅
      await optInCol.updateOne(
        { phone },
        { $set: { optedIn: true, verifiedAt: new Date() }, $setOnInsert: { phone, createdAt: new Date() } },
        { upsert: true }
      );

      await refreshCol.updateMany({ phone, revoked: false }, { $set: { revoked: true } });

      const [accessToken, refreshToken] = await Promise.all([
        issueAccessToken(phone),
        issueRefreshToken(phone),
      ]);

      await otpCol.deleteOne({ phone });

      // Confirmation WhatsApp message + image + channel context
      if (waReady && waConn) {
        const confirmText =
`✅ *Verification Successful!*

Your number *+${phone}* is now opted in to *Mezuka MD*.

╭─────────────────────╮
│ 🌸 *Mezuka MD V4✻*
│ © Black Cat Ofc 2026
╰─────────────────────╯`;

        const imgBuffer = await fetchImageBuffer(OTP_IMAGE_URL);
        if (imgBuffer) {
          waConn.sendMessage(`${phone}@s.whatsapp.net`, {
            image: imgBuffer,
            caption: confirmText,
            contextInfo: CHANNEL_CONTEXT,
          }).catch(() => {});
        } else {
          waConn.sendMessage(`${phone}@s.whatsapp.net`, {
            text: confirmText,
            contextInfo: CHANNEL_CONTEXT,
          }).catch(() => {});
        }
      }

      console.log(`✅ [OTP] Tokens issued for ${phone}`);

      return res.json({
        success:          true,
        message:          'Phone verified and opted in successfully',
        phone,
        accessToken,
        refreshToken,
        accessExpiresIn:  ACCESS_TTL,
        refreshExpiresIn: REFRESH_TTL,
        usage: {
          makeApiCall:       'Authorization: Bearer <accessToken>',
          whenAccessExpires: 'POST /api/refresh  body: { "refreshToken": "..." }',
          toLogOut:          'GET  /api/optout/:phone  (with accessToken)',
        }
      });

    } catch (err) {
      console.error('❌ [verifyotp]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── ROUTE 3: Refresh access token ──────────────────────────────────────────
  app.post('/api/refresh', async (req, res) => {
    if (!rateLimit(req, res)) return;
    try {
      await initDB();
      const { refreshToken } = req.body || {};

      if (!refreshToken)
        return res.status(400).json({ success: false, error: 'REFRESH_TOKEN_REQUIRED' });

      let decoded;
      try { decoded = jwt.verify(refreshToken, REFRESH_SECRET); }
      catch { return res.status(401).json({ success: false, error: 'INVALID_OR_EXPIRED_REFRESH_TOKEN' }); }

      if (decoded.type !== 'refresh')
        return res.status(401).json({ success: false, error: 'WRONG_TOKEN_TYPE' });

      const stored = await refreshCol.findOne({ tokenHash: sha256(refreshToken) });
      if (!stored || stored.revoked)
        return res.status(401).json({ success: false, error: 'REFRESH_TOKEN_REVOKED',
          message: 'This refresh token has been revoked. Please verify OTP again.' });

      const newAccessToken = issueAccessToken(decoded.phone);
      console.log(`🔄 [TOKEN] New access token for ${decoded.phone}`);

      return res.json({ success: true, accessToken: newAccessToken, accessExpiresIn: ACCESS_TTL });

    } catch (err) {
      console.error('❌ [refresh]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── ROUTE 4: Opt-in status ──────────────────────────────────────────────────
  app.get('/api/optstatus/:phone', async (req, res) => {
    try {
      await initDB();
      const phone = normalizePhone(req.params.phone);
      if (!isValidPhone(phone))
        return res.status(400).json({ success: false, error: 'INVALID_PHONE' });
      const doc = await optInCol.findOne({ phone });
      return res.json({ success: true, phone, optedIn: doc?.optedIn ?? false, verifiedAt: doc?.verifiedAt ?? null });
    } catch { return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' }); }
  });

  // ── ROUTE 5: Opt out (requires valid access token) ──────────────────────────
  app.get('/api/optout/:phone', requireAuth, async (req, res) => {
    try {
      await initDB();
      const phone = normalizePhone(req.params.phone);
      if (req.user.phone !== phone)
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });

      await optInCol.updateOne({ phone }, { $set: { optedIn: false, optedOutAt: new Date() } });
      await refreshCol.updateMany({ phone }, { $set: { revoked: true } });

      if (waReady && waConn) {
        waConn.sendMessage(`${phone}@s.whatsapp.net`, {
          text: `🚪 *Opted Out*\n\nYour number *+${phone}* has been removed from Mezuka MD.\n\nTo rejoin, simply verify OTP again.\n\n╭─────────────────────╮\n│ 🌸 *Mezuka MD V4✻*\n│ © Black Cat Ofc 2026\n╰─────────────────────╯`,
          contextInfo: CHANNEL_CONTEXT,
        }).catch(() => {});
      }

      console.log(`🚪 [OPT-OUT] ${phone}`);
      return res.json({ success: true, message: `+${phone} opted out successfully` });
    } catch { return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' }); }
  });

  // ── ROUTE: Register website account ────────────────────────────────────────
  // POST /api/register  { name, email, siteName, siteUrl, password, phone, plan }
  // Requires: Bearer accessToken (from verifyotp)
  app.post('/api/register', requireAuth, async (req, res) => {
    try {
      await initDB();
      const { name, email, siteName, siteUrl, password, plan } = req.body || {};
      const phone = req.user.phone; // from verified JWT

      if(!name||!email||!siteName||!siteUrl||!password)
        return res.status(400).json({ success:false, error:'MISSING_FIELDS', message:'All fields are required.' });

      const usersCol = _db.collection('opt_users');

      // Check duplicate email
      const existing = await usersCol.findOne({ email });
      if(existing)
        return res.status(409).json({ success:false, error:'EMAIL_EXISTS', message:'An account with this email already exists.' });

      // Generate unique API key
      const apiKey = 'mzk_' + crypto.randomBytes(20).toString('hex');

      const planLimits = { free:50, starter:80, pro:150, unlimited:-1 };
      const dailyLimit = planLimits[plan] ?? 50;

      const doc = {
        name, email, phone,
        siteName, siteUrl,
        passwordHash: sha256(password),
        plan: plan || 'free',
        dailyLimit,
        apiKey,
        apiKeyHash: sha256(apiKey),
        createdAt: new Date(),
        active: true,
      };

      await usersCol.insertOne(doc);
      await usersCol.createIndex({ email:1 }, { unique:true }).catch(()=>{});
      await usersCol.createIndex({ apiKey:1 }, { unique:true }).catch(()=>{});

      console.log(`✅ [REGISTER] New account: ${email} | plan: ${plan} | site: ${siteUrl}`);

      return res.json({
        success:  true,
        message:  'Account created successfully',
        apiKey,
        plan:     plan || 'free',
        dailyLimit,
      });

    } catch(err) {
      console.error('❌ [register]', err.message);
      return res.status(500).json({ success:false, error:'INTERNAL_ERROR' });
    }
  });

  // ── ROUTE 6: Health ─────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => res.json({
    success: true, waReady, timestamp: new Date().toISOString(),
    service: 'Mezuka OPT Service by Black Cat Ofc',
    otpExpiresIn: '5 minutes', accessTokenTTL: ACCESS_TTL, refreshTokenTTL: REFRESH_TTL,
  }));
}

/**
 * Initialize DB + WhatsApp OTP sender.
 * Call this once at startup from index.js
 */
async function initOtpService() {
  try { await initDB(); } catch (e) { console.error('❌ [DB] Failed:', e.message); }
  await initWaSender();
}

// Export getters so index.js can read live state if needed
function getWaState() { return { waConn, waReady }; }

module.exports = { registerOtpRoutes, initOtpService, getWaState };
