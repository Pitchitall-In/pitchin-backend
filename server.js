const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
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
      stripe_account_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}
initDB().catch(console.error);

app.get('/', (req, res) => {
  res.send('Pitch-In backend running');
});

app.post('/connect/onboard', async (req, res) => {
  try {
    const { email, potId, returnUrl } = req.body;
    const existing = await pool.query('SELECT stripe_account_id FROM organizers WHERE email = $1', [email]);
    let accountId;
    if (existing.rows.length) {
      accountId = existing.rows[0].stripe_account_id;
    } else {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_type: 'individual',
        metadata: { potId }
      });
      accountId = account.id;
      await pool.query('INSERT INTO organizers (email, stripe_account_id) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [email, accountId]);
    }
    if (potId) {
      const potSlug = potId.slice(-8);
      const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [potSlug]);
      if (potResult.rows.length) {
        const pot = potResult.rows[0].data;
        pot.connectedAccountId = accountId;
        pot.organizerEmail = email;
        await pool.query('INSERT INTO pots (slug, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (slug) DO UPDATE SET data = $2, updated_at = NOW()', [potSlug, JSON.stringify(pot)]);
      }
    }
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: returnUrl + '&connect=refresh',
      return_url: returnUrl + '&connect=success',
      type: 'account_onboarding',
    });
    res.json({ url: accountLink.url, accountId });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/connect/status/:accountId', async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve(req.params.accountId);
    res.json({ connected: account.charges_enabled && account.payouts_enabled, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, potId, potName } = req.body;
    const amountCents = Math.round(amount * 100);
    const feeAmount = Math.round(amountCents * 0.02);
    const potSlug = potId.slice(-8);
    const potResult = await pool.query('SELECT data FROM pots WHERE slug = $1', [potSlug]);
    const pot = potResult.rows.length ? potResult.rows[0].data : null;
    const connectedAccountId = pot ? pot.connectedAccountId : null;
    const intentParams = {
      amount: amountCents,
      currency: 'usd',
      metadata: { potId, potName },
      automatic_payment_methods: { enabled: true },
    };
    if (connectedAccountId) {
      intentParams.application_fee_amount = feeAmount;
      intentParams.transfer_data = { destination: connectedAccountId };
    }
    const paymentIntent = await stripe.paymentIntents.create(intentParams);
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pitch-In backend on port ${PORT}`));
