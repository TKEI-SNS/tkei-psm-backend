// server.js - Updated with Part 1 Changes + Currency + Email + Manual File Upload
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const SharePointSyncService = require('./sharepoint-sync-service');
const CalculationService = require('./calculation-service');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - Comprehensive configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Handle preflight
app.options('*', cors());

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

// Configure multer for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept only Excel files
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel') {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
    }
  }
});

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
    version: '2.2.0 - Part 1 + Currency + Email + Manual Upload'
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

// ==================== MANUAL FILE UPLOAD SYNC ====================

app.post('/api/sync/upload', upload.fields([
  { name: 'infoRecordsFile', maxCount: 1 },
  { name: 'porvFile', maxCount: 1 }
]), async (req, res) => {
  console.log('📁 File upload sync started');
  
  // Track memory
  const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`Memory before: ${memBefore.toFixed(2)} MB`);
  
  try {
    if (!req.files || !req.files.infoRecordsFile || !req.files.porvFile) {
      return res.status(400).json({
        success: false,
        error: 'Both files required'
      });
    }
    
    const infoFile = req.files.infoRecordsFile[0];
    const porvFile = req.files.porvFile[0];
    
    console.log(`Files: ${infoFile.originalname} (${(infoFile.size/1024).toFixed(2)}KB), ${porvFile.originalname} (${(porvFile.size/1024).toFixed(2)}KB)`);
    
    // Parse and insert Info Records in small batches to save memory
    console.log('📊 Processing Info Records...');
    let infoInserted = 0;
    try {
      const workbook = XLSX.read(infoFile.buffer, { type: 'buffer', sheetRows: 1000 }); // Limit rows read
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet, { raw: false });
      
      // Log detected columns
      if (data.length > 0) {
        console.log('📋 Info Records columns found:', Object.keys(data[0]).join(', '));
      }
      
      // Clear old data first
      await supabase.from('info_records').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      
      // Process in smaller batches (50 instead of 100)
      for (let i = 0; i < data.length; i += 50) {
        const batch = data.slice(i, i + 50).map(row => ({
          material_number: (row['Material'] || row['FS Code'] || '').toString().trim(),
          material_description: (row['Material Number'] || '').toString().trim(),
          vendor_account_number: (row["Vendor's account number"] || row['Vendor account number'] || '').toString().trim(),
          supplier_name: (row['Supplier'] || '').toString().trim(),
          amount: parseFloat(row['Amount'] || 0),
          valid_from: row['Valid From'] || null,
          valid_to: row['Valid to'] || null,
          item_vendor_key: `${(row['Material'] || row['FS Code'] || '').toString().trim()}-${(row["Vendor's account number"] || row['Vendor account number'] || '').toString().trim()}`
        })).filter(r => r.material_number && r.vendor_account_number);
        
        const { error } = await supabase.from('info_records').insert(batch);
        if (!error) infoInserted += batch.length;
        
        // Force garbage collection hint
        if (global.gc && i % 200 === 0) global.gc();
      }
      
      console.log(`✅ Info Records: ${infoInserted}`);
    } catch (e) {
      console.error('Info Records error:', e.message);
      return res.status(400).json({ success: false, error: `Info Records: ${e.message}` });
    }
    
    // Clear buffer
    infoFile.buffer = null;
    
    // Parse and insert PORV in small batches
    console.log('📊 Processing PORV...');
    let porvInserted = 0;
    try {
      const workbook = XLSX.read(porvFile.buffer, { type: 'buffer', sheetRows: 1000 });
      const sheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'working') || workbook.SheetNames[0];
      console.log(`📄 Using PORV sheet: "${sheetName}"`);
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { raw: false });
      
      // Log detected columns
      if (data.length > 0) {
        console.log('📋 PORV columns found:', Object.keys(data[0]).join(', '));
      }
      
      // Clear old data
      await supabase.from('porv_data').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      
      // Process in batches
      for (let i = 0; i < data.length; i += 50) {
        const batch = data.slice(i, i + 50).map(row => ({
          vendor_id: (row['Vendor ID'] || '').toString().trim(),
          item_code: (row['Item'] || '').toString().trim(),
          qty_in_unit_of_entry: parseFloat(row['Qty in unit of entry'] || 0),
          item_vendor_key: `${(row['Item'] || '').toString().trim()}-${(row['Vendor ID'] || '').toString().trim()}`
        })).filter(r => r.item_code && r.vendor_id && r.qty_in_unit_of_entry > 0);
        
        const { error } = await supabase.from('porv_data').insert(batch);
        if (!error) porvInserted += batch.length;
        
        if (global.gc && i % 200 === 0) global.gc();
      }
      
      console.log(`✅ PORV: ${porvInserted}`);
    } catch (e) {
      console.error('PORV error:', e.message);
      return res.status(400).json({ success: false, error: `PORV: ${e.message}` });
    }
    
    // Clear buffer
    porvFile.buffer = null;
    
    // Force cleanup
    if (global.gc) global.gc();
    
    const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`Memory after: ${memAfter.toFixed(2)} MB (diff: ${(memAfter - memBefore).toFixed(2)} MB)`);
    
    res.json({
      success: true,
      infoRecords: infoInserted,
      porvData: porvInserted,
      lastSync: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

/**
 * Parse Info Records Excel file
 */
function parseInfoRecordsExcel(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(firstSheet, { raw: false });
    
    console.log(`📄 Info Records columns:`, Object.keys(data[0] || {}));
    
    return data.map(row => ({
      material_number: (row['Material Number'] || row['Material'] || '').toString().trim(),
      material_description: (row['Material Description'] || row['Description'] || '').toString().trim(),
      vendor_account_number: (row['Vendor account number'] || row['Vendor Code'] || '').toString().trim(),
      supplier_name: (row['Supplier'] || row['Vendor Name'] || '').toString().trim(),
      amount: parseFloat(row['Amount'] || row['Net Price'] || 0),
      valid_from: row['Valid From'] || null,
      valid_to: row['Valid To'] || null,
      item_vendor_key: `${(row['Material Number'] || '').toString().trim()}-${(row['Vendor account number'] || '').toString().trim()}`
    })).filter(r => r.material_number && r.vendor_account_number);
    
  } catch (error) {
    throw new Error(`Failed to parse Info Records file: ${error.message}`);
  }
}

/**
 * Parse PORV Excel file (looks for "Working" or "WORKING" sheet)
 */
function parsePorvExcel(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    
    // Find "Working" or "WORKING" sheet
    const sheetName = workbook.SheetNames.find(name => 
      name.toLowerCase() === 'working'
    ) || workbook.SheetNames[0];
    
    console.log(`📄 Using PORV sheet: "${sheetName}"`);
    
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { raw: false });
    
    console.log(`📄 PORV columns:`, Object.keys(data[0] || {}));
    
    return data.map(row => ({
      vendor_id: (row['Vendor ID'] || row['Vendor Code'] || '').toString().trim(),
      item_code: (row['Item Code'] || row['Material Number'] || '').toString().trim(),
      qty_in_unit_of_entry: parseFloat(row['Qty in unit of entry'] || row['Quantity'] || 0),
      item_vendor_key: `${(row['Item Code'] || '').toString().trim()}-${(row['Vendor ID'] || '').toString().trim()}`
    })).filter(r => r.item_code && r.vendor_id && r.qty_in_unit_of_entry > 0);
    
  } catch (error) {
    throw new Error(`Failed to parse PORV file: ${error.message}`);
  }
}

