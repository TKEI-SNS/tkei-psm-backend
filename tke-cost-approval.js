// =============================================================================
// TKE Cost Approval — Express router module (CommonJS)
//
// Usage from your existing server.js:
//
//   const { createTkeCostApprovalRouter } = require("./tke-cost-approval");
//
//   // You already have `app` and `supabase` — reuse them:
//   app.use("/api/tke", createTkeCostApprovalRouter({ supabase }));
//
// All routes live under /api/tke/* so they won't collide with anything you
// already have. Auth middleware reads Bearer JWT from Supabase Auth.
// =============================================================================

const express = require("express");
const multer = require("multer");
const puppeteer = require("puppeteer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

// =============================================================================
// TKE Logo (loaded once at startup from sibling file)
// =============================================================================
const TKE_LOGO_DATA_URI = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "tke-logo-data-uri.txt"), "utf-8").trim();
  } catch {
    console.warn("[tke] tke-logo-data-uri.txt not found, PDFs will render without logo");
    return "";
  }
})();

// =============================================================================
// Excel parsing
// =============================================================================
const HEADER_MAP = {
  "item code": "item_code", "itemcode": "item_code",
  "item description": "item_description", "description": "item_description",
  "vendor code": "vendor_code", "vendor name": "vendor_name",
  "new price": "new_price", "old price": "old_price",
  "price diff": "price_diff", "pricediff": "price_diff", "price difference": "price_diff",
  "quantity": "quantity", "qty": "quantity",
  "impact": "impact", "cost impact": "impact",
};
const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Workbook has no sheets");
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  if (aoa.length < 2) throw new Error("Excel needs a header row + at least one data row");

  const headers = aoa[0].map((h) => str(h).toLowerCase());
  const col = {};
  headers.forEach((h, i) => { if (HEADER_MAP[h]) col[HEADER_MAP[h]] = i; });

  const required = ["item_code", "item_description", "vendor_code", "vendor_name", "new_price", "old_price", "quantity"];
  const missing = required.filter((k) => col[k] === undefined);
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}. Found: ${headers.join(", ")}`);

  const rows = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((c) => str(c) === "")) continue;
    const newPrice = num(row[col.new_price]);
    const oldPrice = num(row[col.old_price]);
    const quantity = num(row[col.quantity]);
    const priceDiff = col.price_diff !== undefined ? num(row[col.price_diff]) : newPrice - oldPrice;
    const impact = col.impact !== undefined ? num(row[col.impact]) : priceDiff * quantity;
    rows.push({
      item_code: str(row[col.item_code]),
      item_description: str(row[col.item_description]),
      vendor_code: str(row[col.vendor_code]),
      vendor_name: str(row[col.vendor_name]),
      new_price: newPrice, old_price: oldPrice, price_diff: priceDiff, quantity, impact,
    });
  }
  if (!rows.length) throw new Error("No data rows found");
  return rows;
}

function computeTotals(rows) {
  const total_impact = rows.reduce((s, r) => s + r.impact, 0);
  const cost_impact_per_lift = rows.reduce((s, r) => s + r.price_diff, 0);
  const total_yearly_vol = rows.reduce((s, r) => s + r.quantity, 0);
  const pcts = rows.filter((r) => r.old_price !== 0).map((r) => (r.price_diff / r.old_price) * 100);
  const avg_price_diff_pct = pcts.length ? pcts.reduce((s, p) => s + p, 0) / pcts.length : 0;
  return {
    cost_impact_per_lift, quarterly_impact: total_impact,
    yearly_impact: total_impact * 4, avg_price_diff_pct, total_yearly_vol,
  };
}

// =============================================================================
// PDF template
// =============================================================================
const fmt = (n, showZero = false) => {
  if (n === null || n === undefined) return "";
  if (n === 0 && !showZero) return "0.00";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (n) => (n === null || n === undefined ? "" : `${Number(n).toFixed(2)}%`);
const esc = (s) => (!s ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
const dash = (v) => {
  const s = (v || "").toString().trim();
  return s === "" ? "—" : esc(s);
};
const chk = (on) => (on ? `<span class="cb checked">✓</span>` : `<span class="cb"></span>`);

function renderFormHtml(meta, items) {
  const totalImpact = items.reduce((s, i) => s + (Number(i.impact) || 0), 0);
  const totalDelta = items.reduce((s, i) => s + (Number(i.price_diff) || 0), 0);
  const totalYearlyVol = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

  const mainRows = items.map((it) => `
    <tr>
      <td class="c">${dash(it.old_item_code)}</td>
      <td class="c">${dash(it.old_description)}</td>
      <td class="c">${esc(it.item_code)}</td>
      <td>${esc(it.item_description)}</td>
      <td class="r">${fmt(it.old_price, true)}</td>
      <td class="r">${fmt(it.new_price)}</td>
      <td class="r delta">${fmt(it.price_diff)}</td>
      <td class="r">${it.quantity}</td>
      <td class="r impact">${fmt(it.impact)}</td>
    </tr>`).join("");

  const annexRows = items.map((it, idx) => {
    const oldP = Number(it.old_price) || 0;
    const p = oldP ? (Number(it.price_diff) / oldP) * 100 : 0;
    return `
    <tr>
      <td class="c">${idx + 1}</td>
      <td class="c">${dash(it.fs_item_code)}</td>
      <td class="c">${esc(it.item_code)}</td>
      <td>${esc(it.item_description)}</td>
      <td class="r">${fmt(it.new_price)}</td>
      <td class="r">${fmt(it.old_price, true)}</td>
      <td class="r delta">${fmt(it.price_diff)}</td>
      <td class="r">${pct(p)}</td>
      <td class="r">${it.quantity}</td>
      <td class="r impact">${fmt(it.impact)}</td>
    </tr>`;
  }).join("");

  const pctItems = items.filter((i) => Number(i.old_price) !== 0);
  const avgPct = pctItems.length
    ? pctItems.reduce((s, i) => s + (Number(i.price_diff) / Number(i.old_price)) * 100, 0) / pctItems.length
    : 0;

  const vendors = [...new Set(items.map((i) => `${i.vendor_code} — ${i.vendor_name}`).filter((v) => v && v !== " — "))];
  const vendorCell = vendors.length === 1 ? esc(vendors[0]) : (vendors.length > 1 ? "Multiple" : "—");

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Form ${esc(meta.form_no)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm 14mm 12mm; }
  * { box-sizing: border-box; }
  html, body { font-family: "Times New Roman", Times, serif; font-size: 10pt; color: #000; margin: 0; padding: 0; }
  .hdr { display: flex; align-items: center; border-bottom: 1.2pt solid #000; padding-bottom: 6pt; margin-bottom: 10pt; }
  .logo { width: 90pt; height: 45pt; margin-right: 14pt; object-fit: contain; }
  .title { flex: 1; font-size: 16pt; font-weight: 700; text-align: center; padding-right: 90pt; }
  .meta-row { display: flex; justify-content: space-between; font-size: 10pt; margin-bottom: 8pt; }
  .meta-row b { font-weight: 700; }
  .initiated { margin: 6pt 0; font-size: 10pt; }
  .initiated .label { font-weight: 700; display: inline-block; min-width: 90pt; }
  h2.section { font-size: 11pt; font-weight: 700; margin: 10pt 0 6pt 0; padding-bottom: 2pt; border-bottom: 0.5pt solid #999; text-transform: uppercase; }
  .reasons { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10pt; margin-bottom: 8pt; }
  .reasons h4 { font-size: 10pt; margin: 0 0 4pt 0; font-weight: 700; text-transform: uppercase; }
  .reasons ul { list-style: none; padding: 0; margin: 0; }
  .reasons li { margin: 2pt 0; display: flex; align-items: center; gap: 5pt; font-size: 10pt; }
  .cb { display: inline-block; width: 9pt; height: 9pt; border: 0.7pt solid #333; text-align: center; font-size: 8pt; line-height: 8pt; vertical-align: middle; background: #fff; }
  .cb.checked { background: #000; color: #fff; border-color: #000; font-weight: 700; }
  .kv { margin: 4pt 0; font-size: 10pt; border-bottom: 0.3pt solid #ddd; padding-bottom: 3pt; }
  .kv b { display: inline-block; min-width: 140pt; font-weight: 700; }
  .totals-line { margin: 8pt 0; font-size: 10pt; }
  .totals-line b { font-weight: 700; }
  .neg { color: #c00; font-weight: 700; }
  table.data { width: 100%; border-collapse: collapse; margin-top: 6pt; font-size: 9pt; }
  table.data th, table.data td { border: 0.5pt solid #888; padding: 4pt 5pt; color: #000; }
  table.data th { background: #f5f5f5; font-weight: 700; text-align: left; font-size: 9pt; text-transform: uppercase; }
  table.data td.r { text-align: right; }
  table.data td.c { text-align: center; }
  table.data td.delta, table.data td.impact { color: #c00; font-weight: 600; }
  table.data tr.total td { background: #f5f5f5; font-weight: 700; color: #c00; }
  table.data tr.total td.label { color: #000; text-align: right; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 14pt; margin-top: 36pt; }
  .sig { text-align: center; font-size: 10pt; }
  .sig .line { border-top: 0.5pt solid #333; padding-top: 3pt; margin-top: 24pt; }
  .sig .label { font-style: italic; color: #666; font-size: 9pt; }
  .sig .name { font-weight: 700; margin-top: 1pt; }
  .footnote { text-align: right; font-size: 9pt; color: #555; margin-top: 8pt; font-style: italic; }
  .page-break { page-break-before: always; }
  .annexure-summary { text-align: right; margin-top: 12pt; font-size: 10pt; line-height: 1.7; }
</style></head>
<body>

<div class="hdr">
  <img class="logo" src="${TKE_LOGO_DATA_URI}" alt="TKE"/>
  <div class="title">Cost Approval Form</div>
</div>

<div class="meta-row">
  <div>Form No.: <b>${esc(meta.form_no)}</b></div>
  <div>Date: <b>${esc(meta.form_date)}</b></div>
</div>

<div class="initiated">
  <span class="label">Initiated By</span>
  Name: ${esc(meta.initiated_by_name || "—")} &nbsp;|&nbsp;
  Category: ${esc(meta.category || "—")} &nbsp;|&nbsp;
  Dept: ${esc(meta.department || "—")}
</div>

<h2 class="section">Reason of Change</h2>
<div class="reasons">
  <div><h4>PRICING</h4><ul>
    <li>${chk(meta.reason_rm_increase)} RM Increase</li>
    <li>${chk(meta.reason_rm_decrease)} RM Decrease</li>
    <li>${chk(meta.reason_sourcing_increase)} Sourcing Increase</li>
    <li>${chk(meta.reason_sourcing_decrease)} Sourcing Decrease</li>
    <li>${chk(meta.reason_eauction_increase)} E Auction Increase</li>
    <li>${chk(meta.reason_eauction_decrease)} E Auction Decrease</li>
  </ul></div>
  <div><h4>QUALITY / PDC</h4><ul>
    <li>${chk(meta.quality_field_complaint)} Quality-Field Complaint</li>
    <li>${chk(meta.quality_product_improvement)} Quality-Product Improvement</li>
    <li>${chk(meta.pdc_product_improvement)} PDC/CE - Product Improvement</li>
    <li>${chk(meta.pdc_emi_change)} PDC/CE - EMI Change</li>
  </ul></div>
  <div><h4>PART TYPE</h4><ul>
    <li>${chk(meta.part_new)} New Part</li>
    <li>${chk(meta.part_existing)} Existing/Old Part</li>
    <li>${chk(meta.part_other)} Other</li>
  </ul></div>
</div>

<div class="kv"><b>Supplier</b> ${vendorCell}</div>
<div class="kv"><b>Details of Change</b> ${dash(meta.details_of_change)}</div>
<div class="kv"><b>Product Line Impacted</b> ${dash(meta.product_line_impacted)}</div>

<div class="totals-line">
  <b>Cost Impact per Lift:</b> ${fmt(totalDelta)}
  &nbsp;&nbsp;&nbsp;&nbsp;
  <b>Quarterly Impact (Approx):</b>
  <span class="${totalImpact < 0 ? "neg" : ""}">${fmt(totalImpact)}</span> INR
</div>

<h2 class="section">Cost Impact Analysis</h2>
<table class="data">
  <thead><tr>
    <th>OLD ITEM CODE</th><th>OLD DESC</th><th>NEW ITEM CODE</th><th>NEW DESC</th>
    <th>OLD PRICE</th><th>NEW PRICE</th><th>DELTA</th><th>QTY/LIFT</th><th>IMPACT/LIFT</th>
  </tr></thead>
  <tbody>${mainRows}
    <tr class="total"><td colspan="8" class="label">Total</td><td class="r">${fmt(totalImpact)}</td></tr>
  </tbody>
</table>

<div class="footnote">All Costs are in INR</div>

<div class="signatures">
  <div class="sig"><div class="line"><span class="label">Signature</span></div><div>Prepared By</div><div class="name">${esc(meta.prepared_by || "—")}</div></div>
  <div class="sig"><div class="line"><span class="label">Signature</span></div><div>Checked By</div><div class="name">${esc(meta.checked_by || "—")}</div></div>
  <div class="sig"><div class="line"><span class="label">Signature</span></div><div>Approved By</div><div class="name">${esc(meta.approved_by_vp || "VP Purchase")}</div></div>
  <div class="sig"><div class="line"><span class="label">Signature</span></div><div>Approved By</div><div class="name">${esc(meta.approved_by_finance || "Finance Controller")}</div></div>
</div>

<div class="footnote">All amounts in Indian Rupees ₹</div>

<div class="page-break"></div>

<div class="hdr">
  <img class="logo" src="${TKE_LOGO_DATA_URI}" alt="TKE"/>
  <div class="title">Annexure — Item Price Details</div>
</div>

<div class="meta-row">
  <div>Form No.: <b>${esc(meta.form_no)}</b></div>
  <div>Date: <b>${esc(meta.form_date)}</b></div>
</div>

<div class="kv"><b>Vendor Code</b> ${dash(items[0]?.vendor_code)}</div>
<div class="kv"><b>Vendor Name</b> ${dash(items[0]?.vendor_name)}</div>

<table class="data">
  <thead><tr>
    <th>#</th><th>FS ITEM CODE</th><th>ITEM CODE</th><th>DESCRIPTION</th>
    <th>NEW PRICE</th><th>OLD PRICE</th><th>PRICE DIFF</th>
    <th>% DIFF</th><th>YEARLY VOL</th><th>COST IMPACT</th>
  </tr></thead>
  <tbody>${annexRows}</tbody>
</table>

<div class="annexure-summary">
  <div>Avg % Price Diff: <b class="${avgPct < 0 ? "neg" : ""}">${pct(avgPct)}</b>
  &nbsp;&nbsp;&nbsp; Total Yearly Vol: <b>${totalYearlyVol}</b></div>
  <div>Total Quarterly Impact (INR): <b class="${totalImpact < 0 ? "neg" : ""}">${fmt(totalImpact)}</b></div>
  <div>Total Yearly Impact (INR): <b class="${totalImpact * 4 < 0 ? "neg" : ""}">${fmt(totalImpact * 4)}</b></div>
</div>

<div class="footnote">All amounts in Indian Rupees ₹</div>
</body></html>`;
}

