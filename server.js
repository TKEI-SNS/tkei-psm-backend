const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
//const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
//const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());

// Create form with calculations
app.post('/api/forms/create', async (req, res) => {
  try {
    const { items } = req.body;
    console.log(`📝 Creating form with ${items.length} items`);
    
    const { data: formNum, error: fnErr } = await supabase.rpc('get_next_form_number');
    if (fnErr) throw fnErr;
    
    const formSeq = parseInt(formNum.split('_')[3]);
    console.log(`✅ Form number: ${formNum}`);
    
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
        id: `${formNum}_${item.itemCode}_${item.vendorCode}`,
        form_number: formNum,
        form_sequence: formSeq,
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
    
    res.json({ success: true, formNumber: formNum, items: insertData });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get form
app.get('/api/forms/:formNumber', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cost_approval_forms')
      .select('*')
      .eq('form_number', req.params.formNumber)
      .order('item_code');
    
    if (error) throw error;
    res.json({ success: true, formNumber: req.params.formNumber, items: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send email
//app.post('/api/send-email', async (req, res) => {
  //try {
    //const { to, formNo, signerName, signerRole } = req.body;
    //const link = `https://tkei-psm-portals.pages.dev/signatory-portal.html?form=${formNo}`;
    
    //const { data, error } = await resend.emails.send({
      //from: 'TK Elevator <onboarding@resend.dev>',
      //to: to,
      //subject: `Form ${formNo} - Sign Required`,
      //html: `<div style="font-family:Arial;padding:20px;">
//<h2>Hello ${signerName},</h2>
//<p>You are designated as <strong>${signerRole}</strong> for Form <strong>${formNo}</strong>.</p>
//<center><a href="${link}" style="display:inline-block;background:#e94560;color:white;padding:12px 30px;text-decoration:none;border-radius:5px;margin:20px 0;">SIGN DOCUMENT</a></center>
//<p>Link: <a href="${link}">${link}</a></p>
//</div>`
//    });
    
  //  if (error) throw error;
    //console.log('✅ Email sent:', to);
    //res.json({ success: true });
  //} catch (error) {
    //console.error('❌ Email error:', error);
    //res.status(500).json({ success: false, error: error.message });
  //}
//});

//app.listen(PORT, '0.0.0.0', () => {
 // console.log(`🚀 Server running on port ${PORT}`);
//});
