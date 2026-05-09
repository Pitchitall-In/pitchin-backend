const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PLATFORM_FEE = 0.02; // 2%

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

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pots (
      slug VARCHAR(8) PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizers (
      email VARCHAR(255) PRIMARY KEY,
      stripe_customer_id VARCHAR(255),
      payout_method_id VARCHAR(255),
      payout_last4 VARCHAR(4),
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
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Pitch-In <noreply@pitchinapp.netlify.app>',
        to,
        subject,
        html
      })
    });
  } catch (err) {
    console.warn('Email error:', err.message);
  }
}

function emailContributionConfirmed(email, name, amount, potName, potLink) {
  return sendEmail({
    to: email,
    subject: `✓ You're in! $${amount} added to ${potName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#2352e8">You're in! 💸</h2>
        <p>Hey ${name}, your <strong>$${amount}</strong> has been added to <strong>${potName}</strong>.</p>
        <p style="color:#666">Your money is held securely by Stripe. If the pot doesn't fill before the deadline, you'll be automatically refunded in full.</p>
        <a href="${potLink}" style="display:inline-block;background:#2352e8;color:white;padding:12px 24px;border-radius:50px;text-decoration:none;margin:16px 0">View the Pot</a>
        <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
      </div>
    `
  });
}

function emailPotFilled(organizerEmail, potName, amount, potLink) {
  return sendEmail({
    to: organizerEmail,
    subject: `🎉 Your pot is full! $${amount} on the way`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#0a8a4a">Your pot is full! 🎉</h2>
        <p><strong>${potName}</strong> has reached its goal of <strong>$${amount}</strong>.</p>
        <p style="color:#666">Your payout has been initiated and should arrive within 30 minutes to your debit card on file.</p>
        <a href="${potLink}" style="display:inline-block;background:#0a8a4a;color:white;padding:12px 24px;border-radius:50px;text-decoration:none;margin:16px 0">View Completed Pot</a>
        <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
      </div>
    `
  });
}

function emailContributorPotFilled(email, name, potName, potLink) {
  return sendEmail({
    to: email,
    subject: `🎉 ${potName} is full!`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#0a8a4a">The pot is full! 🎉</h2>
        <p>Hey ${name}, <strong>${potName}</strong> has reached its goal! The organizer will receive the funds shortly.</p>
        <a href="${potLink}" style="display:inline-block;background:#2352e8;color:white;padding:12px 24px;border-radius:50px;text-decoration:none;margin:16px 0">View the Pot</a>
        <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
      </div>
    `
  });
}

