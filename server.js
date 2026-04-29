// ============================================================
// TK ELEVATOR — PSM CHAKAN
// Unified Backend: Signatory Portal + Cost Approval Form Portal
// Hosted on: https://tkei-psm-backend.onrender.com
//
// ENVIRONMENT VARIABLES (Render Dashboard > Environment):
//   SUPABASE_URL                — Supabase project URL
//   SUPABASE_KEY                — Supabase anon/service key
//   ONEDRIVE_PDF_WEBHOOK_URL    — Power Automate trigger (PDF save + fetch)
//   ONEDRIVE_ATT_WEBHOOK_URL    — Power Automate trigger (attachments) [optional]
//   ONEDRIVE_EXCEL_WEBHOOK_URL  — Power Automate trigger (Excel log) [optional]
//
// SUPABASE SQL — run once:
//   ALTER TABLE portal_forms ADD COLUMN IF NOT EXISTS onedrive_pdf_path TEXT;
// ============================================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── OneDrive / Power Automate config ──
const ONEDRIVE_PDF_WEBHOOK   = process.env.ONEDRIVE_PDF_WEBHOOK_URL   || null;
const ONEDRIVE_ATT_WEBHOOK   = process.env.ONEDRIVE_ATT_WEBHOOK_URL   || null;
const ONEDRIVE_EXCEL_WEBHOOK = process.env.ONEDRIVE_EXCEL_WEBHOOK_URL || null;

async function sendToOneDrive(webhookUrl, payload) {
  if (!webhookUrl) return { success: false, skipped: true };
  try {
    const axios = require('axios');
    const r = await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    console.log(`✅ OneDrive webhook: ${r.status}`);
    return { success: true };
  } catch (err) {
    console.error('⚠ OneDrive webhook error (non-fatal):', err.message);
    return { success: false, error: err.message };
  }
}

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', time: new Date().toISOString(),
    onedrive: { pdf: !!ONEDRIVE_PDF_WEBHOOK, att: !!ONEDRIVE_ATT_WEBHOOK, excel: !!ONEDRIVE_EXCEL_WEBHOOK }
  });
});

