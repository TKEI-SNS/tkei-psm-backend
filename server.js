// server.js - Updated with Part 1 Changes + Currency + Email body
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

// NOTE: createTransport (not createTransporter)
const transporter = nodemailer.createTransport({
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
    version: '2.1.0 - Part 1 + Currency + Email'
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
        is_approved: true,
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
      calculationErrors,
      currencyRates // NEW optional field
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
        currency_rates: currencyRates || null,
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

// ==================== EMAIL ====================
// REPLACE EMAIL ENDPOINT IN server.js
// REPLACE in server.js
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, formNo, signerName, signerRole } = req.body;
    const formLink = `https://tkei-psm-portals.pages.dev/signatory-portal.html?form=${formNo}`;
    
    await transporter.sendMail({
      from: `"TK Elevator" <${process.env.SMTP_USER}>`,
      to: to,
      subject: `Action Required: Form ${formNo} - Sign Document`,
      html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:#1a1a2e;color:white;padding:20px;text-align:center;"><h1>TK Elevator Cost Approval</h1></div>
<div style="padding:30px;background:#f9f9f9;margin:20px 0;">
<h2>Hello ${signerName},</h2>
<p>You are designated as <strong>${signerRole}</strong> for Form <strong>${formNo}</strong>.</p>
<div style="background:#fff;border-left:4px solid #e94560;padding:15px;margin:15px 0;"><strong>Action Required:</strong> Review and sign the document.</div>
<center><a href="${formLink}" style="display:inline-block;background:#e94560;color:white;padding:12px 30px;text-decoration:none;border-radius:5px;margin:20px 0;font-weight:bold;">REVIEW & SIGN</a></center>
<p>Link: <a href="${formLink}">${formLink}</a></p>
</div>
<div style="text-align:center;color:#666;font-size:12px;">
<p>Automated email - Do not reply</p>
<p>&copy; 2026 TK Elevator India</p>
</div></div>`
    });
    
    console.log('✅ Email sent:', to);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==========================================
// NEW ENDPOINT: Create Form with Calculations
// POST /api/forms/create
// ==========================================
// REPLACE /api/forms/create endpoint in server.js
app.post('/api/forms/create', async (req, res) => {
  try {
    const { items } = req.body;
    console.log(`📝 Creating form with ${items.length} items`);
    
    // Get form number
    const { data: formNumData, error: formNumError } = await supabase
      .rpc('get_next_form_number');
    if (formNumError) throw formNumError;
    
    const formNumber = formNumData;
    const formSequence = parseInt(formNumber.split('_')[3]);
    console.log(`✅ Form number: ${formNumber}`);
    
    // Process items
    const formRows = [];
    
    for (const item of items) {
      // Clean all numeric values - remove ALL commas
      const cleanPrice = parseFloat(String(item.newPrice || 0).replace(/,/g, ''));
      
      const { data: calcData, error: calcError } = await supabase
        .rpc('calculate_form_row', {
          p_item_code: String(item.itemCode),
          p_item_description: String(item.itemDescription || ''),
          p_vendor_code: String(item.vendorCode),
          p_vendor_name: String(item.vendorName || ''),
          p_new_price: cleanPrice,
          p_currency: String(item.currency || 'INR')
        });
      
      if (calcError) {
        console.error('Calculation error:', calcError);
        continue;
      }
      
      const calc = calcData[0];
      
      formRows.push({
        id: `${formNumber}_${item.itemCode}_${item.vendorCode}`,
        form_number: formNumber,
        form_sequence: formSequence,
        item_code: String(item.itemCode),
        item_description: String(item.itemDescription || ''),
        vendor_code: String(item.vendorCode),
        vendor_name: String(item.vendorName || ''),
        new_price: cleanPrice,
        currency: String(item.currency || 'INR'),
        old_price: parseFloat(calc.old_price || 0),
        price_diff: parseFloat(calc.price_diff || 0),
        percent_diff: parseFloat(calc.percent_diff || 0),
        porv_qty: parseFloat(calc.porv_qty || 0),
        impact: parseFloat(calc.impact || 0),
        remarks: String(calc.remarks || 'Calculated')
      });
    }
    
    // Insert to DB
    const { data: insertData, error: insertError } = await supabase
      .from('cost_approval_forms')
      .insert(formRows)
      .select();
    
    if (insertError) throw insertError;
    
    console.log(`✅ Inserted ${insertData.length} rows`);
    
    res.json({
      success: true,
      formNumber: formNumber,
      items: insertData
    });
    
  } catch (error) {
    console.error('❌ Form creation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// NEW ENDPOINT: Get Form Data
// GET /api/forms/:formNumber
// ==========================================

app.get('/api/forms/:formNumber', async (req, res) => {
  try {
    const { formNumber } = req.params;
    
    const { data, error } = await supabase
      .from('cost_approval_forms')
      .select('*')
      .eq('form_number', formNumber)
      .order('item_code');
    
    if (error) throw error;
    
    res.json({
      success: true,
      formNumber: formNumber,
      items: data,
      summary: {
        totalItems: data.length,
        totalImpact: data.reduce((sum, r) => sum + (parseFloat(r.impact) || 0), 0)
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ==========================================
// ENDPOINT: Upload Pre-Calculated Form
// POST /api/forms/upload-precalc
// ==========================================

app.post('/api/forms/upload-precalc', async (req, res) => {
  try {
    const { items } = req.body; 
    // items = [{itemCode, itemDescription, vendorCode, vendorName, newPrice, currency, 
    //           oldPrice, priceDiff, percentDiff, porvQty, impact, remarks}]
    
    // 1. Generate form number
    const { data: formNumData, error: formNumError } = await supabase
      .rpc('get_next_form_number');
    if (formNumError) throw formNumError;
    
    const formNumber = formNumData;
    const formSequence = parseInt(formNumber.split('_')[3]);
    
    // 2. Insert rows directly (no calculation needed)
    const formRows = items.map(item => ({
      id: `${formNumber}_${item.itemCode}_${item.vendorCode}`,
      form_number: formNumber,
      form_sequence: formSequence,
      item_code: item.itemCode,
      item_description: item.itemDescription || '',
      vendor_code: item.vendorCode,
      vendor_name: item.vendorName || '',
      new_price: item.newPrice,
      currency: item.currency || 'INR',
      old_price: item.oldPrice || 0,
      price_diff: item.priceDiff || 0,
      percent_diff: item.percentDiff || 0,
      porv_qty: item.porvQty || 0,
      impact: item.impact || 0,
      remarks: item.remarks || 'Pre-calculated'
    }));
    
    const { data: insertData, error: insertError } = await supabase
      .from('cost_approval_forms')
      .insert(formRows)
      .select();
    
    if (insertError) throw insertError;
    
    res.json({
      success: true,
      formNumber: formNumber,
      items: insertData,
      summary: {
        totalItems: insertData.length,
        totalImpact: insertData.reduce((sum, r) => sum + (parseFloat(r.impact) || 0), 0)
      }
    });
    
  } catch (error) {
    console.error('❌ Pre-calc upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ENDPOINT: Upload Pre-Calculated Form
// POST /api/forms/upload-precalc
// ==========================================
// SIMPLIFIED: Direct insert from 12-column file
app.post('/api/forms/upload-precalc', async (req, res) => {
  try {
    const { items } = req.body;
    
    // Get form number
    const { data: formNum, error: fnErr } = await supabase
      .rpc('get_next_form_number');
    if (fnErr) throw fnErr;
    
    console.log('Form:', formNum, 'Items:', items.length);
    
    // Direct insert - map columns exactly as uploaded
    const rows = items.map(item => ({
      id: `${formNum}_${item.item_code}_${item.vendor_code}`,
      form_number: formNum,
      form_sequence: parseInt(formNum.split('_')[3]),
      item_code: item.item_code,
      item_description: item.item_description,
      vendor_code: item.vendor_code,
      vendor_name: item.vendor_name,
      new_price: parseFloat(item.new_price) || 0,
      currency: item.currency || 'INR',
      old_price: parseFloat(item.old_price) || 0,
      price_diff: parseFloat(item.price_diff) || 0,
      percent_diff: parseFloat(item.percent_diff) || 0,
      porv_qty: parseFloat(item.porv_qty) || 0,
      impact: parseFloat(item.impact) || 0,
      remarks: item.remarks || ''
    }));
    
    const { data, error } = await supabase
      .from('cost_approval_forms')
      .insert(rows)
      .select();
    
    if (error) throw error;
    
    console.log('✅ Inserted:', data.length);
    
    res.json({
      success: true,
      formNumber: formNum,
      items: data
    });
    
  } catch (error) {
    console.error('❌', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ENDPOINT: Send Email with Attachments
// POST /api/send-email-with-attachments
// ==========================================

app.post('/api/send-email-with-attachments', async (req, res) => {
  try {
    const { to, formNo, formLink, attachments } = req.body;
    // attachments = [{filename, content: base64, contentType}]
    
    const mailOptions = {
      from: `"TK Elevator Cost Approval" <${process.env.SMTP_USER}>`,
      to,
      subject: `Cost Approval Form (${formNo}) - Action required`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2>Cost Approval Form - Signature Required</h2>
          <p>Form Number: <strong>${formNo}</strong></p>
          <p>Please review and sign the form:</p>
          <p><a href="${formLink}" style="color: #1d4ed8;">${formLink}</a></p>
          ${attachments?.length ? `<p><strong>Attachments:</strong> ${attachments.length} file(s) included</p>` : ''}
          <p style="color: #666; font-size: 0.9em;">[No reply - system generated email]</p>
        </div>
      `,
      attachments: attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64',
        contentType: att.contentType
      })) || []
    };
    
    await transporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Email sent with attachments' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET form by number (for signatory portal)
app.get('/api/forms/:formNumber', async (req, res) => {
  try {
    const { formNumber } = req.params;
    
    const { data, error } = await supabase
      .from('cost_approval_forms')
      .select('*')
      .eq('form_number', formNumber)
      .order('item_code');
    
    if (error) throw error;
    
    res.json({
      success: true,
      formNumber: formNumber,
      items: data,
      summary: {
        totalItems: data.length,
        totalImpact: data.reduce((s, r) => s + (parseFloat(r.impact) || 0), 0)
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 TK Elevator Cost Approval API v2.2 running on port ${PORT}`);
  console.log(`📧 Email: ${process.env.SMTP_USER || 'Not configured'}`);
  console.log(`💾 Database: ${process.env.SUPABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`🔄 Sync: Manual Upload + SharePoint OAuth enabled`);
});