// =============================================================================
// Auth middleware factory — closes over the supabase client
// =============================================================================
function makeAuthMiddleware(supabase) {
  return async function requireAuth(req, res, next) {
    try {
      const token = (req.headers.authorization || "").startsWith("Bearer ")
        ? req.headers.authorization.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Missing auth token" });

      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: "Invalid or expired token" });

      const { data: profile } = await supabase
        .from("profiles").select("full_name").eq("id", data.user.id).single();

      req.user = {
        id: data.user.id,
        email: data.user.email,
        full_name: profile?.full_name
          || data.user.user_metadata?.full_name
          || data.user.email?.split("@")[0]
          || "Unknown",
      };
      next();
    } catch (e) {
      console.error("[tke auth]", e);
      res.status(401).json({ error: "Auth failed" });
    }
  };
}

// =============================================================================
// Router factory
// =============================================================================
const EDITABLE = [
  "initiated_by_name", "category", "department",
  "reason_rm_increase", "reason_rm_decrease", "reason_sourcing_increase", "reason_sourcing_decrease",
  "reason_eauction_increase", "reason_eauction_decrease",
  "quality_field_complaint", "quality_product_improvement", "pdc_product_improvement", "pdc_emi_change",
  "part_new", "part_existing", "part_other",
  "supplier", "details_of_change", "product_line_impacted",
  "checked_by", "approved_by_vp", "approved_by_finance",
  "status",
];