function emailRefund(email, name, amount, potName) {
  return sendEmail({
    to: email,
    subject: `↩ Refund: $${amount} from ${potName} is on its way`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#c8193a">Pot expired — refund coming ↩</h2>
        <p>Hey ${name}, <strong>${potName}</strong> didn't reach its goal in time.</p>
        <p>Your <strong>$${amount}</strong> is being refunded to your original payment method. Expect it within 5-10 business days.</p>
        <p style="color:#666">No fees were charged on this pot.</p>
        <p style="color:#999;font-size:12px">Pitch-In · Pool money with your group</p>
      </div>
    `
  });
}

// ── OPEN GRAPH: Dynamic pot preview for link sharing ───────
app.get('/og/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM pots WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).send('Not found');
    const pot = result.rows[0].data;
    const raised = pot.members.reduce((s, m) => s + (m.contributed || 0), 0);
    const pct = Math.min(100, Math.round(raised / pot.goal * 100));
    const link = `https://pitchinapp.netlify.app/app.html?pot=${req.params.slug}`;

    // Return HTML page with Open Graph meta tags
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta property="og:title" content="${pot.name} — Pitch In!"/>
  <meta property="og:description" content="$${raised.toFixed(0)} of $${pot.goal} raised · ${pct}% funded · Tap to pitch in"/>
  <meta property="og:url" content="${link}"/>
  <meta property="og:type" content="website"/>
  <meta property="og:image" content="https://pitchin-backend-cjat.onrender.com/og-image/${req.params.slug}"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${pot.name} — Pitch In!"/>
  <meta name="twitter:description" content="$${raised.toFixed(0)} of $${pot.goal} raised · ${pct}% funded"/>
  <meta http-equiv="refresh" content="0;url=${link}"/>
</head>
<body><a href="${link}">Click here to view the pot</a></body>
</html>`);
  } catch (err) {
    res.status(500).send('Error');
  }
});

// Generate OG image as SVG
app.get('/og-image/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM pots WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).send('Not found');
    const pot = result.rows[0].data;
    const raised = pot.members.reduce((s, m) => s + (m.contributed || 0), 0);
    const pct = Math.min(100, Math.round(raised / pot.goal * 100));
    const barWidth = Math.round(pct * 9.6); // 960px max bar

    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#f7f8fc"/>
  <rect x="60" y="60" width="1080" height="510" rx="24" fill="white" stroke="#e2e6f3" stroke-width="2"/>
  <text x="100" y="160" font-family="Arial" font-size="52" font-weight="bold" fill="#0f1523">${pot.name.substring(0, 32)}</text>
  <text x="100" y="220" font-family="Arial" font-size="28" fill="#6b7499">${pot.desc ? pot.desc.substring(0, 60) : 'Group payment pot'}</text>
  <rect x="100" y="280" width="1000" height="20" rx="10" fill="#f0f2f9"/>
  <rect x="100" y="280" width="${barWidth}" height="20" rx="10" fill="${pct >= 100 ? '#f59e0b' : '#2352e8'}"/>
  <text x="100" y="350" font-family="Arial" font-size="36" font-weight="bold" fill="#2352e8">$${raised.toFixed(0)} raised</text>
  <text x="100" y="395" font-family="Arial" font-size="28" fill="#6b7499">of $${pot.goal} goal · ${pct}% funded</text>
  <rect x="100" y="440" width="280" height="72" rx="36" fill="#2352e8"/>
  <text x="240" y="485" font-family="Arial" font-size="28" font-weight="bold" fill="white" text-anchor="middle">Pitch In →</text>
  <text x="1100" y="545" font-family="Arial" font-size="22" fill="#8891b0" text-anchor="end">Pitch-In</text>
</svg>`);
  } catch (err) {
    res.status(500).send('Error');
  }
});

// ── ORGANIZER: Save payout card ────────────────────────────
app.post('/save-organizer-card', async (req, res) => {
  try {
    const { email, paymentMethodId, last4, potId } = req.body;

    // Create or get Stripe customer for organizer
    let customerId;
    const existing = await pool.query('SELECT stripe_customer_id FROM organizers WHERE email = $1', [email]);
    if (existing.rows.length && existing.rows[0].stripe_customer_id) {
      customerId = existing.rows[0].stripe_customer_id;
      // Update payment method
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
    } else {
      const customer = await stripe.customers.create({
        email,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId }
      });
      customerId = customer.id;
    }

    await pool.query(`
      INSERT INTO organizers (email, stripe_customer_id, payout_method_id, payout_last4)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET
        stripe_customer_id = $2, payout_method_id = $3, payout_last4 = $4
    `, [email, customerId, paymentMethodId, last4]);

    // Attach card to pot
    if (potId) {
      const slug = potId.slice(-8);
      const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [slug]);
      if (potResult.rows.length) {
        const pot = potResult.rows[0].data;
        pot.organizerEmail = email;
        pot.organizerCustomerId = customerId;
        pot.organizerPayoutMethodId = paymentMethodId;
        pot.organizerPayoutLast4 = last4;
        await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [slug, JSON.stringify(pot)]);
      }
    }

    res.json({ success: true, customerId, last4 });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ── POT: Save ──────────────────────────────────────────────
