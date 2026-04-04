/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         MEZUKA OPT – WhatsApp OTP Widget                ║
 * ║         by Black Cat Ofc                                ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Usage:                                                  ║
 * ║  <script src="mezuka-opt.js"                            ║
 * ║    data-api-key="mzk_..."                               ║
 * ║    data-server="https://your-server.up.railway.app">    ║
 * ║  </script>                                              ║
 * ║                                                          ║
 * ║  Open modal:   MezukaOpt.showModal()                    ║
 * ║  On verified:  MezukaOpt.onVerified(fn)                 ║
 * ╚══════════════════════════════════════════════════════════╝
 */

(function () {
  'use strict';

  // ── Config from script tag ─────────────────────────────────────────────────
  const scriptTag  = document.currentScript ||
    document.querySelector('script[data-api-key]');
  const API_KEY    = scriptTag?.getAttribute('data-api-key')  || '';
  const SERVER_URL = (scriptTag?.getAttribute('data-server')  || '').replace(/\/$/, '');

  if (!API_KEY || !SERVER_URL) {
    console.warn('[MezukaOpt] Missing data-api-key or data-server attribute.');
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let _phone         = '';
  let _resendTimer   = null;
  let _verifiedCb    = null;
  let _injected      = false;

  // ── CSS ────────────────────────────────────────────────────────────────────
  const CSS = `
  #mzk-overlay{
    display:none;position:fixed;inset:0;z-index:999999;
    background:rgba(10,30,30,0.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    align-items:center;justify-content:center;padding:16px;font-family:'Segoe UI',Arial,sans-serif;
  }
  #mzk-overlay.mzk-open{display:flex;}
  #mzk-card{
    background:#fff;border-radius:24px;width:100%;max-width:380px;
    box-shadow:0 24px 64px rgba(37,211,102,0.18);
    overflow:hidden;animation:mzkPop .35s cubic-bezier(.34,1.4,.64,1);
    position:relative;
  }
  @keyframes mzkPop{from{opacity:0;transform:scale(.88) translateY(24px)}to{opacity:1;transform:scale(1) translateY(0)}}
  #mzk-header{
    background:linear-gradient(135deg,#25d366,#128c7e);
    padding:28px 28px 22px;text-align:center;position:relative;
  }
  #mzk-close{
    position:absolute;top:12px;right:12px;
    width:28px;height:28px;border-radius:50%;border:none;
    background:rgba(255,255,255,0.2);color:white;font-size:14px;
    cursor:pointer;display:flex;align-items:center;justify-content:center;
    transition:background .2s;line-height:1;
  }
  #mzk-close:hover{background:rgba(255,255,255,0.35);}
  .mzk-logo{
    width:52px;height:52px;border-radius:16px;
    background:rgba(255,255,255,0.2);border:2px solid rgba(255,255,255,0.35);
    display:flex;align-items:center;justify-content:center;font-size:26px;
    margin:0 auto 12px;
  }
  .mzk-title{font-size:18px;font-weight:800;color:#fff;margin-bottom:4px;letter-spacing:-.3px;}
  .mzk-sub{font-size:12px;color:rgba(255,255,255,.8);}
  #mzk-body{padding:24px 24px 28px;}
  .mzk-step{display:none;}
  .mzk-step.mzk-active{display:block;}
  .mzk-step-title{font-size:15px;font-weight:800;color:#1a2e2e;margin-bottom:4px;}
  .mzk-step-sub{font-size:12px;color:#6b8080;margin-bottom:18px;line-height:1.5;}
  .mzk-label{display:block;font-size:10px;font-weight:800;color:#1a2e2e;margin-bottom:5px;letter-spacing:.8px;text-transform:uppercase;}
  .mzk-input{
    width:100%;padding:11px 13px;
    border:1.5px solid rgba(78,205,196,0.25);border-radius:11px;
    font-size:15px;font-family:inherit;outline:none;
    background:#f0fdfc;color:#1a2e2e;transition:all .2s;
  }
  .mzk-input:focus{border-color:#25d366;background:#fff;box-shadow:0 0 0 3px rgba(37,211,102,0.1);}
  .mzk-input.mzk-otp{letter-spacing:8px;font-size:22px;font-weight:900;text-align:center;}
  .mzk-field{margin-bottom:14px;}
  .mzk-btn{
    width:100%;padding:12px;border:none;border-radius:12px;
    font-size:13px;font-weight:800;font-family:inherit;cursor:pointer;
    background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;
    box-shadow:0 5px 18px rgba(37,211,102,0.28);
    transition:all .22s;display:flex;align-items:center;justify-content:center;gap:8px;
  }
  .mzk-btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(37,211,102,0.38);}
  .mzk-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
  .mzk-btn-ghost{
    width:100%;padding:10px;border-radius:11px;
    border:1.5px solid rgba(78,205,196,0.25);background:rgba(78,205,196,0.07);
    color:#2bb5ab;font-size:12px;font-weight:800;font-family:inherit;
    cursor:pointer;margin-top:8px;transition:all .2s;
  }
  .mzk-btn-ghost:hover{background:rgba(78,205,196,0.14);}
  .mzk-msg{
    padding:9px 12px;border-radius:9px;font-size:12px;font-weight:600;
    margin-bottom:13px;display:none;
  }
  .mzk-msg.mzk-show{display:block;}
  .mzk-msg.mzk-error{background:rgba(224,85,85,0.08);border:1px solid rgba(224,85,85,0.2);color:#e05555;}
  .mzk-msg.mzk-success{background:rgba(37,211,102,0.08);border:1px solid rgba(37,211,102,0.22);color:#128c7e;}
  .mzk-spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:mzkSpin .7s linear infinite;flex-shrink:0;}
  @keyframes mzkSpin{to{transform:rotate(360deg)}}
  .mzk-phone-badge{
    display:inline-block;background:rgba(37,211,102,0.1);
    border:1px solid rgba(37,211,102,0.22);border-radius:8px;
    padding:4px 12px;font-size:13px;font-weight:700;color:#128c7e;
    margin-bottom:16px;font-family:monospace;
  }
  .mzk-resend{text-align:center;margin-top:10px;font-size:11px;color:#6b8080;}
  .mzk-resend button{background:none;border:none;color:#25d366;font-weight:800;cursor:pointer;font-size:11px;font-family:inherit;}
  .mzk-resend button:disabled{color:#a0b8b8;cursor:not-allowed;}
  .mzk-success-wrap{text-align:center;padding:8px 0;}
  .mzk-success-icon{font-size:56px;margin-bottom:12px;}
  .mzk-success-title{font-size:20px;font-weight:900;color:#1a2e2e;margin-bottom:6px;}
  .mzk-success-sub{font-size:12.5px;color:#6b8080;line-height:1.6;margin-bottom:16px;}
  .mzk-verified-badge{
    display:inline-flex;align-items:center;gap:6px;
    background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.25);
    border-radius:100px;padding:6px 16px;
    font-size:12px;font-weight:700;color:#128c7e;margin-bottom:16px;
  }
  .mzk-done-btn{
    width:100%;padding:11px;border:none;border-radius:12px;
    background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;
    font-size:13px;font-weight:800;font-family:inherit;cursor:pointer;
    box-shadow:0 5px 18px rgba(37,211,102,0.28);transition:all .22s;
  }
  .mzk-done-btn:hover{transform:translateY(-1px);}
  .mzk-brand{
    text-align:center;margin-top:18px;
    font-size:10px;color:#a0b8b8;letter-spacing:.5px;
  }
  .mzk-brand a{color:#4ecdc4;text-decoration:none;font-weight:700;}
  `;

  // ── HTML ───────────────────────────────────────────────────────────────────
  const HTML = `
  <div id="mzk-overlay">
    <div id="mzk-card">
      <div id="mzk-header">
        <button id="mzk-close" onclick="MezukaOpt.hideModal()" title="Close">✕</button>
        <div class="mzk-logo">📲</div>
        <div class="mzk-title">WhatsApp Verification</div>
        <div class="mzk-sub">Verify your number in seconds</div>
      </div>
      <div id="mzk-body">

        <!-- Step 1: Phone -->
        <div class="mzk-step mzk-active" id="mzk-s1">
          <div class="mzk-step-title">Enter Your Number</div>
          <div class="mzk-step-sub">We'll send a 6-digit OTP to your WhatsApp.</div>
          <div class="mzk-msg" id="mzk-msg1"></div>
          <div class="mzk-field">
            <label class="mzk-label">WhatsApp Number</label>
            <input class="mzk-input" id="mzk-phone" type="tel" placeholder="94712345678" maxlength="15"/>
          </div>
          <button class="mzk-btn" id="mzk-send-btn" onclick="MezukaOpt._sendOtp()">
            📲 Send OTP
          </button>
        </div>

        <!-- Step 2: OTP -->
        <div class="mzk-step" id="mzk-s2">
          <div class="mzk-step-title">Enter OTP</div>
          <div class="mzk-step-sub">Check your WhatsApp for the 6-digit code.</div>
          <div class="mzk-phone-badge" id="mzk-phone-badge"></div>
          <div class="mzk-msg" id="mzk-msg2"></div>
          <div class="mzk-field">
            <label class="mzk-label">6-Digit Code</label>
            <input class="mzk-input mzk-otp" id="mzk-otp" type="number" placeholder="000000" maxlength="6"/>
          </div>
          <button class="mzk-btn" id="mzk-verify-btn" onclick="MezukaOpt._verifyOtp()">
            ✅ Verify
          </button>
          <div class="mzk-resend">
            <button id="mzk-resend-btn" onclick="MezukaOpt._resendOtp()" disabled>Resend OTP</button>
          </div>
          <button class="mzk-btn-ghost" onclick="MezukaOpt._backToPhone()">← Change Number</button>
        </div>

        <!-- Step 3: Success -->
        <div class="mzk-step" id="mzk-s3">
          <div class="mzk-success-wrap">
            <div class="mzk-success-icon">🎉</div>
            <div class="mzk-success-title">Verified!</div>
            <div class="mzk-success-sub">Your WhatsApp number has been verified successfully.</div>
            <div class="mzk-verified-badge">✅ <span id="mzk-verified-phone"></span></div>
            <button class="mzk-done-btn" onclick="MezukaOpt.hideModal()">Done →</button>
          </div>
        </div>

        <div class="mzk-brand">Powered by <a href="https://opt-production-3749.up.railway.app" target="_blank">Mezuka OPT</a></div>
      </div>
    </div>
  </div>
  `;

  // ── Inject into DOM ────────────────────────────────────────────────────────
  function _inject() {
    if (_injected) return;
    _injected = true;

    // CSS
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // HTML
    const div = document.createElement('div');
    div.innerHTML = HTML;
    document.body.appendChild(div);

    // Close on overlay click
    document.getElementById('mzk-overlay').addEventListener('click', function(e){
      if (e.target === this) MezukaOpt.hideModal();
    });

    // Enter key on phone input
    document.getElementById('mzk-phone').addEventListener('keypress', function(e){
      if (e.key === 'Enter') MezukaOpt._sendOtp();
    });

    // Enter key on OTP input
    document.getElementById('mzk-otp').addEventListener('keypress', function(e){
      if (e.key === 'Enter') MezukaOpt._verifyOtp();
    });

    // Limit OTP to 6 digits
    document.getElementById('mzk-otp').addEventListener('input', function(){
      if (this.value.length > 6) this.value = this.value.slice(0, 6);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _goToStep(n) {
    [1,2,3].forEach(i => {
      const el = document.getElementById('mzk-s' + i);
      if (el) el.classList.toggle('mzk-active', i === n);
    });
  }

  function _showMsg(id, type, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'mzk-msg mzk-' + type + ' mzk-show';
    el.textContent = (type === 'error' ? '⚠️ ' : '✅ ') + text;
  }

  function _hideMsg(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('mzk-show');
  }

  function _startResendTimer() {
    let t = 60;
    const btn = document.getElementById('mzk-resend-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Resend (' + t + 's)';
    clearInterval(_resendTimer);
    _resendTimer = setInterval(function() {
      t--;
      if (t <= 0) {
        clearInterval(_resendTimer);
        btn.disabled = false;
        btn.textContent = 'Resend OTP';
      } else {
        btn.textContent = 'Resend (' + t + 's)';
      }
    }, 1000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.MezukaOpt = {

    // Show the modal
    showModal: function() {
      _inject();
      document.getElementById('mzk-overlay').classList.add('mzk-open');
      document.body.style.overflow = 'hidden';
      setTimeout(function(){ document.getElementById('mzk-phone').focus(); }, 300);
    },

    // Hide the modal
    hideModal: function() {
      const overlay = document.getElementById('mzk-overlay');
      if (overlay) overlay.classList.remove('mzk-open');
      document.body.style.overflow = '';
    },

    // Register verified callback
    onVerified: function(fn) {
      _verifiedCb = fn;
    },

    // Send OTP
    _sendOtp: async function() {
      const phone = document.getElementById('mzk-phone').value.replace(/\D/g, '').trim();
      if (!phone || phone.length < 7) {
        _showMsg('mzk-msg1', 'error', 'Valid phone number enter කරන්න.');
        return;
      }
      _phone = phone;
      const btn = document.getElementById('mzk-send-btn');
      btn.disabled = true;
      btn.innerHTML = '<div class="mzk-spinner"></div> Sending…';
      _hideMsg('mzk-msg1');

      try {
        const res  = await fetch(SERVER_URL + '/api/sendotp/' + API_KEY + '/' + phone);
        const data = await res.json();

        if (data.success) {
          document.getElementById('mzk-phone-badge').textContent = '+' + phone;
          document.getElementById('mzk-otp').value = '';
          _goToStep(2);
          _startResendTimer();
          setTimeout(function(){ document.getElementById('mzk-otp').focus(); }, 200);
        } else {
          const msgs = {
            COOLDOWN:            'Please wait ' + (data.retryAfterSeconds || 60) + 's before requesting again.',
            SERVICE_UNAVAILABLE: 'OTP service is not ready. Please try again shortly.',
            DAILY_LIMIT_REACHED: 'Daily OTP limit has been reached.',
            NOT_OPTED_IN:        'This number is not opted in.',
          };
          _showMsg('mzk-msg1', 'error', msgs[data.error] || data.message || 'Failed to send OTP.');
        }
      } catch (e) {
        _showMsg('mzk-msg1', 'error', 'Network error. Please try again.');
      }

      btn.disabled = false;
      btn.innerHTML = '📲 Send OTP';
    },

    // Verify OTP
    _verifyOtp: async function() {
      const otp = document.getElementById('mzk-otp').value.trim();
      if (otp.length !== 6) {
        _showMsg('mzk-msg2', 'error', 'Please enter the 6-digit OTP.');
        return;
      }
      const btn = document.getElementById('mzk-verify-btn');
      btn.disabled = true;
      btn.innerHTML = '<div class="mzk-spinner"></div> Verifying…';
      _hideMsg('mzk-msg2');

      try {
        const res  = await fetch(SERVER_URL + '/api/verifyopt/' + API_KEY + '/' + _phone + '/' + otp);
        const data = await res.json();

        if (data.success) {
          clearInterval(_resendTimer);
          document.getElementById('mzk-verified-phone').textContent = '+' + _phone;
          _goToStep(3);

          // Fire callback
          if (typeof _verifiedCb === 'function') {
            _verifiedCb({
              phone:        _phone,
              accessToken:  data.accessToken  || null,
              refreshToken: data.refreshToken || null,
            });
          }
        } else {
          const msgs = {
            INVALID_OTP:       'Wrong OTP. ' + (data.attemptsRemaining || 0) + ' attempt(s) remaining.',
            OTP_NOT_FOUND:     'OTP has expired. Please request a new one.',
            TOO_MANY_ATTEMPTS: 'Too many wrong attempts. Please request a new OTP.',
            OTP_ALREADY_USED:  'This OTP has already been used.',
          };
          _showMsg('mzk-msg2', 'error', msgs[data.error] || data.message || 'Verification failed.');
        }
      } catch (e) {
        _showMsg('mzk-msg2', 'error', 'Network error. Please try again.');
      }

      btn.disabled = false;
      btn.innerHTML = '✅ Verify';
    },

    // Resend OTP
    _resendOtp: async function() {
      _hideMsg('mzk-msg2');
      const btn = document.getElementById('mzk-resend-btn');
      btn.disabled = true;

      try {
        const res  = await fetch(SERVER_URL + '/api/sendotp/' + API_KEY + '/' + _phone);
        const data = await res.json();

        if (data.success) {
          _showMsg('mzk-msg2', 'success', 'OTP resent! Check your WhatsApp.');
          _startResendTimer();
        } else {
          _showMsg('mzk-msg2', 'error', data.message || 'Resend failed.');
          btn.disabled = false;
        }
      } catch (e) {
        _showMsg('mzk-msg2', 'error', 'Network error.');
        btn.disabled = false;
      }
    },

    // Back to phone step
    _backToPhone: function() {
      clearInterval(_resendTimer);
      document.getElementById('mzk-otp').value = '';
      _hideMsg('mzk-msg2');
      _goToStep(1);
    },

  };

  // ── Auto-inject when DOM is ready ──────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _inject);
  } else {
    _inject();
  }

})();

