// Integrated server - Combines package booking and tipping systems
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const SibApiV3Sdk = require('sib-api-v3-sdk');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();

// Initialize Brevo API client
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

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

// Configure CORS to allow requests
app.use(cors({
  origin: ['http://127.0.0.1:5500', 'https://kenyaonabudgetsafaris.co.uk', 'http://localhost:5500', 'http://localhost:3000'],
  credentials: true
}));

// Middleware for JSON parsing, except for webhook endpoint
app.use((req, res, next) => {
  if (req.originalUrl === '/api/tip/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

//===========================================================================
// SHARED ENDPOINTS
//===========================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    message: 'Server is running (Packages & Tips)',
    timestamp: new Date().toISOString(),
    keepAlive: process.env.NODE_ENV === 'production' ? 'active' : 'disabled'
  });
});

//===========================================================================
// PACKAGE BOOKING ENDPOINTS 
//===========================================================================

// Create checkout session endpoint for package bookings
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
    
    console.log('Creating checkout session for package:', { 
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
        hasCoupon: couponCode ? 'true' : 'false',
        type: 'package' // Add type to distinguish from tips
      }
    });

    console.log('Checkout session created for package:', session.id);
    
    res.json({ 
      id: session.id,
      timestamp: timestamp 
    });
  } catch (error) {
    console.error('Error creating checkout session for package:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify payment endpoint for package bookings
app.post('/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    console.log('Verifying payment for package session:', sessionId);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log('Package session retrieved:', {
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
    console.error('Error verifying package payment:', error);
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

//===========================================================================
// TIPPING SYSTEM ENDPOINTS
//===========================================================================

/**
 * Endpoint to create a Stripe Checkout session for tips
 */
app.post('/api/tip/create-checkout-session', async (req, res) => {
  try {
    const { 
      amount, 
      currency = 'gbp', 
      recipientType, 
      recipientId, 
      recipientName,
      userId, 
      userName,
      message,
      successUrl,
      cancelUrl
    } = req.body;
    
    // Log the request
    console.log('Creating tip checkout session:', {
      amount,
      recipientType,
      recipientName,
      userId,
      message
    });
    
    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    
    // Create line item description based on recipient
    const lineItemDescription = recipientType === 'guide' 
      ? `Tip for ${recipientName}`
      : 'Tip for Kenya on a Budget Safaris';
    
    // Create checkout session with Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: lineItemDescription,
              description: message || 'Thank you for your service!',
              images: ['https://kenyaonabudgetsafaris.co.uk/logo1.png'],
            },
            unit_amount: Math.round(amount * 100), // Stripe requires amount in cents/pence
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl || `https://kenyaonabudgetsafaris.co.uk/tip-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `https://kenyaonabudgetsafaris.co.uk/tip-cancel.html`,
      metadata: {
        recipientType,
        recipientId,
        recipientName,
        userId,
        userName,
        message,
        type: 'tip' // Add type to distinguish from packages
      }
    });
    
    console.log('Tip checkout session created:', session.id);
    
    res.json({
      sessionId: session.id
    });
  } catch (error) {
    console.error('Error creating tip checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint to verify a checkout session for tips
 */
app.get('/api/tip/verify-checkout-session', async (req, res) => {
  try {
    const { session_id } = req.query;
    
    if (!session_id) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    console.log('Verifying tip checkout session:', session_id);
    
    // Retrieve the session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);
    
    if (session.payment_status === 'paid') {
      // Get the payment details
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      
      // Get metadata
      const { recipientType, recipientId, recipientName, userId, userName, message } = session.metadata || {};
      const amount = paymentIntent.amount / 100; // Convert from cents/pence
      
      // Get recipient name if it's a guide
      let finalRecipientName = recipientName || 'Kenya on a Budget Safaris';
      if (recipientType === 'guide' && recipientId && !recipientName) {
        const guideDoc = await db.collection('guides').doc(recipientId).get();
        if (guideDoc.exists) {
          finalRecipientName = guideDoc.data().fullName || 'Guide';
        }
      }
      
      // Save tip record to Firestore
      await db.collection('tips').add({
        stripePaymentIntentId: paymentIntent.id,
        stripeSessionId: session_id,
        amount,
        currency: paymentIntent.currency,
        recipientType,
        recipientId,
        recipientName: finalRecipientName,
        senderId: userId || 'anonymous',
        senderName: userName || 'Anonymous',
        message: message || '',
        status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log('Tip verified and saved:', {
        amount,
        recipientType,
        recipientName: finalRecipientName
      });
      
      // Send notification emails
      if (recipientType === 'guide' && recipientId) {
        await sendGuideNotification(recipientId, finalRecipientName, amount, userId, userName, message);
      } else {
        await sendCompanyNotification(amount, userId, userName, message);
      }
      
      // Return success with payment details
      res.json({
        success: true,
        payment: {
          amount,
          recipientType,
          recipientId,
          recipientName: finalRecipientName,
          status: 'completed'
        }
      });
    } else {
      res.json({
        success: false,
        error: 'Payment not complete'
      });
    }
  } catch (error) {
    console.error('Error verifying tip checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Webhook endpoint to handle Stripe events
 */
app.post('/api/tip/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    try {
      // Check if this is a tip payment (from metadata)
      if (session.metadata && session.metadata.type === 'tip') {
        // Process only if payment is successful
        if (session.payment_status === 'paid') {
          // Get the payment details
          const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
          
          // Get metadata
          const { recipientType, recipientId, recipientName, userId, userName, message } = session.metadata || {};
          const amount = paymentIntent.amount / 100; // Convert from cents/pence
          
          // Get recipient name if it's a guide
          let finalRecipientName = recipientName || 'Kenya on a Budget Safaris';
          if (recipientType === 'guide' && recipientId && !recipientName) {
            const guideDoc = await db.collection('guides').doc(recipientId).get();
            if (guideDoc.exists) {
              finalRecipientName = guideDoc.data().fullName || 'Guide';
            }
          }
          
          console.log('Processing webhook for tip payment:', {
            sessionId: session.id,
            amount,
            recipientType,
            recipientName: finalRecipientName
          });
          
          // Save tip record to Firestore
          await db.collection('tips').add({
            stripePaymentIntentId: paymentIntent.id,
            stripeSessionId: session.id,
            amount,
            currency: paymentIntent.currency,
            recipientType,
            recipientId,
            recipientName: finalRecipientName,
            senderId: userId || 'anonymous',
            senderName: userName || 'Anonymous',
            message: message || '',
            status: 'completed',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // Send notification emails
          if (recipientType === 'guide' && recipientId) {
            await sendGuideNotification(recipientId, finalRecipientName, amount, userId, userName, message);
          } else {
            await sendCompanyNotification(amount, userId, userName, message);
          }
        }
      }
    } catch (error) {
      console.error('Error processing tip webhook event:', error);
    }
  }
  
  // Return a response to acknowledge receipt of the event
  res.json({ received: true });
});

//===========================================================================
// EMAIL NOTIFICATION FUNCTIONS
//===========================================================================

/**
 * Send email notification to guide about tip using Brevo
 */
async function sendGuideNotification(guideId, guideName, amount, userId, userName, message) {
  try {
    // Get guide information from Firestore
    const guideDoc = await db.collection('guides').doc(guideId).get();
    
    if (!guideDoc.exists) {
      console.error('Guide not found for notification');
      return;
    }
    
    const guideData = guideDoc.data();
    const guideEmail = guideData.email;
    
    if (!guideEmail) {
      console.error('Guide email not found for notification');
      return;
    }
    
    // Create email content with improved template
    const emailContent = getGuideEmailTemplate(guideName, amount, userName, message);
    
    // Create Brevo send email object
    const sendSmtpEmail = {
      to: [{ email: guideEmail, name: guideName }],
      cc: [{ email: process.env.ADMIN_EMAIL, name: 'Admin' }],
      sender: { 
        email: 'noreply@kenyaonabudgetsafaris.co.uk', 
        name: 'Kenya on a Budget Safaris' 
      },
      subject: 'You Received a Tip!',
      htmlContent: emailContent
    };
    
    // Send the email via Brevo
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    
    // Also send admin notification
    await sendAdminGuideNotification(guideName, amount, userName, message);
    
    // Log in Firestore
    await db.collection('emailNotifications').add({
      to: guideEmail,
      subject: 'You Received a Tip!',
      guideId,
      tipAmount: amount,
      tipperName: userName || 'Anonymous',
      message: message || '',
      status: 'sent',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`Tip notification email sent to guide ${guideId}`);
    return true;
  } catch (error) {
    console.error('Error sending guide notification email:', error);
    return false;
  }
}

/**
 * Send email notification to admin about guide tip
 */
async function sendAdminGuideNotification(guideName, amount, userName, message) {
  try {
    // Create email content with improved template
    const emailContent = getAdminGuideEmailTemplate(guideName, amount, userName, message);
    
    // Create Brevo send email object
    const sendSmtpEmail = {
      to: [{ email: process.env.ADMIN_EMAIL, name: 'Admin' }],
      sender: { 
        email: 'noreply@kenyaonabudgetsafaris.co.uk', 
        name: 'Kenya on a Budget Safaris' 
      },
      subject: `Guide Tip Alert: ${guideName} Received a Tip`,
      htmlContent: emailContent
    };
    
    // Send the email via Brevo
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    
    console.log(`Admin notification sent for guide tip to ${guideName}`);
    return true;
  } catch (error) {
    console.error('Error sending admin notification for guide tip:', error);
    return false;
  }
}

/**
 * Send email notification to company admins about tip using Brevo
 */
async function sendCompanyNotification(amount, userId, userName, message) {
  try {
    // Create email content with improved template
    const emailContent = getCompanyEmailTemplate(amount, userName, message);
    
    // Create Brevo send email object
    const sendSmtpEmail = {
      to: [{ email: process.env.ADMIN_EMAIL, name: 'Admin' }],
      sender: { 
        email: 'noreply@kenyaonabudgetsafaris.co.uk', 
        name: 'Kenya on a Budget Safaris' 
      },
      subject: 'Company Tip Received',
      htmlContent: emailContent
    };
    
    // Send the email via Brevo
    await apiInstance.sendTransacEmail(sendSmtpEmail);
    
    // Log in Firestore
    await db.collection('emailNotifications').add({
      to: process.env.ADMIN_EMAIL,
      subject: 'Company Tip Received',
      tipAmount: amount,
      tipperName: userName || 'Anonymous',
      message: message || '',
      status: 'sent',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`Company tip notification email sent`);
    return true;
  } catch (error) {
    console.error('Error sending company notification email:', error);
    return false;
  }
}

//===========================================================================
// EMAIL TEMPLATES
//===========================================================================

/**
 * Get HTML template for guide tip notification
 */
function getGuideEmailTemplate(guideName, amount, userName, message) {
    const clientMessage = message 
        ? `<div class="client-message">
             <h4 class="message-title">Client Message:</h4>
             <blockquote>"${message}"</blockquote>
           </div>`
        : '';
        
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>You Received a Tip!</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
            
            body {
                font-family: 'Poppins', Arial, sans-serif;
                line-height: 1.6;
                color: #33261D;
                background-color: #F8F5E9;
                margin: 0;
                padding: 0;
            }
            
            .email-container {
                max-width: 600px;
                margin: 0 auto;
                background-color: #FFFFF0;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            }
            
            .email-header {
                background: linear-gradient(135deg, #BF9B30 0%, #98762B 100%);
                padding: 30px 20px;
                text-align: center;
            }
            
            .email-header img {
                max-width: 200px;
                height: auto;
            }
            
            .email-body {
                padding: 30px;
            }
            
            .email-title {
                color: #BF9B30;
                font-size: 24px;
                font-weight: 700;
                margin-top: 0;
                margin-bottom: 20px;
                text-align: center;
            }
            
            .tip-amount {
                font-size: 48px;
                font-weight: 700;
                color: #98762B;
                text-align: center;
                margin: 30px 0;
            }
            
            .tip-icon {
                display: block;
                text-align: center;
                margin-bottom: 20px;
            }
            
            .tip-icon img {
                width: 80px;
                height: 80px;
            }
            
            .note-box {
                background-color: #F8F5E9;
                border-left: 4px solid #5E7460;
                padding: 15px;
                margin: 25px 0;
                border-radius: 0 8px 8px 0;
            }
            
            .note-title {
                color: #5E7460;
                font-weight: 600;
                margin-top: 0;
                margin-bottom: 5px;
            }
            
            .client-message {
                background-color: #F8F5E9;
                border-radius: 8px;
                padding: 15px;
                margin: 25px 0;
                border: 1px solid #E6C87F;
            }
            
            .message-title {
                color: #BF9B30;
                margin-top: 0;
                margin-bottom: 10px;
            }
            
            blockquote {
                margin: 0;
                padding: 10px 20px;
                font-style: italic;
                border-left: 3px solid #BF9B30;
                color: #5E7460;
            }
            
            .button {
                display: inline-block;
                background: linear-gradient(135deg, #BF9B30 0%, #98762B 100%);
                color: white !important;
                text-decoration: none;
                padding: 12px 25px;
                border-radius: 50px;
                font-weight: 600;
                margin: 20px 0;
                text-align: center;
            }
            
            .email-footer {
                background-color: #33261D;
                color: #F8F5E9;
                text-align: center;
                padding: 20px;
                font-size: 12px;
            }
            
            .email-footer a {
                color: #E6C87F;
                text-decoration: none;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="email-header">
                <img src="https://kenyaonabudgetsafaris.co.uk/logo1.png" alt="Kenya on a Budget Safaris">
            </div>
            
            <div class="email-body">
                <h1 class="email-title">Congratulations, ${guideName}!</h1>
                
                <div class="tip-icon">
                    <img src="https://img.icons8.com/color/96/000000/tip.png" alt="Tip Icon">
                </div>
                
                <div class="tip-amount">£${amount}</div>
                
                <p>Great news! A client has left you a tip of £${amount} in recognition of your exceptional service.</p>
                
                <p>The client who tipped you was: <strong>${userName || 'Anonymous'}</strong></p>
                
                ${clientMessage}
                
                <p>This tip has been processed through our website and will be included in your next payment.</p>
                
                <div class="note-box">
                    <h4 class="note-title">Reminder</h4>
                    <p>As per our policy, all tips are processed through our website system for transparency and security. Thank you for your continued excellence!</p>
                </div>
                
                <p>Thank you for being an outstanding ambassador for Kenya on a Budget Safaris. Your dedication and exceptional service make our clients' experiences unforgettable.</p>
                
                <p>Best regards,<br>
                Kenya on a Budget Safaris Team</p>
                
                <a href="https://kenyaonabudgetsafaris.co.uk/staff-portal" class="button">View in Staff Portal</a>
            </div>
            
            <div class="email-footer">
                <p>This is an automated notification. Please do not reply to this email.</p>
                <p>Kenya on a Budget Safaris | <a href="https://kenyaonabudgetsafaris.co.uk">kenyaonabudgetsafaris.co.uk</a></p>
            </div>
        </div>
    </body>
    </html>
    `;
}

/**
 * Get HTML template for admin notification about guide tip
 */
function getAdminGuideEmailTemplate(guideName, amount, userName, message) {
    const clientMessage = message 
        ? `<div class="client-message">
             <h4 class="message-title">Client Message:</h4>
             <blockquote>"${message}"</blockquote>
           </div>`
        : '';
        
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Guide Tip Alert</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
            
            body {
                font-family: 'Poppins', Arial, sans-serif;
                line-height: 1.6;
                color: #33261D;
                background-color: #F8F5E9;
                margin: 0;
                padding: 0;
            }
            
            .email-container {
                max-width: 600px;
                margin: 0 auto;
                background-color: #FFFFF0;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            }
            
            .email-header {
                background: linear-gradient(135deg, #5E7460 0%, #A3B899 100%);
                padding: 30px 20px;
                text-align: center;
            }
            
            .email-header img {
                max-width: 200px;
                height: auto;
            }
            
            .email-body {
                padding: 30px;
            }
            
            .email-title {
                color: #5E7460;
                font-size: 24px;
                font-weight: 700;
                margin-top: 0;
                margin-bottom: 20px;
                text-align: center;
            }
            
            .tip-badge {
                background-color: #F8F5E9;
                border-radius: 12px;
                padding: 20px;
                margin: 20px 0;
                border: 2px solid #E6C87F;
                text-align: center;
            }
            
            .guide-name {
                font-size: 22px;
                font-weight: 700;
                color: #BF9B30;
                margin-bottom: 10px;
            }
            
            .tip-amount {
                font-size: 36px;
                font-weight: 700;
                color: #98762B;
                margin: 10px 0;
            }
            
            .details-table {
                width: 100%;
                border-collapse: collapse;
                margin: 25px 0;
                background-color: #F8F5E9;
                border-radius: 8px;
                overflow: hidden;
            }
            
            .details-table th {
                background-color: #E6C87F;
                color: #33261D;
                text-align: left;
                padding: 12px 15px;
                font-weight: 600;
            }
            
            .details-table td {
                padding: 12px 15px;
                border-bottom: 1px solid #E6C87F;
            }
            
            .details-table tr:last-child td {
                border-bottom: none;
            }
            
            .client-message {
                background-color: #F8F5E9;
                border-radius: 8px;
                padding: 15px;
                margin: 25px 0;
                border: 1px solid #E6C87F;
            }
            
            .message-title {
                color: #BF9B30;
                margin-top: 0;
                margin-bottom: 10px;
            }
            
            blockquote {
                margin: 0;
                padding: 10px 20px;
                font-style: italic;
                border-left: 3px solid #BF9B30;
                color: #5E7460;
            }
            
            .button {
                display: inline-block;
                background: linear-gradient(135deg, #5E7460 0%, #A3B899 100%);
                color: white !important;
                text-decoration: none;
                padding: 12px 25px;
                border-radius: 50px;
                font-weight: 600;
                margin: 20px 0;
                text-align: center;
            }
            
            .email-footer {
                background-color: #33261D;
                color: #F8F5E9;
                text-align: center;
                padding: 20px;
                font-size: 12px;
            }
            
            .email-footer a {
                color: #E6C87F;
                text-decoration: none;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="email-header">
                <img src="https://kenyaonabudgetsafaris.co.uk/logo1.png" alt="Kenya on a Budget Safaris">
            </div>
            
            <div class="email-body">
                <h1 class="email-title">Guide Tip Alert</h1>
                
                <p>This is an automated notification that a guide has received a tip through the website.</p>
                
                <div class="tip-badge">
                    <div class="guide-name">${guideName}</div>
                    <div class="tip-amount">£${amount}</div>
                </div>
                
                <table class="details-table">
                    <tr>
                        <th>Detail</th>
                        <th>Value</th>
                    </tr>
                    <tr>
                        <td>Tip Amount</td>
                        <td>£${amount}</td>
                    </tr>
                    <tr>
                        <td>Recipient Guide</td>
                        <td>${guideName}</td>
                    </tr>
                    <tr>
                        <td>Client</td>
                        <td>${userName || 'Anonymous'}</td>
                    </tr>
                    <tr>
                        <td>Date</td>
                        <td>${new Date().toLocaleDateString()}</td>
                    </tr>
                    <tr>
                        <td>Status</td>
                        <td>Processed</td>
                    </tr>
                </table>
                
                ${clientMessage}
                
                <p>This tip has been processed through the website and will be included in the guide's next payment.</p>
                
                <a href="https://kenyaonabudgetsafaris.co.uk/admin-portal" class="button">View in Admin Portal</a>
            </div>
            
            <div class="email-footer">
                <p>This is an automated notification.</p>
                <p>Kenya on a Budget Safaris | <a href="https://kenyaonabudgetsafaris.co.uk">kenyaonabudgetsafaris.co.uk</a></p>
            </div>
        </div>
    </body>
    </html>
    `;
}

/**
 * Get HTML template for company tip notification
 */
function getCompanyEmailTemplate(amount, userName, message) {
    const clientMessage = message 
        ? `<div class="client-message">
             <h4 class="message-title">Client Message:</h4>
             <blockquote>"${message}"</blockquote>
           </div>`
        : '';
        
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Company Tip Received</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
            
            body {
                font-family: 'Poppins', Arial, sans-serif;
                line-height: 1.6;
                color: #33261D;
                background-color: #F8F5E9;
                margin: 0;
                padding: 0;
            }
            
            .email-container {
                max-width: 600px;
                margin: 0 auto;
                background-color: #FFFFF0;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            }
            
            .email-header {
                background: linear-gradient(135deg, #BF9B30 0%, #98762B 100%);
                padding: 30px 20px;
                text-align: center;
            }
            
            .email-header img {
                max-width: 200px;
                height: auto;
            }
            
            .email-body {
                padding: 30px;
            }
            
            .email-title {
                color: #BF9B30;
                font-size: 24px;
                font-weight: 700;
                margin-top: 0;
                margin-bottom: 20px;
                text-align: center;
            }
            
            .tip-amount {
                font-size: 48px;
                font-weight: 700;
                color: #98762B;
                text-align: center;
                margin: 30px 0;
            }
            
            .tip-icon {
                display: block;
                text-align: center;
                margin-bottom: 20px;
            }
            
            .tip-icon img {
                width: 80px;
                height: 80px;
            }
            
            .details-table {
                width: 100%;
                border-collapse: collapse;
                margin: 25px 0;
                background-color: #F8F5E9;
                border-radius: 8px;
                overflow: hidden;
            }
            
            .details-table th {
                background-color: #E6C87F;
                color: #33261D;
                text-align: left;
                padding: 12px;
                font-weight: 600;
            }
            
            .details-table td {
                padding: 12px;
                border-bottom: 1px solid #E6C87F;
            }
            
            .details-table tr:last-child td {
                border-bottom: none;
            }
            
            .client-message {
                background-color: #F8F5E9;
                border-radius: 8px;
                padding: 15px;
                margin: 25px 0;
                border: 1px solid #E6C87F;
            }
            
            .message-title {
                color: #BF9B30;
                margin-top: 0;
                margin-bottom: 10px;
            }
            
            blockquote {
                margin: 0;
                padding: 10px 20px;
                font-style: italic;
                border-left: 3px solid #BF9B30;
                color: #5E7460;
            }
            
            .button {
                display: inline-block;
                background: linear-gradient(135deg, #BF9B30 0%, #98762B 100%);
                color: white !important;
                text-decoration: none;
                padding: 12px 25px;
                border-radius: 50px;
                font-weight: 600;
                margin: 20px 0;
                text-align: center;
            }
            
            .email-footer {
                background-color: #33261D;
                color: #F8F5E9;
                text-align: center;
                padding: 20px;
                font-size: 12px;
            }
            
            .email-footer a {
                color: #E6C87F;
                text-decoration: none;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="email-header">
                <img src="https://kenyaonabudgetsafaris.co.uk/logo1.png" alt="Kenya on a Budget Safaris">
            </div>
            
            <div class="email-body">
                <h1 class="email-title">Company Tip Received!</h1>
                
                <div class="tip-icon">
                    <img src="https://img.icons8.com/color/96/000000/tip.png" alt="Tip Icon">
                </div>
                
                <div class="tip-amount">£${amount}</div>
                
                <p>A client has left a tip of £${amount} for the company to be distributed among all staff.</p>
                
                <table class="details-table">
                    <tr>
                        <th>Detail</th>
                        <th>Value</th>
                    </tr>
                    <tr>
                        <td>Tip Amount</td>
                        <td>£${amount}</td>
                    </tr>
                    <tr>
                        <td>Client</td>
                        <td>${userName || 'Anonymous'}</td>
                    </tr>
                    <tr>
                        <td>Date</td>
                        <td>${new Date().toLocaleDateString()}</td>
                    </tr>
                    <tr>
                        <td>Status</td>
                        <td>Processed</td>
                    </tr>
                </table>
                
                ${clientMessage}
                
                <p>This tip has been processed through the website and will be distributed according to company policy.</p>
                
                <a href="https://kenyaonabudgetsafaris.co.uk/admin-portal" class="button">View in Admin Portal</a>
            </div>
            
            <div class="email-footer">
                <p>This is an automated notification.</p>
                <p>Kenya on a Budget Safaris | <a href="https://kenyaonabudgetsafaris.co.uk">kenyaonabudgetsafaris.co.uk</a></p>
            </div>
        </div>
    </body>
    </html>
    `;
}

//===========================================================================
// HELPER FUNCTIONS
//===========================================================================

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

// Start the server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`
===========================================
🔥 Integrated Server running on port ${PORT} 🔥
===========================================

Available endpoints:
A. PACKAGE BOOKING ENDPOINTS:
- GET  /health                     - Check server health
- POST /create-checkout-session    - Create Stripe checkout for packages
- POST /verify-payment             - Verify package payment status
- GET  /ping-activity              - Ping activity upgrades server

B. TIPPING SYSTEM ENDPOINTS:
- POST /api/tip/create-checkout-session - Create Stripe checkout for tips
- GET  /api/tip/verify-checkout-session - Verify tip payment status
- POST /api/tip/webhook                 - Webhook handler for Stripe tip events

Keep-alive system: ${process.env.NODE_ENV === 'production' ? 'ACTIVE' : 'DISABLED IN DEVELOPMENT MODE'}

Server is ready for handling both package bookings and tips!
  `);
  
  // Set up keep-alive mechanisms
  setupKeepAlive();
});
