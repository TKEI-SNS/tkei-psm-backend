// ============================================================
// TK ELEVATOR — PSM CHAKAN  
// Unified Backend: Portal Forms + Signatory + Cost Analyzer
// Hosted on: https://tkei-psm-backend.onrender.com
//
// ENVIRONMENT VARIABLES (Render Dashboard):
//   SUPABASE_URL, SUPABASE_KEY (service_role after enabling RLS)
//   ONEDRIVE_PDF_WEBHOOK_URL, ONEDRIVE_ATT_WEBHOOK_URL, ONEDRIVE_EXCEL_WEBHOOK_URL
//
// Run admin_control_setup.sql in Supabase before deploying
// ============================================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
// express-rate-limit — graceful fallback if not installed
let rateLimit;
try { rateLimit = require('express-rate-limit'); }
catch(e) { console.warn('⚠ express-rate-limit not installed — rate limiting disabled');
  rateLimit = (opts) => (req,res,next) => next(); }
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors({
  origin: ['https://tke-portal.pages.dev', /\.pages\.dev$/, 'http://localhost:3000'],
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','admin_email','admin_password']
}));
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  next();
});

const loginLimiter = rateLimit({ windowMs:15*60*1000, max:10,
  message:{success:false,error:'Too many attempts. Try again in 15 minutes.'} });

const ONEDRIVE_PDF_WEBHOOK   = process.env.ONEDRIVE_PDF_WEBHOOK_URL   || null;
const ONEDRIVE_ATT_WEBHOOK   = process.env.ONEDRIVE_ATT_WEBHOOK_URL   || null;
const ONEDRIVE_EXCEL_WEBHOOK = process.env.ONEDRIVE_EXCEL_WEBHOOK_URL || null;

async function sendToOneDrive(url, payload) {
  if (!url) return;
  try { const axios=require('axios'); await axios.post(url,payload,{timeout:30000}); }
  catch(e) { console.error('OneDrive (non-fatal):',e.message); }
}

const clean = s => String(s||'').replace(/<[^>]*>/g,'').trim();

app.get('/health',(req,res)=>res.json({status:'ok',time:new Date().toISOString()}));

// ── ROLE RULES ──
const SINGLE_SLOT_ROLES = ['VP Purchase','Finance Controller','Admin Control'];
const PENDING_ROLES     = ['VP Purchase','Finance Controller'];

// ── REGISTER ──
app.post('/api/auth/register', loginLimiter, async (req,res) => {
  try {
    const email=clean(req.body.email).toLowerCase(), password=req.body.password||'';
    const name=clean(req.body.name), role=clean(req.body.role);
    if(!email||!password||!name||!role) return res.status(400).json({success:false,error:'All fields required.'});
    const validRoles=['Admin','Purchase Manager','VP Purchase','Finance Controller'];
    if(!validRoles.includes(role)) return res.status(400).json({success:false,error:'Invalid role.'});
    if(role==='Admin Control') return res.status(403).json({success:false,error:'Admin Control is managed by superadmin only.'});
    if(role==='Admin'&&!email.endsWith('@tkelevator.com')) return res.status(400).json({success:false,error:'Admin requires @tkelevator.com email.'});
    if(password.length<6) return res.status(400).json({success:false,error:'Password min 6 characters.'});
    const {data:ex}=await supabase.from('portal_users').select('id').eq('email',email).single();
    if(ex) return res.status(409).json({success:false,error:'Account already exists. Please sign in.'});
    if(SINGLE_SLOT_ROLES.includes(role)){
      const {data:taken}=await supabase.from('portal_users').select('id').eq('role',role).in('status',['active','pending']);
      if(taken&&taken.length>0) return res.status(409).json({success:false,error:`${role} slot already occupied. Contact Admin Control.`});
    }
    const password_hash=await bcrypt.hash(password,10);
    const status=PENDING_ROLES.includes(role)?'pending':'active';
    const {data:user,error}=await supabase.from('portal_users')
      .insert({email,password_hash,name,role,status}).select('id,email,name,role,status').single();
    if(error) throw error;
    console.log(`✅ Registered: ${email} as ${role} [${status}]`);
    res.json({success:true,pending:status==='pending',
      message:status==='pending'?'Request submitted. Admin Control will approve your access.':null,
      user:{id:user.id,email:user.email,name:user.name,role:user.role,sig:null}});
  } catch(e){console.error('Register:',e);res.status(500).json({success:false,error:e.message});}
});

