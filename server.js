// server.js - Local payment server for Stripe integration testing
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Import fetch - handling both Node.js 18+ (built-in fetch) and older versions (node-fetch package)
let fetch;
try {
  // For Node.js versions that have built-in fetch (v18+)
  fetch = global.fetch;
} catch (e) {
  // If built-in fetch is not available, try to import node-fetch
  // We'll handle this in the setupKeepAlive function to avoid startup errors
  fetch = null;
}

const app = express();

// Configure CORS to allow localhost requests
app.use(cors({
  origin: ['http://127.0.0.1:5500', 'https://kenyaonabudgetsafaris.co.uk', 'http://localhost:5500', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    message: 'Payment server is running',
    timestamp: new Date().toISOString(),
    keepAlive: process.env.NODE_ENV === 'production' ? 'active' : 'disabled'
  });
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
      success_url: `http://127.0.0.1:5500/payment-success.html?session_id={CHECKOUT_SESSION_ID}&userId=${userId}&timestamp=${timestamp}`,
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

// Endpoint to ping activity upgrades server
app.get('/ping-activity', async (req, res) => {
  try {
    const activityServerUrl = process.env.ACTIVITY_SERVER_URL;
    if (!activityServerUrl) {
      return res.status(400).json({ error: 'Activity server URL not configured' });
    }
    
    // Safe fetch handling
    const fetchModule = await getFetchModule();
    if (!fetchModule) {
      return res.status(500).json({ error: 'HTTP client not available' });
    }
    
    const response = await fetchModule(`${activityServerUrl}/health`);
    const data = await response.json();
    
    console.log('🏓 Pinged activity upgrades server successfully:', data);
    res.json({ success: true, activityServerStatus: data });
  } catch (error) {
    console.error('Failed to ping activity upgrades server:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to safely get the fetch module
async function getFetchModule() {
  // If we already have fetch, return it
  if (fetch) return fetch;
  
  try {
    // Try to use the global fetch in Node.js 18+
    if (global.fetch) {
      fetch = global.fetch;
      return fetch;
    }
    
    // Try to load node-fetch dynamically
    const nodeFetch = await import('node-fetch');
    fetch = nodeFetch.default;
    return fetch;
  } catch (error) {
    console.error('Error loading fetch module:', error.message);
    console.error('Please run: npm install node-fetch');
    return null;
  }
}

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
- GET  /ping-activity              - Ping activity upgrades server to keep it alive

Keep-alive system: ${process.env.NODE_ENV === 'production' ? 'ACTIVE' : 'DISABLED IN DEVELOPMENT MODE'}

Server is ready for local testing with Stripe!
  `);
  
  // Set up keep-alive mechanisms
  setupKeepAlive();
});

// Use a more resilient HTTP request function
async function makeHttpRequest(url) {
  try {
    // Get the fetch module safely
    const fetchModule = await getFetchModule();
    if (!fetchModule) {
      console.error('HTTP client not available - cannot make request to:', url);
      return null;
    }
    
    const response = await fetchModule(url);
    return response;
  } catch (error) {
    console.error(`Error making HTTP request to ${url}:`, error.message);
    return null;
  }
}

function setupKeepAlive() {
  // Add keep-alive ping to prevent sleep on Render free tier
  if (process.env.NODE_ENV === 'production') {
    console.log('Setting up keep-alive system...');
    
    // 1. Self-ping to keep this server alive
    const serviceUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(async () => {
      try {
        const response = await makeHttpRequest(`${serviceUrl}/health`);
        if (response) {
          console.log('🏓 Self keep-alive ping sent successfully');
        }
      } catch (error) {
        console.error('Error in self keep-alive ping:', error.message);
      }
    }, 10 * 60 * 1000); // Every 10 minutes
    
    // 2. Ping activity upgrades server to keep it alive
    const activityServerUrl = process.env.ACTIVITY_SERVER_URL;
    if (activityServerUrl) {
      setInterval(async () => {
        try {
          const response = await makeHttpRequest(`${activityServerUrl}/health`);
          if (response) {
            console.log('🏓 Activity upgrades server keep-alive ping sent successfully');
          }
        } catch (error) {
          console.error('Error in activity server ping:', error.message);
        }
      }, 13 * 60 * 1000); // Every 13 minutes (offset from self-ping)
    } else {
      console.warn('⚠️ Activity upgrades server URL not configured. Add ACTIVITY_SERVER_URL to your environment variables for mutual pinging.');
    }
  }
}
