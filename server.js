// server.js - Local payment server for Stripe integration testing
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();

// Configure CORS to allow localhost requests
app.use(cors({
  origin: ['http://127.0.0.1:5500', 'https://kenyaonabudgetsafaris.co.uk', 'http://localhost:5500', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', message: 'Payment server is running' });
});

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    // Extract all relevant data from the request body
    const { 
      packageId, 
      userId, 
      originalAmount,  // Original amount before discount
      amount,          // Final amount after discount
      packageName,
      couponCode,      // Coupon code if applied
      discountAmount   // Amount discounted
    } = req.body;
    
    console.log('Creating checkout session:', { 
      packageId, 
      userId, 
      originalAmount, 
      finalAmount: amount, 
      packageName,
      couponCode,
      discountAmount 
    });
    
    // Validate required fields
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: 'Missing amount' });
    }

    // Check if this is a free booking (100% discount)
    if (amount === 0 || amount === '0') {
      console.log('Detected free booking (100% discount). This should be handled client-side.');
      return res.status(400).json({ 
        error: 'Free bookings should be processed without Stripe',
        code: 'FREE_BOOKING'
      });
    }

    const timestamp = Date.now();
    
    // Prepare product name with coupon info if a coupon was applied
    const productName = couponCode 
      ? `${packageName || 'Kenya Safari Package'} (Coupon: ${couponCode})` 
      : packageName || 'Kenya Safari Package';
      
    // Prepare product description
    const productDescription = couponCode && discountAmount 
      ? `Original price: £${originalAmount.toFixed(2)}, Discount: £${discountAmount.toFixed(2)}`
      : 'KenyaOnABudget Safaris booking';

    // For local testing, redirect to localhost URLs
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: productName,
            description: productDescription
          },
          unit_amount: Math.round(amount * 100), // Convert to pence - use discounted amount
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://kenyaonabudgetsafaris.co.uk/payment-success.html?session_id={CHECKOUT_SESSION_ID}&userId=${userId}&timestamp=${timestamp}`,
      cancel_url: `https://kenyaonabudgetsafaris.co.uk/packages/payment-cancelled.html?userId=${userId}&timestamp=${timestamp}`,
      client_reference_id: userId,
      metadata: {
        userId: userId,
        timestamp: timestamp.toString(),
        packageId: packageId,
        packageName: packageName || 'Kenya Safari Package',
        originalAmount: originalAmount ? originalAmount.toString() : amount.toString(),
        discountAmount: discountAmount ? discountAmount.toString() : '0',
        couponCode: couponCode || 'none',
        hasCoupon: couponCode ? 'true' : 'false'
      }
    });

    console.log('Checkout session created:', session.id);
    
    res.json({ 
      id: session.id,
      timestamp: timestamp 
    });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify payment endpoint
app.post('/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    console.log('Verifying payment for session:', sessionId);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log('Session retrieved:', {
      id: session.id,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      metadata: session.metadata
    });

    if (session.payment_status === 'paid') {
      // Extract discount information from metadata
      const metadata = session.metadata || {};
      const originalAmount = parseFloat(metadata.originalAmount || (session.amount_total / 100));
      const discountAmount = parseFloat(metadata.discountAmount || 0);
      const finalAmount = session.amount_total / 100;
      const couponCode = metadata.couponCode !== 'none' ? metadata.couponCode : null;
      
      res.json({
        paid: true,
        amount: finalAmount,
        originalAmount: originalAmount,
        discountAmount: discountAmount,
        finalAmount: finalAmount,
        couponCode: couponCode,
        customerId: session.customer,
        metadata: session.metadata
      });
    } else {
      res.json({ 
        paid: false,
        status: session.payment_status,
        metadata: session.metadata
      });
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add endpoint to ping companion app
app.get('/ping-companion', async (req, res) => {
  try {
    const companionUrl = process.env.COMPANION_APP_URL;
    if (!companionUrl) {
      return res.status(400).json({ error: 'Companion app URL not configured' });
    }
    
    const response = await fetch(`${companionUrl}/health`);
    const data = await response.json();
    
    console.log('🏓 Pinged companion app successfully:', data);
    res.json({ success: true, companionStatus: data });
  } catch (error) {
    console.error('Failed to ping companion app:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`
===========================================
🔥 Payment Server running on port ${PORT} 🔥
===========================================

Available endpoints:
- GET  /health                     - Check server health
- POST /create-checkout-session    - Create Stripe checkout session (now supports coupons!)
- POST /verify-payment             - Verify payment status
- GET  /ping-companion             - Ping companion app to keep it alive

Server is ready for local testing with Stripe!
  `);
  
  // Set up keep-alive mechanisms
  setupKeepAlive();
});

function setupKeepAlive() {
  // Add keep-alive ping to prevent sleep on Render free tier
  if (process.env.NODE_ENV === 'production') {
    // 1. Self-ping to keep this server alive
    const serviceUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
      try {
        fetch(`${serviceUrl}/health`)
          .then(() => console.log('🏓 Self keep-alive ping sent'))
          .catch(err => console.error('Self keep-alive ping failed:', err.message));
      } catch (error) {
        console.error('Error sending self keep-alive ping:', error.message);
      }
    }, 10 * 60 * 1000); // Every 10 minutes
    
    // 2. Ping companion app to keep it alive
    const companionUrl = process.env.COMPANION_APP_URL;
    if (companionUrl) {
      setInterval(() => {
        try {
          fetch(`${companionUrl}/health`)
            .then(() => console.log('🏓 Companion keep-alive ping sent'))
            .catch(err => console.error('Companion keep-alive ping failed:', err.message));
        } catch (error) {
          console.error('Error sending companion keep-alive ping:', error.message);
        }
      }, 14 * 60 * 1000); // Every 14 minutes (offset from self-ping to distribute pings)
    } else {
      console.warn('⚠️ Companion app URL not configured. Add COMPANION_APP_URL to your environment variables for mutual pinging.');
    }
  }
}
