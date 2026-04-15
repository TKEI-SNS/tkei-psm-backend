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
app.use(express.json({ limit: '50mb' }));  // Large limit for PDF base64

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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

    const validRoles = ['Purchase Manager', 'VP Purchase', 'Finance Controller'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role.' });
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
// PORTAL FORMS — UPLOAD
// POST /api/portal-forms/upload
// Body: { formId, formNo, filename, uploadedBy, pdfBase64, category, vendor }
// ============================================================
app.post('/api/portal-forms/upload', async (req, res) => {
  try {
    const { formId, formNo, filename, uploadedBy, pdfBase64, category, vendor, quarterlyImpact } = req.body;

    if (!formId || !formNo || !filename || !uploadedBy || !pdfBase64) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    // Insert form metadata
    const { error: formErr } = await supabase
      .from('portal_forms')
      .insert({
        id: formId,
        form_no: formNo,
        filename,
        uploaded_by: uploadedBy,
        category: category || 'Electrical',
        vendor: vendor || '',
        quarterly_impact: quarterlyImpact || '',
        status: 'pending_admin'
      });

    if (formErr) throw formErr;

    // Insert PDF separately (large blob)
    const { error: pdfErr } = await supabase
      .from('portal_form_pdfs')
      .insert({
        form_id: formId,
        pdf_base64: pdfBase64,
        file_size_bytes: Math.round(pdfBase64.length * 0.75)
      });

    if (pdfErr) throw pdfErr;

    console.log(`✅ Form uploaded: ${formNo} by ${uploadedBy}`);
    res.json({ success: true, formId });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// PORTAL FORMS — GET ALL (metadata only, no PDF)
// GET /api/portal-forms
// ============================================================
app.get('/api/portal-forms', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('portal_forms')
      .select('id, form_no, filename, uploaded_at, uploaded_by, category, vendor, quarterly_impact, status, sig_admin, sig_pm, sig_vp, sig_fc, sig_admin_at, sig_pm_at, sig_vp_at, sig_fc_at, sig_admin_by, sig_pm_by, sig_vp_by, sig_fc_by')
      .order('uploaded_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, forms: data || [] });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// PORTAL FORMS — GET SINGLE FORM WITH PDF
// GET /api/portal-forms/:formId
// ============================================================
app.get('/api/portal-forms/:formId', async (req, res) => {
  try {
    const { formId } = req.params;

    const { data: form, error: formErr } = await supabase
      .from('portal_forms')
      .select('*')
      .eq('id', formId)
      .single();

    if (formErr || !form) {
      return res.status(404).json({ success: false, error: 'Form not found.' });
    }

    const { data: pdf, error: pdfErr } = await supabase
      .from('portal_form_pdfs')
      .select('pdf_base64')
      .eq('form_id', formId)
      .single();

    if (pdfErr || !pdf) {
      return res.status(404).json({ success: false, error: 'PDF not found.' });
    }

    res.json({ success: true, form: { ...form, pdfBase64: pdf.pdf_base64 } });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================
// PORTAL FORMS — APPLY SIGNATURE
// POST /api/portal-forms/:formId/sign
// Body: { role: 'admin'|'pm'|'vp'|'fc', signatureData, signedBy (email) }
// ============================================================
app.post('/api/portal-forms/:formId/sign', async (req, res) => {
  try {
    const { formId } = req.params;
    const { role, signatureData, signedBy } = req.body;

    const validRoles = ['admin', 'pm', 'vp', 'fc'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role key.' });
    }
    if (!signatureData || !signedBy) {
      return res.status(400).json({ success: false, error: 'signatureData and signedBy required.' });
    }

    // Get current form to check sequence
    const { data: form, error: fetchErr } = await supabase
      .from('portal_forms')
      .select('sig_admin, sig_pm, sig_vp, sig_fc, status')
      .eq('id', formId)
      .single();

    if (fetchErr || !form) {
      return res.status(404).json({ success: false, error: 'Form not found.' });
    }

    // Enforce signing sequence
    if (role === 'pm' && !form.sig_admin) {
      return res.status(403).json({ success: false, error: 'Admin must sign first.' });
    }
    if (role === 'vp' && !form.sig_pm) {
      return res.status(403).json({ success: false, error: 'Purchase Manager must sign first.' });
    }
    if (role === 'fc' && !form.sig_vp) {
      return res.status(403).json({ success: false, error: 'VP Purchase must sign first.' });
    }
    if (form[`sig_${role}`]) {
      return res.status(409).json({ success: false, error: 'Already signed.' });
    }

    const now = new Date().toISOString();
    const updateFields = {
      [`sig_${role}`]: signatureData,
      [`sig_${role}_at`]: now,
      [`sig_${role}_by`]: signedBy
    };

    // Update status
    const newSigs = {
      admin: role === 'admin' ? signatureData : form.sig_admin,
      pm: role === 'pm' ? signatureData : form.sig_pm,
      vp: role === 'vp' ? signatureData : form.sig_vp,
      fc: role === 'fc' ? signatureData : form.sig_fc,
    };
    const sigCount = Object.values(newSigs).filter(Boolean).length;
    updateFields.status = sigCount === 4 ? 'done' : newSigs.admin ? 'in_circulation' : 'pending_admin';

    const { error: updateErr } = await supabase
      .from('portal_forms')
      .update(updateFields)
      .eq('id', formId);

    if (updateErr) throw updateErr;

    console.log(`✅ Signed: form=${formId} role=${role} by=${signedBy}`);
    res.json({ success: true, status: updateFields.status });

  } catch (error) {
    console.error('❌ Sign error:', error);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