function createTkeCostApprovalRouter({ supabase, requireAuth }) {
  if (!supabase) throw new Error("createTkeCostApprovalRouter: supabase client required");

  const auth = requireAuth || makeAuthMiddleware(supabase);
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  router.get("/health", (_req, res) => res.json({ ok: true, module: "tke-cost-approval" }));

  router.get("/me", auth, (req, res) => res.json({ user: req.user }));

  router.post("/upload", auth, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const rows = parseExcel(req.file.buffer);
      const totals = computeTotals(rows);

      const { data: numData, error: numErr } = await supabase.rpc("tke_next_form_no");
      if (numErr) throw numErr;
      const { out_form_no: form_no, out_form_date: form_date, out_form_seq: form_seq } = numData[0];

      // Auto-fill from Excel data
      const uniqueVendors = [...new Set(rows.map(r => r.vendor_name).filter(Boolean))];
      const supplierAuto = uniqueVendors.length === 1
        ? `${rows[0].vendor_code} — ${rows[0].vendor_name}`
        : (uniqueVendors.length > 1 ? "Multiple" : null);

      const { data: formRow, error: formErr } = await supabase.from("tke_forms").insert({
        form_no, form_date, form_seq,
        prepared_by_user_id: req.user.id,
        prepared_by: req.user.full_name,
        category: "Electrical",
        department: "PSM",                       // fixed default
        product_line_impacted: "All",            // default if not edited
        supplier: supplierAuto,                  // pulled from Excel vendor
        part_new: true,
        ...totals,
      }).select().single();
      if (formErr) throw formErr;

      const itemRows = rows.map((r, idx) => ({
        form_id: formRow.id, row_index: idx, ...r,
        fs_item_code: null, old_item_code: null, old_description: null,
        pct_diff: r.old_price !== 0 ? (r.price_diff / r.old_price) * 100 : 0,
      }));
      const { error: itemsErr } = await supabase.from("tke_form_items").insert(itemRows);
      if (itemsErr) throw itemsErr;

      res.json({ form_id: formRow.id, form_no, row_count: rows.length });
    } catch (e) {
      console.error("[tke upload]", e);
      res.status(400).json({ error: e?.message || "Upload failed" });
    }
  });

  router.get("/forms/:id", auth, async (req, res) => {
    try {
      const { data: form, error: fe } = await supabase.from("tke_forms").select("*").eq("id", req.params.id).single();
      if (fe || !form) return res.status(404).json({ error: "Not found" });
      const { data: items } = await supabase.from("tke_form_items").select("*").eq("form_id", req.params.id).order("row_index");
      res.json({ form, items: items || [] });
    } catch (e) {
      res.status(500).json({ error: e?.message || "Fetch failed" });
    }
  });

  router.patch("/forms/:id", auth, async (req, res) => {
    try {
      const { data: existing } = await supabase.from("tke_forms").select("prepared_by_user_id").eq("id", req.params.id).single();
      if (!existing) return res.status(404).json({ error: "Not found" });
      if (existing.prepared_by_user_id !== req.user.id) {
        return res.status(403).json({ error: "Only the preparer can edit this form" });
      }
      const patch = {};
      for (const k of EDITABLE) if (k in req.body) patch[k] = req.body[k];
      const { data, error } = await supabase.from("tke_forms").update(patch).eq("id", req.params.id).select().single();
      if (error) throw error;
      res.json({ form: data });
    } catch (e) {
      console.error("[tke patch]", e);
      res.status(400).json({ error: e?.message || "Update failed" });
    }
  });

  router.get("/my-forms", auth, async (req, res) => {
    try {
      const { data, error } = await supabase.from("tke_forms")
        .select("id, form_no, form_date, status, quarterly_impact, prepared_by, created_at")
        .eq("prepared_by_user_id", req.user.id)
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      res.json({ forms: data || [] });
    } catch (e) {
      res.status(500).json({ error: e?.message });
    }
  });

  // Generate PDF buffer (shared by both /pdf and /pdf-preview endpoints)
  async function generatePdfForForm(formId) {

// TEMPORARY DIAGNOSTIC — remove once fixed
const { execSync } = require("child_process");
try {
  console.log("[DIAG] PUPPETEER_CACHE_DIR =", process.env.PUPPETEER_CACHE_DIR);
  console.log("[DIAG] HOME =", process.env.HOME);
  console.log("[DIAG] cwd =", process.cwd());
  console.log("[DIAG] /opt/render/.cache contents:");
  console.log(execSync("ls -la /opt/render/.cache/ 2>&1 || echo 'missing'").toString());
  console.log("[DIAG] /opt/render/.cache/puppeteer contents:");
  console.log(execSync("ls -laR /opt/render/.cache/puppeteer/ 2>&1 || echo 'missing'").toString());
  console.log("[DIAG] find chrome binaries:");
  console.log(execSync("find / -name 'chrome' -type f 2>/dev/null | head -20").toString());
} catch (e) { console.log("[DIAG] failed:", e.message); }

    const { data: form, error: fe } = await supabase.from("tke_forms").select("*").eq("id", formId).single();
    if (fe || !form) throw new Error("Form not found");
    const { data: items } = await supabase.from("tke_form_items").select("*").eq("form_id", formId).order("row_index");
    const html = renderFormHtml(form, items || []);

    // Robust Chrome resolution: try Puppeteer's bundled path first,
    // then fall back to env var, then let Puppeteer auto-detect.
   const launchOpts = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};

