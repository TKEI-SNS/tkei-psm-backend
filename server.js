// server.js - Updated with Part 1 Changes
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const SharePointSyncService = require('./sharepoint-sync-service');
const CalculationService = require('./calculation-service');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const syncService = new SharePointSyncService(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const calcService = new CalculationService(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const transporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'TK Elevator Cost Approval API',
    version: '2.0.0 - Part 1 Updates'
  });
});

// ==================== AUTHENTICATION ====================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.json({ success: false, error: 'All fields required' });
    }
    
    const { data: existing } = await supabase
      .from('admin_users')
      .select('id')
      .eq('username', username)
      .single();
    
    if (existing) {
      return res.json({ success: false, error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const { data, error } = await supabase
      .from('admin_users')
      .insert([{
        username,
        email,
        password: hashedPassword,
        is_approved: true, // Auto-approve for now
        created_at: new Date().toISOString()
      }])
      .select();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      message: 'Account created successfully',
      user: { id: data[0].id, username: data[0].username, email: data[0].email }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.json({ success: false, error: 'Username and password required' });
    }
    
    const { data: user, error } = await supabase
      .from('admin_users')
      .select('*')
      .eq('username', username)
      .single();
    
    if (error || !user) {
      return res.json({ success: false, error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.json({ success: false, error: 'Invalid credentials' });
    }
    
    await supabase
      .from('admin_users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);
    
    res.json({ 
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.username
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SYNC ENDPOINTS ====================

/**
 * Sync Info Records from SharePoint
 * Requires SharePoint access token from frontend
 */
app.post('/api/sync/info-records', async (req, res) => {
  try {
    const { accessToken, syncedBy } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'SharePoint access token required. Please authenticate with Microsoft.'
      });
    }
    
    const result = await syncService.syncInfoRecords(accessToken, syncedBy || 'unknown');
    
    res.json({
      success: true,
      message: 'Info Records synced successfully',
      ...result
    });
    
  } catch (error) {
    console.error('Info Records sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Failed to sync Info Records from SharePoint'
    });
  }
});

/**
 * Sync PORV data from SharePoint
 */
app.post('/api/sync/porv-data', async (req, res) => {
  try {
    const { accessToken, syncedBy } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'SharePoint access token required. Please authenticate with Microsoft.'
      });
    }
    
    const result = await syncService.syncPorvData(accessToken, syncedBy || 'unknown');
    
    res.json({
      success: true,
      message: 'PORV data synced successfully',
      ...result
    });
    
  } catch (error) {
    console.error('PORV sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Failed to sync PORV data from SharePoint'
    });
  }
});

/**
 * Sync both Info Records and PORV data
 */
app.post('/api/sync/all', async (req, res) => {
  try {
    const { accessToken, syncedBy } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'SharePoint access token required. Please authenticate with Microsoft.'
      });
    }
    
    const results = await syncService.syncAll(accessToken, syncedBy || 'unknown');
    
    res.json({
      success: results.errors.length === 0,
      message: results.errors.length === 0 
        ? 'All data synced successfully' 
        : 'Sync completed with errors',
      ...results
    });
    
  } catch (error) {
    console.error('Full sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Failed to complete full sync'
    });
  }
});

/**
 * Get sync status - when was data last synced
 */
app.get('/api/sync/status', async (req, res) => {
  try {
    const status = await syncService.getSyncStatus();
    
    res.json({
      success: true,
      ...status
    });
    
  } catch (error) {
    console.error('Get sync status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== CALCULATION ENDPOINTS ====================

/**
 * Calculate fields for items (Old Price, PORV, Impact)
 */
app.post('/api/forms/calculate', async (req, res) => {
  try {
    const { items } = req.body;
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Items array required'
      });
    }
    
    const results = await calcService.calculateItems(items);
    
    res.json({
      success: true,
      ...results
    });
    
  } catch (error) {
    console.error('Calculate error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get next form number
 */
app.get('/api/forms/next-number', async (req, res) => {
  try {
    const result = await calcService.getNextFormNumber();
    
    res.json(result);
    
  } catch (error) {
    console.error('Get next form number error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Lookup old price for specific item-vendor
 */
app.post('/api/lookup/old-price', async (req, res) => {
  try {
    const { itemCode, vendorCode } = req.body;
    
    if (!itemCode || !vendorCode) {
      return res.status(400).json({
        success: false,
        error: 'itemCode and vendorCode required'
      });
    }
    
    const result = await calcService.getOldPrice(itemCode, vendorCode);
    
    res.json(result);
    
  } catch (error) {
    console.error('Lookup old price error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Lookup PORV for specific item-vendor
 */
app.post('/api/lookup/porv', async (req, res) => {
  try {
    const { itemCode, vendorCode } = req.body;
    
    if (!itemCode || !vendorCode) {
      return res.status(400).json({
        success: false,
        error: 'itemCode and vendorCode required'
      });
    }
    
    const result = await calcService.getPorvQuantity(itemCode, vendorCode);
    
    res.json(result);
    
  } catch (error) {
    console.error('Lookup PORV error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== FORMS API ====================

app.post('/api/forms', async (req, res) => {
  try {
    const { 
      formNo, 
      autoFormNo,
      vendor, 
      vendorCode, 
      date, 
      category, 
      note, 
      items,
      itemsCalculated,
      signatories, 
      quarterlyImpact,
      totalImpact,
      calculationErrors
    } = req.body;
    
    const { data, error } = await supabase
      .from('forms')
      .insert([{
        form_no: formNo,
        auto_form_no: autoFormNo,
        vendor,
        vendor_code: vendorCode,
        date,
        category,
        note,
        items,
        items_calculated: itemsCalculated,
        signatories,
        quarterly_impact: quarterlyImpact,
        total_impact: totalImpact,
        calculation_errors: calculationErrors,
        status: 'pending',
        created_at: new Date().toISOString()
      }])
      .select();
    
    if (error) throw error;
    
    res.json({ success: true, data: data[0] });
  } catch (error) {
    console.error('Create form error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/forms', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('forms')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get forms error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, html, formNo } = req.body;
    
    const mailOptions = {
      from: `"TK Elevator Cost Approval" <${process.env.SMTP_USER}>`,
      to,
      subject: subject || `Cost Approval Form #${formNo} - Signature Required`,
      html: html || `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #0d3b52;">Cost Approval Form Ready for Signature</h2>
          <p>Dear Signatory,</p>
          <p>A cost approval form #${formNo} is ready for your review and signature.</p>
          <p><a href="${process.env.FRONTEND_URL}/signatory-portal-FINAL.html" 
                style="background: #10b981; color: white; padding: 12px 24px; 
                       text-decoration: none; border-radius: 6px; display: inline-block;">
             View Form & Sign
          </a></p>
          <p style="color: #666; font-size: 0.9rem; margin-top: 20px;">
            This is an automated email from TK Elevator Cost Approval System.
          </p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TK Elevator Cost Approval API v2.0 running on port ${PORT}`);
  console.log(`📧 Email: ${process.env.SMTP_USER || 'Not configured'}`);
  console.log(`💾 Database: ${process.env.SUPABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`🔄 Sync: SharePoint integration enabled`);
});
