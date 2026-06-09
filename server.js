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

// ─── Form number generation for Standard portal ───────────────────────────
// Format: PSM/YY-YY/MM/N
//   - YY-YY = Indian financial year (Apr 1 – Mar 31). E.g. June 2025 -> "25-26"
//   - MM    = 2-digit current month
//   - N     = incremental counter, reset every (FY, month) pair
//
// Backed by Postgres table `psm_form_counter (fy_month text primary key, last_seq int)`
// via RPC `psm_next_form_no()`. Falls back gracefully if RPC is missing — uses
// timestamp-based number so production never gets stuck.
function indianFinancialYearLabel(d = new Date()) {
  // Company FY runs Oct 1 – Sept 30. October (month index 9) onwards = new FY.
  const y = d.getFullYear();
  const fyStart = d.getMonth() >= 9 ? y : y - 1;
  const fyEnd   = fyStart + 1;
  const pad2 = n => String(n).padStart(2,'0');
  return `${pad2(fyStart % 100)}-${pad2(fyEnd % 100)}`;
}

async function generatePsmFormNumber() {
  const now = new Date();
  const fy  = indianFinancialYearLabel(now);
  const mm  = String(now.getMonth() + 1).padStart(2,'0');
  try {
    const { data, error } = await supabase.rpc('psm_next_form_no', {
      p_fy: fy, p_month: mm,
    });
    if (error) throw error;
    const seq = (data && data[0] && data[0].out_seq) || data?.out_seq || data;
    if (!seq) throw new Error('RPC returned no sequence');
    return `PSM/${fy}/${mm}/${seq}`;
  } catch (e) {
    // Production safety: never block form creation just because counter is misconfigured.
    // Use a timestamp-derived suffix that's guaranteed unique within the month.
    console.warn('[psm_next_form_no] RPC failed, falling back to timestamp suffix:', e.message);
    const suffix = String(Date.now()).slice(-6);
    return `PSM/${fy}/${mm}/T${suffix}`;
  }
}

