const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Pitch-In backend running');
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, potId, potName } = req.body;
    const amountCents = Math.round(amount * 100);
    const feeAmount = Math.round(amountCents * 0.02);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      application_fee_amount: feeAmount,
      metadata: { potId, potName },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/withdraw', async (req, res) => {
  try {
    const { paymentIntentId, early } = req.body;
    const refundAmount = early ? null : undefined;
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: refundAmount,
    });
    res.json({ refund });
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pitch-In backend running on port ${PORT}`));
