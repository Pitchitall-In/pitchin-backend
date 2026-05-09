const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory pot storage (persists while server is running)
const potStore = {};

app.get('/', (req, res) => {
  res.send('Pitch-In backend running');
});

// Save a pot so shared links work for anyone
app.post('/save-pot', (req, res) => {
  try {
    const { pot } = req.body;
    if (!pot || !pot.id) return res.status(400).json({ error: 'Invalid pot' });
    const slug = pot.id.slice(-8);
    potStore[slug] = pot;
    res.json({ success: true, slug });
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

// Get a pot by its slug (last 8 chars of ID)
app.get('/get-pot/:slug', (req, res) => {
  try {
    const pot = potStore[req.params.slug];
    if (!pot) return res.status(404).json({ error: 'Pot not found' });
    res.json({ pot });
  } catch(err) {
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