/**
 * Insert records in batches to avoid timeout
 */
async function insertInBatches(table, records, batchSize) {
  let inserted = 0;
  let failed = 0;
  
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from(table)
      .insert(batch);
    
    if (error) {
      console.error(`Batch insert error for ${table}:`, error.message);
      failed += batch.length;
    } else {
      inserted += batch.length;
    }
  }
  
  if (failed > 0) {
    console.warn(`⚠️ ${table}: ${failed} records failed to insert`);
  }
  
  return inserted;
}

// ==================== SYNC ENDPOINTS (SharePoint OAuth - Optional) ====================

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

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, html, formNo } = req.body;

    const formLink = `${process.env.FRONTEND_URL}/signatory-portal-FINAL.html?formNo=${encodeURIComponent(formNo || '')}`;

    const defaultHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Kindly review and Sign the Cost Approval Form, by clicking on the link below -</p>
        <p>
          <a href="${formLink}" style="color: #1d4ed8; text-decoration: underline;">
            ${formLink}
          </a>
        </p>
        <p>[No reply - system generated email]</p>
      </div>
    `;

    const mailOptions = {
      from: `"TK Elevator Cost Approval" <${process.env.SMTP_USER}>`,
      to,
      subject: subject || `Cost Approval Form (${formNo}) - Action required`,
      html: html || defaultHtml
    };
    
    await transporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 TK Elevator Cost Approval API v2.2 running on port ${PORT}`);
  console.log(`📧 Email: ${process.env.SMTP_USER || 'Not configured'}`);
  console.log(`💾 Database: ${process.env.SUPABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`🔄 Sync: Manual Upload + SharePoint OAuth enabled`);
});
