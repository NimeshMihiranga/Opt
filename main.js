/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║       MEZUKA OPT SERVICE – by Black Cat Ofc              ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Internal (connect.html):                                ║
 * ║  GET  /api/requestotp/:phone                             ║
 * ║  GET  /api/verifyotp/:phone/:otp                         ║
 * ║  POST /api/refresh          (body: {refreshToken})       ║
 * ║  GET  /api/optstatus/:phone                              ║
 * ║  GET  /api/optout/:phone    (Bearer accessToken)         ║
 * ║  POST /api/register         (Bearer accessToken)         ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  External (API key protected – for user websites):       ║
 * ║  GET  /api/sendotp/:apiKey/:phone                        ║
 * ║  GET  /api/verifyopt/:apiKey/:phone/:otp                 ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  GET  /api/health                                        ║
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
const MONGODB_URI    = process.env.MONGODB_URI    || 'mongodb://mongo:DcDwyaHTqnCUTCgGatnQlRQwAfYJPrSY@crossover.proxy.rlwy.net:44026';
const ACCESS_SECRET  = process.env.JWT_SECRET         || 'mezuka_secret_access_key_@2026';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'mezuka_refresh_secret_key_@9988';

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
const OTP_IMAGE_URL = process.env.OTP_IMAGE_URL || 'https://files.catbox.moe/4mp4ry.jpg';

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
      const senderNumber = '94789345531';
      console.log('\n⏳ [OTP-SENDER] Waiting 5s before requesting pairing code…');
      await new Promise(r => setTimeout(r, 5000));
      try {
        const pairCode = await conn.requestPairingCode(senderNumber);
        const formatted = pairCode?.match(/.{1,4}/g)?.join('-') || pairCode;
        console.log('\n╔══════════════════════════════════════╗');
        console.log('║  🔑 OTP SENDER PAIRING CODE           ║');
        console.log('║                                       ║');
        console.log(`║  Code : ${formatted.padEnd(29)}║`);
        console.log('║                                       ║');
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

  // ── ROUTE: Login ────────────────────────────────────────────────────────────
  // POST /api/login  { email, password }
  // Returns: user profile data (name, email, phone, siteName, siteUrl, plan, apiKey, dailyLimit)
  app.post('/api/login', async (req, res) => {
    if (!rateLimit(req, res)) return;
    try {
      await initDB();
      const { email, password } = req.body || {};

      if (!email || !password)
        return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'Email and password are required.' });

      const usersCol = _db.collection('opt_users');
      const user = await usersCol.findOne({ email });

      if (!user)
        return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'No account found with this email.' });

      if (!user.active)
        return res.status(403).json({ success: false, error: 'ACCOUNT_SUSPENDED', message: 'Your account has been suspended. Contact support.' });

      if (sha256(password) !== user.passwordHash)
        return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'Incorrect password.' });

      // Get today's usage
      const usageCol = _db.collection('api_usage');
      const today = new Date().toISOString().slice(0, 10);
      const usageDoc = await usageCol.findOne({ apiKey: user.apiKey, date: today });
      const todayUsed = usageDoc?.count || 0;

      console.log(`✅ [LOGIN] ${email}`);

      return res.json({
        success: true,
        message: 'Login successful',
        user: {
          name:       user.name,
          email:      user.email,
          phone:      user.phone,
          siteName:   user.siteName,
          siteUrl:    user.siteUrl,
          plan:       user.plan,
          apiKey:     user.apiKey,
          dailyLimit: user.dailyLimit,
          todayUsed,
          createdAt:  user.createdAt,
        }
      });

    } catch (err) {
      console.error('❌ [login]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── ROUTE: Profile Usage ─────────────────────────────────────────────────────
  // GET /api/profile/usage?apiKey=mzk_xxx
  // Returns today's usage count for the given API key
  app.get('/api/profile/usage', async (req, res) => {
    try {
      await initDB();
      const { apiKey } = req.query;
      if (!apiKey)
        return res.status(400).json({ success: false, error: 'API_KEY_REQUIRED' });

      const usersCol = _db.collection('opt_users');
      const user = await usersCol.findOne({ apiKey });
      if (!user)
        return res.status(404).json({ success: false, error: 'INVALID_API_KEY' });

      const usageCol = _db.collection('api_usage');
      const today = new Date().toISOString().slice(0, 10);
      const usageDoc = await usageCol.findOne({ apiKey, date: today });
      const todayUsed = usageDoc?.count || 0;

      return res.json({
        success: true,
        todayUsed,
        dailyLimit: user.dailyLimit,
        plan: user.plan,
      });

    } catch (err) {
      console.error('❌ [profile/usage]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  EXTERNAL API KEY ROUTES  (for user websites – /api/sendotp & /api/verifyopt)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Helper: validate API key & check daily limit ────────────────────────────
  async function validateApiKey(apiKey) {
    await initDB();
    const usersCol = _db.collection('opt_users');
    const user = await usersCol.findOne({ apiKey });

    if (!user)        return { ok: false, error: 'INVALID_API_KEY',   status: 401 };
    if (!user.active) return { ok: false, error: 'API_KEY_SUSPENDED', status: 403 };

    // Daily limit check (unlimited = -1)
    if (user.dailyLimit !== -1) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const usageCol = _db.collection('api_usage');
      const todayDoc = await usageCol.findOne({ apiKey, date: todayStart.toISOString().slice(0, 10) });
      const used = todayDoc?.count || 0;

      if (used >= user.dailyLimit) {
        return {
          ok: false,
          error:   'DAILY_LIMIT_REACHED',
          status:  429,
          message: `Daily OTP limit (${user.dailyLimit}) reached. Upgrade your plan or wait until tomorrow.`,
          plan:    user.plan,
          limit:   user.dailyLimit,
          used,
        };
      }
    }

    return { ok: true, user };
  }

  // ── Helper: increment daily usage count ────────────────────────────────────
  async function incrementUsage(apiKey) {
    const usageCol = _db.collection('api_usage');
    const today    = new Date().toISOString().slice(0, 10);
    await usageCol.updateOne(
      { apiKey, date: today },
      { $inc: { count: 1 }, $setOnInsert: { apiKey, date: today, createdAt: new Date() } },
      { upsert: true }
    );
  }

  // ── EXTERNAL ROUTE 1: Send OTP  GET /api/sendotp/:apiKey/:phone ────────────
  app.get('/api/sendotp/:apiKey/:phone', async (req, res) => {
    if (!rateLimit(req, res)) return;
    try {
      const { apiKey, phone: rawPhone } = req.params;
      const phone = normalizePhone(rawPhone);

      // Validate API key + plan limit
      const check = await validateApiKey(apiKey);
      if (!check.ok) return res.status(check.status).json({ success: false, error: check.error, message: check.message, plan: check.plan, limit: check.limit, used: check.used });

      if (!isValidPhone(phone))
        return res.status(400).json({ success: false, error: 'INVALID_PHONE', message: 'Phone must be 7–15 digits e.g. 94771234567' });

      // Cooldown check
      const recent = await otpCol.findOne({ phone, createdAt: { $gt: new Date(Date.now() - OTP_COOLDOWN_SECS * 1000) } });
      if (recent) {
        const wait = Math.ceil(OTP_COOLDOWN_SECS - (Date.now() - recent.createdAt.getTime()) / 1000);
        return res.status(429).json({ success: false, error: 'COOLDOWN', message: `Wait ${wait}s before requesting another OTP`, retryAfterSeconds: wait });
      }

      const otp = generateOtp();
      await otpCol.deleteMany({ phone });
      await otpCol.insertOne({ phone, otpHash: sha256(otp), createdAt: new Date(), attempts: 0, verified: false, apiKey });

      await sendOtpWhatsApp(phone, otp);
      await incrementUsage(apiKey);

      console.log(`📤 [EXT-OTP] Sent to ${phone} | key: ${apiKey.slice(0, 12)}…`);

      return res.json({
        success:          true,
        message:          `OTP sent to WhatsApp +${phone}`,
        expiresInSeconds: OTP_EXPIRE_SECS,
        plan:             check.user.plan,
      });

    } catch (err) {
      console.error('❌ [sendotp]', err.message);
      if (err.message === 'OTP_SENDER_NOT_READY')
        return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'WhatsApp OTP sender not ready. Try again shortly.' });
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── EXTERNAL ROUTE 2: Verify OTP  GET /api/verifyopt/:apiKey/:phone/:otp ───
  app.get('/api/verifyopt/:apiKey/:phone/:otp', async (req, res) => {
    if (!rateLimit(req, res)) return;
    try {
      const { apiKey, phone: rawPhone, otp: rawOtp } = req.params;
      const phone = normalizePhone(rawPhone);
      const otp   = String(rawOtp).replace(/\D/g, '');

      // Validate API key
      const check = await validateApiKey(apiKey);
      if (!check.ok) return res.status(check.status).json({ success: false, error: check.error, message: check.message });

      if (!isValidPhone(phone))
        return res.status(400).json({ success: false, error: 'INVALID_PHONE' });
      if (!/^\d{6}$/.test(otp))
        return res.status(400).json({ success: false, error: 'INVALID_OTP_FORMAT', message: 'OTP must be 6 digits' });

      const record = await otpCol.findOne({ phone });

      if (!record)
        return res.status(404).json({ success: false, error: 'OTP_NOT_FOUND', message: 'No active OTP. It may have expired (5 min). Request a new one.' });
      if (record.verified)
        return res.status(409).json({ success: false, error: 'OTP_ALREADY_USED' });
      if (record.attempts >= 5) {
        await otpCol.deleteOne({ phone });
        return res.status(429).json({ success: false, error: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong attempts. Request a new OTP.' });
      }
      if (sha256(otp) !== record.otpHash) {
        await otpCol.updateOne({ phone }, { $inc: { attempts: 1 } });
        const left = 5 - (record.attempts + 1);
        return res.status(401).json({ success: false, error: 'INVALID_OTP', message: `Wrong OTP. ${left} attempt(s) remaining.`, attemptsRemaining: left });
      }

      // OTP correct ✅
      await otpCol.deleteOne({ phone });
      console.log(`✅ [EXT-VERIFY] Verified ${phone} | key: ${apiKey.slice(0, 12)}…`);

      return res.json({
        success:  true,
        message:  'Phone number verified successfully',
        phone,
        verified: true,
        plan:     check.user.plan,
      });

    } catch (err) {
      console.error('❌ [verifyopt]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
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

// ══════════════════════════════════════════════════════════════════════════════
//  GITHUB OAUTH ROUTES
//  Register these from index.js:  registerGithubRoutes(app);
// ══════════════════════════════════════════════════════════════════════════════
function registerGithubRoutes(app) {

  const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID     || 'Ov23liiollotY7ugLfGw';
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '3822fec1ab0eaa71f1e96c9702c334c13af97155';

  function getBaseUrl(req) {
    if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    return `${req.protocol}://${req.get('host')}`;
  }

  // ── STEP 1: Redirect to GitHub ─────────────────────────────────────────────
  app.get('/auth/github', (req, res) => {
    const from = req.query.from || '';
    const state = Buffer.from(JSON.stringify({ from })).toString('base64');
    const params = new URLSearchParams({
      client_id:    GITHUB_CLIENT_ID,
      scope:        'user:email',
      redirect_uri: `${getBaseUrl(req)}/auth/github/callback`,
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // ── STEP 2: GitHub Callback ────────────────────────────────────────────────
  app.get('/auth/github/callback', async (req, res) => {
    const { code, state } = req.query;
    let from = '';
    try { from = JSON.parse(Buffer.from(state || '', 'base64').toString()).from || ''; } catch {}

    if (!code) return res.redirect(`/?error=github_auth_failed`);

    try {
      // Exchange code → access token
      const tokenRes = await axios.post(
        'https://github.com/login/oauth/access_token',
        { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
        { headers: { Accept: 'application/json' } }
      );
      const ghToken = tokenRes.data.access_token;
      if (!ghToken) return res.redirect('/?error=github_token_failed');

      // Get GitHub user profile
      const ghHeaders = { Authorization: `Bearer ${ghToken}`, 'User-Agent': 'MezukaOPT' };
      const [userRes, emailRes] = await Promise.all([
        axios.get('https://api.github.com/user', { headers: ghHeaders }),
        axios.get('https://api.github.com/user/emails', { headers: ghHeaders }),
      ]);
      const ghUser = userRes.data;
      const primaryEmail = emailRes.data.find(e => e.primary && e.verified);
      const email = ghUser.email || primaryEmail?.email;
      if (!email) return res.redirect('/?error=no_github_email');

      // DB: upsert user
      await initDB();
      const usersCol = _db.collection('opt_users');
      let user = await usersCol.findOne({ $or: [{ githubId: String(ghUser.id) }, { email }] });

      if (!user) {
        // Brand new user — create minimal account
        const apiKey = 'mzk_' + crypto.randomBytes(20).toString('hex');
        const newUser = {
          name:         ghUser.name || ghUser.login,
          email,
          phone:        null,
          siteName:     null,
          siteUrl:      null,
          passwordHash: null,
          plan:         'free',
          dailyLimit:   50,
          apiKey,
          githubId:     String(ghUser.id),
          avatarUrl:    ghUser.avatar_url || '',
          createdAt:    new Date(),
          active:       true,
        };
        await usersCol.insertOne(newUser);
        await usersCol.createIndex({ email: 1 }, { unique: true }).catch(() => {});
        await usersCol.createIndex({ apiKey: 1 }, { unique: true }).catch(() => {});
        user = newUser;
        console.log(`✅ [GITHUB] New user: ${email}`);
      } else {
        // Existing — patch GitHub fields
        await usersCol.updateOne(
          { email },
          { $set: { githubId: String(ghUser.id), avatarUrl: ghUser.avatar_url || '' } }
        );
        user = { ...user, githubId: String(ghUser.id), avatarUrl: ghUser.avatar_url || '' };
        console.log(`✅ [GITHUB] Existing user login: ${email}`);
      }

      // Today's usage
      const usageCol = _db.collection('api_usage');
      const today    = new Date().toISOString().slice(0, 10);
      const usageDoc = await usageCol.findOne({ apiKey: user.apiKey, date: today });

      const userData = encodeURIComponent(JSON.stringify({
        name:       user.name,
        email:      user.email,
        phone:      user.phone || '',
        siteName:   user.siteName || '',
        siteUrl:    user.siteUrl  || '',
        plan:       user.plan,
        apiKey:     user.apiKey,
        dailyLimit: user.dailyLimit,
        todayUsed:  usageDoc?.count || 0,
        githubId:   user.githubId,
        avatarUrl:  user.avatarUrl,
      }));

      // Redirect to origin page (connect or main)
      const redirectPath = from === 'connect' ? '/connect' : '/';
      res.redirect(`${redirectPath}?gh_login=${userData}`);

    } catch (err) {
      console.error('❌ [GitHub OAuth]', err.message);
      res.redirect('/?error=github_error');
    }
  });

  // ── GitHub Register: POST /api/register-github ─────────────────────────────
  // For GitHub-authenticated users who haven't set up a website yet
  app.post('/api/register-github', async (req, res) => {
    try {
      await initDB();
      const { name, email, siteName, siteUrl, password, plan, githubId, avatarUrl } = req.body || {};

      if (!name || !email || !siteName || !siteUrl || !password || !githubId)
        return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'All fields are required.' });

      const usersCol = _db.collection('opt_users');
      const user = await usersCol.findOne({ githubId: String(githubId) });
      if (!user)
        return res.status(401).json({ success: false, error: 'GITHUB_NOT_FOUND', message: 'GitHub account not found. Please login via GitHub first.' });

      const planLimits = { free: 50, starter: 80, pro: 150, unlimited: -1 };
      const dailyLimit  = planLimits[plan] ?? 50;

      // Check if they already have a site registered
      if (user.siteName)
        return res.status(409).json({ success: false, error: 'ALREADY_REGISTERED', message: 'Website already connected. Use your existing API key.' });

      // Update the record with site details
      const apiKey = user.apiKey || ('mzk_' + crypto.randomBytes(20).toString('hex'));
      await usersCol.updateOne(
        { githubId: String(githubId) },
        {
          $set: {
            name,
            email,
            siteName,
            siteUrl,
            passwordHash: sha256(password),
            plan:         plan || 'free',
            dailyLimit,
            apiKey,
            avatarUrl:    avatarUrl || user.avatarUrl || '',
          }
        }
      );

      console.log(`✅ [GH-REGISTER] ${email} | plan: ${plan} | site: ${siteUrl}`);

      return res.json({
        success:    true,
        message:    'Account connected successfully',
        apiKey,
        plan:       plan || 'free',
        dailyLimit,
      });

    } catch (err) {
      console.error('❌ [register-github]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  GOOGLE OAUTH ROUTES
//  Register these from index.js:  registerGoogleRoutes(app);
// ══════════════════════════════════════════════════════════════════════════════
function registerGoogleRoutes(app) {

  const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

  function getBaseUrl(req) {
    if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    return `${req.protocol}://${req.get('host')}`;
  }

  // ── STEP 1: Redirect to Google ─────────────────────────────────────────────
  app.get('/auth/google', (req, res) => {
    const from  = req.query.from || '';
    const state = Buffer.from(JSON.stringify({ from })).toString('base64');
    const params = new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      redirect_uri:  `${getBaseUrl(req)}/auth/google/callback`,
      response_type: 'code',
      scope:         'openid email profile',
      state,
      access_type:   'offline',
      prompt:        'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // ── STEP 2: Google Callback ────────────────────────────────────────────────
  app.get('/auth/google/callback', async (req, res) => {
    const { code, state } = req.query;
    let from = '';
    try { from = JSON.parse(Buffer.from(state || '', 'base64').toString()).from || ''; } catch {}

    if (!code) return res.redirect('/?error=google_auth_failed');

    try {
      // Exchange code → access token
      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${getBaseUrl(req)}/auth/google/callback`,
        grant_type:    'authorization_code',
      });
      const { access_token } = tokenRes.data;
      if (!access_token) return res.redirect('/?error=google_token_failed');

      // Get Google user profile
      const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const gUser = userRes.data;
      const email = gUser.email;
      if (!email) return res.redirect('/?error=no_google_email');

      // DB: upsert user
      await initDB();
      const usersCol = _db.collection('opt_users');
      let user = await usersCol.findOne({ $or: [{ googleId: String(gUser.id) }, { email }] });

      if (!user) {
        // Brand new user — create minimal account
        const apiKey = 'mzk_' + crypto.randomBytes(20).toString('hex');
        const newUser = {
          name:         gUser.name || email.split('@')[0],
          email,
          phone:        null,
          siteName:     null,
          siteUrl:      null,
          passwordHash: null,
          plan:         'free',
          dailyLimit:   50,
          apiKey,
          googleId:     String(gUser.id),
          avatarUrl:    gUser.picture || '',
          createdAt:    new Date(),
          active:       true,
        };
        await usersCol.insertOne(newUser);
        await usersCol.createIndex({ email: 1 }, { unique: true }).catch(() => {});
        await usersCol.createIndex({ apiKey: 1 }, { unique: true }).catch(() => {});
        user = newUser;
        console.log(`✅ [GOOGLE] New user: ${email}`);
      } else {
        // Existing — patch Google fields
        await usersCol.updateOne(
          { email },
          { $set: { googleId: String(gUser.id), avatarUrl: gUser.picture || '' } }
        );
        user = { ...user, googleId: String(gUser.id), avatarUrl: gUser.picture || '' };
        console.log(`✅ [GOOGLE] Existing user login: ${email}`);
      }

      // Today's usage
      const usageCol = _db.collection('api_usage');
      const today    = new Date().toISOString().slice(0, 10);
      const usageDoc = await usageCol.findOne({ apiKey: user.apiKey, date: today });

      const userData = encodeURIComponent(JSON.stringify({
        name:       user.name,
        email:      user.email,
        phone:      user.phone || '',
        siteName:   user.siteName || '',
        siteUrl:    user.siteUrl  || '',
        plan:       user.plan,
        apiKey:     user.apiKey,
        dailyLimit: user.dailyLimit,
        todayUsed:  usageDoc?.count || 0,
        googleId:   user.googleId,
        avatarUrl:  user.avatarUrl,
      }));

      // Redirect to origin page
      const redirectPath = from === 'connect' ? '/connect' : '/';
      res.redirect(`${redirectPath}?gh_login=${userData}`);

    } catch (err) {
      console.error('❌ [Google OAuth]', err.message);
      res.redirect('/?error=google_error');
    }
  });

  // ── Google Register: POST /api/register-google ─────────────────────────────
  app.post('/api/register-google', async (req, res) => {
    try {
      await initDB();
      const { name, email, siteName, siteUrl, password, plan, googleId, avatarUrl } = req.body || {};

      if (!name || !email || !siteName || !siteUrl || !password || !googleId)
        return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'All fields are required.' });

      const usersCol = _db.collection('opt_users');
      const user = await usersCol.findOne({ googleId: String(googleId) });
      if (!user)
        return res.status(401).json({ success: false, error: 'GOOGLE_NOT_FOUND', message: 'Google account not found. Please login via Google first.' });

      const planLimits = { free: 50, starter: 80, pro: 150, unlimited: -1 };
      const dailyLimit  = planLimits[plan] ?? 50;

      if (user.siteName)
        return res.status(409).json({ success: false, error: 'ALREADY_REGISTERED', message: 'Website already connected. Use your existing API key.' });

      const apiKey = user.apiKey || ('mzk_' + crypto.randomBytes(20).toString('hex'));
      await usersCol.updateOne(
        { googleId: String(googleId) },
        {
          $set: {
            name,
            email,
            siteName,
            siteUrl,
            passwordHash: sha256(password),
            plan:         plan || 'free',
            dailyLimit,
            apiKey,
            avatarUrl:    avatarUrl || user.avatarUrl || '',
          }
        }
      );

      console.log(`✅ [GOOGLE-REGISTER] ${email} | plan: ${plan} | site: ${siteUrl}`);

      return res.json({
        success:    true,
        message:    'Account connected successfully',
        apiKey,
        plan:       plan || 'free',
        dailyLimit,
      });

    } catch (err) {
      console.error('❌ [register-google]', err.message);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });
}

module.exports = { registerOtpRoutes, registerGithubRoutes, registerGoogleRoutes, initOtpService, getWaState };