// ─── Supabase Auth middleware (Bearer JWT) ─────────────────────────────────
// Use this on any route that needs the logged-in user's identity.
// Same pattern as tke-cost-approval.js — one Supabase Auth shared across portals.
async function requireSupabaseAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7) : null;
    if (!token) return res.status(401).json({success:false,error:'Missing auth token'});
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({success:false,error:'Invalid or expired token'});

    // Domain restriction (security boundary — never trust the client check alone)
    const email = (data.user.email || '').toLowerCase();
    if (!email.endsWith('@tkelevator.com')) {
      return res.status(403).json({success:false,error:'Only TK Elevator accounts are permitted on this portal.'});
    }

    const { data: profile } = await supabase
      .from('profiles').select('full_name').eq('id', data.user.id).maybeSingle();
    req.user = {
      id: data.user.id,
      email: data.user.email,
      full_name: profile?.full_name
        || data.user.user_metadata?.full_name
        || data.user.email?.split('@')[0]
        || 'Unknown',
    };
    next();
  } catch (e) {
    console.error('[psm auth]', e);
    res.status(401).json({success:false,error:'Auth failed'});
  }
}

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
    let {formNumber,formSequence,items} = req.body || {};
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({success:false,error:'items[] is required and must be non-empty.'});
    }
    // Auto-generate formNumber if frontend didn't supply one
    if (!formNumber) {
      formNumber = await generatePsmFormNumber();
    }
    const formRows=[];
    for(const item of items){
      const cleanPrice=parseFloat(String(item.newPrice||0).replace(/[^0-9.]/g,''))||0;
      const orderType=String(item.orderType||item.order_type||'STANDARD').toUpperCase();
      let calc=null;
      try{const {data:cd}=await supabase.rpc('calculate_form_row_v2',{p_item_code:String(item.itemCode),p_item_description:String(item.itemDescription||''),p_vendor_code:String(item.vendorCode),p_vendor_name:String(item.vendorName||''),p_new_price:cleanPrice,p_currency:String(item.currency||'INR'),p_order_type:orderType});if(cd&&cd.length>0)calc=cd[0];}catch(_){}
      if(!calc){
        try {
          const {data:cd2,error:fe}=await supabase.rpc('calculate_form_row',{p_item_code:String(item.itemCode),p_item_description:String(item.itemDescription||''),p_vendor_code:String(item.vendorCode),p_vendor_name:String(item.vendorName||''),p_new_price:cleanPrice,p_currency:String(item.currency||'INR')});
          if(fe){console.error('Calc RPC error:',fe);}
          else if (cd2 && cd2.length>0) calc=cd2[0];
        } catch(e) { console.error('Calc RPC threw:',e.message); }
      }
      // If both calc RPCs failed/missing, still write the row with raw values so the user isn't blocked.
      if(!calc) calc = { old_price:0, price_diff:0, percent_diff:0, porv_qty:0, impact:0, remarks:'No calc RPC' };
      // Safe id — replace slashes so it doesn't break composite keys
      const safeFormNo = String(formNumber).replace(/[/\\]/g,'_');
      formRows.push({
        id:`${safeFormNo}_${item.itemCode}_${item.vendorCode}`,
        form_number:String(formNumber),
        form_sequence:parseInt(formSequence)||1,
        item_code:String(item.itemCode),
        item_description:String(item.itemDescription||''),
        vendor_code:String(item.vendorCode),
        vendor_name:String(item.vendorName||''),
        new_price:cleanPrice,
        currency:String(item.currency||'INR'),
        order_type:orderType,
        old_price:parseFloat(calc.old_price||0),
        price_diff:parseFloat(calc.price_diff||0),
        percent_diff:parseFloat(calc.percent_diff||0),
        porv_qty:parseFloat(calc.porv_qty||0),
        impact:parseFloat(calc.impact||0),
        remarks:String(calc.remarks||'Calculated'),
      });
    }
    if (formRows.length === 0) {
      return res.status(422).json({success:false,error:'No valid items to insert.'});
    }
    const {data:insertData,error:ie}=await supabase.from('cost_approval_forms').insert(formRows).select();
    if(ie) throw ie;

    // ─── Write metadata row (best-effort; never fail the request if this fails) ───
    // If the request had a Bearer token we attribute the form to that user; else null.
    let createdByUserId = null;
    let createdByName = null;
    try {
      const token = (req.headers.authorization || '').startsWith('Bearer ')
        ? req.headers.authorization.slice(7) : null;
      if (token) {
        const { data: u } = await supabase.auth.getUser(token);
        if (u?.user) {
          createdByUserId = u.user.id;
          const { data: profile } = await supabase
            .from('profiles').select('full_name').eq('id', u.user.id).maybeSingle();
          createdByName = profile?.full_name
            || u.user.user_metadata?.full_name
            || u.user.email?.split('@')[0]
            || 'Unknown';
        }
      }
    } catch (e) { console.warn('[create meta auth]', e.message); }

    try {
      // Aggregate metadata from the inserted rows
      const totalImpact = formRows.reduce((s,r)=>s+(parseFloat(r.impact)||0),0);
      const totalQty    = formRows.reduce((s,r)=>s+(parseFloat(r.porv_qty)||0),0);
      const pctRows     = formRows.filter(r=>parseFloat(r.old_price)>0);
      const avgPct      = pctRows.length
        ? pctRows.reduce((s,r)=>s+(parseFloat(r.percent_diff)||0),0)/pctRows.length : 0;
      const firstRow    = formRows[0] || {};

      console.log('[psm_forms_meta] writing form_number=' + String(formNumber)
                + ' user_id=' + (createdByUserId || 'NULL (no auth token)')
                + ' user_name=' + (createdByName || 'unknown'));

      const upsertRes = await supabase.from('psm_forms_meta').upsert({
        form_number: String(formNumber),
        form_sequence: parseInt(formSequence)||1,
        created_by_user_id: createdByUserId,
        created_by_name: createdByName,
        vendor_name: firstRow.vendor_name || null,
        vendor_code: firstRow.vendor_code || null,
        category: req.body?.category || null,
        item_count: formRows.length,
        total_impact: totalImpact,
        quarterly_impact: totalImpact/4,
        avg_pct_diff: avgPct,
        total_yearly_vol: totalQty,
        source: req.body?.source === 'precalc' ? 'precalc' : 'standard',
      }, { onConflict: 'form_number' });
      if (upsertRes.error) {
        console.error('[psm_forms_meta upsert ERROR]', upsertRes.error.message, upsertRes.error.details||'');
      } else {
        console.log('[psm_forms_meta] write OK');
      }
    } catch (e) { console.warn('[psm_forms_meta upsert threw]', e.message); }

    res.json({success:true,formNumber:String(formNumber),items:insertData});
  } catch(e){
    console.error('[POST /api/forms/create]', e);
    res.status(500).json({success:false,error:e.message||'Internal error'});
  }
});

