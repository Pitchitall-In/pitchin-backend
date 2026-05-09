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

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create pots table if it doesn't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pots (
      slug VARCHAR(8) PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}
initDB().catch(console.error);

app.get('/', (req, res) => {
  res.send('Pitch-In backend running');
});

// Save a pot
app.post('/save-pot', async (req, res) => {
  try {
    const { pot } = req.body;
    if (!pot || !pot.id) return res.status(400).json({ error: 'Invalid pot' });
    const slug = pot.id.slice(-8);
    await pool.query(
      `INSERT INTO pots (slug, data, updated_at) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (slug) DO UPDATE 
       SET data = $2, updated_at = NOW()`,
      [slug, JSON.stringify(pot)]
    );
    res.json({ success: true, slug });
  } catch(err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Get a pot by slug
app.get('/get-pot/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT data FROM pots WHERE slug = $1',
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pot not found' });
    res.json({ pot: result.rows[0].data });
  } catch(err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Create a Stripe PaymentIntent
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
  } catch(err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Refund a payment
app.post('/withdraw', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
    });
    res.json({ refund });
  } catch(err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pitch-In backend on port ${PORT}`));