// ── LOGIN ──
app.post('/api/auth/login', loginLimiter, async (req,res) => {
  try {
    const {email,password}=req.body;
    if(!email||!password) return res.status(400).json({success:false,error:'Email and password required.'});
    const {data:user}=await supabase.from('portal_users')
      .select('id,email,name,role,status,password_hash,signature_data')
      .eq('email',email.toLowerCase()).single();
    if(!user) return res.status(401).json({success:false,error:'Invalid email or password.'});
    if(!await bcrypt.compare(password,user.password_hash)) return res.status(401).json({success:false,error:'Invalid email or password.'});
    const status=user.status||'active';
    if(status!=='active'){
      const msg=status==='pending'?'Account pending Admin Control approval.':'Account suspended. Contact Admin Control.';
      return res.status(403).json({success:false,error:msg});
    }
    console.log(`✅ Login: ${email}`);
    res.json({success:true,user:{id:user.id,email:user.email,name:user.name,role:user.role,sig:user.signature_data||null}});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ── ADMIN LOGIN ──
app.post('/api/auth/admin-login', loginLimiter, async (req,res) => {
  try {
    const {email,password}=req.body;
    if(!email.toLowerCase().endsWith('@tkelevator.com')) return res.status(401).json({success:false,error:'Only @tkelevator.com accounts allowed.'});
    const {data:user}=await supabase.from('portal_users')
      .select('id,email,name,role,status,password_hash,signature_data')
      .eq('email',email.toLowerCase()).in('role',['Admin','Admin Control']).single();
    if(!user){
      if(password.length<4) return res.status(401).json({success:false,error:'Enter a valid password.'});
      const password_hash=await bcrypt.hash(password,10);
      const {data:na,error:ce}=await supabase.from('portal_users')
        .insert({email:email.toLowerCase(),password_hash,name:email.split('@')[0],role:'Admin',status:'active'})
        .select('id,email,name,role').single();
      if(ce) throw ce;
      return res.json({success:true,user:{id:na.id,email:na.email,name:na.name,role:na.role,sig:null}});
    }
    if(!await bcrypt.compare(password,user.password_hash)) return res.status(401).json({success:false,error:'Invalid password.'});
    if((user.status||'active')!=='active') return res.status(403).json({success:false,error:'Account suspended.'});
    console.log(`✅ Admin login: ${email}`);
    res.json({success:true,user:{id:user.id,email:user.email,name:user.name,role:user.role,sig:user.signature_data||null}});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ── SAVE SIGNATURE ──
app.post('/api/auth/save-signature', async (req,res) => {
  try {
    const {userId,signatureData}=req.body;
    if(!userId||!signatureData) return res.status(400).json({success:false,error:'userId and signatureData required.'});
    const {error}=await supabase.from('portal_users').update({signature_data:signatureData}).eq('id',userId);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ── ADMIN CONTROL HELPER ──
async function verifyAdminControl(req,res){
  const ae=(req.headers['admin_email']||'').toLowerCase();
  const ap=req.headers['admin_password']||'';
  if(!ae||!ap){res.status(401).json({success:false,error:'Admin Control credentials required.'});return null;}
  const {data:admin}=await supabase.from('portal_users').select('id,role,password_hash,status').eq('email',ae).single();
  if(!admin||admin.role!=='Admin Control'||admin.status!=='active'){res.status(403).json({success:false,error:'Not authorised.'});return null;}
  if(!await bcrypt.compare(ap,admin.password_hash)){res.status(401).json({success:false,error:'Invalid credentials.'});return null;}
  return admin;
}

app.get('/api/admin-control/users', async (req,res) => {
  try {
    const admin=await verifyAdminControl(req,res); if(!admin) return;
    const {data:users,error}=await supabase.from('portal_users').select('id,email,name,role,status,created_at').order('role').order('created_at');
    if(error) throw error;
    res.json({success:true,users});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/admin-control/users/:id/approve', async (req,res) => {
  try {
    const admin=await verifyAdminControl(req,res); if(!admin) return;
    const {error}=await supabase.from('portal_users').update({status:'active'}).eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/admin-control/users/:id/suspend', async (req,res) => {
  try {
    const admin=await verifyAdminControl(req,res); if(!admin) return;
    const {data:t}=await supabase.from('portal_users').select('role').eq('id',req.params.id).single();
    if(t&&t.role==='Admin Control') return res.status(403).json({success:false,error:'Cannot suspend Admin Control.'});
    const {error}=await supabase.from('portal_users').update({status:'suspended'}).eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.delete('/api/admin-control/users/:id', async (req,res) => {
  try {
    const admin=await verifyAdminControl(req,res); if(!admin) return;
    const {data:t}=await supabase.from('portal_users').select('role').eq('id',req.params.id).single();
    if(t&&t.role==='Admin Control') return res.status(403).json({success:false,error:'Cannot delete Admin Control.'});
    const {error}=await supabase.from('portal_users').delete().eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/admin-control/users/create', async (req,res) => {
  try {
    const admin=await verifyAdminControl(req,res); if(!admin) return;
    const email=clean(req.body.email).toLowerCase(), password=req.body.password||'';
    const name=clean(req.body.name), role=clean(req.body.role);
    const allowed=['Admin','Admin Control','VP Purchase','Finance Controller','Purchase Manager'];
    if(!allowed.includes(role)) return res.status(400).json({success:false,error:'Invalid role.'});
    if(password.length<6) return res.status(400).json({success:false,error:'Password min 6 chars.'});
    if(['Admin Control','VP Purchase','Finance Controller'].includes(role)){
      const {data:ex}=await supabase.from('portal_users').select('id').eq('role',role).in('status',['active','pending']);
      if(ex&&ex.length>0) return res.status(409).json({success:false,error:`${role} slot already occupied.`});
    }
    const {data:exE}=await supabase.from('portal_users').select('id').eq('email',email).single();
    if(exE) return res.status(409).json({success:false,error:'Email already registered.'});
    const password_hash=await bcrypt.hash(password,10);
    const {data:user,error}=await supabase.from('portal_users').insert({email,password_hash,name,role,status:'active'}).select('id,email,name,role,status').single();
    if(error) throw error;
    res.json({success:true,user});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ── PORTAL FORMS ──
app.post('/api/portal-forms/upload', async (req,res) => {
  try {
    const {formId,formNo,filename,uploadedBy,pdfBase64,category,vendor,quarterlyImpact}=req.body;
    if(!formId||!formNo||!filename||!uploadedBy) return res.status(400).json({success:false,error:'formId,formNo,filename,uploadedBy required.'});
    const {error:me}=await supabase.from('portal_forms').insert({
      id:formId,form_no:formNo,filename,uploaded_by:uploadedBy,
      uploaded_at:new Date().toISOString(),category:category||'Electrical',
      vendor:vendor||'',quarterly_impact:quarterlyImpact||'',
      status:'pending_admin',sig_admin:null,sig_pm:null,sig_vp:null,sig_fc:null
    });
    if(me) throw me;
    if(pdfBase64){
      const {error:pe}=await supabase.from('portal_form_pdfs').insert({form_id:formId,pdf_base64:pdfBase64});
      if(pe) throw pe;
      if(ONEDRIVE_PDF_WEBHOOK) sendToOneDrive(ONEDRIVE_PDF_WEBHOOK,{action:'save_pdf',formId,formNo,filename});
    }
    res.json({success:true,formId});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/portal-forms', async (req,res) => {
  try {
    const {data,error}=await supabase.from('portal_forms').select(`
      id,form_no,filename,uploaded_at,uploaded_by,category,vendor,
      quarterly_impact,status,onedrive_pdf_path,
      sig_admin,sig_pm,sig_vp,sig_fc,
      sig_admin_at,sig_pm_at,sig_vp_at,sig_fc_at,
      sig_admin_by,sig_pm_by,sig_vp_by,sig_fc_by,
      sig_admin_remark,sig_pm_remark,sig_vp_remark,sig_fc_remark,
      attachment_count,has_concern,concerns,downloaded_at
    `).order('uploaded_at',{ascending:false});
    if(error) throw error;
    res.json({success:true,forms:data||[]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/portal-forms/:id', async (req,res) => {
  try {
    const {data:form,error:fe}=await supabase.from('portal_forms').select('*').eq('id',req.params.id).single();
    if(fe) throw fe;
    const {data:pdf}=await supabase.from('portal_form_pdfs').select('pdf_base64').eq('form_id',req.params.id).single();
    res.json({success:true,form:{...form,pdfBase64:pdf?.pdf_base64||null}});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/portal-forms/:id/pdf', async (req,res) => {
  try {
    const {data,error}=await supabase.from('portal_form_pdfs').select('pdf_base64').eq('form_id',req.params.id).single();
    if(error) throw error;
    res.json({success:true,pdfBase64:data?.pdf_base64||null});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/portal-forms/:id/sign', async (req,res) => {
  try {
    const {role,signatureData,signedBy,remark}=req.body;
    if(!role||!signatureData||!signedBy) return res.status(400).json({success:false,error:'role,signatureData,signedBy required.'});
    if(!['admin','pm','vp','fc'].includes(role)) return res.status(400).json({success:false,error:'Invalid role.'});
    const {data:form}=await supabase.from('portal_forms').select('*').eq('id',req.params.id).single();
    if(!form) return res.status(404).json({success:false,error:'Form not found.'});
    const order={pm:'admin',vp:'pm',fc:'vp'};
    if(order[role]&&!form[`sig_${order[role]}`]) return res.status(400).json({success:false,error:`${order[role].toUpperCase()} must sign first.`});
    const now=new Date().toISOString();
    const uf={[`sig_${role}`]:signatureData,[`sig_${role}_at`]:now,[`sig_${role}_by`]:signedBy,
      [`sig_${role}_remark`]:String(remark||'').replace(/<[^>]*>/g,'').trim().substring(0,120)};
    const upd={...form,...uf};
    uf.status=(upd.sig_admin&&upd.sig_pm&&upd.sig_vp&&upd.sig_fc)?'done':'in_circulation';
    const {error}=await supabase.from('portal_forms').update(uf).eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true,status:uf.status});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/portal-forms/:id/attachments', async (req,res) => {
  try {
    const {name,type,size,data}=req.body;
    const {data:form}=await supabase.from('portal_forms').select('attachments,attachment_count').eq('id',req.params.id).single();
    const atts=form?.attachments||[];
    atts.push({name,type,size,data,uploaded_at:new Date().toISOString()});
    const {error}=await supabase.from('portal_forms').update({attachments:atts,attachment_count:atts.length}).eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true,attachment_count:atts.length});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/portal-forms/:id/concern', async (req,res) => {
  try {
    const concern=clean(req.body.concern), raisedBy=clean(req.body.raisedBy);
    const raisedByName=clean(req.body.raisedByName), role=clean(req.body.role);
    if(!concern||concern.length<6) return res.status(400).json({success:false,error:'Concern must be at least 6 characters.'});
    const {data:form}=await supabase.from('portal_forms').select('concerns').eq('id',req.params.id).single();
    const concerns=form?.concerns||[];
    concerns.push({raisedBy,raisedByName,role,concern,raisedAt:new Date().toISOString()});
    const {error}=await supabase.from('portal_forms').update({concerns,has_concern:true}).eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.delete('/api/portal-forms/:id', async (req,res) => {
  try {
    await supabase.from('portal_form_pdfs').delete().eq('form_id',req.params.id);
    const {error}=await supabase.from('portal_forms').delete().eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/portal-forms/:id/downloaded', async (req,res) => {
  try {
    await supabase.from('portal_forms').update({downloaded_at:new Date().toISOString()}).eq('id',req.params.id);
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ── LEGACY FORMS ──
app.post('/api/forms/create', async (req,res) => {
  try {
    const {formNumber,formSequence,items}=req.body;
    if(!formNumber||!items||!Array.isArray(items)||items.length===0)
      return res.status(400).json({success:false,error:'formNumber and items[] required.'});
    const formRows=[];
    for(const item of items){
      const cleanPrice=parseFloat(String(item.newPrice||0).replace(/[^0-9.]/g,''))||0;
      const orderType=String(item.orderType||item.order_type||'STANDARD').toUpperCase();
      let calc=null;
      try{const {data:cd}=await supabase.rpc('calculate_form_row_v2',{p_item_code:String(item.itemCode),p_item_description:String(item.itemDescription||''),p_vendor_code:String(item.vendorCode),p_vendor_name:String(item.vendorName||''),p_new_price:cleanPrice,p_currency:String(item.currency||'INR'),p_order_type:orderType});if(cd&&cd.length>0)calc=cd[0];}catch(_){}
      if(!calc){const {data:cd2,error:fe}=await supabase.rpc('calculate_form_row',{p_item_code:String(item.itemCode),p_item_description:String(item.itemDescription||''),p_vendor_code:String(item.vendorCode),p_vendor_name:String(item.vendorName||''),p_new_price:cleanPrice,p_currency:String(item.currency||'INR')});if(fe){console.error('Calc:',fe);continue;}calc=cd2[0];}
      formRows.push({id:`${formNumber}_${item.itemCode}_${item.vendorCode}`,form_number:String(formNumber),form_sequence:parseInt(formSequence)||1,item_code:String(item.itemCode),item_description:String(item.itemDescription||''),vendor_code:String(item.vendorCode),vendor_name:String(item.vendorName||''),new_price:cleanPrice,currency:String(item.currency||'INR'),order_type:orderType,old_price:parseFloat(calc.old_price||0),price_diff:parseFloat(calc.price_diff||0),percent_diff:parseFloat(calc.percent_diff||0),porv_qty:parseFloat(calc.porv_qty||0),impact:parseFloat(calc.impact||0),remarks:String(calc.remarks||'Calculated')});
    }
    const {data:insertData,error:ie}=await supabase.from('cost_approval_forms').insert(formRows).select();
    if(ie) throw ie;
    res.json({success:true,formNumber:String(formNumber),items:insertData});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/forms/:formNumber', async (req,res) => {
  try {
    const {data,error}=await supabase.from('cost_approval_forms').select('*').eq('form_number',req.params.formNumber).order('item_code');
    if(error) throw error;
    res.json({success:true,formNumber:req.params.formNumber,items:data||[]});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/forms/:formNumber/downloaded', async (req,res) => {
  try {
    await supabase.from('cost_approval_forms').update({downloaded_at:new Date().toISOString()}).eq('form_number',req.params.formNumber);
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ── COST ANALYZER ──
app.post('/api/analytics/record', async (req,res) => {
  try {
    const {form_no,form_date,vendor_code,vendor_name,category,dept,item_code,item_desc,
      old_price,new_price,delta,pct_diff,qty_per_lift,impact,source_file,form_tag,yearly_vol,quarterly_impact}=req.body;
    if(!form_no||!item_code) return res.status(400).json({success:false,error:'form_no and item_code required.'});
    const {data:ex}=await supabase.from('form_analytics').select('id').eq('form_no',form_no).eq('item_code',item_code).eq('vendor_code',vendor_code||'').single();
    if(ex) return res.json({success:true,status:'dupe',id:ex.id});
    const {data,error}=await supabase.from('form_analytics').insert({
      form_no,form_date:form_date||null,vendor_code:vendor_code||'',vendor_name:vendor_name||'',
      category:category||'',dept:dept||'',item_code,item_desc:item_desc||'',
      old_price:parseFloat(old_price)||0,new_price:parseFloat(new_price)||0,
      delta:parseFloat(delta)||0,pct_diff:parseFloat(pct_diff)||0,
      qty_per_lift:parseFloat(qty_per_lift)||0,impact:parseFloat(impact)||0,
      yearly_vol:parseFloat(yearly_vol)||0,quarterly_impact:parseFloat(quarterly_impact)||0,
      source_file:source_file||'',form_tag:form_tag||''
    }).select('id').single();
    if(error) throw error;
    res.json({success:true,status:'added',id:data.id});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/analytics/records', async (req,res) => {
  try {
    const {vendor,item,from,to}=req.query;
    let q=supabase.from('form_analytics').select('*').order('form_date',{ascending:false});
    if(vendor) q=q.ilike('vendor_code',`%${vendor}%`);
    if(item)   q=q.ilike('item_code',`%${item}%`);
    if(from)   q=q.gte('form_date',from);
    if(to)     q=q.lte('form_date',to);
    const {data,error}=await q;
    if(error) throw error;
    res.json({success:true,records:data||[],count:(data||[]).length});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.delete('/api/analytics/record/:id', async (req,res) => {
  try {
    const {error}=await supabase.from('form_analytics').delete().eq('id',req.params.id);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/api/analytics/tag', async (req,res) => {
  try {
    const {form_no,form_tag}=req.body;
    if(!form_no) return res.status(400).json({success:false,error:'form_no required.'});
    const {error}=await supabase.from('form_analytics').update({form_tag:form_tag||''}).eq('form_no',form_no);
    if(error) throw error;
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/analytics/forms-list', async (req,res) => {
  try {
    const {data,error}=await supabase.from('form_analytics').select('form_no,form_date,vendor_code,vendor_name,category,dept,form_tag,impact').order('form_date',{ascending:false});
    if(error) throw error;
    const map={};
    (data||[]).forEach(r=>{
      if(!map[r.form_no]) map[r.form_no]={form_no:r.form_no,form_date:r.form_date,vendor_code:r.vendor_code,vendor_name:r.vendor_name,category:r.category,dept:r.dept,form_tag:r.form_tag||'',item_count:0,total_impact:0};
      map[r.form_no].item_count++;
      map[r.form_no].total_impact+=parseFloat(r.impact)||0;
    });
    res.json({success:true,forms:Object.values(map)});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ═══════════════════════════════════════════════════════════════
// PRE-CALC PORTAL — /api/tke routes
// Tables: tke_forms, tke_form_items (see SQL below)
// Auth: Supabase JWT Bearer token
// ═══════════════════════════════════════════════════════════════
const multer = require('multer');
const XLSX = require('xlsx');
const tkeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

// Auth middleware: extract user from Supabase JWT
async function tkeAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const token = auth.replace('Bearer ', '');
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });
    req.tkeUser = { id: user.id, email: user.email, full_name: user.user_metadata?.full_name || user.email.split('@')[0] };
    next();
  } catch (e) { res.status(401).json({ error: 'Auth failed' }); }
}

// 1. UPLOAD Excel/CSV → parse → create form + items
app.post('/api/tke/upload', tkeAuth, tkeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Empty spreadsheet' });

    // Auto-detect column mapping (flexible headers)
    const colMap = {};
    const headers = Object.keys(rows[0]).map(h => ({ orig: h, low: h.toLowerCase().replace(/[^a-z0-9]/g, '') }));
    const find = (patterns) => headers.find(h => patterns.some(p => h.low.includes(p)));
    colMap.item_code = find(['itemcode', 'partno', 'partcode', 'materialcode', 'sapcode'])?.orig || find(['code'])?.orig;
    colMap.item_description = find(['description', 'desc', 'itemdesc', 'partdesc', 'material'])?.orig || find(['name'])?.orig;
    colMap.old_price = find(['oldprice', 'currentprice', 'existingprice', 'prevprice'])?.orig || find(['old'])?.orig;
    colMap.new_price = find(['newprice', 'revisedprice', 'proposedprice'])?.orig || find(['new', 'price'])?.orig;
    colMap.quantity = find(['quantity', 'qty', 'vol', 'volume', 'yearlyqty', 'yearlyvol', 'annual'])?.orig;
    colMap.vendor_code = find(['vendorcode', 'suppliercode', 'sapvendor'])?.orig;
    colMap.vendor_name = find(['vendorname', 'suppliername', 'vendor', 'supplier'])?.orig;

    if (!colMap.item_code) return res.status(400).json({ error: 'Could not find Item Code column. Expected headers: Item Code, Description, Old Price, New Price, Qty' });

    // Extract vendor info from first row
    const r0 = rows[0];
    const vendorCode = colMap.vendor_code ? String(r0[colMap.vendor_code] || '') : '';
    const vendorName = colMap.vendor_name ? String(r0[colMap.vendor_name] || '') : '';

    // Generate form number
    const now = new Date();
    const seq = Math.floor(Math.random() * 900) + 100;
    const formNo = `PSM/${now.getFullYear().toString().slice(-2)}-${(now.getFullYear()+1).toString().slice(-2)}/${String(now.getMonth()+1).padStart(2,'0')}/${String(seq).padStart(3,'0')}`;

    // Create form
    const { data: form, error: fe } = await supabase.from('tke_forms').insert({
      form_no: formNo,
      form_seq: seq,
      form_date: now.toISOString().slice(0, 10),
      category: 'Electrical',
      department: 'PSM',
      supplier: vendorName ? `${vendorCode} — ${vendorName}` : '',
      prepared_by: req.tkeUser.full_name,
      prepared_by_user_id: req.tkeUser.id,
      status: 'draft'
    }).select('id').single();
    if (fe) throw fe;

    // Create items
    const items = rows.map((r, i) => {
      const oldP = parseFloat(String(r[colMap.old_price] || 0).replace(/,/g, '')) || 0;
      const newP = parseFloat(String(r[colMap.new_price] || 0).replace(/,/g, '')) || 0;
      const qty = parseFloat(String(r[colMap.quantity] || 0).replace(/,/g, '')) || 0;
      const diff = newP - oldP;
      return {
        form_id: form.id,
        item_code: String(r[colMap.item_code] || '').trim(),
        item_description: String(r[colMap.item_description] || '').trim().substring(0, 200),
        old_price: oldP, new_price: newP, price_diff: diff,
        quantity: qty, impact: diff * qty
      };
    }).filter(it => it.item_code);

    if (items.length) {
      const { error: ie } = await supabase.from('tke_form_items').insert(items);
      if (ie) throw ie;
    }

    // Update quarterly impact on form
    const totalImpact = items.reduce((s, i) => s + i.impact, 0);
    await supabase.from('tke_forms').update({ quarterly_impact: totalImpact }).eq('id', form.id);

    res.json({ success: true, form_id: form.id, form_no: formNo, item_count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. MY FORMS
app.get('/api/tke/my-forms', tkeAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tke_forms')
      .select('id, form_no, form_date, category, supplier, status, quarterly_impact, prepared_by')
      .eq('prepared_by_user_id', req.tkeUser.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, forms: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. GET FORM + ITEMS
app.get('/api/tke/forms/:id', tkeAuth, async (req, res) => {
  try {
    const { data: form, error: fe } = await supabase.from('tke_forms').select('*').eq('id', req.params.id).single();
    if (fe) throw fe;
    const { data: items, error: ie } = await supabase.from('tke_form_items').select('*').eq('form_id', req.params.id);
    if (ie) throw ie;
    res.json({ success: true, form, items: items || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. UPDATE FORM (PATCH)
app.patch('/api/tke/forms/:id', tkeAuth, async (req, res) => {
  try {
    const allowed = ['form_no','form_date','category','department','initiated_by_name','supplier','checked_by',
      'details_of_change','product_line_impacted','prepared_by','approved_by_vp','approved_by_finance',
      'reason_rm_increase','reason_rm_decrease','reason_sourcing_increase','reason_sourcing_decrease',
      'reason_eauction_increase','reason_eauction_decrease','quality_field_complaint','quality_product_improvement',
      'pdc_product_improvement','pdc_emi_change','part_new','part_existing','part_other'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (Object.keys(updates).length === 0) return res.json({ success: true });
    const { error } = await supabase.from('tke_forms').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5 & 6. PDF GENERATION (shared logic)
async function generateTkePdf(formId) {
  const { data: form } = await supabase.from('tke_forms').select('*').eq('id', formId).single();
  if (!form) throw new Error('Form not found');
  const { data: items } = await supabase.from('tke_form_items').select('*').eq('form_id', formId);

  const totalImpact = (items||[]).reduce((s,i)=>s+Number(i.impact||0),0);
  const totalDelta = (items||[]).reduce((s,i)=>s+Number(i.price_diff||0),0);
  const totalVol = (items||[]).reduce((s,i)=>s+Number(i.quantity||0),0);
  const pctItems = (items||[]).filter(i=>Number(i.old_price)!==0);
  const avgPct = pctItems.length ? pctItems.reduce((s,i)=>s+(Number(i.price_diff)/Number(i.old_price))*100,0)/pctItems.length : 0;
  const fmtN = v => v==null?'—':Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});

  // Build reason tags
  const reasons = [];
  if(form.reason_rm_increase)reasons.push('RM Increase');if(form.reason_rm_decrease)reasons.push('RM Decrease');
  if(form.reason_sourcing_increase)reasons.push('Sourcing Increase');if(form.reason_sourcing_decrease)reasons.push('Sourcing Decrease');
  if(form.reason_eauction_increase)reasons.push('E Auction Increase');if(form.reason_eauction_decrease)reasons.push('E Auction Decrease');
  const qualities = [];
  if(form.quality_field_complaint)qualities.push('Quality-Field Complaint');if(form.quality_product_improvement)qualities.push('Quality-Product Improvement');
  if(form.pdc_product_improvement)qualities.push('PDC/CE - Product Improvement');if(form.pdc_emi_change)qualities.push('PDC/CE - EMI Change');
  const partTypes = [];
  if(form.part_new)partTypes.push('New Part');if(form.part_existing)partTypes.push('Existing/Old Part');if(form.part_other)partTypes.push('Other');

  const itemRows = (items||[]).map((it,i) => `<tr>
    <td>${i+1}</td><td>${it.item_code||''}</td><td style="text-align:left;max-width:180px;word-wrap:break-word">${it.item_description||''}</td>
    <td style="text-align:right">${fmtN(it.old_price)}</td><td style="text-align:right">${fmtN(it.new_price)}</td>
    <td style="text-align:right">${fmtN(it.price_diff)}</td><td style="text-align:right">${Number(it.quantity)||0}</td>
    <td style="text-align:right;font-weight:600">${fmtN(it.impact)}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;padding:30px 36px}
    h1{font-size:16px;text-align:center;margin-bottom:4px}
    .sub{text-align:center;font-size:10px;color:#666;margin-bottom:16px}
    .meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:12px;font-size:10px}
    .meta b{color:#333}
    .section{border:1px solid #ccc;border-radius:4px;padding:10px 12px;margin-bottom:12px}
    .section-title{font-weight:700;font-size:11px;margin-bottom:6px;color:#333}
    .reason-row{display:flex;gap:20px;margin-bottom:4px}
    .reason-col{flex:1}
    .reason-col h4{font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-bottom:4px}
    .reason-item{font-size:10px;margin-bottom:2px}
    .check{color:#1a7a3a;font-weight:700}
    .stats{display:flex;gap:12px;margin-bottom:12px}
    .stat-box{flex:1;border:1px solid #ddd;border-radius:4px;padding:8px;text-align:center}
    .stat-box .label{font-size:8px;text-transform:uppercase;color:#888;letter-spacing:0.5px}
    .stat-box .value{font-size:14px;font-weight:700;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th{background:#2a2520;color:#fff;padding:5px 6px;font-size:9px;text-transform:uppercase;text-align:left}
    td{padding:4px 6px;border-bottom:1px solid #e0e0e0;font-size:10px}
    tr:nth-child(even){background:#f8f8f8}
    .footer{margin-top:20px;display:flex;justify-content:space-between;font-size:9px;color:#888}
    .sig-row{display:flex;gap:20px;margin-top:30px}
    .sig-box{flex:1;text-align:center;border-top:1px solid #999;padding-top:6px;font-size:9px;color:#666}
    /* Invisible text layer for Analyzer extraction */
    .text-layer{position:absolute;left:-9999px;font-size:1px;color:white}
  </style></head><body>
  <!-- Invisible text layer for Analyzer auto-extraction -->
  <div class="text-layer">
    Form No.: ${form.form_no} Date: ${form.form_date}
    Initiated By Name: ${form.initiated_by_name||''} | Category: ${form.category||''} | Dept: ${form.department||'PSM'}
    Supplier ${form.supplier||''}
    Details of Change ${form.details_of_change||''}
    Product Line Impacted ${form.product_line_impacted||'All'}
    Annexure --- Item Price Details
    Vendor Code ${form.supplier?.match(/(\d+)/)?.[1]||''}
    Vendor Name ${form.supplier?.replace(/^\d+\s*[-—]\s*/,'')||''}
    ${(items||[]).map((it,i)=>`${i+1} ${it.item_code} ${it.item_code} ${it.item_description} ${it.new_price} ${it.old_price} ${it.price_diff} ${Number(it.old_price)?((Number(it.price_diff)/Number(it.old_price))*100).toFixed(2):'0'}% ${it.quantity} ${it.impact}`).join('\n')}
    Total Yearly Vol: ${totalVol}
    Total Quarterly Impact (INR): ${totalImpact}
  </div>

  <h1>Cost Approval Form</h1>
  <div class="sub">Form No.: ${form.form_no} &nbsp;|&nbsp; Date: ${form.form_date}</div>

  <div class="meta">
    <div>Initiated By: <b>${form.initiated_by_name||form.prepared_by||''}</b></div>
    <div>Category: <b>${form.category||''}</b></div>
    <div>Dept: <b>${form.department||'PSM'}</b></div>
    <div>Supplier: <b>${form.supplier||''}</b></div>
  </div>

  <div class="section">
    <div class="reason-row">
      <div class="reason-col"><h4>Pricing</h4>${reasons.length?reasons.map(r=>`<div class="reason-item"><span class="check">✓</span> ${r}</div>`).join(''):'<div class="reason-item" style="color:#bbb">—</div>'}</div>
      <div class="reason-col"><h4>Quality / PDC</h4>${qualities.length?qualities.map(r=>`<div class="reason-item"><span class="check">✓</span> ${r}</div>`).join(''):'<div class="reason-item" style="color:#bbb">—</div>'}</div>
      <div class="reason-col"><h4>Part Type</h4>${partTypes.length?partTypes.map(r=>`<div class="reason-item"><span class="check">✓</span> ${r}</div>`).join(''):'<div class="reason-item" style="color:#bbb">—</div>'}</div>
    </div>
  </div>

  <div class="meta">
    <div>Details: <b>${form.details_of_change||''}</b></div>
    <div>Product Line: <b>${form.product_line_impacted||'All'}</b></div>
  </div>

  <div class="stats">
    <div class="stat-box"><div class="label">Cost Impact / Lift</div><div class="value" style="color:${totalDelta<0?'#c0392b':'#27ae60'}">₹${fmtN(totalDelta)}</div></div>
    <div class="stat-box"><div class="label">Quarterly Impact</div><div class="value" style="color:${totalImpact<0?'#c0392b':'#27ae60'}">₹${fmtN(totalImpact)}</div></div>
    <div class="stat-box"><div class="label">Yearly Volume</div><div class="value">${totalVol}</div></div>
    <div class="stat-box"><div class="label">Avg % Diff</div><div class="value">${avgPct.toFixed(2)}%</div></div>
  </div>

  <div class="section">
    <div class="section-title">Cost Impact Analysis — ${(items||[]).length} Items</div>
    <table>
      <thead><tr><th>#</th><th>Item Code</th><th>Description</th><th style="text-align:right">Old Price</th><th style="text-align:right">New Price</th><th style="text-align:right">Diff</th><th style="text-align:right">Qty</th><th style="text-align:right">Impact</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div style="text-align:right;margin-top:6px;font-weight:700;font-size:11px">Total: ₹${fmtN(totalImpact)}</div>
    <div style="text-align:right;font-size:9px;color:#888;margin-top:2px">All amounts in Indian Rupees ₹</div>
  </div>

  <div class="sig-row">
    <div class="sig-box">Prepared By<br><b>${form.prepared_by||''}</b></div>
    <div class="sig-box">Checked By<br><b>${form.checked_by||''}</b></div>
    <div class="sig-box">Approved By<br><b>${form.approved_by_vp||'VP Purchase'}</b></div>
    <div class="sig-box">Approved By<br><b>${form.approved_by_finance||'Finance Controller'}</b></div>
  </div>
  </body></html>`;

  // Use Puppeteer to render
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  await browser.close();
  return pdfBuffer;
}

app.get('/api/tke/forms/:id/pdf', tkeAuth, async (req, res) => {
  try {
    const buf = await generateTkePdf(req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename=TKE_Cost_Approval.pdf' });
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tke/forms/:id/pdf-preview', tkeAuth, async (req, res) => {
  try {
    const buf = await generateTkePdf(req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' });
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.listen(PORT,'0.0.0.0',()=>{
  console.log(`🚀 TKE Portal Backend on port ${PORT}`);
  console.log(`PDF webhook: ${ONEDRIVE_PDF_WEBHOOK?'✅':'⚠ not set'}`);
});