// Alias: frontend's pre-calc upload calls this; same behaviour as /create.
app.post('/api/forms/upload-precalc', async (req,res) => {
  // Forward to the same handler — keep one source of truth
  req.url = '/api/forms/create';
  app._router.handle(req, res, () => {});
});

// Frontend's "Forms Tracker" view fetches this.
app.get('/api/forms/tracker/all', async (req,res) => {
  try {
    const {data,error} = await supabase
      .from('cost_approval_forms')
      .select('form_number,form_sequence,created_at,downloaded_at')
      .order('created_at',{ascending:false});
    if (error) throw error;
    // Group by form_number to one row per form
    const byForm = {};
    for (const row of (data||[])) {
      if (!byForm[row.form_number]) {
        byForm[row.form_number] = {
          formNumber: row.form_number,
          createdAt: row.created_at,
          totalSigners: 0,
          signedCount: 0,
        };
      }
    }
    // Try to enrich with signing data if the table exists
    try {
      const {data:signData} = await supabase
        .from('portal_forms')
        .select('form_no,sig_admin,sig_pm,sig_vp,sig_fc');
      if (signData) {
        for (const s of signData) {
          if (!byForm[s.form_no]) continue;
          const sigs = [s.sig_admin,s.sig_pm,s.sig_vp,s.sig_fc].filter(Boolean);
          byForm[s.form_no].totalSigners = 4;
          byForm[s.form_no].signedCount = sigs.length;
        }
      }
    } catch(_){}
    res.json({success:true, forms: Object.values(byForm)});
  } catch(e){
    console.error('[GET /api/forms/tracker/all]', e);
    res.status(500).json({success:false,error:e.message});
  }
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
    const ts = new Date().toISOString();
    await supabase.from('cost_approval_forms').update({downloaded_at:ts}).eq('form_number',req.params.formNumber);
    // Keep metadata in sync
    await supabase.from('psm_forms_meta').update({downloaded_at:ts}).eq('form_number',req.params.formNumber);
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// ─── Forms Created — the user's own forms only, last 500, metadata only ───
app.get('/api/forms/my-forms', requireSupabaseAuth, async (req,res) => {
  try {
    console.log('[my-forms] requested by user_id=' + req.user.id + ' email=' + req.user.email);
    const { data, error } = await supabase
      .from('psm_forms_meta')
      .select('form_number, form_sequence, created_at, downloaded_at, vendor_name, vendor_code, category, item_count, total_impact, quarterly_impact, avg_pct_diff, total_yearly_vol, source, created_by_name')
      .eq('created_by_user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    console.log('[my-forms] returned ' + (data||[]).length + ' rows');
    res.json({success:true, forms: data || []});
  } catch (e) {
    console.error('[GET /api/forms/my-forms]', e);
    res.status(500).json({success:false,error:e.message});
  }
});

// ── STUB ROUTES — frontend calls these but they're not implemented yet.
// Return clean JSON instead of HTML 500s, so the frontend can show a friendly toast.
app.post('/api/sync/upload', async (req,res) => {
  res.status(501).json({success:false,error:'Sync endpoint not yet configured on this backend.'});
});

app.post('/api/send-email', async (req,res) => {
  res.status(501).json({success:false,error:'Email endpoint not yet configured on this backend.'});
});

// ── COST ANALYZER ──
app.post('/api/analytics/record', async (req,res) => {
  try {
    const {form_no,form_date,vendor_code,vendor_name,category,dept,item_code,item_desc,
      old_price,new_price,delta,pct_diff,qty_per_lift,impact,source_file,form_tag,yearly_vol,quarterly_impact}=req.body;
    if(!form_no||!item_code) return res.status(400).json({success:false,error:'form_no and item_code required.'});
    const {data:ex}=await supabase.from('form_analytics').select('id').eq('form_no',form_no).eq('item_code',item_code).eq('vendor_code',vendor_code||'').single();
    if(ex) return res.json({success:true,status:'dupe',id:ex.id});

    // Build the insert payload. Try with optional aggregate columns first; if they
    // don't exist in this Supabase schema, retry without them.
    const baseRow = {
      form_no, form_date: form_date||null, vendor_code: vendor_code||'', vendor_name: vendor_name||'',
      category: category||'', dept: dept||'', item_code, item_desc: item_desc||'',
      old_price: parseFloat(old_price)||0, new_price: parseFloat(new_price)||0,
      delta: parseFloat(delta)||0, pct_diff: parseFloat(pct_diff)||0,
      qty_per_lift: parseFloat(qty_per_lift)||0, impact: parseFloat(impact)||0,
      source_file: source_file||'', form_tag: form_tag||''
    };
    const optionalRow = {
      ...baseRow,
      yearly_vol: parseFloat(yearly_vol)||0,
      quarterly_impact: parseFloat(quarterly_impact)||0,
    };

    let inserted = null, err = null;
    // First attempt — include optional aggregate columns
    {
      const {data, error} = await supabase.from('form_analytics').insert(optionalRow).select('id').single();
      if (!error) inserted = data;
      else err = error;
    }
    // Retry without the optional columns if the schema doesn't have them
    if (!inserted && err && /yearly_vol|quarterly_impact|schema cache/i.test(err.message||'')) {
      const {data, error} = await supabase.from('form_analytics').insert(baseRow).select('id').single();
      if (error) throw error;
      inserted = data;
    } else if (!inserted) {
      throw err;
    }

    res.json({success:true,status:'added',id:inserted.id});
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
// PRE-CALC PORTAL — /api/tke routes (mounted from external module)
// All TKE Cost Approval routes live in ./tke-cost-approval.js
// ═══════════════════════════════════════════════════════════════
const { createTkeCostApprovalRouter } = require('./tke-cost-approval');
// ── REFERENCE DATA STATUS (Info Records + PORV) ──
// Read-only health check for the two large SAP reference tables.
// Returns row count and the most recent row date so the user can see
// how stale the data is without having to open Supabase.
app.get('/api/reference-data/status', async (req,res) => {
  try {
    const out = { info_records: null, porv_data: null };

    // Use HEAD count for efficiency — never pulls actual rows
    const ir = await supabase.from('info_records_csv').select('*', { count: 'exact', head: true });
    if (!ir.error) {
      out.info_records = { count: ir.count || 0, error: null };
      // Try to read the most recent "Valid to" date — non-fatal if it fails
      try {
        const { data } = await supabase
          .from('info_records_csv')
          .select('"Valid to"')
          .order('"Valid to"', { ascending: false, nullsFirst: false })
          .limit(1);
        if (data && data[0]) out.info_records.latest = data[0]['Valid to'];
      } catch(_){}
    } else {
      out.info_records = { count: null, error: ir.error.message };
    }

    const pv = await supabase.from('porv_data_csv').select('*', { count: 'exact', head: true });
    if (!pv.error) {
      out.porv_data = { count: pv.count || 0, error: null };
    } else {
      out.porv_data = { count: null, error: pv.error.message };
    }

    res.json({ success: true, ...out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.use('/api/tke', createTkeCostApprovalRouter({ supabase }));

// ─── Production safety: clean 404 + JSON-only error response ──────────────
// Any /api/* path that didn't match a route returns JSON, not HTML.
app.use('/api', (req,res) => {
  res.status(404).json({success:false,error:`Route not found: ${req.method} ${req.originalUrl}`});
});
// Final error handler — if anything anywhere throws and isn't caught locally,
// we still respond with JSON instead of a stack trace HTML page.
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({success:false,error:err.message||'Internal server error'});
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`🚀 TKE Portal Backend on port ${PORT}`);
  console.log(`PDF webhook: ${ONEDRIVE_PDF_WEBHOOK?'✅':'⚠ not set'}`);
});