app.post('/save-pot', async (req, res) => {
  try {
    const { pot } = req.body;
    if (!pot || !pot.id) return res.status(400).json({ error: 'Invalid pot' });
    const slug = pot.id.slice(-8);
    await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [slug, JSON.stringify(pot)]);
    res.json({ success: true, slug });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ── POT: Get ───────────────────────────────────────────────
app.get('/get-pot/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM pots WHERE slug = $1', [req.params.slug]);
    if (!result.rows.length) return res.status(404).json({ error: 'Pot not found' });
    res.json({ pot: result.rows[0].data });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ── PAYMENTS: Create PaymentIntent ────────────────────────
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, potId, potName } = req.body;
    const amountCents = Math.round(amount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      metadata: { potId, potName },
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ── PAYMENTS: Confirm contribution + check if pot is full ─
app.post('/confirm-contribution', async (req, res) => {
  try {
    const { potId, memberName, amount, paymentIntentId, email } = req.body;
    const slug = potId.slice(-8);
    const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [slug]);
    if (!potResult.rows.length) return res.status(404).json({ error: 'Pot not found' });
    const pot = potResult.rows[0].data;

    // Update member contribution
    const existing = pot.members.find(m => m.name === memberName);
    if (existing) {
      existing.contributed = parseFloat(((existing.contributed || 0) + parseFloat(amount)).toFixed(2));
      existing.paymentIntentId = paymentIntentId;
      if (email) existing.email = email;
    } else {
      pot.members.push({ name: memberName, contributed: parseFloat(amount), paymentIntentId, email: email || null });
    }

    // Save updated pot
    await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [slug, JSON.stringify(pot)]);

    // Send confirmation email to contributor
    const potLink = `https://pitchinapp.netlify.app/app.html?pot=${slug}`;
    if (email) {
      emailContributionConfirmed(email, memberName, amount, pot.name, potLink).catch(() => {});
    }

    // Check if pot is now full
    const raised = pot.members.reduce((s, m) => s + (m.contributed || 0), 0);
    const isFull = raised >= pot.goal;

    if (isFull && !pot.released) {
      pot.released = true;
      pot.releasedAt = new Date().toISOString();

      // Calculate Pitch-In fee
      const totalCents = Math.round(raised * 100);
      const feeCents = Math.round(totalCents * PLATFORM_FEE);
      const payoutCents = totalCents - feeCents;

      // Instant payout to organizer's saved card if available
      let payoutResult = null;
      if (pot.organizerCustomerId && pot.organizerPayoutMethodId) {
        try {
          // Create a payout via Stripe
          const transfer = await stripe.payouts.create({
            amount: payoutCents,
            currency: 'usd',
            method: 'instant',
            destination: pot.organizerPayoutMethodId,
          }, {
            stripeAccount: pot.organizerCustomerId
          });
          payoutResult = { status: 'instant', transfer: transfer.id };
          pot.payoutStatus = 'instant';
        } catch (payoutErr) {
          console.warn('Instant payout failed, trying standard:', payoutErr.message);
          payoutResult = { status: 'pending', error: payoutErr.message };
          pot.payoutStatus = 'pending';
        }
      }

      // Save final pot state
      await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [slug, JSON.stringify(pot)]);

      // Email organizer
      if (pot.organizerEmail) {
        emailPotFilled(pot.organizerEmail, pot.name, raised.toFixed(2), potLink).catch(() => {});
      }

      // Email all contributors
      pot.members.forEach(m => {
        if (m.email && m.name !== 'You') {
          emailContributorPotFilled(m.email, m.name, pot.name, potLink).catch(() => {});
        }
      });

      return res.json({ success: true, potFull: true, raised, payoutResult });
    }

    await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [slug, JSON.stringify(pot)]);
    res.json({ success: true, potFull: false, raised });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ── PAYMENTS: Early withdrawal ─────────────────────────────
app.post('/withdraw', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const refund = await stripe.refunds.create({ payment_intent: paymentIntentId });
    res.json({ refund });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ── PAYMENTS: Refund expired pot ───────────────────────────
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
          const refund = await stripe.refunds.create({ payment_intent: member.paymentIntentId });
          member.refunded = true;
          member.refundId = refund.id;
          results.push({ name: member.name, status: 'refunded', amount: member.contributed });
          // Email refund notification
          if (member.email) {
            emailRefund(member.email, member.name, member.contributed, pot.name).catch(() => {});
          }
        } catch (e) {
          results.push({ name: member.name, status: 'error', error: e.message });
        }
      }
    }

    pot.refunded = true;
    pot.refundedAt = new Date().toISOString();
    await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [slug, JSON.stringify(pot)]);
    res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Pitch-In backend running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pitch-In backend on port ${PORT}`));