// Let Puppeteer find Chrome via its own resolver, using the cache dir from env.
// This survives Puppeteer/Chrome version bumps automatically.
try {
  const { computeExecutablePath, Browser } = require("@puppeteer/browsers");
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer";
  const buildId = puppeteer.PUPPETEER_REVISIONS?.chrome
    || require("puppeteer/lib/cjs/puppeteer/revisions.js")?.PUPPETEER_REVISIONS?.chrome;
  if (buildId) {
    launchOpts.executablePath = computeExecutablePath({
      browser: Browser.CHROME,
      buildId,
      cacheDir,
    });
  }
} catch (e) {
  console.warn("[tke pdf] @puppeteer/browsers resolver failed, falling back:", e.message);
}

// Fallback 1: env var override (lets you swap Chrome paths without redeploying code)
if (!launchOpts.executablePath && process.env.PUPPETEER_EXECUTABLE_PATH) {
  launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

// Fallback 2: Puppeteer's own resolver (works for non-Render setups)
if (!launchOpts.executablePath) {
  try { launchOpts.executablePath = puppeteer.executablePath(); } catch (_) {}
}
    try {
      const execPath = puppeteer.executablePath();
      if (execPath) launchOpts.executablePath = execPath;
    } catch (_) { /* fall through to env or default */ }
    if (!launchOpts.executablePath && process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const browser = await puppeteer.launch(launchOpts);
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdfBuffer = await page.pdf({
        format: "A4", printBackground: true,
        margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
      });
      return { form, pdfBuffer };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // Download PDF (Content-Disposition: attachment)
  router.get("/forms/:id/pdf", auth, async (req, res) => {
    try {
      const { form, pdfBuffer } = await generatePdfForForm(req.params.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="TKE_Cost_Approval_${form.form_no}.pdf"`);
      res.send(pdfBuffer);
    } catch (e) {
      console.error("[tke pdf]", e);
      res.status(500).json({ error: e?.message || "PDF generation failed" });
    }
  });

  // Preview PDF (inline — opens in browser)
  router.get("/forms/:id/pdf-preview", auth, async (req, res) => {
    try {
      const { form, pdfBuffer } = await generatePdfForForm(req.params.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="TKE_Cost_Approval_${form.form_no}.pdf"`);
      res.send(pdfBuffer);
    } catch (e) {
      console.error("[tke pdf-preview]", e);
      res.status(500).json({ error: e?.message || "PDF preview failed" });
    }
  });

  return router;
}

module.exports = {
  createTkeCostApprovalRouter,
  parseExcel,
  computeTotals,
  renderFormHtml,
  makeAuthMiddleware,
};
