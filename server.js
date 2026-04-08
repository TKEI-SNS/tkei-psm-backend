const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());

// Email endpoint
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, formNo, signerName, signerRole } = req.body;
    const formLink = `https://tkei-psm-portals.pages.dev/signatory-portal.html?form=${formNo}`;
    
    const { data, error } = await resend.emails.send({
      from: 'TK Elevator <onboarding@resend.dev>',
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
    
    if (error) throw error;
    console.log('✅ Email sent:', to);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create form endpoint
app.post('/api/forms/create', async (req, res) => {
  try {
    const { items } = req.body;
    console.log(`📝 Creating form with ${items.length} items`);
    
    const { data: formNumData, error: formNumError } = await supabase.rpc('get_next_form_number');
    if (formNumError) throw formNumError;
    
    const formNumber = formNumData;
    const formSequence = parseInt(formNumber.split('_')[3]);
    console.log(`✅ Form number: ${formNumber}`);
    
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
    
    const { data: insertData, error: insertError } = await supabase
      .from('cost_approval_forms')
      .insert(formRows)
      .select();
    
    if (insertError) throw insertError;
    console.log(`✅ Inserted ${insertData.length} rows`);
    
    res.json({ success: true, formNumber: formNumber, items: insertData });
  } catch (error) {
    console.error('❌ Form creation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get form endpoint
app.get('/api/forms/:formNumber', async (req, res) => {
  try {
    const { formNumber } = req.params;
    const { data, error } = await supabase
      .from('cost_approval_forms')
      .select('*')
      .eq('form_number', formNumber)
      .order('item_code');
    
    if (error) throw error;
    res.json({ success: true, formNumber: formNumber, items: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
