const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PLATFORM_FEE = 0.02;
const INSTANT_FEE = 0.015;

app.use(cors({
  origin: ['https://pitchinapp.netlify.app', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Simple password hashing using built-in crypto (no bcrypt needed)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verify;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pots (
      slug VARCHAR(8) PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(255) NOT NULL,
      password_hash VARCHAR(512) NOT NULL,
      token VARCHAR(64),
      token_expires TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      email VARCHAR(255) PRIMARY KEY,
      display_name VARCHAR(255),
      balance DECIMAL(10,2) DEFAULT 0,
      total_earned DECIMAL(10,2) DEFAULT 0,
      total_contributed DECIMAL(10,2) DEFAULT 0,
      stripe_customer_id VARCHAR(255),
      payout_method_id VARCHAR(255),
      payout_last4 VARCHAR(4),
      moov_account_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Add moov_account_id column if it doesn't exist (for existing tables)
  await pool.query(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS moov_account_id VARCHAR(255)`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      fee DECIMAL(10,2) DEFAULT 0,
      description TEXT,
      pot_slug VARCHAR(8),
      pot_name VARCHAR(255),
      stripe_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}
initDB().catch(console.error);

// ── EMAIL ──────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) return;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: 'Pitch-In <noreply@pitchin.llc>', to, subject, html })
    });
    const data = await response.json();
    if (data.error) console.warn('Email error:', data.error);
  } catch (err) { console.warn('Email error:', err.message); }
}

function emailWelcome(email, name) {
  return sendEmail({
    to: email, subject: 'Welcome to Pitch-In 🎉',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#2352e8">Welcome to Pitch-In, ${name}! 💰</h2>
      <p>Your wallet is ready. Every time a pot you organize fills up, your earnings land here instantly.</p>
      <p style="color:#666">Withdraw anytime — free standard transfer or instant to your debit card for 1.5%.</p>
      <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
    </div>`
  });
}

function emailContributionConfirmed(email, name, amount, potName, potLink) {
  return sendEmail({
    to: email, subject: `✓ You're in! $${amount} added to ${potName}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#2352e8">You're in! 💸</h2>
      <p>Hey ${name}, your <strong>$${amount}</strong> has been added to <strong>${potName}</strong>.</p>
      <p style="color:#666">Held securely by Stripe. Auto-refunded in full if the goal isn't met.</p>
      <a href="${potLink}" style="display:inline-block;background:#2352e8;color:white;padding:12px 24px;border-radius:50px;text-decoration:none;margin:16px 0">View the Pot</a>
      <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
    </div>`
  });
}

function emailPotFilled(organizerEmail, potName, amount, potLink) {
  return sendEmail({
    to: organizerEmail, subject: `🎉 Your pot is full! $${amount} in your wallet`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#0a8a4a">Your pot is full! 🎉</h2>
      <p><strong>${potName}</strong> has reached its goal. <strong>$${amount}</strong> is now in your Pitch-In wallet.</p>
      <p style="color:#666">Open the app to withdraw — free standard transfer or instant to your debit card.</p>
      <a href="${potLink}" style="display:inline-block;background:#0a8a4a;color:white;padding:12px 24px;border-radius:50px;text-decoration:none;margin:16px 0">View &amp; Withdraw</a>
      <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
    </div>`
  });
}

function emailContributorPotFilled(email, name, potName, potLink) {
  return sendEmail({
    to: email, subject: `🎉 ${potName} is full!`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#0a8a4a">The pot is full! 🎉</h2>
      <p>Hey ${name}, <strong>${potName}</strong> reached its goal! The organizer has been paid.</p>
      <a href="${potLink}" style="display:inline-block;background:#2352e8;color:white;padding:12px 24px;border-radius:50px;text-decoration:none;margin:16px 0">View the Pot</a>
      <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
    </div>`
  });
}

function emailRefund(email, name, amount, potName) {
  return sendEmail({
    to: email, subject: `↩ Refund: $${amount} from ${potName} is on its way`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#c8193a">Pot expired — refund coming ↩</h2>
      <p>Hey ${name}, <strong>${potName}</strong> didn't reach its goal in time.</p>
      <p>Your <strong>$${amount}</strong> is being refunded. Expect it within 5-10 business days.</p>
      <p style="color:#666">No fees charged on this pot.</p>
      <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
    </div>`
  });
}

function emailWithdrawal(email, name, amount, method, arrivalDate) {
  return sendEmail({
    to: email, subject: `💸 $${amount} withdrawal initiated`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#2352e8">Withdrawal confirmed 💸</h2>
      <p>Hey ${name}, <strong>$${amount}</strong> is on its way to your bank account.</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;margin:16px 0">
        <p style="margin:0;color:#166534">✓ Method: ${method}<br/>✓ Expected: ${arrivalDate}</p>
      </div>
      <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
    </div>`
  });
}

// ── AUTH: Register ─────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(400).json({ error: 'An account with this email already exists' });

    const passwordHash = hashPassword(password);
    const token = generateToken();
    const tokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await pool.query(
      'INSERT INTO users (email, username, password_hash, token, token_expires) VALUES ($1, $2, $3, $4, $5)',
      [email.toLowerCase(), username, passwordHash, token, tokenExpires]
    );

    // Create wallet for new user
    await pool.query(
      'INSERT INTO wallets (email, display_name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET display_name = $2',
      [email.toLowerCase(), username]
    );

    sendEmail({
      to: email,
      subject: 'Welcome to Pitch-In! 🎉',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#2352e8">Welcome, ${username}! 💰</h2>
        <p>Your Pitch-In account is ready. Create pots, pitch in with your group, and track everything in your wallet.</p>
        <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
      </div>`
    }).catch(() => {});

    res.json({ success: true, token, user: { email: email.toLowerCase(), username } });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── AUTH: Login ────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(400).json({ error: 'No account found with this email' });

    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(400).json({ error: 'Incorrect password' });
    }

    // Refresh token
    const token = generateToken();
    const tokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET token=$1, token_expires=$2 WHERE email=$3', [token, tokenExpires, email.toLowerCase()]);

    res.json({ success: true, token, user: { email: email.toLowerCase(), username: user.username } });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── AUTH: Verify token ─────────────────────────────────────
app.post('/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const result = await pool.query(
      'SELECT * FROM users WHERE token = $1 AND token_expires > NOW()',
      [token]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired session' });
    const user = result.rows[0];
    res.json({ success: true, user: { email: user.email, username: user.username } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── OPEN GRAPH ─────────────────────────────────────────────
app.get('/og/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM pots WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).send('Not found');
    const pot = result.rows[0].data;
    const raised = pot.members.reduce((s, m) => s + (m.contributed || 0), 0);
    const pct = Math.min(100, Math.round(raised / pot.goal * 100));
    const remaining = Math.max(0, pot.goal - raised).toFixed(2);
    const link = `https://pitchinapp.netlify.app/app.html?pot=${req.params.slug}`;
    const title = `${pot.name} — Pitch In! 💰`;
    const desc = `$${raised.toFixed(0)} raised of $${pot.goal} goal · ${pct}% funded · $${remaining} to go · Tap to pitch in with your group`;
    // Use static OG image hosted on Netlify — iMessage needs a real PNG/JPEG
    const imageUrl = `https://pitchinapp.netlify.app/og-preview.png`;
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <meta name="description" content="${desc}"/>
  <meta property="og:title" content="${title}"/>
  <meta property="og:description" content="${desc}"/>
  <meta property="og:url" content="${link}"/>
  <meta property="og:type" content="website"/>
  <meta property="og:image" content="${imageUrl}"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta property="og:image:type" content="image/png"/>
  <meta property="og:site_name" content="Pitch-In"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${title}"/>
  <meta name="twitter:description" content="${desc}"/>
  <meta name="twitter:image" content="${imageUrl}"/>
  <meta http-equiv="refresh" content="0;url=${link}"/>
</head>
<body>
  <h1>${title}</h1>
  <p>${desc}</p>
  <a href="${link}">Tap to Pitch In →</a>
</body>
</html>`);
  } catch (err) { res.status(500).send('Error'); }
});

app.get('/og-image/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM pots WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).send('Not found');
    const pot = result.rows[0].data;
    const raised = pot.members.reduce((s, m) => s + (m.contributed || 0), 0);
    const pct = Math.min(100, Math.round(raised / pot.goal * 100));
    const barWidth = Math.round(pct * 9.6);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="#f7f8fc"/>
      <rect x="60" y="60" width="1080" height="510" rx="24" fill="white" stroke="#e2e6f3" stroke-width="2"/>
      <text x="100" y="160" font-family="Arial" font-size="52" font-weight="bold" fill="#0f1523">${pot.name.substring(0,32)}</text>
      <text x="100" y="220" font-family="Arial" font-size="28" fill="#6b7499">${pot.desc ? pot.desc.substring(0,60) : 'Group payment pot'}</text>
      <rect x="100" y="280" width="1000" height="20" rx="10" fill="#f0f2f9"/>
      <rect x="100" y="280" width="${barWidth}" height="20" rx="10" fill="${pct>=100?'#f59e0b':'#2352e8'}"/>
      <text x="100" y="350" font-family="Arial" font-size="36" font-weight="bold" fill="#2352e8">$${raised.toFixed(0)} raised</text>
      <text x="100" y="395" font-family="Arial" font-size="28" fill="#6b7499">of $${pot.goal} goal · ${pct}% funded</text>
      <rect x="100" y="440" width="280" height="72" rx="36" fill="#2352e8"/>
      <text x="240" y="485" font-family="Arial" font-size="28" font-weight="bold" fill="white" text-anchor="middle">Pitch In →</text>
      <text x="1100" y="545" font-family="Arial" font-size="22" fill="#8891b0" text-anchor="end">Pitch-In</text>
    </svg>`);
  } catch (err) { res.status(500).send('Error'); }
});

// ── WALLET: Get or create ──────────────────────────────────
app.post('/wallet/get-or-create', async (req, res) => {
  try {
    const { email, displayName } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    let result = await pool.query('SELECT * FROM wallets WHERE email = $1', [email]);
    if (!result.rows.length) {
      await pool.query(
        'INSERT INTO wallets (email, display_name) VALUES ($1, $2)',
        [email, displayName || email.split('@')[0]]
      );
      result = await pool.query('SELECT * FROM wallets WHERE email = $1', [email]);
      emailWelcome(email, displayName || email.split('@')[0]).catch(() => {});
    } else if (displayName && !result.rows[0].display_name) {
      await pool.query('UPDATE wallets SET display_name = $1 WHERE email = $2', [displayName, email]);
      result = await pool.query('SELECT * FROM wallets WHERE email = $1', [email]);
    }
    const wallet = result.rows[0];
    // Get recent transactions
    const txResult = await pool.query(
      'SELECT * FROM transactions WHERE email = $1 ORDER BY created_at DESC LIMIT 20',
      [email]
    );
    res.json({ wallet, transactions: txResult.rows });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── WALLET: Save payout card ───────────────────────────────
app.post('/wallet/save-card', async (req, res) => {
  try {
    const { email, paymentMethodId, last4 } = req.body;
    let customerId;
    const existing = await pool.query('SELECT stripe_customer_id FROM wallets WHERE email = $1', [email]);
    if (existing.rows.length && existing.rows[0].stripe_customer_id) {
      customerId = existing.rows[0].stripe_customer_id;
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } else {
      const customer = await stripe.customers.create({ email, payment_method: paymentMethodId });
      customerId = customer.id;
    }
    await pool.query(
      'UPDATE wallets SET stripe_customer_id=$1, payout_method_id=$2, payout_last4=$3, updated_at=NOW() WHERE email=$4',
      [customerId, paymentMethodId, last4, email]
    );
    res.json({ success: true, last4 });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── WALLET: Withdraw ───────────────────────────────────────
const MOOV_PUBLIC_KEY = process.env.MOOV_PUBLIC_KEY;
const MOOV_SECRET_KEY = process.env.MOOV_SECRET_KEY;
const MOOV_ACCOUNT_ID = process.env.MOOV_ACCOUNT_ID;

// Moov API helper
async function moovRequest(method, path, body) {
  const credentials = Buffer.from(`${MOOV_PUBLIC_KEY}:${MOOV_SECRET_KEY}`).toString('base64');
  const res = await fetch(`https://api.moov.io${path}`, {
    method,
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
      'X-Wait-For': 'rail-response'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

// Create or get Moov account for organizer
async function getOrCreateMoovAccount(email, displayName) {
  // Check if we already have a Moov account ID stored
  const result = await pool.query('SELECT moov_account_id FROM wallets WHERE email = $1', [email]);
  if (result.rows.length && result.rows[0].moov_account_id) {
    return result.rows[0].moov_account_id;
  }
  // Create new Moov account
  const nameParts = (displayName || email.split('@')[0]).split(' ');
  const response = await moovRequest('POST', '/accounts', {
    accountType: 'individual',
    profile: {
      individual: {
        name: {
          firstName: nameParts[0] || 'User',
          lastName: nameParts[1] || 'Pitch-In'
        },
        email
      }
    },
    capabilities: ['send-funds', 'collect-funds'],
    foreignID: email
  });
  if (response.status === 200 || response.status === 201) {
    const moovAccountId = response.data.accountID;
    await pool.query('UPDATE wallets SET moov_account_id = $1 WHERE email = $2', [moovAccountId, email]);
    return moovAccountId;
  }
  throw new Error('Could not create Moov account: ' + JSON.stringify(response.data));
}

// Get Moov link token for user to add payment method
app.post('/moov/link-token', async (req, res) => {
  try {
    const { email, displayName } = req.body;
    const moovAccountId = await getOrCreateMoovAccount(email, displayName);
    // Create a link token for the frontend to use Moov Drop-in UI
    const response = await moovRequest('POST', `/accounts/${MOOV_ACCOUNT_ID}/transfers`, null);
    res.json({ success: true, moovAccountId });
  } catch (err) {
    console.error('Moov link token error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Get Moov payment methods for account
app.get('/moov/payment-methods/:email', async (req, res) => {
  try {
    const result = await pool.query('SELECT moov_account_id FROM wallets WHERE email = $1', [req.params.email]);
    if (!result.rows.length || !result.rows[0].moov_account_id) {
      return res.json({ paymentMethods: [] });
    }
    const moovAccountId = result.rows[0].moov_account_id;
    const response = await moovRequest('GET', `/accounts/${moovAccountId}/payment-methods`);
    res.json({ paymentMethods: response.data || [] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/wallet/withdraw', async (req, res) => {
  try {
    const { email, amount, method } = req.body;
    if (!email || !amount) return res.status(400).json({ error: 'Email and amount required' });

    const walletResult = await pool.query('SELECT * FROM wallets WHERE email = $1', [email]);
    if (!walletResult.rows.length) return res.status(404).json({ error: 'Wallet not found' });
    const wallet = walletResult.rows[0];

    if (parseFloat(wallet.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    const instantFee = method === 'instant' ? Math.round(amountCents * INSTANT_FEE) : 0;
    const payoutCents = amountCents - instantFee;
    const payoutAmount = payoutCents / 100;

    let payoutId, arrivalDate, actualMethod;

    if (method === 'instant') {
      // Use Moov for instant payout
      try {
        const moovAccountId = await getOrCreateMoovAccount(email, wallet.display_name);

        // Get payment methods for this account
        const pmResponse = await moovRequest('GET', `/accounts/${moovAccountId}/payment-methods`);
        const paymentMethods = pmResponse.data || [];
        const rtpMethod = paymentMethods.find(pm => pm.paymentMethodType === 'rtp-credit' || pm.paymentMethodType === 'ach-credit-same-day' || pm.paymentMethodType === 'push-to-card');

        if (!rtpMethod) {
          return res.status(400).json({
            error: 'no_payment_method',
            message: 'No instant payout method on file. Please add a debit card first.',
            moovAccountId,
            needsSetup: true
          });
        }

        // Get Pitch-In's Moov payment method to send from
        const platformPMResponse = await moovRequest('GET', `/accounts/${MOOV_ACCOUNT_ID}/payment-methods`);
        const platformPMs = platformPMResponse.data || [];
        const platformPM = platformPMs.find(pm => pm.paymentMethodType === 'moov-wallet');

        if (!platformPM) throw new Error('Platform wallet not configured in Moov');

        // Create transfer
        const transfer = await moovRequest('POST', '/transfers', {
          source: {
            accountID: MOOV_ACCOUNT_ID,
            paymentMethodID: platformPM.paymentMethodID
          },
          destination: {
            accountID: moovAccountId,
            paymentMethodID: rtpMethod.paymentMethodID
          },
          amount: { currency: 'USD', value: payoutCents },
          description: `Pitch-In wallet withdrawal for ${email}`
        });

        if (transfer.status !== 200 && transfer.status !== 201) {
          throw new Error('Transfer failed: ' + JSON.stringify(transfer.data));
        }

        payoutId = transfer.data.transferID;
        actualMethod = 'instant';
        arrivalDate = 'Within 30 minutes';
      } catch (moovErr) {
        console.error('Moov instant payout failed:', moovErr.message);
        // Don't fall back silently — tell the user
        return res.status(400).json({ error: moovErr.message });
      }
    } else {
      // Standard withdrawal via Stripe
      const payout = await stripe.payouts.create({
        amount: payoutCents,
        currency: 'usd',
        method: 'standard',
        metadata: { email, walletWithdrawal: 'true' }
      });
      payoutId = payout.id;
      actualMethod = 'standard';
      arrivalDate = new Date(payout.arrival_date * 1000).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      });
    }

    // Deduct from wallet
    await pool.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE email = $2',
      [amount, email]
    );

    // Record transaction
    await pool.query(
      'INSERT INTO transactions (email, type, amount, fee, description, stripe_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [email, 'withdrawal', amount, instantFee / 100, `${actualMethod === 'instant' ? 'Instant' : 'Standard'} withdrawal`, payoutId]
    );

    const displayName = wallet.display_name || email.split('@')[0];
    emailWithdrawal(email, displayName, payoutAmount.toFixed(2), actualMethod === 'instant' ? 'Instant (30 min)' : 'Standard (next business day)', arrivalDate).catch(() => {});

    res.json({
      success: true,
      amount: payoutAmount,
      fee: instantFee / 100,
      method: actualMethod,
      arrivalDate,
      newBalance: parseFloat(wallet.balance) - parseFloat(amount)
    });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── POT: Save ──────────────────────────────────────────────
app.post('/save-pot', async (req, res) => {
  try {
    const { pot } = req.body;
    if (!pot || !pot.id) return res.status(400).json({ error: 'Invalid pot' });
    const slug = pot.id.slice(-8);
    await pool.query(
      'INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()',
      [slug, JSON.stringify(pot)]
    );
    res.json({ success: true, slug });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── POT: Get ───────────────────────────────────────────────
app.get('/get-pot/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM pots WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).json({ error: 'Pot not found' });
    res.json({ pot: result.rows[0].data });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── PAYMENTS: Create PaymentIntent ────────────────────────
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, potId, potName, deadline } = req.body;
    // Use manual capture for pots under 7 days (auth hold model)
    // Use immediate capture for pots over 7 days (charge + refund model)
    const hoursUntilDeadline = deadline ? (deadline - Date.now()) / (1000 * 60 * 60) : 0;
    const useAuthCapture = hoursUntilDeadline > 0 && hoursUntilDeadline <= 167; // under 7 days

    const intentParams = {
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { potId, potName, useAuthCapture: useAuthCapture ? 'true' : 'false' },
      automatic_payment_methods: { enabled: true },
    };

    if (useAuthCapture) {
      intentParams.capture_method = 'manual'; // authorize only, don't charge yet
    }

    const paymentIntent = await stripe.paymentIntents.create(intentParams);
    res.json({ clientSecret: paymentIntent.client_secret, useAuthCapture });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// Capture all authorized payments when pot fills
app.post('/capture-pot-payments', async (req, res) => {
  try {
    const { potId } = req.body;
    const slug = potId.slice(-8);
    const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [slug]);
    if (!potResult.rows.length) return res.status(404).json({ error: 'Pot not found' });
    const pot = potResult.rows[0].data;

    const results = [];
    for (const member of pot.members) {
      if (member.paymentIntentId && member.contributed > 0 && !member.captured) {
        try {
          const pi = await stripe.paymentIntents.retrieve(member.paymentIntentId);
          if (pi.capture_method === 'manual' && pi.status === 'requires_capture') {
            await stripe.paymentIntents.capture(member.paymentIntentId);
            member.captured = true;
            results.push({ name: member.name, status: 'captured', amount: member.contributed });
          } else {
            // Already captured (immediate charge model)
            member.captured = true;
            results.push({ name: member.name, status: 'already_captured' });
          }
        } catch (e) {
          results.push({ name: member.name, status: 'error', error: e.message });
        }
      }
    }

    await pool.query(
      'INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()',
      [slug, JSON.stringify(pot)]
    );
    res.json({ success: true, results });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── PAYMENTS: Confirm contribution ────────────────────────
app.post('/confirm-contribution', async (req, res) => {
  try {
    const { potId, memberName, amount, paymentIntentId, email } = req.body;
    const slug = potId.slice(-8);
    const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [slug]);
    if (!potResult.rows.length) return res.status(404).json({ error: 'Pot not found' });
    const pot = potResult.rows[0].data;

    // Update member
    const existing = pot.members.find(m => m.name === memberName);
    if (existing) {
      existing.contributed = parseFloat(((existing.contributed || 0) + parseFloat(amount)).toFixed(2));
      existing.paymentIntentId = paymentIntentId;
      if (email) existing.email = email;
    } else {
      pot.members.push({ name: memberName, contributed: parseFloat(amount), paymentIntentId, email: email || null });
    }

    // Track contributor wallet
    if (email) {
      await pool.query(
        'INSERT INTO wallets (email, display_name, total_contributed) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET total_contributed = wallets.total_contributed + $3, updated_at = NOW()',
        [email, memberName, amount]
      );
      await pool.query(
        'INSERT INTO transactions (email, type, amount, description, pot_slug, pot_name) VALUES ($1, $2, $3, $4, $5, $6)',
        [email, 'contribution', amount, `Pitched in to ${pot.name}`, slug, pot.name]
      );
    }

    await pool.query(
      'INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()',
      [slug, JSON.stringify(pot)]
    );

    const potLink = `https://pitchinapp.netlify.app/app.html?pot=${slug}`;
    if (email) emailContributionConfirmed(email, memberName, amount, pot.name, potLink).catch(() => {});

    // Check if pot is full
    const raised = pot.members.reduce((s, m) => s + (m.contributed || 0), 0);
    const isFull = raised >= pot.goal;

    if (isFull && !pot.released) {
      pot.released = true;
      pot.releasedAt = new Date().toISOString();

      // Capture all authorized payments first
      for (const member of pot.members) {
        if (member.paymentIntentId && member.contributed > 0 && !member.captured) {
          try {
            const pi = await stripe.paymentIntents.retrieve(member.paymentIntentId);
            if (pi.capture_method === 'manual' && pi.status === 'requires_capture') {
              await stripe.paymentIntents.capture(member.paymentIntentId);
            }
            member.captured = true;
          } catch (e) {
            console.warn('Capture error for', member.name, e.message);
          }
        }
      }

      const feeCents = Math.round(raised * 100 * PLATFORM_FEE);
      const organizerAmount = parseFloat(((raised * 100 - feeCents) / 100).toFixed(2));

      // Credit organizer wallet instantly
      if (pot.organizerEmail) {
        await pool.query(
          `INSERT INTO wallets (email, display_name, balance, total_earned)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (email) DO UPDATE SET
             balance = wallets.balance + $3,
             total_earned = wallets.total_earned + $3,
             updated_at = NOW()`,
          [pot.organizerEmail, pot.organizerEmail.split('@')[0], organizerAmount]
        );
        await pool.query(
          'INSERT INTO transactions (email, type, amount, fee, description, pot_slug, pot_name) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [pot.organizerEmail, 'pot_earned', organizerAmount, raised * PLATFORM_FEE, `${pot.name} completed`, slug, pot.name]
        );
        pot.payoutStatus = 'in_wallet';
        emailPotFilled(pot.organizerEmail, pot.name, organizerAmount.toFixed(2), potLink).catch(() => {});
      }

      // Notify all contributors
      pot.members.forEach(m => {
        if (m.email && m.email !== pot.organizerEmail) {
          emailContributorPotFilled(m.email, m.name, pot.name, potLink).catch(() => {});
        }
      });

      await pool.query(
        'INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()',
        [slug, JSON.stringify(pot)]
      );

      return res.json({ success: true, potFull: true, raised, organizerAmount });
    }

    await pool.query(
      'INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()',
      [slug, JSON.stringify(pot)]
    );
    res.json({ success: true, potFull: false, raised });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── PAYMENTS: Refund ───────────────────────────────────────
app.post('/withdraw', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const refund = await stripe.refunds.create({ payment_intent: paymentIntentId });
    res.json({ refund });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// ── PAYMENTS: Refund expired pot ──────────────────────────
app.post('/refund-expired-pot', async (req, res) => {
  try {
    const { potId } = req.body;
    const slug = potId.slice(-8);
    const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [slug]);
    if (!potResult.rows.length) return res.status(404).json({ error: 'Pot not found' });
    const pot = potResult.rows[0].data;
    if (pot.refunded) return res.json({ success: true, message: 'Already refunded' });

    const results = [];
    for (const member of pot.members) {
      if (member.paymentIntentId && member.contributed > 0) {
        try {
          const pi = await stripe.paymentIntents.retrieve(member.paymentIntentId);
          if (pi.capture_method === 'manual' && pi.status === 'requires_capture') {
            // Authorization hold — just cancel it, no refund needed, nothing was charged
            await stripe.paymentIntents.cancel(member.paymentIntentId);
            member.refunded = true;
            member.refundId = 'auth_cancelled';
            results.push({ name: member.name, status: 'authorization_cancelled', amount: member.contributed });
          } else if (pi.status === 'succeeded') {
            // Already captured — do a real refund
            const refund = await stripe.refunds.create({ payment_intent: member.paymentIntentId });
            member.refunded = true;
            member.refundId = refund.id;
            results.push({ name: member.name, status: 'refunded', amount: member.contributed });
          }
          if (member.email) emailRefund(member.email, member.name, member.contributed, pot.name).catch(() => {});
        } catch (e) {
          results.push({ name: member.name, status: 'error', error: e.message });
        }
      }
    }

    pot.refunded = true;
    pot.refundedAt = new Date().toISOString();
    await pool.query(
      'INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()',
      [slug, JSON.stringify(pot)]
    );
    res.json({ success: true, results });
  } catch (err) { console.error(err); res.status(400).json({ error: err.message }); }
});

// Get payment intent details (used after Cash App Pay redirect)
app.get('/get-payment-intent/:id', async (req, res) => {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(req.params.id);
    res.json({
      amount: paymentIntent.amount,
      status: paymentIntent.status,
      potId: paymentIntent.metadata.potId,
      potName: paymentIntent.metadata.potName
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Pitch-In backend running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pitch-In backend on port ${PORT}`));