// ============================================================
// AUTH — REGISTER
// POST /api/auth/register
// Body: { email, password, name, role }
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name || !role) {
      return res.status(400).json({ success: false, error: 'All fields required.' });
    }

    const validRoles = ['Admin', 'Purchase Manager', 'VP Purchase', 'Finance Controller'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role.' });
    }

    // Admin must use @tkelevator.com email
    if (role === 'Admin' && !email.toLowerCase().endsWith('@tkelevator.com')) {
      return res.status(400).json({ success: false, error: 'Admin accounts require a @tkelevator.com email.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    // Check if email already registered
    const { data: existing } = await supabase
      .from('portal_users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(409).json({ success: false, error: 'Account already exists. Please sign in.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert user
    const { data: user, error } = await supabase
      .from('portal_users')
      .insert({
        email: email.toLowerCase(),
        password_hash,
        name,
        role
      })
      .select('id, email, name, role, signature_data')
      .single();

    if (error) throw error;

    console.log(`✅ Registered: ${email} as ${role}`);
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        sig: user.signature_data || null
      }
    });

  } catch (error) {
    console.error('❌ Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// AUTH — LOGIN
// POST /api/auth/login
// Body: { email, password }
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required.' });
    }

    // Find user
    const { data: user, error } = await supabase
      .from('portal_users')
      .select('id, email, name, role, password_hash, signature_data')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    console.log(`✅ Login: ${email}`);
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        sig: user.signature_data || null
      }
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// AUTH — ADMIN LOGIN (email must end in @tkelevator.com)
// POST /api/auth/admin-login
// Body: { email, password }
// ============================================================
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email.toLowerCase().endsWith('@tkelevator.com')) {
      return res.status(401).json({ success: false, error: 'Only @tkelevator.com accounts allowed.' });
    }

    // Check if admin exists in portal_users with Admin role
    const { data: user } = await supabase
      .from('portal_users')
      .select('id, email, name, role, password_hash, signature_data')
      .eq('email', email.toLowerCase())
      .eq('role', 'Admin')
      .single();

    if (!user) {
      // Auto-create admin account on first login
      if (password.length < 4) {
        return res.status(401).json({ success: false, error: 'Enter a valid password.' });
      }
      const password_hash = await bcrypt.hash(password, 10);
      const { data: newAdmin, error: createErr } = await supabase
        .from('portal_users')
        .insert({ email: email.toLowerCase(), password_hash, name: email.split('@')[0], role: 'Admin' })
        .select('id, email, name, role, signature_data')
        .single();

      if (createErr) throw createErr;
      console.log(`✅ Admin created: ${email}`);
      return res.json({
        success: true,
        user: { id: newAdmin.id, email: newAdmin.email, name: newAdmin.name, role: newAdmin.role, sig: null }
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid password.' });
    }

    console.log(`✅ Admin login: ${email}`);
    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, sig: user.signature_data || null }
    });

  } catch (error) {
    console.error('❌ Admin login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// SAVE SIGNATURE
// POST /api/auth/save-signature
// Body: { userId, signatureData }
// ============================================================
app.post('/api/auth/save-signature', async (req, res) => {
  try {
    const { userId, signatureData } = req.body;
    if (!userId || !signatureData) {
      return res.status(400).json({ success: false, error: 'userId and signatureData required.' });
    }

    const { error } = await supabase
      .from('portal_users')
      .update({ signature_data: signatureData, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) throw error;
    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// ============================================================
// PORTAL FORMS — UPLOAD PDF
// POST /api/portal-forms/upload
// OneDrive mode: saves metadata to Supabase, fires PDF to OneDrive async.
// Fallback mode: stores PDF blob in Supabase (original behaviour).
// ============================================================
app.post('/api/portal-forms/upload', async (req, res) => {
  try {
    const { formId, formNo, filename, uploadedBy, pdfBase64, category, vendor, quarterlyImpact } = req.body;
    if (!formId || !formNo || !filename || !uploadedBy || !pdfBase64) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    // Metadata always goes to Supabase (tiny — no PDF blob)
    const { error: formErr } = await supabase
      .from('portal_forms')
      .insert({
        id: formId, form_no: formNo, filename, uploaded_by: uploadedBy,
        category: category || 'Electrical', vendor: vendor || '',
        quarterly_impact: quarterlyImpact || '', status: 'pending_admin',
        onedrive_pdf_path: ONEDRIVE_PDF_WEBHOOK ? `TKE-Forms/${formNo}/${filename}` : null
      });
    if (formErr) throw formErr;

    if (ONEDRIVE_PDF_WEBHOOK) {
      // Fire-and-forget to Power Automate — saves to OneDrive/TKE-Forms/{formNo}/{filename}
      sendToOneDrive(ONEDRIVE_PDF_WEBHOOK, {
        action: 'save_pdf', formId, formNo, filename, uploadedBy,
        category: category || 'Electrical', vendor: vendor || '',
        folderPath: `TKE-Forms/${formNo}`, pdfBase64,
        uploadedAt: new Date().toISOString()
      });
      console.log(`✅ Form metadata saved, PDF → OneDrive: ${formNo}`);
    } else {
      // Fallback: store PDF blob in Supabase
      const { error: pdfErr } = await supabase
        .from('portal_form_pdfs')
        .insert({ form_id: formId, pdf_base64: pdfBase64, file_size_bytes: Math.round(pdfBase64.length * 0.75) });
      if (pdfErr) throw pdfErr;
      console.log(`✅ Form uploaded to Supabase: ${formNo}`);
    }

    res.json({ success: true, formId });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// PORTAL FORMS — GET ALL (metadata only, no PDF blobs)
// GET /api/portal-forms
// ============================================================
app.get('/api/portal-forms', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('portal_forms')
      .select(`id, form_no, filename, uploaded_at, uploaded_by, category, vendor,
               quarterly_impact, status, onedrive_pdf_path,
               sig_admin, sig_pm, sig_vp, sig_fc,
               sig_admin_at, sig_pm_at, sig_vp_at, sig_fc_at,
               sig_admin_by, sig_pm_by, sig_vp_by, sig_fc_by,
               attachment_count, has_concern, concerns, downloaded_at`)
      .order('uploaded_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, forms: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// PORTAL FORMS — GET SINGLE (metadata + pdfBase64 if Supabase mode)
// GET /api/portal-forms/:formId
// In OneDrive mode pdfBase64 is null — client calls /pdf endpoint next.
// ============================================================
app.get('/api/portal-forms/:formId', async (req, res) => {
  try {
    const { formId } = req.params;
    const { data: form, error: formErr } = await supabase
      .from('portal_forms').select('*').eq('id', formId).single();
    if (formErr || !form) return res.status(404).json({ success: false, error: 'Form not found.' });

    let pdfBase64 = null;
    if (!ONEDRIVE_PDF_WEBHOOK) {
      const { data: pdf } = await supabase
        .from('portal_form_pdfs').select('pdf_base64').eq('form_id', formId).single();
      pdfBase64 = pdf?.pdf_base64 || null;
    }

    res.json({ success: true, form: { ...form, pdfBase64 } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// PORTAL FORMS — FETCH PDF FROM ONEDRIVE
// GET /api/portal-forms/:formId/pdf
// Called by client when pdfBase64 is null (OneDrive mode).
// ============================================================
app.get('/api/portal-forms/:formId/pdf', async (req, res) => {
  try {
    const { formId } = req.params;

    if (!ONEDRIVE_PDF_WEBHOOK) {
      const { data: pdf, error } = await supabase
        .from('portal_form_pdfs').select('pdf_base64').eq('form_id', formId).single();
      if (error || !pdf) return res.status(404).json({ success: false, error: 'PDF not found.' });
      return res.json({ success: true, pdfBase64: pdf.pdf_base64 });
    }

    const { data: form } = await supabase
      .from('portal_forms').select('form_no, filename').eq('id', formId).single();
    if (!form) return res.status(404).json({ success: false, error: 'Form not found.' });

    const axios = require('axios');
    const response = await axios.post(ONEDRIVE_PDF_WEBHOOK, {
      action: 'get_pdf', formId, formNo: form.form_no,
      folderPath: `TKE-Forms/${form.form_no}`, filename: form.filename
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });

    const pdfBase64 = response.data?.pdfBase64 || response.data?.base64 || null;
    if (!pdfBase64) return res.status(404).json({ success: false, error: 'PDF not returned from OneDrive. Check Power Automate flow.' });

    res.json({ success: true, pdfBase64 });
  } catch (error) {
    console.error('❌ PDF fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// PORTAL FORMS — APPLY SIGNATURE
// POST /api/portal-forms/:formId/sign
// Enforces sequence: admin → pm → vp → fc
// Fires Excel log to OneDrive on 4th signature.
// ============================================================
app.post('/api/portal-forms/:formId/sign', async (req, res) => {
  try {
    const { formId } = req.params;
    const { role, signatureData, signedBy } = req.body;

    const validRoles = ['admin', 'pm', 'vp', 'fc'];
    if (!validRoles.includes(role)) return res.status(400).json({ success: false, error: 'Invalid role key.' });
    if (!signatureData || !signedBy) return res.status(400).json({ success: false, error: 'signatureData and signedBy required.' });

    const { data: form, error: fetchErr } = await supabase
      .from('portal_forms')
      .select('sig_admin, sig_pm, sig_vp, sig_fc, status, form_no, filename, category, vendor, uploaded_by, uploaded_at, quarterly_impact')
      .eq('id', formId).single();

    if (fetchErr || !form) return res.status(404).json({ success: false, error: 'Form not found.' });

    if (role === 'pm' && !form.sig_admin) return res.status(403).json({ success: false, error: 'Admin must sign first.' });
    if (role === 'vp' && !form.sig_pm)    return res.status(403).json({ success: false, error: 'Purchase Manager must sign first.' });
    if (role === 'fc' && !form.sig_vp)    return res.status(403).json({ success: false, error: 'VP Purchase must sign first.' });
    if (form[`sig_${role}`])              return res.status(409).json({ success: false, error: 'Already signed.' });

    const now = new Date().toISOString();
    const updateFields = {
      [`sig_${role}`]: signatureData,
      [`sig_${role}_at`]: now,
      [`sig_${role}_by`]: signedBy
    };

    const newSigs = {
      admin: role === 'admin' ? signatureData : form.sig_admin,
      pm:    role === 'pm'    ? signatureData : form.sig_pm,
      vp:    role === 'vp'    ? signatureData : form.sig_vp,
      fc:    role === 'fc'    ? signatureData : form.sig_fc,
    };
    const sigCount = Object.values(newSigs).filter(Boolean).length;
    updateFields.status = sigCount === 4 ? 'done' : newSigs.admin ? 'in_circulation' : 'pending_admin';

    const { error: updateErr } = await supabase.from('portal_forms').update(updateFields).eq('id', formId);
    if (updateErr) throw updateErr;

    console.log(`✅ Signed: form=${form.form_no} role=${role} by=${signedBy}`);

    // Fire Excel log when all 4 signed
    if (updateFields.status === 'done' && ONEDRIVE_EXCEL_WEBHOOK) {
      sendToOneDrive(ONEDRIVE_EXCEL_WEBHOOK, {
        action: 'log_to_excel',
        formId, formNo: form.form_no, filename: form.filename,
        category: form.category, vendor: form.vendor,
        uploadedBy: form.uploaded_by, uploadedAt: form.uploaded_at,
        quarterlyImpact: form.quarterly_impact,
        sig_fc_by: signedBy, sig_fc_at: now,
        fullySignedAt: now,
        onedriveFolder: `TKE-Forms/${form.form_no}`
      });
      console.log(`📊 Excel log triggered: ${form.form_no}`);
    }

    res.json({ success: true, status: updateFields.status });
  } catch (error) {
    console.error('❌ Sign error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ATTACHMENTS — ADD
// POST /api/portal-forms/:formId/attachments
// OneDrive mode: file sent to OneDrive/TKE-Forms/{formNo}/Attachments/
// Fallback: full blob stored in Supabase JSONB
// ============================================================
app.post('/api/portal-forms/:formId/attachments', async (req, res) => {
  try {
    const { formId } = req.params;
    const { name, type, size, data } = req.body;

    const MAX = 10 * 1024 * 1024;
    const approxSize = Math.round((data.length * 3) / 4);
    if (approxSize > MAX) return res.status(400).json({ success: false, error: `${name} exceeds 10MB limit.` });

    const { data: form } = await supabase
      .from('portal_forms').select('attachments, attachment_count, form_no').eq('id', formId).single();

    // Send to OneDrive (async, non-blocking)
    sendToOneDrive(ONEDRIVE_ATT_WEBHOOK || ONEDRIVE_PDF_WEBHOOK, {
      action: 'save_attachment', formId,
      formNo: form?.form_no || formId,
      folderPath: `TKE-Forms/${form?.form_no || formId}/Attachments`,
      filename: name, fileType: type, fileBase64: data,
      uploadedAt: new Date().toISOString()
    });

    const existing = form?.attachments || [];
    const newAtt = (ONEDRIVE_ATT_WEBHOOK || ONEDRIVE_PDF_WEBHOOK)
      ? { name, type, size, uploadedAt: new Date().toISOString(), onedrive: true }
      : { name, type, size, data, uploadedAt: new Date().toISOString() };
    const updated = [...existing, newAtt];

    const { error } = await supabase
      .from('portal_forms').update({ attachments: updated, attachment_count: updated.length }).eq('id', formId);
    if (error) throw error;

    console.log(`📎 Attachment: ${name} → form ${form?.form_no}`);
    res.json({ success: true, count: updated.length });
  } catch (error) {
    console.error('❌ Attachment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// RAISE CONCERN
// POST /api/portal-forms/:formId/concern
// Body: { raisedBy, raisedByName, role, concern }
// ============================================================
app.post('/api/portal-forms/:formId/concern', async (req, res) => {
  try {
    const { formId } = req.params;
    const { raisedBy, raisedByName, role, concern } = req.body;

    if (!concern || concern.length < 6) {
      return res.status(400).json({ success: false, error: 'Concern must be at least 6 characters.' });
    }

    // Get current concerns array
    const { data: form } = await supabase
      .from('portal_forms')
      .select('concerns')
      .eq('id', formId)
      .single();

    const existing = form?.concerns || [];
    const newConcern = {
      raisedBy, raisedByName, role, concern,
      raisedAt: new Date().toISOString(),
      resolved: false
    };
    const updated = [...existing, newConcern];

    const { error } = await supabase
      .from('portal_forms')
      .update({ concerns: updated, has_concern: true })
      .eq('id', formId);

    if (error) throw error;

    console.log(`⚠ Concern raised on ${formId} by ${raisedBy}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Concern error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// PORTAL FORMS — DELETE
// DELETE /api/portal-forms/:formId
// ============================================================
app.delete('/api/portal-forms/:formId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('portal_forms')
      .delete()
      .eq('id', req.params.formId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// MARK DOWNLOADED
// POST /api/portal-forms/:formId/downloaded
// ============================================================
app.post('/api/portal-forms/:formId/downloaded', async (req, res) => {
  try {
    await supabase
      .from('portal_forms')
      .update({ downloaded_at: new Date().toISOString() })
      .eq('id', req.params.formId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// EXISTING ROUTES (kept from original server.js)
// ============================================================

app.post('/api/forms/create', async (req, res) => {
  try {
    const { items } = req.body;
    console.log(`📝 Creating form with ${items.length} items`);
    const { data: formNum, error: fnErr } = await supabase.rpc('get_next_form_number');
    if (fnErr) throw fnErr;
    const formSeq = parseInt(formNum.split('_')[3]);
    const formRows = [];
    for (const item of items) {
      const cleanPrice = parseFloat(String(item.newPrice || 0).replace(/,/g, ''));
      const { data: calcData, error: calcError } = await supabase.rpc('calculate_form_row', {
        p_item_code: String(item.itemCode),
        p_item_description: String(item.itemDescription || ''),
        p_vendor_code: String(item.vendorCode),
        p_vendor_name: String(item.vendorName || ''),
        p_new_price: cleanPrice,
        p_currency: String(item.currency || 'INR')
      });
      if (calcError) { console.error('Calculation error:', calcError); continue; }
      const calc = calcData[0];
      formRows.push({
        id: `${formNum}_${item.itemCode}_${item.vendorCode}`,
        form_number: formNum, form_sequence: formSeq,
        item_code: String(item.itemCode), item_description: String(item.itemDescription || ''),
        vendor_code: String(item.vendorCode), vendor_name: String(item.vendorName || ''),
        new_price: cleanPrice, currency: String(item.currency || 'INR'),
        old_price: parseFloat(calc.old_price || 0), price_diff: parseFloat(calc.price_diff || 0),
        percent_diff: parseFloat(calc.percent_diff || 0), porv_qty: parseFloat(calc.porv_qty || 0),
        impact: parseFloat(calc.impact || 0), remarks: String(calc.remarks || 'Calculated')
      });
    }
    const { data: insertData, error: insertError } = await supabase.from('cost_approval_forms').insert(formRows).select();
    if (insertError) throw insertError;
    res.json({ success: true, formNumber: formNum, items: insertData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/forms/:formNumber', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cost_approval_forms').select('*').eq('form_number', req.params.formNumber).order('item_code');
    if (error) throw error;
    res.json({ success: true, formNumber: req.params.formNumber, items: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/forms/:formNumber/downloaded', async (req, res) => {
  try {
    await supabase.from('cost_approval_forms').update({ downloaded_at: new Date().toISOString() }).eq('form_number', req.params.formNumber);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// ============================================================
// COST ANALYZER — SAVE RECORD
// POST /api/analytics/record
// ============================================================
app.post('/api/analytics/record', async (req, res) => {
  try {
    const { form_no, form_date, vendor_code, vendor_name, category, dept,
            item_code, item_desc, old_price, new_price, delta, pct_diff,
            qty_per_lift, impact, source_file } = req.body;

    if (!form_no || !item_code) {
      return res.status(400).json({ success: false, error: 'form_no and item_code required.' });
    }

    // Duplicate check: form_no + item_code + vendor_code
    const { data: existing } = await supabase
      .from('form_analytics')
      .select('id')
      .eq('form_no', form_no)
      .eq('item_code', item_code)
      .eq('vendor_code', vendor_code || '')
      .single();

    if (existing) return res.json({ success: true, status: 'dupe', id: existing.id });

    const { data, error } = await supabase
      .from('form_analytics')
      .insert({
        form_no, form_date: form_date || null,
        vendor_code: vendor_code || '', vendor_name: vendor_name || '',
        category: category || '', dept: dept || '',
        item_code, item_desc: item_desc || '',
        old_price: parseFloat(old_price)||0, new_price: parseFloat(new_price)||0,
        delta: parseFloat(delta)||0, pct_diff: parseFloat(pct_diff)||0,
        qty_per_lift: parseFloat(qty_per_lift)||0, impact: parseFloat(impact)||0,
        source_file: source_file || ''
      })
      .select('id').single();

    if (error) throw error;
    res.json({ success: true, status: 'added', id: data.id });
  } catch (error) {
    console.error('Analytics save error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// COST ANALYZER — GET ALL RECORDS
// GET /api/analytics/records
// ============================================================
app.get('/api/analytics/records', async (req, res) => {
  try {
    const { vendor, item, from, to } = req.query;
    let query = supabase.from('form_analytics').select('*').order('form_date', { ascending: false });
    if (vendor) query = query.ilike('vendor_code', `%${vendor}%`);
    if (item)   query = query.ilike('item_code', `%${item}%`);
    if (from)   query = query.gte('form_date', from);
    if (to)     query = query.lte('form_date', to);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, records: data || [], count: (data||[]).length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// COST ANALYZER — DELETE RECORD
// DELETE /api/analytics/record/:id
// ============================================================
app.delete('/api/analytics/record/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('form_analytics').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

//SIGN UP_SIGN IN CREDENTIALS FOR THE ADMIN PORTAL//
  const bcrypt = require('bcryptjs');
 
// ─── SIGNUP ───────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
 
    // Validate input
    if (!email || !password) {
      return res.json({ success: false, error: 'Email and password are required' });
    }
    if (password.length < 6) {
      return res.json({ success: false, error: 'Password must be at least 6 characters' });
    }
 
    // Check if email already exists
    const { data: existing } = await supabase
      .from('admin_users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .single();
 
    if (existing) {
      return res.json({ success: false, error: 'An account with this email already exists' });
    }
 
    // Hash password (10 salt rounds)
    const password_hash = await bcrypt.hash(password, 10);
 
    // Insert new user
    const { data, error } = await supabase
      .from('admin_users')
      .insert({
        email: email.toLowerCase().trim(),
        password_hash,
        name: (name || '').trim() || null,
      })
      .select('id, email, name')
      .single();
 
    if (error) {
      console.error('Signup DB error:', error);
      return res.json({ success: false, error: 'Could not create account' });
    }
 
    res.json({ success: true, name: data.name, email: data.email });
  } catch (e) {
    console.error('Signup error:', e);
    res.json({ success: false, error: 'Server error during signup' });
  }
});
 
// ─── LOGIN ────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
 
    if (!email || !password) {
      return res.json({ success: false, error: 'Email and password are required' });
    }
 
    // Fetch user by email
    const { data: user, error } = await supabase
      .from('admin_users')
      .select('id, email, name, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();
 
    if (error || !user) {
      return res.json({ success: false, error: 'Invalid email or password' });
    }
 
    // Compare password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.json({ success: false, error: 'Invalid email or password' });
    }
 
    // Update last_login timestamp
    await supabase
      .from('admin_users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);
 
    res.json({ success: true, name: user.name, email: user.email });
  } catch (e) {
    console.error('Login error:', e);
    res.json({ success: false, error: 'Server error during login' });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 https://tkei-psm-backend.onrender.com`);
  console.log(`📁 OneDrive PDF: ${ONEDRIVE_PDF_WEBHOOK ? '✅ configured' : '⚠ not set (Supabase fallback)'}`);
  console.log(`📎 OneDrive ATT: ${ONEDRIVE_ATT_WEBHOOK ? '✅ configured' : '⚠ not set'}`);
  console.log(`📊 OneDrive Excel: ${ONEDRIVE_EXCEL_WEBHOOK ? '✅ configured' : '⚠ not set'}`);
});
