console.log('%c[app.js] build BUGFIX-2026-09-11-v7-STATICSAVE loaded', 'color:#1a5276;font-weight:bold');
/* ── State ──────────────────────────────────────────────────── */
const API = 'http://127.0.0.1:5000/api';

/* ── Gender Prefix Helper ──────────────────────────────────── */
function getPatientPrefix(gender, age, greeting) {
  if (greeting && String(greeting).trim()) return String(greeting).trim();
  const g = (gender || '').toLowerCase();
  const a = parseInt(age) || 0;
  if (g === 'male')   return a < 18 ? 'Master.' : 'Mr.';
  if (g === 'female') return a < 18 ? 'Miss.'   : 'Mrs.';
  return '';
}
function prefixedName(name, gender, age, greeting) {
  const prefix = getPatientPrefix(gender, age, greeting);
  return prefix ? `${prefix} ${name}` : (name || '—');
}
let currentReportId = null;
let currentPatientPhone = null;
let currentPdfReady = false;

/* ── Page Cache State ──────────────────────────────────────────── */
const pageCache = {
  patients: { loaded: false, data: null },
  doctors: { loaded: false, data: null },
  reports: { loaded: false, data: null },
  appointments: { loaded: false, data: null },
  tests: { loaded: false, data: null },
  dashboard: { loaded: false, data: null }
};

function markPageLoaded(name, data = null) {
  if (pageCache[name]) {
    pageCache[name].loaded = true;
    pageCache[name].data = data;
  }
}

function isPageLoaded(name) {
  return pageCache[name] && pageCache[name].loaded === true;
}

function getCachedPageData(name) {
  return pageCache[name] ? pageCache[name].data : null;
}

function clearPageCache(name) {
  if (name && pageCache[name]) {
    pageCache[name].loaded = false;
    pageCache[name].data = null;
  } else if (!name) {
    Object.keys(pageCache).forEach(key => {
      pageCache[key].loaded = false;
      pageCache[key].data = null;
    });
  }
}
 
/* ── Toast ──────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3500);
}
 
/* ── Navigation ─────────────────────────────────────────────── */
function showPage(name) {
  // Gate fully-locked pages behind their license feature flag
  if (typeof LOCKED_PAGES !== 'undefined' && LOCKED_PAGES[name] && typeof guardFeature === 'function') {
    if (!guardFeature(LOCKED_PAGES[name])) return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`).classList.add('active');
  document.getElementById('page-title').textContent =
    { dashboard: 'Dashboard', patients: 'Patients', doctors: 'Doctors', reports: 'Reports',
      appointments: 'Appointments', tests: 'Test Catalog', stages: 'Test Stages',
      labtest: 'Lab Test Bill', collections: 'Collections', settings: 'Settings', interpretations: 'Test Interpretations',
      reftables: 'Reference Tables',
      backup: 'Backup & Restore', otherlabtests: 'Other Lab Tests', about: 'About' }[name];
  
  // Always call load functions - they handle their own caching
  if (name === 'dashboard') loadDashboard();
  else if (name === 'patients') loadPatients();
  else if (name === 'doctors') loadDoctors();
  else if (name === 'reports') loadReports();
  else if (name === 'appointments') loadAppointments();
  else if (name === 'tests') { buildStageCache().then(() => loadTests()); }
  else if (name === 'stages') {
    loadStage1().then(() => applyPendingStageFocus());
  }
  else if (name === 'labtest') initLabTestPage();
  else if (name === 'collections') loadCollectionsReport();
  else if (name === 'settings') loadSettings();
  else if (name === 'backup') loadBackupStats();
  else if (name === 'otherlabtests') loadOtherLabs();
}
 
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});
 
/* ── Modal ──────────────────────────────────────────────────── */
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});
 
// Looks up a single test in the catalog by exact name. A 404 here just
// means "no catalog entry for this test name" (e.g. a custom/typo'd test) —
// that's an expected, routine outcome, not a real error, so this quietly
// returns null instead of going through apiFetch's error-toast handling.
async function fetchTestByNameSilent(url) {
  try {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* ── API helper ──────────────────────────────────────────────── */
async function apiFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch (e) {
    // fetch() itself only throws when the request never reached the server
    // (server down, wrong port, network dropped) — this is the real
    // "is Flask running?" case.
    console.error(e);
    toast('Server error. Is Flask running?', 'error');
    return null;
  }
  // License expired or invalid — block the app and show the renewal overlay
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'license_invalid' && !_licenseValid) {
      disableApp();
      // Re-fetch license status to get system_code and expiry for the overlay
      const status = await fetch('/api/license/status').then(r => r.json()).catch(() => ({}));
      showLicenseOverlay(status.system_code, status.expired, false, null, status.expiry);
    } else if (data.error === 'feature_locked' && opts.method && opts.method !== 'GET') {
      // A backend feature gate fired on a write action that wasn't pre-checked
      // by guardFeature() client-side (e.g. an endpoint shared across pages) —
      // surface it instead of failing silently. Reads (GET) stay quiet since
      // several pages poll optional/feature-gated data in the background
      // (e.g. the reference-lab dropdown on New Report) and shouldn't toast
      // every time they come back empty for an unlicensed feature.
      toast(data.message || `${data.feature || 'This feature'} requires an upgraded license key.`, 'error');
    }
    return null;
  }
  try {
    const data = await res.json();
    if (!res.ok) {
      // Server responded but with an error — show the real message now that
      // the backend always returns JSON errors.
      toast(data.error || `Request failed (${res.status})`, 'error');
      return null;
    }
    return data;
  } catch (e) {
    console.error(e);
    toast(`Unexpected response from server (${res.status})`, 'error');
    return null;
  }
}
 
/* ── Dashboard ──────────────────────────────────────────────── */
let chartDaily = null;
let chartStatus = null;
 
async function loadDashboard() {
  const stats = await apiFetch(`${API}/stats`);
  if (stats) {
    document.getElementById('stat-patients').textContent = stats.total_patients;
    document.getElementById('stat-reports').textContent = stats.total_reports;
    document.getElementById('stat-doctors').textContent = stats.total_doctors;
    document.getElementById('stat-today').textContent = stats.reports_today;
    document.getElementById('stat-appts').textContent = stats.appointments_today || 0;
 
    // Daily chart
    const dailyLabels = stats.daily_reports.map(d => d.day ? d.day.slice(5) : '');
    const dailyCounts = stats.daily_reports.map(d => d.count);
    const ctxD = document.getElementById('chart-daily').getContext('2d');
    if (chartDaily) chartDaily.destroy();
    chartDaily = new Chart(ctxD, {
      type: 'bar',
      data: {
        labels: dailyLabels,
        datasets: [{ label: 'Reports', data: dailyCounts,
          backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 6, borderSkipped: false }]
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    });
 
    // Status pie chart
    const statusColors = { uploaded: '#3b82f6', completed: '#10b981', pending: '#f59e0b' };
    const ctxS = document.getElementById('chart-status').getContext('2d');
    if (chartStatus) chartStatus.destroy();
    chartStatus = new Chart(ctxS, {
      type: 'doughnut',
      data: {
        labels: stats.status_breakdown.map(s => s.status),
        datasets: [{ data: stats.status_breakdown.map(s => s.count),
          backgroundColor: stats.status_breakdown.map(s => statusColors[s.status] || '#94a3b8') }]
      },
      options: { plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, cutout: '60%' }
    });
  }
  const reports = await apiFetch(`${API}/reports`);
  const list = document.getElementById('recent-reports-list');
  if (reports && reports.length) {
    list.innerHTML = reports.slice(0, 6).map(r => `
      <div class="recent-item">
        <div>
          <div class="recent-item-name">${prefixedName(r.patient_name, r.gender, r.age, r.greeting)}</div>
          <div class="recent-item-sub">${r.report_title} · ${r.report_date || ''}</div>
        </div>
        <span class="badge badge-${r.status}">${r.status}</span>
      </div>`).join('');
  } else {
    list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px 0">No reports yet</div>';
  }
  markPageLoaded('dashboard', stats);
}
 
/* ── Patients ────────────────────────────────────────────────── */
async function loadPatients(q = '') {
  // Use cache if available and no search query
  if (!q && isPageLoaded('patients')) {
    const cachedData = getCachedPageData('patients');
    const tbody = document.getElementById('patients-tbody');
    if (!cachedData || !cachedData.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">No patients found</td></tr>`;
      return;
    }
    tbody.innerHTML = cachedData.map(p => `
      <tr>
        <td><b>${prefixedName(p.name, p.gender, p.age, p.greeting)}</b></td>
        <td>${p.age || '—'}</td>
        <td>${p.gender || '—'}</td>
        <td><span class="badge" style="background:rgba(239,68,68,.1);color:#f87171">${p.blood_group || '—'}</span></td>
        <td>${p.phone || '—'}</td>
        <td>
          <div class="action-btns">
            <button class="btn btn-sm btn-outline" onclick="editPatient(${JSON.stringify(p).replace(/"/g,'&quot;')})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deletePatient(${p.id})">Delete</button>
          </div>
        </td>
      </tr>`).join('');
    return;
  }
  
  const url = q ? `${API}/patients?q=${encodeURIComponent(q)}` : `${API}/patients`;
  const data = await apiFetch(url);
  const tbody = document.getElementById('patients-tbody');
  
  if (!data) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">Error loading patients. Is the server running?</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">No patients found</td></tr>`;
    return;
  }
  
  tbody.innerHTML = data.map(p => `
    <tr>
      <td><b>${prefixedName(p.name, p.gender, p.age, p.greeting)}</b></td>
      <td>${p.age || '—'}</td>
      <td>${p.gender || '—'}</td>
      <td><span class="badge" style="background:rgba(239,68,68,.1);color:#f87171">${p.blood_group || '—'}</span></td>
      <td>${p.phone || '—'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-outline" onclick="editPatient(${JSON.stringify(p).replace(/"/g,'&quot;')})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deletePatient(${p.id})">Delete</button>
        </div>
      </td>
    </tr>`).join('');
  
  // Only cache if no search query AND has data
  if (!q && data.length > 0) {
    markPageLoaded('patients', data);
  }
}
 
document.getElementById('patient-search').addEventListener('input', e => loadPatients(e.target.value));
 
async function savePatient() {
  const id = document.getElementById('edit-patient-id').value;
  const payload = {
    name: document.getElementById('p-name').value.trim(),
    age: document.getElementById('p-age').value,
    gender: document.getElementById('p-gender').value,
    blood_group: document.getElementById('p-blood').value,
    greeting: document.getElementById('p-greeting').value,
    phone: document.getElementById('p-phone').value,
    email: document.getElementById('p-email').value,
    address: document.getElementById('p-address').value,
    op_ip: document.getElementById('p-op-ip').value,
  };
  if (!payload.name)   { toast('Patient name is required', 'error'); return; }
  if (!payload.age || isNaN(payload.age) || Number(payload.age) <= 0) { toast('Age is required', 'error'); document.getElementById('p-age').focus(); return; }
  if (!payload.gender) { toast('Gender is required', 'error'); document.getElementById('p-gender').focus(); return; }
  const url = id ? `${API}/patients/${id}` : `${API}/patients`;
  const method = id ? 'PUT' : 'POST';
  const res = await apiFetch(url, { method, body: JSON.stringify(payload) });
  if (res) {
    toast(id ? 'Patient updated!' : 'Patient added!', 'success');
    closeModal('patient-modal');
    resetPatientForm();
    clearPageCache('patients');
    clearPageCache('dashboard');
    loadPatients();
    loadDashboard();
  }
}
 
function editPatient(p) {
  document.getElementById('edit-patient-id').value = p.id;
  document.getElementById('p-name').value = p.name || '';
  document.getElementById('p-age').value = p.age || '';
  document.getElementById('p-gender').value = p.gender || '';
  document.getElementById('p-blood').value = p.blood_group || '';
  document.getElementById('p-greeting').value = p.greeting || '';
  document.getElementById('p-phone').value = p.phone || '';
  document.getElementById('p-email').value = p.email || '';
  document.getElementById('p-address').value = p.address || '';
  document.getElementById('p-op-ip').value = p.op_ip || '';
  document.getElementById('patient-modal-title').textContent = 'Edit Patient';
  openModal('patient-modal');
}
 
function resetPatientForm() {
  ['edit-patient-id','p-name','p-age','p-gender','p-blood','p-greeting','p-phone','p-email','p-address','p-op-ip'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('patient-modal-title').textContent = 'Add Patient';
}
 
async function deletePatient(id) {
  if (!confirm('Delete this patient?')) return;
  const res = await apiFetch(`${API}/patients/${id}`, { method: 'DELETE' });
  if (res) { 
    toast('Patient deleted', 'success'); 
    clearPageCache('patients');
    clearPageCache('dashboard');
    loadPatients(); 
    loadDashboard(); 
  }
}
 
/* ── Doctors ─────────────────────────────────────────────────── */
async function loadDoctors() {
  // Use cache if available
  if (isPageLoaded('doctors')) {
    const cachedData = getCachedPageData('doctors');
    const tbody = document.getElementById('doctors-tbody');
    if (!cachedData || !cachedData.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">No doctors added</td></tr>`;
      return;
    }
    tbody.innerHTML = cachedData.map(d => `<tr>
      <td><b>${d.name}</b></td>
      <td>${d.specialization || '—'}</td>
      <td>${d.hospital || '—'}</td>
      <td>${d.phone || '—'}</td>
      <td>
        <button class="btn btn-sm btn-danger" onclick="deleteDoctor(${d.id})">Delete</button>
      </td>
    </tr>`).join('');
    return;
  }

  const data = await apiFetch(`${API}/doctors`);
  const tbody = document.getElementById('doctors-tbody');
  if (!data) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">Error loading doctors. Is the server running?</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">No doctors added</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(d => `
    <tr>
      <td><b>${d.name}</b></td>
      <td>${d.specialization || '—'}</td>
      <td>${d.hospital || '—'}</td>
      <td>${d.phone || '—'}</td>
      <td>
        <button class="btn btn-sm btn-danger" onclick="deleteDoctor(${d.id})">Delete</button>
      </td>
    </tr>`).join('');
  // Only cache if has data
  if (data.length > 0) {
    markPageLoaded('doctors', data);
  }
}
 
async function saveDoctor() {
  const payload = {
    name: document.getElementById('d-name').value.trim(),
    specialization: document.getElementById('d-spec').value,
    hospital: document.getElementById('d-hospital').value,
    phone: document.getElementById('d-phone').value,
    email: document.getElementById('d-email').value,
  };
  if (!payload.name) { toast('Doctor name required', 'error'); return; }
  const res = await apiFetch(`${API}/doctors`, { method: 'POST', body: JSON.stringify(payload) });
  if (res) { 
    toast('Doctor added!', 'success'); 
    closeModal('doctor-modal'); 
    clearPageCache('doctors');
    loadDoctors(); 
  }
}

async function deleteDoctor(id) {
  if (!confirm('Delete this doctor?')) return;
  await apiFetch(`${API}/doctors/${id}`, { method: 'DELETE' });
  toast('Deleted', 'success'); 
  clearPageCache('doctors');
  loadDoctors();
}
 
/* ── Reports ─────────────────────────────────────────────────── */
async function loadReports(q = '') {
  const filterDate = document.getElementById('report-filter-date')?.value || '';
  const hasFilter = q || filterDate;

  // Use cache only if no search query and no date filters
  if (!hasFilter && isPageLoaded('reports')) {
    const cachedData = getCachedPageData('reports');
    const tbody = document.getElementById('reports-tbody');
    if (!cachedData || !cachedData.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No reports yet. Upload a PDF to get started.</td></tr>`;
      return;
    }
    renderReportsTable(cachedData, tbody);
    return;
  }

  // Build query URL
  let url = `${API}/reports?`;
  if (q) url += `q=${encodeURIComponent(q)}&`;
  if (filterDate) url += `date=${filterDate}&`;

  const data = await apiFetch(url);
  const tbody = document.getElementById('reports-tbody');
  if (!data) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">Error loading reports.</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No reports found for the selected criteria.</td></tr>`;
    return;
  }

  renderReportsTable(data, tbody);
  
  if (!hasFilter && data.length > 0) {
    markPageLoaded('reports', data);
  }
}

function renderReportsTable(data, tbody) {
  const waAllowed = (typeof hasFeature !== 'function') || hasFeature('whatsapp');
  tbody.innerHTML = data.map(r => `
    <tr id="report-row-${r.id}">
      <td style="width:36px;text-align:center"><input type="checkbox" class="report-checkbox" data-id="${r.id}" onchange="updateBulkDeleteBtn()" style="width:15px;height:15px;cursor:pointer;accent-color:var(--primary)"></td>
      <td style="font-family:monospace;color:var(--muted)">RPT-${String(r.id).padStart(5,'0')}</td>
      <td><b>${prefixedName(r.patient_name, r.gender, r.age, r.greeting)}</b></td>
      <td>${r.report_title || '—'}</td>
      <td>${r.doctor_name || '—'}</td>
      <td>${r.report_date || '—'}</td>
      <td><span class="badge badge-${r.status}">${r.status}</span></td>
      <td>
        <div class="action-btns" style="gap:4px">
          <button class="btn btn-sm btn-outline" onclick="reprintReport(${r.id})" title="Reprint Report">🖨️</button>
          ${waAllowed ? `<button class="btn btn-sm btn-outline whatsapp-share-btn"
                  data-id="${r.id}"
                  data-phone="${(r.patient_phone || '').replace(/"/g, '&quot;')}"
                  data-patient="${(r.patient_name || 'Patient').replace(/"/g, '&quot;')}"
                  data-title="${(r.report_title || 'Lab Report').replace(/"/g, '&quot;')}"
                  title="Share via WhatsApp">💬</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="deleteReport(${r.id})" title="Delete">✕</button>
        </div>
      </td>
    </tr>`).join('');
  // Reset select-all and bulk button on re-render
  const selectAll = document.getElementById('select-all-reports');
  if (selectAll) selectAll.checked = false;
  updateBulkDeleteBtn();
}

function updateBulkDeleteBtn() {
  const checked = document.querySelectorAll('.report-checkbox:checked');
  const btn = document.getElementById('bulk-delete-btn');
  const countEl = document.getElementById('selected-count');
  const selectAll = document.getElementById('select-all-reports');
  const all = document.querySelectorAll('.report-checkbox');
  if (btn) btn.style.display = checked.length > 0 ? 'inline-flex' : 'none';
  if (countEl) countEl.textContent = checked.length;
  if (selectAll) selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  if (selectAll && checked.length === all.length && all.length > 0) selectAll.checked = true;
}

function toggleSelectAllReports(el) {
  document.querySelectorAll('.report-checkbox').forEach(cb => cb.checked = el.checked);
  updateBulkDeleteBtn();
}

async function bulkDeleteReports() {
  const checked = document.querySelectorAll('.report-checkbox:checked');
  if (!checked.length) return;
  if (!confirm(`Delete ${checked.length} selected report(s)? This cannot be undone.`)) return;
  const ids = Array.from(checked).map(cb => parseInt(cb.dataset.id));
  let deleted = 0;
  for (const id of ids) {
    const res = await apiFetch(`${API}/reports/${id}`, { method: 'DELETE' });
    if (res !== null) deleted++;
  }
  toast(`${deleted} report(s) deleted`, 'success');
  clearPageCache('reports');
  clearPageCache('dashboard');
  loadReports();
  loadDashboard();
}

function clearReportDateFilter() {
  const d = document.getElementById('report-filter-date');
  if (d) d.value = '';
  loadReports();
}

async function reprintReport(id) {
  const w = window.open('', '_blank');
  if (w) w.document.write("<html><body style='display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666'><div><h3>Preparing reprint...</h3></div></body></html>");

  try {
    const data = await apiFetch(`${API}/reports/${id}`);
    if (data && data.html_content) {
      if (w) {
        w.document.open();
        w.document.write(data.html_content);
        w.document.close();
        w.focus();
        setTimeout(() => { if (w.print) w.print(); }, 500);
      }
    } else if (data && (data.pdf_path || data.original_pdf_path)) {
      const rawPath = String(data.pdf_path || data.original_pdf_path || '');
      const normalized = rawPath.replace(/\\/g, '/');
      let staticUrl = '';

      if (normalized.startsWith('/static/')) {
        staticUrl = normalized;
      } else if (normalized.startsWith('static/')) {
        staticUrl = `/${normalized}`;
      } else {
        const i = normalized.toLowerCase().lastIndexOf('/static/');
        if (i >= 0) staticUrl = normalized.slice(i);
      }

      if (staticUrl) {
        if (w) {
          w.location.replace(staticUrl);
          w.focus();
        } else {
          window.open(staticUrl, '_blank');
        }
      } else {
        if (w) w.close();
        toast('Report file path is invalid', 'error');
      }
    } else {
      if (w) w.close();
      toast('Report content not available', 'error');
    }
  } catch (err) {
    if (w) w.close();
    toast('Failed to fetch report content', 'error');
  }
}

function normalizeWhatsAppPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  digits = digits.replace(/^0+/, ''); // drop a leading trunk 0
  if (digits.length === 10) digits = '91' + digits; // assume India when no country code given
  return digits;
}

async function shareReportOnWhatsApp(id, phone, patientName, reportTitle) {
  const waPhone = normalizeWhatsAppPhone(phone);
  if (!waPhone) {
    toast('No phone number on file for this patient — add one first', 'error');
    return;
  }

  toast('Preparing report for download…', 'info');

  // Fetch the PDF ourselves so we can tell a real file apart from an error
  // response — a bare <a href> download can't do that and silently saves
  // whatever comes back, even a JSON error, as a broken file.
  let blob;
  try {
    const res = await fetch(`${API}/reports/${id}/download`);
    const contentType = res.headers.get('content-type') || '';

    if (!res.ok || contentType.includes('application/json')) {
      let msg = `Server error (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      toast(`Could not prepare report: ${msg}`, 'error');
      return;
    }
    blob = await res.blob();
  } catch (err) {
    toast('Could not reach the server to prepare the report', 'error');
    return;
  }

  // Save the fetched PDF locally so it's ready to attach.
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  const safePatient = (patientName || 'Patient').replace(/[^A-Za-z0-9_-]+/g, '_');
  const safeTitle = (reportTitle || 'Lab_Report').replace(/[^A-Za-z0-9_-]+/g, '_');
  a.download = `${safePatient}_${safeTitle}_RPT-${String(id).padStart(5, '0')}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

  const message = `Hi ${patientName}, please find your lab report "${reportTitle}" attached.`;
  const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`;
  window.open(waUrl, '_blank');

  toast('Report downloaded — attach it in the WhatsApp chat (📎) that just opened', 'info');
}

document.getElementById('reports-tbody').addEventListener('click', function(e) {
  const btn = e.target.closest('.whatsapp-share-btn');
  if (!btn) return;
  if (typeof guardFeature === 'function' && !guardFeature('whatsapp')) return;
  shareReportOnWhatsApp(
    btn.dataset.id,
    btn.dataset.phone,
    btn.dataset.patient,
    btn.dataset.title
  );
});


 
document.getElementById('report-search').addEventListener('input', e => loadReports(e.target.value));
 
function onFileSelect(input) {
  const name = input.files[0]?.name || 'No file chosen';
  document.getElementById('file-selected-name').textContent = name;
}
 
async function populateUploadSelects() {
  const patients = await apiFetch(`${API}/patients`);
  const doctors = await apiFetch(`${API}/doctors`);
  const pSel = document.getElementById('u-patient');
  pSel.innerHTML = '<option value="">Select Patient</option>' +
    (patients || []).map(p => `<option value="${p.id}">${p.name} (${p.phone || 'no phone'})</option>`).join('');
  const dSel = document.getElementById('u-doctor');
  dSel.innerHTML = '<option value="">None</option>' +
    (doctors || []).map(d => `<option value="${d.id}">${d.name} — ${d.specialization || ''}</option>`).join('');
  document.getElementById('u-date').value = new Date().toISOString().split('T')[0];
}
 
const _uploadReportBtn = document.getElementById('upload-report-btn');
if (_uploadReportBtn) _uploadReportBtn.addEventListener('click', populateUploadSelects);
 
async function uploadReport() {
  const pid = document.getElementById('u-patient').value;
  const file = document.getElementById('u-file').files[0];
  if (!pid) { toast('Select a patient', 'error'); return; }
  if (!file) { toast('Select a PDF file', 'error'); return; }
 
  const fd = new FormData();
  fd.append('patient_id', pid);
  fd.append('doctor_id', document.getElementById('u-doctor').value);
  fd.append('report_title', document.getElementById('u-title').value || 'Lab Report');
  fd.append('report_date', document.getElementById('u-date').value);
  fd.append('pdf_file', file);
 
  toast('Uploading & extracting text...', 'info');
  const btn = document.querySelector('#upload-modal .btn-primary');
  btn.innerHTML = '<span class="spinner"></span> Processing...';
  btn.disabled = true;
 
  try {
    const res = await fetch(`${API}/reports/upload`, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.id) {
      toast('Report uploaded & extracted!', 'success');
      closeModal('upload-modal');
      document.getElementById('u-file').value = '';
      document.getElementById('file-selected-name').textContent = 'No file chosen';
      clearPageCache('reports');
      clearPageCache('dashboard');
      loadReports();
      loadDashboard();
    }
  } catch (e) {
    toast('Upload failed', 'error');
  } finally {
    btn.innerHTML = 'Upload & Extract';
    btn.disabled = false;
  }
}

async function deleteReport(id) {
  if (!confirm('Delete this report?')) return;
  await apiFetch(`${API}/reports/${id}`, { method: 'DELETE' });
  toast('Report deleted', 'success'); 
  clearPageCache('reports');
  clearPageCache('dashboard');
  loadReports(); 
  loadDashboard();
}
 

 
async function saveSettings() {
  const payload = {
    lab_name: document.getElementById('s-lab-name').value,
    lab_address: document.getElementById('s-lab-addr').value,
    lab_phone: document.getElementById('s-lab-phone').value,
    lab_email: document.getElementById('s-lab-email').value,
    form_design: JSON.stringify(fdDesign),
    nr_subcategory_mode: (document.getElementById('s-nr-subcategory-mode') || {}).value || 'subcategory',
  };
  const res = await apiFetch(`${API}/settings`, { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    toast('Settings saved!', 'success');
    clearPageCache('settings');
    _nrSubcategoryMode = payload.nr_subcategory_mode;
  }
}
 
async function uploadLogo() {
  const file = document.getElementById('s-logo').files[0];
  if (!file) { toast('Select a logo file', 'error'); return; }
  const fd = new FormData();
  fd.append('logo', file);
  const res = await fetch(`${API}/settings/logo`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.message) toast('Logo uploaded!', 'success');
}
 
/* ── Linked Subcategories (Settings → Linked Subcategories) ────
   Groups of subcategories that always travel together (e.g. CBC + DC).
   Used by nrQuickSelect() when the "subcategory" mode is active. ── */
let _lgGroups = [];
let _lgAllSubcats = [];
let _lgSelectedIds = new Set();
let _lgEditingGroupId = null;

async function loadLinkGroups() {
  const list = document.getElementById('s-links-list');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px">Loading…</div>';
  const groups = await apiFetch(`${API}/stage2-links`);
  _lgGroups = groups || [];
  if (!_lgGroups.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px">No linked groups yet. Create one below.</div>';
    return;
  }
  list.innerHTML = _lgGroups.map(g => {
    const names = g.members.map(m =>
      `<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:2px 8px;margin:2px;font-size:12px">${m.stage1_name} › ${m.stage2_name}</span>`
    ).join('');
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-weight:600;font-size:13px">${g.name ? g.name : 'Linked Group'}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-outline" onclick="openLinkGroupModal(${g.id})">✏ Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteLinkGroupUI(${g.id})">✕</button>
        </div>
      </div>
      <div>${names}</div>
    </div>`;
  }).join('');
}

async function openLinkGroupModal(groupId) {
  _lgEditingGroupId = groupId || null;
  document.getElementById('link-group-modal-title').textContent = groupId ? 'Edit Linked Group' : 'New Linked Group';
  document.getElementById('lg-search').value = '';
  _lgSelectedIds = new Set();

  const existing = groupId ? _lgGroups.find(g => g.id === groupId) : null;
  document.getElementById('lg-name').value = existing ? (existing.name || '') : '';
  if (existing) existing.members.forEach(m => _lgSelectedIds.add(m.stage2_id));

  const [s1list, s2list] = await Promise.all([
    apiFetch(`${API}/stage1`),
    apiFetch(`${API}/stage2`),
  ]);
  const s1map = {};
  (s1list || []).forEach(s => s1map[s.id] = s.name);
  _lgAllSubcats = (s2list || []).map(s2 => ({
    id: s2.id, name: s2.name, categoryName: s1map[s2.stage1_id] || ''
  })).sort((a, b) => (a.categoryName + a.name).localeCompare(b.categoryName + b.name));

  renderLinkGroupPicker();
  openModal('link-group-modal');
}

function renderLinkGroupPicker() {
  const list = document.getElementById('lg-picker-list');
  const q = (document.getElementById('lg-search').value || '').trim().toLowerCase();
  let items = _lgAllSubcats;
  if (q) items = items.filter(i => i.name.toLowerCase().includes(q) || i.categoryName.toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:13px">No matches.</div>';
    return;
  }
  list.innerHTML = items.map(i => {
    const checked = _lgSelectedIds.has(i.id) ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border2);cursor:pointer;font-size:13px">
      <input type="checkbox" ${checked} onchange="toggleLgSelect(${i.id}, this.checked)"/>
      <span>${i.categoryName} › ${i.name}</span>
    </label>`;
  }).join('');
}

function toggleLgSelect(id, checked) {
  if (checked) _lgSelectedIds.add(id);
  else _lgSelectedIds.delete(id);
}

async function saveLinkGroup() {
  const ids = Array.from(_lgSelectedIds);
  if (ids.length < 2) { toast('Select at least two subcategories to link', 'error'); return; }
  const payload = {
    id: _lgEditingGroupId || undefined,
    name: document.getElementById('lg-name').value.trim(),
    stage2_ids: ids,
  };
  const res = await apiFetch(`${API}/stage2-links`, { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    toast('Linked group saved', 'success');
    closeModal('link-group-modal');
    loadLinkGroups();
    _loadStage2LinkMap();
  }
}

async function deleteLinkGroupUI(groupId) {
  if (!confirm('Delete this linked group? These subcategories will no longer be auto-added together.')) return;
  await apiFetch(`${API}/stage2-links/${groupId}`, { method: 'DELETE' });
  toast('Linked group deleted', 'success');
  loadLinkGroups();
  _loadStage2LinkMap();
}

/* ── Print Report ────────────────────────────────────────────── */
async function printReport() {
  if (!currentReportId) return;
 
  const settings = await apiFetch(`${API}/settings`) || {};
  if (settings.form_design) {
    try { Object.assign(fdDesign, JSON.parse(settings.form_design)); fdMigrateCustomImages(); if (fdDesign.logoDataUrl) fdLogoDataUrl = fdDesign.logoDataUrl; } catch(e) {}
  }
  const labName  = settings.lab_name    || 'Diagnostic Lab';
  const labAddr  = settings.lab_address || '';
  const labPhone = settings.lab_phone   || '';
  const labEmail = settings.lab_email   || '';
 
  const rpt = currentReportData || {};
  const patientAge    = rpt.age            || '\u2014';
  const patientGender = rpt.gender         || '\u2014';
  const patientName   = prefixedName(rpt.patient_name, patientGender, patientAge, rpt.greeting);
  const doctorName    = rpt.doctor_name    || '\u2014';
  const reportDate    = rpt.report_date    || '\u2014';
  const reportTitle   = rpt.report_title   || 'Lab Report';
  const extractedText = rpt.extracted_text || '';
  const patientNo     = rpt.patient_no     || '\u2014';
  const opIp          = rpt.op_ip          || '\u2014';
  const logoSrc = fdLogoDataUrl || null;
 
  const bodyHTML = fdBuildOrderedBody(fdDesign, {
    titlebar:     { hidden: fdDesign.showTitleBar === false,    html: `<div class="rpt-title-bar">${fdDesign.reportTitle || reportTitle}</div>` },
    patientinfo:  { hidden: fdDesign.showPatientInfo === false, html: fdBuildPatientInfoHTML(fdDesign, {
        name: patientName, age: patientAge === '\u2014' ? '\u2014' : patientAge + ' Y', sex: patientGender,
        doctor: doctorName, reportDate: reportDate, visitDate: '\u2014', refNo: patientNo, opIp: opIp,
      }) },
    resultstable: { hidden: false, html: extractedText ? `
      <div class="section-heading">\ud83d\udccb Extracted Report Data</div>
      <div class="extracted-block">${extractedText}</div>` : '' },
  }, []);
 
  // Header is rendered as a repeating slot on every printed page (see rpt-page-header
  // below), not as part of the scrolling/paginated body — this keeps it (or its
  // reserved blank space, when toggled off) consistent across every page instead of
  // appearing only wherever it happened to land in the content flow.
  const headerContentHTML = fdBuildHeader(fdDesign, labName, labAddr, labPhone, labEmail, logoSrc);
  const headerHTML = (fdDesign.showHeader === false)
    ? `<div style="visibility:hidden">${headerContentHTML}</div>`
    : headerContentHTML;
 
  // Signatures are pinned directly above the footer and, like the footer,
  // repeat on every printed page rather than appearing only on whichever
  // page the content happened to end on.
  const sigContentHTML = `
      <div class="rpt-signatures">
        ${(fdDesign.sigs || []).map(s => fdBuildSigBoxHTML(s)).join('')}
      </div>`;
  // Wrapped with the same 12mm side inset the body content uses (the footer
  // bar below deliberately bleeds edge-to-edge instead, via its own CSS).
  const sigHTML = `<div style="padding:0 12mm;box-sizing:border-box;width:100%;${fdDesign.showSignatures === false ? 'visibility:hidden' : ''}">${sigContentHTML}</div>`;
 
  // Footer content is always built; when toggled off it's wrapped so its
  // height (i.e. its reserved blank space) still shows consistently on every
  // printed page, the same way the header slot behaves. Signatures are
  // bundled into the same slot so they sit right above the footer on every page.
  const footerContentHTML = fdBuildFooterBar(fdDesign, labAddr, labPhone);
  const footerBarHTML = (fdDesign.showFooter === false)
    ? `<div style="visibility:hidden">${footerContentHTML}</div>`
    : footerContentHTML;
  const footerHTML = sigHTML + footerBarHTML;
 
  const printWin = window.open('', '_blank');
  printWin.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8"/>
    <title>${reportTitle}</title>
    <style>

      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #888; font-family: Arial, sans-serif; }

      .print-toolbar {
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        background: #2d2d2d; display: flex; justify-content: center;
        align-items: center; gap: 12px; padding: 10px 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .print-toolbar button { padding: 8px 28px; border-radius: 6px; font-size: 13px; font-weight: 700; cursor: pointer; border: none; }
      .btn-print { background: #c0392b; color: #fff; }
      .btn-close  { background: #555;    color: #fff; }
      @media print { .print-toolbar { display: none !important; } }

      .rpt-page-wrap {
        margin: 60px auto 20px;
        background: #fff;
        width: 210mm;
        height: 297mm;
        box-shadow: 0 4px 32px rgba(0,0,0,0.35);
        position: relative;
        overflow: hidden;
        page-break-after: always;
        break-after: page;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .rpt-page-wrap:last-child { margin-bottom: 60px; page-break-after: avoid; break-after: avoid; }

      .rpt-page-content {
        position: absolute;
        top: 0;
        left: 12mm;
        right: 12mm;
        overflow: hidden;
      }

      .rpt-page-footer {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        width: 100%;
        overflow: hidden;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .rpt-page-footer > * { width: 100%; page-break-inside: avoid; break-inside: avoid; }

      @media print {
        body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .rpt-page-wrap { margin: 0; width: 100%; height: 297mm; box-shadow: none; }
        @page { size: A4 portrait; margin: 0; }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
      ${fdBuildCSS(fdDesign)}
      .rpt-wrap { width:100% !important; padding:0 !important; margin:0 !important; box-shadow:none !important; position:relative !important; overflow:visible !important; }
      .rpt-title-bar { margin-left:-12mm !important; margin-right:-12mm !important; width:calc(100% + 24mm) !important; }
      .rpt-footer-bar { margin-left:0 !important; margin-right:0 !important; width:100% !important; }
      .rpt-footer-spacer, .rpt-footer-block { display:none !important; }
      .extracted-block { font-family:Courier,monospace; font-size:${fdDesign.fontSize}; line-height:1.6; background:#f8f9fa; padding:10px; border-radius:4px; white-space:pre-wrap; word-break:break-word; margin-bottom:10px; }
      .section-heading { font-size:${fdDesign.fontSize}; font-weight:700; color:${fdDesign.primary}; border-bottom:1px solid #ddd; margin:10px 0 5px; padding-bottom:3px; }
      @media print {
        @page { size: A4 portrait; margin: 0; }
        @page :first { size: A4 portrait; margin: 0; }
        #rpt-measure-wrap, #rpt-header-clone, #rpt-footer-clone { display: none !important; }
        .rpt-page-wrap { width: 210mm !important; height: 297mm !important; margin: 0 !important; }
        .rpt-page-wrap { page-break-after: always !important; break-after: page !important; }
        .rpt-page-wrap:last-child { page-break-after: auto !important; break-after: auto !important; }
      }
    </style>
  </head><body>
    <div class="print-toolbar">
      <button class="btn-print" onclick="window.print()">\ud83d\udda8\ufe0f Print</button>
      <button class="btn-close" onclick="window.close()">\u2715 Close</button>
    </div>
    <div id="rpt-measure-wrap" style="position:absolute;top:60px;left:50%;transform:translateX(-50%);width:calc(210mm - 24mm);visibility:hidden;pointer-events:none;z-index:-1;">
      <div class="rpt-wrap" style="position:relative">${fdBuildWatermark(fdDesign)}${bodyHTML}</div>
    </div>
    <div id="rpt-header-clone" style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:calc(210mm - 24mm);visibility:hidden;pointer-events:none;z-index:-1;">
      ${headerHTML}
    </div>
    <div id="rpt-footer-clone" style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:210mm;visibility:hidden;pointer-events:none;z-index:-1;">
      ${footerHTML}
    </div>
    <div id="rpt-pages-container"></div>

  <script>
  (function() {
    var MM = 96 / 25.4;
    var PAGE_H_MM = 297;
    var FOOTER_TOP_PAD_MM = 4;
    var HEADER_BOTTOM_PAD_MM = 4;

    function measureFooterHeight(footerClone) {
      if (!footerClone) return 0;
      // Temporarily make in-flow so getBoundingClientRect returns a real height
      var prev = {
        position: footerClone.style.position,
        visibility: footerClone.style.visibility,
        opacity: footerClone.style.opacity,
        zIndex: footerClone.style.zIndex,
        top: footerClone.style.top,
        left: footerClone.style.left,
        transform: footerClone.style.transform
      };
      footerClone.style.position = 'relative';
      footerClone.style.visibility = 'hidden';
      footerClone.style.opacity = '0';
      footerClone.style.zIndex = '-1';
      footerClone.style.top = '';
      footerClone.style.left = '';
      footerClone.style.transform = '';
      var h = footerClone.getBoundingClientRect().height;
      // Restore
      footerClone.style.position = prev.position;
      footerClone.style.visibility = prev.visibility;
      footerClone.style.opacity = prev.opacity;
      footerClone.style.zIndex = prev.zIndex;
      footerClone.style.top = prev.top;
      footerClone.style.left = prev.left;
      footerClone.style.transform = prev.transform;
      return h;
    }

    function buildPages() {
      var measureWrap = document.getElementById('rpt-measure-wrap');
      var headerClone = document.getElementById('rpt-header-clone');
      var footerClone = document.getElementById('rpt-footer-clone');
      var container   = document.getElementById('rpt-pages-container');
      if (!measureWrap || !container) return;
      // Guard: see matching comment in the other buildPages() -- skip rebuild
      // if this window's measureWrap was already marked built (display:none),
      // which happens when reopening a previously-saved/printed static snapshot.
      if (measureWrap.style.display === "none") return;

      var footerHTML = footerClone ? footerClone.innerHTML : '';
      var hasFooter = !!(footerHTML && footerHTML.trim());
      var footerHpx  = hasFooter ? measureFooterHeight(footerClone) : 0;
      // Fallback: if measurement returned 0 (layout failed) but there IS footer
      // HTML, query the inner bar. This is a true fallback for a broken
      // measurement — it never inflates a legitimate, smaller real height.
      if (hasFooter && footerHpx <= 0 && footerClone && footerClone.innerHTML.trim()) {
        var innerBar = footerClone.querySelector('.rpt-footer-bar');
        if (innerBar) {
          var cs = window.getComputedStyle(innerBar);
          var minH = parseFloat(cs.minHeight) || 0;
          var paddingH = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
          footerHpx = Math.max(minH, paddingH, 30 * MM); // at minimum 30mm fallback
        } else {
          footerHpx = 30 * MM; // safe fallback
        }
      }
      var footerHmm  = footerHpx / MM;
      var footerSlotHmm = hasFooter ? (footerHmm + FOOTER_TOP_PAD_MM) : 0;

      // Header slot — measured the same way as the footer, and reserved on
      // EVERY page (not just wherever it would have landed in the flowing
      // content). If the header is toggled off its markup is still present
      // (wrapped in visibility:hidden by the caller), so this height still
      // reflects the reserved blank space, kept consistent across all pages.
      var headerHTML = headerClone ? headerClone.innerHTML : '';
      var hasHeader = !!(headerHTML && headerHTML.trim());
      var headerHpx = hasHeader ? measureFooterHeight(headerClone) : 0;
      var headerMinPx = ${(fdDesign.headerHeight || 80)};
      if (hasHeader && headerHpx <= 0) {
        headerHpx = headerMinPx; // safe fallback if measurement failed
      }
      var headerHmm = headerHpx / MM;
      var headerSlotHmm = hasHeader ? (headerHmm + HEADER_BOTTOM_PAD_MM) : 0;

      // Reserve a 2mm safety gap above the footer
      function getUsableHpx(pageIndex) {
        return (PAGE_H_MM - footerSlotHmm - headerSlotHmm - 2) * MM;
      }

      var children = Array.from(measureWrap.querySelectorAll(':scope > .rpt-wrap > *')).filter(function(el) {
        return !el.classList.contains('rpt-watermark-wrap') && !el.classList.contains('rpt-custom-img-layer') && el.offsetParent !== null;
      });

      function measureNodeHeight(node) {
        var probe = document.createElement('div');
        probe.style.position = 'absolute';
        probe.style.left = '0';
        probe.style.top = '0';
        probe.style.width = 'calc(210mm - 24mm)';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        var clone = node.cloneNode(true);
        // Rows still blank of a result collapse to display:none at actual
        // print time (see the .rpt-row-empty rule under @media print), but
        // on screen — where this measurement runs — they are still fully
        // rendered with their input boxes. Hide them here too so the height
        // we measure matches what will really print; otherwise pagination
        // reserves space for rows that vanish later, leaving gaps on the
        // page and stranding later content (e.g. interpretations) onto the
        // next page unnecessarily.
        (clone.classList && clone.classList.contains('rpt-row-empty') ? [clone] : []).concat(
          Array.prototype.slice.call(clone.querySelectorAll ? clone.querySelectorAll('.rpt-row-empty') : [])
        ).forEach(function(el) { el.style.display = 'none'; });
        probe.appendChild(clone);
        measureWrap.appendChild(probe);
        var h = probe.getBoundingClientRect().height;
        measureWrap.removeChild(probe);
        return h;
      }

      function splitTableChild(child, targetPx) {
        var table = (child.matches && child.matches('table.rpt-table')) ? child : child.querySelector('table.rpt-table');
        var tbody = table && table.querySelector('tbody');
        if (!tbody) return null;
        var rows = Array.from(tbody.querySelectorAll(':scope > tr'));
        if (rows.length < 2) return null;

        var first = child.cloneNode(true);
        var rest = child.cloneNode(true);
        var firstTable = (first.matches && first.matches('table.rpt-table')) ? first : first.querySelector('table.rpt-table');
        var restTable = (rest.matches && rest.matches('table.rpt-table')) ? rest : rest.querySelector('table.rpt-table');
        var firstBody = firstTable && firstTable.querySelector('tbody');
        var restBody = restTable && restTable.querySelector('tbody');
        if (!firstBody || !restBody) return null;
        firstBody.innerHTML = '';
        restBody.innerHTML = '';

        var added = 0;
        for (var i = 0; i < rows.length; i++) {
          firstBody.appendChild(rows[i].cloneNode(true));
          var h = measureNodeHeight(first);
          if (h > targetPx && added > 0) {
            firstBody.removeChild(firstBody.lastElementChild);
            break;
          }
          if (h > targetPx && added === 0) {
            firstBody.innerHTML = '';
            return null;
          }
          added++;
        }
        if (added === 0) return null;

        for (var j = added; j < rows.length; j++) {
          restBody.appendChild(rows[j].cloneNode(true));
        }

        // Keep post-table interpretation/notes only with the final chunk.
        var firstTableNode = (first.matches && first.matches('table.rpt-table')) ? first : first.querySelector('table.rpt-table');
        if (firstTableNode) {
          var next = firstTableNode.nextSibling;
          while (next) {
            var rm = next;
            next = next.nextSibling;
            if (rm.parentNode) rm.parentNode.removeChild(rm);
          }
        }

        if (!restBody.children.length) return { first: first, rest: null };
        return { first: first, rest: rest };
      }

      function splitNotesChild(child, targetPx) {
        var entries = Array.from(child.querySelectorAll('.rpt-interp-entry'));
        if (entries.length < 2) return null;

        var first = child.cloneNode(true);
        var rest = child.cloneNode(true);
        var firstEntries = Array.from(first.querySelectorAll('.rpt-interp-entry'));
        var restEntries = Array.from(rest.querySelectorAll('.rpt-interp-entry'));
        if (!firstEntries.length || !restEntries.length) return null;

        var firstParent = firstEntries[0].parentNode;
        var restParent = restEntries[0].parentNode;
        if (!firstParent || !restParent) return null;

        firstEntries.forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });
        restEntries.forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });

        function findEndMarker(parent) {
          var nodes = Array.from(parent.querySelectorAll('div, p, span'));
          for (var k = 0; k < nodes.length; k++) {
            var txt = (nodes[k].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (txt === 'end of the report') return nodes[k];
          }
          return null;
        }
        function appendBeforeEnd(parent, node) {
          var endMarker = findEndMarker(parent);
          if (endMarker && endMarker.parentNode === parent) parent.insertBefore(node, endMarker);
          else parent.appendChild(node);
        }

        var added = 0;
        for (var i = 0; i < entries.length; i++) {
          var insertedNode = entries[i].cloneNode(true);
          appendBeforeEnd(firstParent, insertedNode);
          var h = measureNodeHeight(first);
          if (h > targetPx && added > 0) {
            if (insertedNode.parentNode) insertedNode.parentNode.removeChild(insertedNode);
            break;
          }
          if (h > targetPx && added === 0) {
            firstParent.innerHTML = '';
            return null;
          }
          added++;
        }
        if (added === 0) return null;

        for (var j = added; j < entries.length; j++) {
          appendBeforeEnd(restParent, entries[j].cloneNode(true));
        }

        function stripEndOfReport(root) {
          Array.from(root.querySelectorAll('div, p, span')).forEach(function(n) {
            var txt = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (txt === 'end of the report') {
              if (n.parentNode) n.parentNode.removeChild(n);
            }
          });
        }

        // Keep the closing "End of the report" only on the final notes chunk.
        if (restParent.children.length) {
          stripEndOfReport(first);
        }

        if (!restParent.children.length) return { first: first, rest: null };
        return { first: first, rest: rest };
      }

      var pages = [];
      var bucket = [];
      var used = 0;
      var pageIndex = 0;
      var queue = children.map(function(el) { return el.cloneNode(true); });

      while (queue.length) {
        var child = queue.shift();
        var h = measureNodeHeight(child);

        // Near-zero-height nodes (stray spacers, empty wrappers, collapsed
        // margins) shouldn't be able to trigger a page break on their own —
        // just carry them onto the current page without affecting the
        // overflow decision below.
        if (h < 1) {
          bucket.push(child);
          continue;
        }

        var pageUsableHpx = getUsableHpx(pageIndex);
        var remaining = pageUsableHpx - used;

        if (bucket.length > 0 && h > remaining) {
          var splitFit = splitTableChild(child, remaining);
          if (!splitFit) splitFit = splitNotesChild(child, remaining);
          if (splitFit) {
            var firstH = measureNodeHeight(splitFit.first);
            bucket.push(splitFit.first);
            used += firstH;
            pages.push(bucket);
            bucket = [];
            used = 0;
            pageIndex++;
            if (splitFit.rest) queue.unshift(splitFit.rest);
            continue;
          }
          pages.push(bucket);
          bucket = [];
          used = 0;
          pageIndex++;
          queue.unshift(child);
          continue;
        }

        if (h > pageUsableHpx) {
          var splitFull = splitTableChild(child, pageUsableHpx);
          if (!splitFull) splitFull = splitNotesChild(child, pageUsableHpx);
          if (splitFull) {
            bucket.push(splitFull.first);
            pages.push(bucket);
            bucket = [];
            used = 0;
            pageIndex++;
            if (splitFull.rest) queue.unshift(splitFull.rest);
            continue;
          }
        }

        bucket.push(child);
        used += h;
      }
      if (bucket.length) pages.push(bucket);

      // Safety net: if the last page(s) ended up with no actual visible
      // content (only whitespace/empty wrappers made it past the h<1 check,
      // e.g. because they contain a hidden image that reports 0 width),
      // drop them instead of printing a blank trailing page.
      function pageHasVisibleContent(pageChildren) {
        for (var i = 0; i < pageChildren.length; i++) {
          var el = pageChildren[i];
          if ((el.textContent || '').replace(/\s+/g, '') !== '') return true;
          if (el.querySelector && el.querySelector('img, table, canvas, svg')) return true;
        }
        return false;
      }
      while (pages.length > 1 && !pageHasVisibleContent(pages[pages.length - 1])) {
        pages.pop();
      }

      container.innerHTML = '';

      pages.forEach(function(pageChildren, idx) {
        var pageWrap = document.createElement('div');
        pageWrap.className = 'rpt-page-wrap';

        // Header slot — same content (or same reserved blank space) on every page.
        if (hasHeader) {
          var hDiv = document.createElement('div');
          hDiv.className = 'rpt-page-header';
          hDiv.style.position = 'absolute';
          hDiv.style.top = '0';
          hDiv.style.left = '12mm';
          hDiv.style.right = '12mm';
          hDiv.style.height = headerSlotHmm + 'mm';
          hDiv.style.overflow = 'hidden';
          hDiv.style.boxSizing = 'border-box';
          hDiv.style.pageBreakInside = 'avoid';
          hDiv.style.breakInside = 'avoid';
          hDiv.innerHTML = headerHTML;
          pageWrap.appendChild(hDiv);
        }

        var contentDiv = document.createElement('div');
        contentDiv.className = 'rpt-page-content';
        contentDiv.style.top = headerSlotHmm + 'mm';
        contentDiv.style.bottom = footerSlotHmm + 'mm';
        contentDiv.style.height = (PAGE_H_MM - footerSlotHmm - headerSlotHmm) + 'mm';
        pageChildren.forEach(function(c) { contentDiv.appendChild(c); });
        pageWrap.appendChild(contentDiv);

        if (footerHTML) {
          var fDiv = document.createElement('div');
          fDiv.className = 'rpt-page-footer';
          fDiv.style.height = footerSlotHmm + 'mm';
          fDiv.style.paddingTop = FOOTER_TOP_PAD_MM + 'mm';
          fDiv.style.boxSizing = 'border-box';
          fDiv.innerHTML = footerHTML;
          pageWrap.appendChild(fDiv);
        }

        container.appendChild(pageWrap);
      });

      measureWrap.style.display = 'none';
      if (headerClone) headerClone.style.display = 'none';
      if (footerClone) footerClone.style.display = 'none';
    }

    function runBuildPages() {
      // Use rAF x2 to ensure layout is fully settled after load
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          buildPages();
        });
      });
    }

    if (document.readyState === 'complete') { runBuildPages(); }
    else { window.addEventListener('load', runBuildPages); }
  })();
  <\/script>
  </body></html>`);
  printWin.document.close();
  printWin.focus();
}
 
/* ── Abnormal Alert Highlighting ────────────────────────────── */
function highlightAbnormals(text) {
  if (!text) return text;
  // Highlight CRITICAL, HIGH, LOW, ABNORMAL keywords with colored spans
  return text
    .replace(/\bCRITICAL\b/gi, '<span style="background:#fee2e2;color:#dc2626;font-weight:700;padding:1px 5px;border-radius:3px">⚠ CRITICAL</span>')
    .replace(/\bHIGH\b/gi, '<span style="background:#fef3c7;color:#d97706;font-weight:700;padding:1px 5px;border-radius:3px">↑ HIGH</span>')
    .replace(/\bLOW\b/gi, '<span style="background:#dbeafe;color:#2563eb;font-weight:700;padding:1px 5px;border-radius:3px">↓ LOW</span>')
    .replace(/\bABNORMAL\b/gi, '<span style="background:#fce7f3;color:#db2777;font-weight:700;padding:1px 5px;border-radius:3px">✗ ABNORMAL</span>')
    .replace(/\bNORMAL\b/gi, '<span style="background:#d1fae5;color:#059669;font-weight:600;padding:1px 5px;border-radius:3px">✓ NORMAL</span>')
    .replace(/\n/g, '<br/>');
}
 
/* ── Appointments ────────────────────────────────────────────── */
async function loadAppointments(q = '') {
  // Use cache if available and no search query
  if (!q && isPageLoaded('appointments')) {
    const cachedData = getCachedPageData('appointments');
    const tbody = document.getElementById('appts-tbody');
    let rows = cachedData || [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No appointments yet</td></tr>`;
      return;
    }
    const statusColors = { scheduled: '#3b82f6', completed: '#10b981', cancelled: '#ef4444' };
    tbody.innerHTML = rows.map(a => `
      <tr>
        <td><b>${prefixedName(a.patient_name, a.gender, a.age, a.greeting)}</b><br><small style="color:var(--muted)">${a.patient_phone || ''}</small></td>
        <td>${a.doctor_name || '—'}</td>
        <td>${a.appointment_date || '—'}</td>
        <td>${a.appointment_time || '—'}</td>
        <td style="max-width:160px;font-size:12px">${a.test_names || '—'}</td>
        <td>
          <select class="form-input" style="padding:3px 6px;font-size:12px;width:auto"
            onchange="updateApptStatus(${a.id}, this.value)">
            <option value="scheduled" ${a.status==='scheduled'?'selected':''}>Scheduled</option>
            <option value="completed" ${a.status==='completed'?'selected':''}>Completed</option>
            <option value="cancelled" ${a.status==='cancelled'?'selected':''}>Cancelled</option>
          </select>
        </td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteAppointment(${a.id})">✕</button>
        </td>
      </tr>`).join('');
    return;
  }

  const data = await apiFetch(`${API}/appointments`);
  const tbody = document.getElementById('appts-tbody');
  let rows = data || [];
  if (q) rows = rows.filter(a =>
    (a.patient_name || '').toLowerCase().includes(q.toLowerCase()) ||
    (a.test_names || '').toLowerCase().includes(q.toLowerCase()));
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No appointments yet</td></tr>`;
    return;
  }
  const statusColors = { scheduled: '#3b82f6', completed: '#10b981', cancelled: '#ef4444' };
  tbody.innerHTML = rows.map(a => `
    <tr>
      <td><b>${prefixedName(a.patient_name, a.gender, a.age, a.greeting)}</b><br><small style="color:var(--muted)">${a.patient_phone || ''}</small></td>
      <td>${a.doctor_name || '—'}</td>
      <td>${a.appointment_date || '—'}</td>
      <td>${a.appointment_time || '—'}</td>
      <td style="max-width:160px;font-size:12px">${a.test_names || '—'}</td>
      <td>
        <select class="form-input" style="padding:3px 6px;font-size:12px;width:auto"
          onchange="updateApptStatus(${a.id}, this.value)">
          <option value="scheduled" ${a.status==='scheduled'?'selected':''}>Scheduled</option>
          <option value="completed" ${a.status==='completed'?'selected':''}>Completed</option>
          <option value="cancelled" ${a.status==='cancelled'?'selected':''}>Cancelled</option>
        </select>
      </td>
      <td>
        <button class="btn btn-sm btn-danger" onclick="deleteAppointment(${a.id})">✕</button>
      </td>
    </tr>`).join('');
  
  // Only cache if no search query AND has data
  if (!q && rows.length > 0) {
    markPageLoaded('appointments', data);
  }
}
 
document.getElementById('appt-search').addEventListener('input', e => loadAppointments(e.target.value));
 
async function openApptModal() {
  document.getElementById('edit-appt-id').value = '';
  const patients = await apiFetch(`${API}/patients`);
  const doctors = await apiFetch(`${API}/doctors`);
  document.getElementById('appt-patient').innerHTML =
    '<option value="">Select Patient</option>' +
    (patients || []).map(p => `<option value="${p.id}">${p.name} (${p.phone || ''})</option>`).join('');
  document.getElementById('appt-doctor').innerHTML =
    '<option value="">None</option>' +
    (doctors || []).map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  document.getElementById('appt-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('appt-time').value = '';
  document.getElementById('appt-tests').value = '';
  document.getElementById('appt-notes').value = '';
  openModal('appt-modal');
}
 
async function saveAppointment() {
  const pid = document.getElementById('appt-patient').value;
  const date = document.getElementById('appt-date').value;
  if (!pid) { toast('Select a patient', 'error'); return; }
  if (!date) { toast('Select a date', 'error'); return; }
  const payload = {
    patient_id: pid,
    doctor_id: document.getElementById('appt-doctor').value || null,
    appointment_date: date,
    appointment_time: document.getElementById('appt-time').value,
    test_names: document.getElementById('appt-tests').value,
    notes: document.getElementById('appt-notes').value,
  };
  const res = await apiFetch(`${API}/appointments`, { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    toast('Appointment booked!', 'success');
    closeModal('appt-modal');
    clearPageCache('appointments');
    clearPageCache('dashboard');
    loadAppointments();
    loadDashboard();
  }
}
 
async function updateApptStatus(id, status) {
  await apiFetch(`${API}/appointments/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
  toast('Status updated', 'success');
  clearPageCache('appointments');
}
 
async function deleteAppointment(id) {
  if (!confirm('Delete this appointment?')) return;
  await apiFetch(`${API}/appointments/${id}`, { method: 'DELETE' });
  toast('Appointment deleted', 'success');
  clearPageCache('appointments');
  clearPageCache('dashboard');
  loadAppointments();
  loadDashboard();
}
 
/* ── Test Catalog ────────────────────────────────────────────── */
let currentTestCategory = 'All';
 
async function loadTests(category = currentTestCategory) {
  currentTestCategory = category;
  
  // Use cache if available and not filtering
  if (category === 'All' && isPageLoaded('tests')) {
    const cachedData = getCachedPageData('tests');
    const cats = await apiFetch(`${API}/tests/categories`);
    const tabBar = document.getElementById('test-cat-tabs');
    const allCats = ['All', ...(cats || [])];
    tabBar.innerHTML = allCats.map(c =>
      `<button class="tab-btn ${c === category ? 'active' : ''}" onclick="loadTests('${c}')">${c}</button>`
    ).join('');
    window._testCatalogData = cachedData || [];
    renderTestCatalogRows(window._testCatalogData);
    return;
  }

  // Load categories for tab bar
  const cats = await apiFetch(`${API}/tests/categories`);
  const tabBar = document.getElementById('test-cat-tabs');
  const allCats = ['All', ...(cats || [])];
  tabBar.innerHTML = allCats.map(c =>
    `<button class="tab-btn ${c === category ? 'active' : ''}" onclick="loadTests('${c}')">${c}</button>`
  ).join('');

  const url = category && category !== 'All' ? `${API}/tests?category=${encodeURIComponent(category)}` : `${API}/tests`;
  const data = await apiFetch(url);
  window._testCatalogData = data || [];
  renderTestCatalogRows(window._testCatalogData);
  
  // Cache only when showing all tests AND has data
  if (category === 'All' && data && data.length > 0) {
    markPageLoaded('tests', data);
  }
}

function renderTestCatalogRows(data) {
  const tbody = document.getElementById('tests-tbody');
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No tests found</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(t => {
    const normalRange = t.normal_text ||
      ((t.normal_min != null && t.normal_max != null) ? `${t.normal_min} – ${t.normal_max} ${t.unit || ''}` :
       (t.normal_min != null ? `> ${t.normal_min}` :
       (t.normal_max != null ? `< ${t.normal_max}` : '—')));
    const subcategoryLabel = t.sub_category || '—';
    return `<tr>
      <td><span class="badge" style="background:rgba(139,92,246,.12);color:#7c3aed">${t.category || '—'}</span></td>
      <td style="font-size:12px;color:#38bdf8;font-weight:600">${subcategoryLabel}</td>
      <td><b>${t.test_name}</b></td>
      <td style="font-family:monospace;font-size:12px">${t.unit || '—'}</td>
      <td style="font-size:12px;color:var(--success)">${normalRange}</td>
      <td style="font-size:12px;color:#16a34a;font-weight:600">${t.amount ? '₹' + Number(t.amount).toFixed(2) : '—'}</td>
      <td style="font-size:12px;color:var(--muted)">${t.description || '—'}</td>
      <td style="white-space:nowrap"><button class="btn btn-sm btn-outline" onclick="openEditTest(${t.id})" style="margin-right:4px">✏</button><button class="btn btn-sm btn-danger" onclick="deleteTest(${t.id})">✕</button></td>
    </tr>`;
  }).join('');
}

function filterTestCatalog(q) {
  const query = q.toLowerCase().trim();
  if (!window._testCatalogData) return;
  if (!query) { renderTestCatalogRows(window._testCatalogData); return; }
  const filtered = window._testCatalogData.filter(t => {
    const sub = (t.sub_category || '').toLowerCase();
    return t.test_name.toLowerCase().includes(query)
        || (t.category || '').toLowerCase().includes(query)
        || sub.includes(query)
        || (t.description || '').toLowerCase().includes(query);
  });
  renderTestCatalogRows(filtered);
}
 
// Populate Stage 1 dropdown
async function _populateStage1Dropdown(selId, selectedS1Id) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const s1list = await apiFetch(`${API}/stage1`);
  sel.innerHTML = '<option value="">— Select Category —</option>';
  (s1list || []).forEach(s1 => {
    const opt = document.createElement('option');
    opt.value = s1.id; opt.textContent = s1.name; opt.dataset.name = s1.name;
    if (selectedS1Id && s1.id === selectedS1Id) opt.selected = true;
    sel.appendChild(opt);
  });
  // Always keep "Add New" at the bottom
  const newOpt = document.createElement('option');
  newOpt.value = '__new__'; newOpt.textContent = '➕ Add New Category...';
  sel.appendChild(newOpt);
}

// Populate Stage 2 dropdown filtered by stage1_id
async function _populateStage2ForStage1(selId, s1id, selectedS2Id) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— Skip Subcategory —</option>';
  if (!s1id) return;
  const stage2Data = await apiFetch(`${API}/stage2?stage1_id=${s1id}`);
  const seen = new Set();
  (stage2Data || []).forEach(s2 => {
    const key = (s2.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const opt = document.createElement('option');
    opt.value = s2.id; opt.textContent = s2.name;
    if (selectedS2Id && s2.id === selectedS2Id) opt.selected = true;
    sel.appendChild(opt);
  });
  // Add "Add New Subcategory" at bottom
  const newSubOpt = document.createElement('option');
  newSubOpt.value = '__new__'; newSubOpt.textContent = '\u2795 Add New Subcategory...';
  sel.appendChild(newSubOpt);
}

// Auto-create or find a hidden bridge Stage 2 under a Stage 1 (used when user skips Stage 2)
async function _getOrCreateBridgeStage2(s1id) {
  const BRIDGE_NAME = '(General)';
  const data = await apiFetch(`${API}/stage2?stage1_id=${s1id}`);
  const existing = (data || []).find(s2 => s2.name === BRIDGE_NAME);
  if (existing) return existing.id;
  const created = await apiFetch(`${API}/stage2`, { method: 'POST',
    body: JSON.stringify({ stage1_id: parseInt(s1id), name: BRIDGE_NAME }) });
  return created?.id || null;
}

// ── ADD TEST modal stage cascade ──────────────────────────────
async function onAddTestStage1Change() {
  const s1sel = document.getElementById('t-stage1');
  const s1id = s1sel.value;
  const newInput = document.getElementById('t-stage1-new');
  const wrap = document.getElementById('t-stage23-wrap');
  if (s1id === '__new__') {
    newInput.style.display = '';
    newInput.focus();
    document.getElementById('t-cat').value = '';
    // Still show subcategory + test name fields
    wrap.style.display = '';
    const s2sel = document.getElementById('t-stage2');
    s2sel.innerHTML = '<option value="">— Skip Subcategory —</option>';
    const addSubOpt = document.createElement('option');
    addSubOpt.value = '__new__'; addSubOpt.textContent = '➕ Add New Subcategory...';
    s2sel.appendChild(addSubOpt);
    document.getElementById('t-stage2-new').style.display = 'none';
    document.getElementById('t-stage2-new').value = '';
    document.getElementById('t-stage3').value = '';
  } else if (s1id) {
    newInput.style.display = 'none';
    newInput.value = '';
    document.getElementById('t-cat').value = s1sel.options[s1sel.selectedIndex].textContent;
    wrap.style.display = '';
    await _populateStage2ForStage1('t-stage2', parseInt(s1id), null);
    document.getElementById('t-stage3').value = '';
  } else {
    newInput.style.display = 'none';
    newInput.value = '';
    document.getElementById('t-cat').value = '';
    wrap.style.display = 'none';
  }
}

function onAddTestStage2Change() {
  const s2val = document.getElementById('t-stage2').value;
  const newInput = document.getElementById('t-stage2-new');
  if (newInput) {
    if (s2val === '__new__') {
      newInput.style.display = '';
      newInput.focus();
    } else {
      newInput.style.display = 'none';
      newInput.value = '';
    }
  }
}

// ── EDIT TEST modal stage cascade ─────────────────────────────
async function onEditTestStage1Change() {
  const s1sel = document.getElementById('et-stage1');
  const s1id = s1sel.value;
  const wrap = document.getElementById('et-stage23-wrap');
  if (s1id) {
    document.getElementById('et-cat').value = s1sel.options[s1sel.selectedIndex].textContent;
    wrap.style.display = '';
    await _populateStage2ForStage1('et-stage2', parseInt(s1id), null);
    document.getElementById('et-stage3').value = '';
  } else {
    document.getElementById('et-cat').value = '';
    wrap.style.display = 'none';
  }
}

function onEditTestStage2Change() {
  const s2val = document.getElementById('et-stage2').value;
  const newInput = document.getElementById('et-stage2-new');
  if (newInput) {
    if (s2val === '__new__') {
      newInput.style.display = '';
      newInput.focus();
    } else {
      newInput.style.display = 'none';
      newInput.value = '';
    }
  }
}

async function openAddTestModal() {
  ['t-name','t-cat','t-unit','t-min','t-max','t-normal-text','t-desc','t-amount'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  renderRefTableRows('t', []);
  await _populateStage1Dropdown('t-stage1', null);
  document.getElementById('t-stage1').value = '';
  document.getElementById('t-stage23-wrap').style.display = 'none';
  document.getElementById('t-stage3').value = '';
  openModal('add-test-modal');
}

/* ── Constant Reference Table editor (Test Catalog add/edit) ──────────────
   A small repeatable label/value list attached to a test — e.g. HbA1c's
   Non Diabetics / Goal / Good Control / Action Suggested targets — that
   prints as its own boxed table under that test's result row. Stored on
   the test_catalog row as ref_table (a JSON array of {label,value}),
   independent of the normal_min/max/text fields used for high/low flagging. */
function renderRefTableRows(prefix, rows) {
  const wrap = document.getElementById(`${prefix}-reftable-rows`);
  if (!wrap) return;
  wrap.innerHTML = (rows || []).map((r, i) => `
    <div class="reftable-row" style="display:flex;gap:8px;margin-bottom:6px" data-idx="${i}">
      <input type="text" class="form-input reftable-label" placeholder="Label (e.g. Non Diabetics)" value="${escAttr(r.label)}" style="flex:1"/>
      <input type="text" class="form-input reftable-value" placeholder="Value (e.g. 4.0 - 6.0 %)" value="${escAttr(r.value)}" style="flex:1"/>
      <button type="button" class="btn-icon" style="padding:4px" title="Remove row" onclick="this.closest('.reftable-row').remove()">✕</button>
    </div>`).join('');
}

function addRefTableRow(prefix) {
  const wrap = document.getElementById(`${prefix}-reftable-rows`);
  if (!wrap) return;
  const rows = collectRefTableRows(prefix);
  rows.push({ label: '', value: '' });
  renderRefTableRows(prefix, rows);
}

function collectRefTableRows(prefix) {
  const wrap = document.getElementById(`${prefix}-reftable-rows`);
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('.reftable-row')).map(rowEl => ({
    label: rowEl.querySelector('.reftable-label')?.value.trim() || '',
    value: rowEl.querySelector('.reftable-value')?.value.trim() || '',
  })).filter(r => r.label || r.value);
}

async function saveTest() {
  const name = (document.getElementById('t-stage3').value || '').trim();
  if (!name) { toast('Test name required', 'error'); return; }
  document.getElementById('t-name').value = name;

  // ── Capture subcategory name NOW before any dropdown re-renders ──────────
  // Reading it here guarantees we always have the correct value regardless of
  // what _populateStage2ForStage1 does to the dropdown later.
  const s2sel = document.getElementById('t-stage2');
  const s2valEarly = s2sel ? s2sel.value : '';
  let capturedSubCategory = '';
  if (s2valEarly === '__new__') {
    capturedSubCategory = (document.getElementById('t-stage2-new').value || '').trim().toUpperCase();
  } else if (s2valEarly && s2valEarly !== '') {
    const opt = s2sel.options[s2sel.selectedIndex];
    capturedSubCategory = opt ? opt.textContent.trim() : '';
  }

  // Resolve stage1 — create new category if needed
  let s1id = document.getElementById('t-stage1').value;
  if (s1id === '__new__') {
    const newCatName = (document.getElementById('t-stage1-new').value || '').trim().toUpperCase();
    if (!newCatName) { toast('Enter a category name', 'error'); return; }
    const created = await apiFetch(`${API}/stage1`, { method: 'POST', body: JSON.stringify({ name: newCatName }) });
    if (!created || !created.id) { toast('Could not create category', 'error'); return; }
    s1id = String(created.id);
    document.getElementById('t-cat').value = newCatName;
    await buildStageCache();
    await _populateStage1Dropdown('t-stage1', created.id);
    document.getElementById('t-stage1').value = s1id;
    document.getElementById('t-stage1-new').style.display = 'none';
    document.getElementById('t-stage23-wrap').style.display = '';
    // NOTE: this re-renders t-stage2 — but capturedSubCategory was already read above
    await _populateStage2ForStage1('t-stage2', created.id, null);
  }

  const payload = {
    test_name: name,
    category: document.getElementById('t-cat').value,
    sub_category: capturedSubCategory || null,
    unit: document.getElementById('t-unit').value,
    normal_min: document.getElementById('t-min').value || null,
    normal_max: document.getElementById('t-max').value || null,
    normal_text: document.getElementById('t-normal-text').value,
    description: document.getElementById('t-desc').value,
    amount: document.getElementById('t-amount').value || 0,
    ref_table: (() => { const r = collectRefTableRows('t'); return r.length ? JSON.stringify(r) : null; })(),
  };

  const res = await apiFetch(`${API}/tests`, { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    s1id = document.getElementById('t-stage1').value;
    // Re-read s2 value (may have changed after new-category flow above)
    // But we already have capturedSubCategory — use it for stage2 creation too
    let s2id = document.getElementById('t-stage2').value;
    let savedStage2Id = null;
    const s3name = name;

    if (s1id) {
      // Create new subcategory in stages if user typed one
      if (s2valEarly === '__new__' && capturedSubCategory) {
        const createdS2 = await apiFetch(`${API}/stage2`, { method: 'POST',
          body: JSON.stringify({ stage1_id: parseInt(s1id), name: capturedSubCategory }) });
        if (!createdS2 || !createdS2.id) { toast('Could not create subcategory', 'error'); return; }
        s2id = String(createdS2.id);
      }
      // If subcategory was skipped, use/create a bridge stage2
      if (!s2id || s2id === '__new__') s2id = await _getOrCreateBridgeStage2(s1id);
      if (s2id) {
        await buildStageCache();
        const exists = _stageCache.find(e => e.s2id === parseInt(s2id) &&
          e.s3 && e.s3.toLowerCase() === s3name.toLowerCase());
        if (!exists) {
          await apiFetch(`${API}/stage3`, { method: 'POST',
            body: JSON.stringify({ stage2_id: parseInt(s2id), name: s3name }) });
        }
        savedStage2Id = parseInt(s2id);
      }
    }

    await buildStageCache();
    toast('Test added to catalog!', 'success');
    closeModal('add-test-modal');
    ['t-name','t-cat','t-unit','t-min','t-max','t-normal-text','t-desc','t-amount'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('t-stage3').value = '';
    document.getElementById('t-stage1-new').value = '';
    document.getElementById('t-stage1-new').style.display = 'none';
    document.getElementById('t-stage2-new').value = '';
    document.getElementById('t-stage2-new').style.display = 'none';
    document.getElementById('t-stage1').value = '';
    document.getElementById('t-stage23-wrap').style.display = 'none';
    _invalidateCatalogCache();
    loadTests();
    await refreshStageViewsIfOpen(s1id ? parseInt(s1id) : null, savedStage2Id);
  }
}

 
async function deleteTest(id) {
  if (!confirm('Remove this test from catalog?')) return;
  await apiFetch(`${API}/tests/${id}`, { method: 'DELETE' });
  toast('Deleted', 'success');
  loadTests();
  await refreshStageViewsIfOpen();
}
 
/* ── Lab Test Bill ───────────────────────────────────────────── */
let billItems = [];
let currentBillPatient = null;
let _billPatientsCache = [];
let _bpHighlight = -1;
let _reportBillTests = [];
 
 
async function initLabTestPage() {
  console.log('initLabTestPage called');
  
  // Check cache first - if already loaded, don't reload
  if (isPageLoaded('labtest')) {
    console.log('Lab Test page already cached, skipping reload');
    return;
  }
  
  console.log('Lab Test page not cached, performing fresh load...');
  
  // Reset all dropdowns first
  const sel = document.getElementById('bill-patient-select');
  const s1sel = document.getElementById('te-stage1');
  const s2sel = document.getElementById('te-stage2');
  const s3sel = document.getElementById('te-stage3');
  
  if (sel) sel.innerHTML = '<option value="">— Loading Patients... —</option>';
  if (s1sel) s1sel.innerHTML = '<option value="">— Loading Tests... —</option>';
  if (s2sel) s2sel.innerHTML = '<option value="">—</option>';
  if (s3sel) s3sel.innerHTML = '<option value="">—</option>';
  
  // Fetch patients with error handling
  let patients = null;
  try {
    console.log('Fetching patients...');
    patients = await apiFetch(`${API}/patients`);
    console.log('Patients fetched:', patients ? patients.length : 'null');
  } catch (e) {
    console.error('Failed to load patients:', e);
    patients = [];
  }
  
  if (sel) {
    sel.innerHTML = '<option value="">— Select Patient —</option>' +
      (patients || []).map(p => `<option value="${p.id}" data-age="${p.age||''}" data-gender="${p.gender||''}" data-phone="${p.phone||''}" data-greeting="${p.greeting||''}">${p.id} ( Ref No : ${p.id} - ${p.name} )</option>`).join('');
    console.log('Patient dropdown populated with', (patients || []).length, 'patients');
  }
  _billPatientsCache = patients || [];

  // Load Stage 1 for test entry with error handling
  let s1 = null;
  try {
    console.log('Fetching stage1...');
    s1 = await apiFetch(`${API}/stage1`);
    console.log('Stage1 fetched:', s1 ? s1.length : 'null');
  } catch (e) {
    console.error('Failed to load stage1:', e);
    s1 = [];
  }
  
  if (s1sel) {
    s1sel.innerHTML = '<option value="">Select Test</option>' +
      (s1 || []).map(s => `<option value="${s.id}" data-name="${s.name}">${s.name}</option>`).join('');
    console.log('Stage1 dropdown populated with', (s1 || []).length, 'tests');
  }

  // Build full stage cache for quick search
  console.log('Building stage cache...');
  await buildStageCache();

  // Pre-load catalog in background so info strip is instant on first selection
  console.log('Loading catalog...');
  loadCatalogGrouped();

  console.log('Loading saved bills...');
  await loadSavedBills();
  
  // Mark page as cached so we don't reload on next tab switch
  markPageLoaded('labtest', { initialized: true });
  
  console.log('initLabTestPage completed');
}
 
async function searchBillPatient() {
  const sel = document.getElementById('bill-patient-select');
  const pid = sel.value;
  if (!pid) { toast('Select a patient', 'error'); return; }
 
  const opt = sel.options[sel.selectedIndex];
  currentBillPatient = {
    id: pid,
    name: opt.text.split(' - ')[1]?.replace(')', '').trim() || opt.text,
    age: opt.dataset.age,
    gender: opt.dataset.gender,
    phone: opt.dataset.phone,
    greeting: opt.dataset.greeting,
  };
 
  document.getElementById('bpc-name').textContent = prefixedName(currentBillPatient.name, currentBillPatient.gender, currentBillPatient.age, currentBillPatient.greeting);
  document.getElementById('bpc-age').textContent = currentBillPatient.age || '—';
  document.getElementById('bpc-gender').textContent = currentBillPatient.gender || '—';
  document.getElementById('bpc-phone').textContent = currentBillPatient.phone || '0';
  document.getElementById('bpc-refno').textContent = pid;
  document.getElementById('bill-date').value = new Date().toISOString().split('T')[0];

  const searchBox = document.getElementById('bill-patient-search');
  if (searchBox) searchBox.value = `${currentBillPatient.name} (${pid})`;
 
  // Load doctors with error handling
  let doctors = null;
  try {
    doctors = await apiFetch(`${API}/doctors`);
  } catch (e) {
    console.error('Failed to load doctors:', e);
    doctors = [];
  }
  
  document.getElementById('bill-doctor').innerHTML =
    '<option value="">Select Doctor</option>' +
    (doctors || []).map(d => `<option value="${d.id}">${d.name}${d.specialization ? ' — ' + d.specialization : ''}</option>`).join('');
 
  document.getElementById('bill-patient-card').style.display = 'block';
  document.getElementById('bill-test-section').style.display = 'block';
  document.getElementById('bill-footer-section').style.display = 'block';
 
  billItems = [];
  renderBillItems();
  document.getElementById('bill-total').value = '';
  document.getElementById('btn-print-bill').disabled = false;

  loadReportTestsForBill();
}
 
/* ── Patient search (name / phone / ref no) for Lab Test Bill ──── */
function filterBillPatients(q) {
  const box = document.getElementById('bill-patient-results');
  _bpHighlight = -1;
  const term = (q || '').trim().toLowerCase();
  if (!term) { box.style.display = 'none'; return; }

  const hits = _billPatientsCache.filter(p =>
    (p.name || '').toLowerCase().includes(term) ||
    (p.phone || '').toLowerCase().includes(term) ||
    String(p.id).includes(term)
  ).slice(0, 20);

  if (!hits.length) {
    box.innerHTML = `<div style="padding:12px 14px;color:var(--muted);font-size:13px">No patients found for "${q}"</div>`;
    box.style.display = 'block';
    box._hits = null;
    return;
  }

  box.innerHTML = hits.map((p, i) => `
    <div class="bp-item" data-idx="${i}"
      style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border2);display:flex;justify-content:space-between;align-items:center"
      onmouseenter="bpHover(${i})"
      onclick="selectBillPatientFromSearch(${i})">
      <div>
        <div style="font-weight:600;font-size:13px;color:var(--text)">${highlightMatch(p.name || '', q)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px">Ref No: ${p.id}${p.phone ? ' · ' + highlightMatch(p.phone, q) : ''}</div>
      </div>
    </div>
  `).join('');
  box.style.display = 'block';
  box._hits = hits;

  document.addEventListener('click', closeBillPatientSearch, { once: true });
}

function bpHover(i) {
  _bpHighlight = i;
  document.querySelectorAll('.bp-item').forEach((el, idx) => {
    el.style.background = idx === i ? 'var(--surface2)' : '';
  });
}

function billPatientKeyNav(e) {
  const box = document.getElementById('bill-patient-results');
  const items = box.querySelectorAll('.bp-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _bpHighlight = Math.min(_bpHighlight + 1, items.length - 1);
    items.forEach((el, i) => el.style.background = i === _bpHighlight ? 'var(--surface2)' : '');
    items[_bpHighlight]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _bpHighlight = Math.max(_bpHighlight - 1, 0);
    items.forEach((el, i) => el.style.background = i === _bpHighlight ? 'var(--surface2)' : '');
    items[_bpHighlight]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && _bpHighlight >= 0) {
    e.preventDefault();
    selectBillPatientFromSearch(_bpHighlight);
  } else if (e.key === 'Escape') {
    closeBillPatientSearch();
  }
}

function selectBillPatientFromSearch(i) {
  const box = document.getElementById('bill-patient-results');
  const hits = box._hits;
  if (!hits || !hits[i]) return;
  const p = hits[i];

  const sel = document.getElementById('bill-patient-select');
  sel.value = p.id;

  box.style.display = 'none';
  box._hits = null;

  searchBillPatient();
}

function closeBillPatientSearch(e) {
  const box = document.getElementById('bill-patient-results');
  const input = document.getElementById('bill-patient-search');
  if (!box) return;
  if (e && (box.contains(e.target) || input.contains(e.target))) return;
  box.style.display = 'none';
}

/* ── Tests pulled from saved reports for the selected patient/date ──── */
async function loadReportTestsForBill() {
  const section = document.getElementById('bill-report-tests-section');
  const list = document.getElementById('bill-report-tests-list');
  if (!currentBillPatient || !section || !list) return;

  const date = document.getElementById('bill-date').value;
  if (!date) { section.style.display = 'none'; return; }

  let data = [];
  try {
    data = await apiFetch(`${API}/reports/tests-for-bill?patient_id=${currentBillPatient.id}&date=${date}`);
  } catch (e) {
    console.error('Failed to load report tests:', e);
    data = [];
  }

  _reportBillTests = data || [];

  if (!_reportBillTests.length) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = _reportBillTests.map((t, i) => {
    const already = billItems.find(b => b.stage1_name === t.stage1_name && b.stage2_name === t.stage2_name && b.stage3_name === t.stage3_name);
    return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--surface2,#1e293b);border:1px solid var(--border);border-radius:6px">
      <div>
        <div style="font-weight:600;font-size:13px;color:var(--text)">${t.test_name}</div>
        <div style="font-size:12px;color:#16a34a;font-weight:600;margin-top:1px">₹${(t.rate || 0).toFixed(2)}</div>
      </div>
      <button class="btn btn-sm ${already ? 'btn-outline' : 'btn-primary'}" ${already ? 'disabled' : ''} onclick="addReportTestToBill(${i})">${already ? '✓ Added' : '+ Add'}</button>
    </div>`;
  }).join('');
}

function addReportTestToBill(i) {
  const t = _reportBillTests[i];
  if (!t) return;

  if (billItems.find(b => b.stage1_name === t.stage1_name && b.stage2_name === t.stage2_name && b.stage3_name === t.stage3_name)) {
    toast('This test is already added', 'error'); return;
  }

  billItems.push({ stage1_name: t.stage1_name, stage2_name: t.stage2_name, stage3_name: t.stage3_name, test_name: t.test_name, rate: t.rate || 0 });
  renderBillItems();
  loadReportTestsForBill();
}

function addAllReportTestsToBill() {
  if (!_reportBillTests.length) return;
  let added = 0;
  _reportBillTests.forEach(t => {
    if (billItems.find(b => b.stage1_name === t.stage1_name && b.stage2_name === t.stage2_name && b.stage3_name === t.stage3_name)) return;
    billItems.push({ stage1_name: t.stage1_name, stage2_name: t.stage2_name, stage3_name: t.stage3_name, test_name: t.test_name, rate: t.rate || 0 });
    added++;
  });
  renderBillItems();
  loadReportTestsForBill();
  if (added) toast(`Added ${added} test(s) from reports`, 'success');
}

async function loadBillStage2() {
  const s1sel = document.getElementById('te-stage1');
  const s1id = s1sel.value;
  const s2sel = document.getElementById('te-stage2');
  const s3sel = document.getElementById('te-stage3');
  s2sel.innerHTML = '<option value="">—</option>';
  s3sel.innerHTML = '<option value="">—</option>';
  document.getElementById('te-rate').value = '';
  const strip = document.getElementById('bill-catalog-info');
  if (strip) strip.style.display = 'none';
  if (!s1id) return;
  
  // Fetch stage2 data with error handling
  let data = null;
  try {
    data = await apiFetch(`${API}/stage2?stage1_id=${s1id}`);
  } catch (e) {
    console.error('Failed to load stage2:', e);
    data = [];
  }
  
  s2sel.innerHTML = '<option value="">— Select —</option>' +
    (data || []).map(s => `<option value="${s.id}" data-name="${s.name}">${s.name}</option>`).join('');
  // Show catalog info for the stage1 test itself (panel-level)
  const s1name = s1sel.options[s1sel.selectedIndex]?.dataset.name || '';
  if (s1name) _showBillCatalogInfo(s1name);
}

async function loadBillStage3() {
  const s2sel = document.getElementById('te-stage2');
  const s2id = s2sel.value;
  const s3sel = document.getElementById('te-stage3');
  s3sel.innerHTML = '<option value="">—</option>';
  document.getElementById('te-rate').value = '';
  if (!s2id) { await autoFillRate(); return; }
  
  // Fetch stage3 data with error handling
  let data = null;
  try {
    data = await apiFetch(`${API}/stage3?stage2_id=${s2id}`);
  } catch (e) {
    console.error('Failed to load stage3:', e);
    data = [];
  }
  
  s3sel.innerHTML = '<option value="">— Select —</option>' +
    (data || []).map(s => `<option value="${s.id}" data-name="${s.name}">${s.name}</option>`).join('');
  await autoFillRate();
}
 
async function autoFillRate() {
  const s1 = document.getElementById('te-stage1');
  const s2 = document.getElementById('te-stage2');
  const s3 = document.getElementById('te-stage3');
  const s1name = s1.options[s1.selectedIndex]?.dataset.name || '';
  const s2name = s2.options[s2.selectedIndex]?.dataset.name || '';
  const s3name = s3.options[s3.selectedIndex]?.dataset.name || '';
  if (!s1name) return;

  // Auto-fill rate from saved test_rates table with error handling
  try {
    const data = await apiFetch(`${API}/test-rate?s1=${encodeURIComponent(s1name)}&s2=${encodeURIComponent(s2name)}&s3=${encodeURIComponent(s3name)}`);
    if (data && data.rate > 0) document.getElementById('te-rate').value = data.rate;
  } catch (e) {
    console.error('Failed to load test rate:', e);
  }

  // Look up catalog info for the most specific test name we have
  const lookupName = s3name || s2name || s1name;
  _showBillCatalogInfo(lookupName);
}
 
async function _showBillCatalogInfo(testName) {
  const strip   = document.getElementById('bill-catalog-info');
  const uEl     = document.getElementById('bci-unit');
  const rEl     = document.getElementById('bci-ref');
  const aEl     = document.getElementById('bci-amount');
  if (!strip) return;

  if (!testName) { strip.style.display = 'none'; return; }

  // Use catalog cache if loaded, else fetch
  let entry = null;
  if (_catalogLoaded && _nrSearchIndex.length) {
    entry = _nrSearchIndex.find(e => e.name && e.name.toUpperCase() === testName.toUpperCase());
  }
  if (!entry) {
    try {
      const d = await fetchTestByNameSilent(`${API}/tests/by-name?name=${encodeURIComponent(testName)}`);
      if (d && d.test_name) {
        entry = {
          unit: d.unit || '',
          ref:  d.normal_text || (d.normal_min != null && d.normal_max != null ? `${d.normal_min} – ${d.normal_max}` : ''),
          amount: d.amount || 0,
        };
      }
    } catch(e) {
      console.error('Failed to load test info:', e);
    }
  }

  if (!entry) { strip.style.display = 'none'; return; }

  uEl.textContent  = entry.unit   ? `Unit: ${entry.unit}` : '';
  rEl.textContent  = entry.ref    ? `Ref: ${entry.ref}`   : '';
  aEl.textContent  = entry.amount ? `Catalog Rate: ₹${entry.amount}` : '';

  // Auto-fill rate from catalog if rate field is empty and catalog has a price
  const rateInp = document.getElementById('te-rate');
  if ((!rateInp.value || parseFloat(rateInp.value) === 0) && entry.amount) {
    rateInp.value = entry.amount;
  }

  strip.style.display = (uEl.textContent || rEl.textContent || aEl.textContent) ? 'flex' : 'none';
}
 
function addBillItem() {
  const s1 = document.getElementById('te-stage1');
  const s2 = document.getElementById('te-stage2');
  const s3 = document.getElementById('te-stage3');
  const rate = parseFloat(document.getElementById('te-rate').value) || 0;
 
  const s1name = s1.options[s1.selectedIndex]?.dataset.name || '';
  const s2name = s2.options[s2.selectedIndex]?.dataset.name || '';
  const s3name = s3.options[s3.selectedIndex]?.dataset.name || '';
 
  if (!s1name) { toast('Select at least a Category', 'error'); return; }
 
  const hasSub = s2name && s2name !== '(General)';
  const testName = hasSub
    ? [s2name, s3name].filter(Boolean).join(' › ')
    : [s1name, s3name].filter(Boolean).join(' › ');
 
  // Prevent duplicate
  if (billItems.find(i => i.stage1_name === s1name && i.stage2_name === s2name && i.stage3_name === s3name)) {
    toast('This test is already added', 'error'); return;
  }
 
  billItems.push({ stage1_name: s1name, stage2_name: s2name, stage3_name: s3name, test_name: testName, rate });
  renderBillItems();
 
  // Reset selects and info strip
  document.getElementById('te-stage1').value = '';
  document.getElementById('te-stage2').innerHTML = '<option value="">—</option>';
  document.getElementById('te-stage3').innerHTML = '<option value="">—</option>';
  document.getElementById('te-rate').value = '';
  const strip = document.getElementById('bill-catalog-info');
  if (strip) strip.style.display = 'none';
}
 
function renderBillItems() {
  const tbody = document.getElementById('bill-items-tbody');
  const total = billItems.reduce((s, i) => s + (i.rate || 0), 0);
  document.getElementById('bill-total').value = total.toFixed(2);
 
  if (!billItems.length) {
    tbody.innerHTML = '<tr id="bill-empty-row"><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No tests added yet</td></tr>';
    return;
  }
  tbody.innerHTML = billItems.map((item, idx) => `
    <tr>
      <td style="text-align:center;font-weight:600">${idx + 1}</td>
      <td><b>${item.test_name}</b></td>
      <td style="font-size:12px;color:var(--muted)">${item.stage1_name}</td>
      <td style="font-size:12px;color:var(--muted)">${(item.stage2_name && item.stage2_name !== '(General)') ? item.stage2_name : '—'}</td>
      <td style="font-size:12px;color:var(--muted)">${item.stage3_name || '—'}</td>
      <td style="text-align:right;font-weight:600;color:var(--success)">₹${(item.rate||0).toFixed(2)}</td>
      <td style="text-align:center">
        <button class="btn btn-sm btn-danger" onclick="removeBillItem(${idx})">✕</button>
      </td>
    </tr>`).join('') + `
    <tr style="background:var(--hover)">
      <td colspan="5" style="text-align:right;font-weight:700;padding:10px 12px">TOTAL</td>
      <td style="text-align:right;font-weight:700;color:var(--primary);font-size:15px">₹${total.toFixed(2)}</td>
      <td></td>
    </tr>`;
}
 
function removeBillItem(idx) {
  billItems.splice(idx, 1);
  renderBillItems();
}
 
async function printBill(bidOverride) {
  if (bidOverride) {
    // Printing from saved bills list — fetch from DB
    const data = await apiFetch(`${API}/bills/${bidOverride}`);
    if (!data) return;
    _renderBillPrint(data.bill, data.items, data.settings, bidOverride);
    return;
  }
 
  // Printing directly from current form — save to DB first
  if (!currentBillPatient) { toast('Select a patient first', 'error'); return; }
  if (!billItems.length) { toast('Add at least one test', 'error'); return; }
 
  const settings = await apiFetch(`${API}/settings`);
  const doctorEl = document.getElementById('bill-doctor');
  const doctorName = doctorEl.options[doctorEl.selectedIndex]?.text || '—';
  const total = billItems.reduce((s, i) => s + (i.rate || 0), 0);
 
  const bill = {
    bill_date: document.getElementById('bill-date').value,
    patient_name: currentBillPatient.name,
    age: currentBillPatient.age,
    gender: currentBillPatient.gender,
    patient_phone: currentBillPatient.phone,
    patient_id: currentBillPatient.id,
    doctor_name: doctorName !== 'Select Doctor' ? doctorName : '—',
    bill_type: document.getElementById('bill-type').value,
    cheque_ref: document.getElementById('bill-cheque').value,
  };
 
  // Auto-save bill to DB so it appears in Saved Bills
  const saved = await apiFetch(`${API}/bills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient_id: currentBillPatient.id,
      doctor_name: bill.doctor_name,
      bill_date: bill.bill_date,
      bill_type: bill.bill_type,
      cheque_ref: bill.cheque_ref,
      total_amount: total,
      items: billItems,
    })
  });
  const newBid = saved?.id || null;
  if (newBid) {
    toast('Bill saved & added to Saved Bills', 'success');
    loadSavedBills();
  }
 
  _renderBillPrint(bill, billItems, settings, newBid);
}
 
function _renderBillPrint(bill, items, settings, bid) {
  const labName = settings.lab_name || 'Diagnostic Lab';
  const labAddr = settings.lab_address || '';
  const labPhone = settings.lab_phone || '';
  const labEmail = settings.lab_email || '';
  const total = items.reduce((s, i) => s + (i.rate || 0), 0);
  const billLabel = bid ? `BIL-${String(bid).padStart(5,'0')}` : new Date().toISOString().slice(0,10).replace(/-/g,'');
 
  const rows = items.map((item, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${item.test_name}</td>
      <td>${item.stage1_name || ''}</td>
      <td>${(item.stage2_name && item.stage2_name !== '(General)') ? item.stage2_name : ''}</td>
      <td>${item.stage3_name || '—'}</td>
      <td style="text-align:right">₹${(item.rate||0).toFixed(2)}</td>
    </tr>`).join('');
 
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head>
    <title>Lab Test Bill — ${billLabel}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, sans-serif; font-size: 13px; color: #111; padding: 20px; }
      .header { text-align: center; border-bottom: 3px double #1a4a7a; padding-bottom: 12px; margin-bottom: 16px; }
      .lab-name { font-size: 22px; font-weight: 700; color: #1a4a7a; }
      .lab-sub { color: #555; font-size: 12px; margin-top: 3px; }
      .bill-title { font-size: 15px; font-weight: 700; color: #0d9488; text-align: center;
                    background: #f0fdf4; padding: 6px; border-radius: 4px; margin-bottom: 12px; letter-spacing: 1px; }
      .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; margin-bottom: 14px;
                   background: #f0f9ff; padding: 10px 14px; border: 1px solid #bfdbfe; border-radius: 6px; }
      .info-row { display: flex; gap: 6px; font-size: 12px; padding: 3px 0; }
      .info-label { font-weight: 700; color: #1a4a7a; min-width: 100px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      thead { background: #1a4a7a; color: white; }
      th { padding: 8px 10px; text-align: left; font-size: 12px; }
      td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; font-size: 12px; }
      tr:nth-child(even) { background: #f9fafb; }
      .total-row { background: #f0fdf4 !important; font-weight: 700; font-size: 14px; }
      .total-row td { border-top: 2px solid #0d9488; padding: 10px; }
      .bill-footer-info { display: flex; justify-content: space-between; font-size: 12px;
                          margin-top: 10px; border-top: 1px dashed #ccc; padding-top: 8px; }
      .footer { text-align: center; margin-top: 20px; font-size: 10px; color: #999;
                border-top: 1px solid #ddd; padding-top: 8px; }
      .sig-area { width: 100%; margin-top: 30px; }
      .eor-area { width: 100%; margin-top: 4px; }
      @media print { body { padding: 10px; } button { display: none; } }
    </style>
  </head><body>
    <div class="header">
      <div class="lab-name">${labName}</div>
      <div class="lab-sub">${labAddr}</div>
      <div class="lab-sub">📞 ${labPhone} &nbsp;|&nbsp; ✉ ${labEmail}</div>
    </div>
    <div class="bill-title">PATIENT TEST BILL</div>
    <div class="info-grid">
      <div class="info-row"><span class="info-label">Bill No:</span> ${billLabel}</div>
      <div class="info-row"><span class="info-label">Date:</span> ${bill.bill_date || ''}</div>
      <div class="info-row"><span class="info-label">Patient Name:</span> ${prefixedName(bill.patient_name, bill.gender, bill.age, bill.greeting)}</div>
      <div class="info-row"><span class="info-label">Age / Gender:</span> ${bill.age || '—'} / ${bill.gender || '—'}</div>
      <div class="info-row"><span class="info-label">Mobile No:</span> ${bill.patient_phone || '0'}</div>
      <div class="info-row"><span class="info-label">Ref No:</span> ${bill.patient_id}</div>
      <div class="info-row"><span class="info-label">Doctor:</span> ${bill.doctor_name || '—'}</div>
      <div class="info-row"><span class="info-label">Bill Type:</span> ${bill.bill_type || 'Cash'}</div>
      ${bill.cheque_ref ? `<div class="info-row"><span class="info-label">Cheque/Ref:</span> ${bill.cheque_ref}</div>` : ''}
    </div>
    <table>
      <thead><tr>
        <th>#</th><th>Test Name</th><th>Category</th><th>Subcategory</th><th>Test Name</th><th style="text-align:right">Rate (₹)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="total-row">
          <td colspan="5" style="text-align:right">TOTAL AMOUNT</td>
          <td style="text-align:right">₹ ${total.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
    <div class="bill-footer-info">
      <div>Amount in Words: <b>${amountInWords(total)}</b></div>
      <div>Payment: <b>${bill.bill_type || 'Cash'}</b></div>
    </div>
    <div class="footer">
      Generated on ${new Date().toLocaleString()} &nbsp;|&nbsp; ${labName} &nbsp;|&nbsp; This is a computer generated bill
    </div>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 500);
}
 
function amountInWords(amount) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  if (amount === 0) return 'Zero Rupees Only';
  const n = Math.floor(amount);
  const fn = (num) => {
    if (num === 0) return '';
    if (num < 20) return ones[num] + ' ';
    if (num < 100) return tens[Math.floor(num/10)] + ' ' + ones[num%10] + ' ';
    return ones[Math.floor(num/100)] + ' Hundred ' + fn(num%100);
  };
  let words = '';
  if (n >= 1000) words += fn(Math.floor(n/1000)) + 'Thousand ';
  words += fn(n % 1000);
  return words.trim() + ' Rupees Only';
}
 
let _savedBillsCache = [];

async function loadSavedBills() {
  let data = null;
  try {
    data = await apiFetch(`${API}/bills`);
  } catch (e) {
    console.error('Failed to load bills:', e);
    data = [];
  }

  _savedBillsCache = data || [];

  const searchBox = document.getElementById('saved-bills-search');
  if (searchBox) searchBox.value = '';

  applySavedBillsFilters();
}

/* Search saved bills by patient name or phone — handy for telling apart
   two patients who share the same name — combined with the From/To date
   range filter above the table. */
function applySavedBillsFilters() {
  const from = (document.getElementById('collections-from') || {}).value || '';
  const to   = (document.getElementById('collections-to')   || {}).value || '';
  const term = ((document.getElementById('saved-bills-search') || {}).value || '').trim().toLowerCase();

  let rows = _savedBillsCache;

  if (from) rows = rows.filter(b => (b.bill_date || '') >= from);
  if (to)   rows = rows.filter(b => (b.bill_date || '') <= to);
  if (term) {
    rows = rows.filter(b =>
      (b.patient_name || '').toLowerCase().includes(term) ||
      (b.patient_phone || '').toLowerCase().includes(term) ||
      String(b.id).includes(term)
    );
  }

  renderSavedBillsTable(rows, term);
  renderSavedBillsSummary(rows);
}

function renderSavedBillsSummary(rows) {
  const panel = document.getElementById('collections-summary');
  if (!panel) return;

  if (!_savedBillsCache.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'flex';

  const total = rows.reduce((s, b) => s + (b.total_amount || 0), 0);
  document.getElementById('collections-total').textContent = `₹${total.toFixed(2)}`;
  document.getElementById('collections-count').textContent = rows.length;

  const byType = {};
  rows.forEach(b => {
    const t = b.bill_type || 'Cash';
    byType[t] = (byType[t] || 0) + (b.total_amount || 0);
  });
  const byTypeEl = document.getElementById('collections-by-type');
  if (byTypeEl) {
    byTypeEl.innerHTML = Object.keys(byType).map(t => `
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">${t}</div>
        <div style="font-size:15px;font-weight:600">₹${byType[t].toFixed(2)}</div>
      </div>`).join('');
  }
}

function setSavedBillsToday() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('collections-from').value = today;
  document.getElementById('collections-to').value = today;
  applySavedBillsFilters();
}

function clearSavedBillsFilter() {
  document.getElementById('collections-from').value = '';
  document.getElementById('collections-to').value = '';
  document.getElementById('saved-bills-search').value = '';
  applySavedBillsFilters();
}

function renderSavedBillsTable(data, highlightTerm) {
  const tbody = document.getElementById('saved-bills-tbody');
  if (!tbody) return;

  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px">No bills found</td></tr>`;
    updateBulkDeleteBillsBtn();
    return;
  }
  tbody.innerHTML = data.map(b => `
    <tr>
      <td style="width:36px;text-align:center"><input type="checkbox" class="bill-checkbox" data-id="${b.id}" onchange="updateBulkDeleteBillsBtn()" style="width:15px;height:15px;cursor:pointer;accent-color:var(--primary)"></td>
      <td style="font-family:monospace;color:var(--muted)">BIL-${String(b.id).padStart(5,'0')}</td>
      <td>
        <b>${highlightTerm ? highlightMatch(prefixedName(b.patient_name, b.gender, b.age, b.greeting), highlightTerm) : prefixedName(b.patient_name, b.gender, b.age, b.greeting)}</b>
        ${b.patient_phone ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">${highlightTerm ? highlightMatch(b.patient_phone, highlightTerm) : b.patient_phone}</div>` : ''}
      </td>
      <td>${b.doctor_name || '—'}</td>
      <td>${b.bill_date || '—'}</td>
      <td style="font-size:12px">${b.bill_type || 'Cash'}</td>
      <td style="text-align:right;font-weight:600;color:var(--success)">₹${(b.total_amount||0).toFixed(2)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-primary" onclick="printBill(${b.id})">🖨 Print</button>
          <button class="btn btn-sm btn-danger" onclick="deleteSavedBill(${b.id})">✕</button>
        </div>
      </td>
    </tr>`).join('');

  const selectAll = document.getElementById('select-all-bills');
  if (selectAll) selectAll.checked = false;
  updateBulkDeleteBillsBtn();
}

function updateBulkDeleteBillsBtn() {
  const checked = document.querySelectorAll('.bill-checkbox:checked');
  const btn = document.getElementById('bulk-delete-bills-btn');
  const countEl = document.getElementById('selected-bills-count');
  const selectAll = document.getElementById('select-all-bills');
  const all = document.querySelectorAll('.bill-checkbox');
  if (btn) btn.style.display = checked.length > 0 ? 'inline-flex' : 'none';
  if (countEl) countEl.textContent = checked.length;
  if (selectAll) selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  if (selectAll && checked.length === all.length && all.length > 0) selectAll.checked = true;
}

function toggleSelectAllBills(el) {
  document.querySelectorAll('.bill-checkbox').forEach(cb => cb.checked = el.checked);
  updateBulkDeleteBillsBtn();
}

async function bulkDeleteSavedBills() {
  const checked = document.querySelectorAll('.bill-checkbox:checked');
  if (!checked.length) return;
  if (!confirm(`Delete ${checked.length} selected bill(s)? This cannot be undone.`)) return;
  const ids = Array.from(checked).map(cb => parseInt(cb.dataset.id));
  let deleted = 0;
  for (const id of ids) {
    const res = await apiFetch(`${API}/bills/${id}`, { method: 'DELETE' });
    if (res !== null) deleted++;
  }
  toast(`${deleted} bill(s) deleted`, 'success');
  loadSavedBills();
}

async function deleteSavedBill(id) {
  if (!confirm('Delete this bill?')) return;
  await apiFetch(`${API}/bills/${id}`, { method: 'DELETE' });
  toast('Bill deleted', 'success');
  loadSavedBills();
}

/* ── Collections report page (amounts collected by date, with
   breakdowns by payment type / doctor / day) ──────────── */
async function loadCollectionsReport() {
  const from = (document.getElementById('coll-from') || {}).value || '';
  const to   = (document.getElementById('coll-to')   || {}).value || '';

  const tbody = document.getElementById('coll-by-day-tbody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:20px">Loading...</td></tr>`;

  let data = { count: 0, total: 0, by_type: [], by_doctor: [], by_day: [] };
  try {
    const params = new URLSearchParams();
    if (from) params.set('from_date', from);
    if (to)   params.set('to_date', to);
    const qs = params.toString();
    data = await apiFetch(`${API}/bills/collections${qs ? '?' + qs : ''}`) || data;
  } catch (e) {
    console.error('Failed to load collections report:', e);
  }

  const count = data.count || 0;
  const total = data.total || 0;
  const avg   = count > 0 ? total / count : 0;

  document.getElementById('coll-total').textContent = `₹${total.toFixed(2)}`;
  document.getElementById('coll-count').textContent = count;
  document.getElementById('coll-avg').textContent   = `₹${avg.toFixed(2)}`;

  const byTypeEl = document.getElementById('coll-by-type');
  if (byTypeEl) {
    const rows = data.by_type || [];
    byTypeEl.innerHTML = rows.length ? rows.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>${r.bill_type || 'Cash'} <span style="color:var(--muted);font-size:12px">(${r.cnt})</span></span>
        <b style="color:#16a34a">₹${(r.total || 0).toFixed(2)}</b>
      </div>`).join('') : `<div style="color:var(--muted);padding:8px 0">No data for this range</div>`;
  }

  const byDoctorEl = document.getElementById('coll-by-doctor');
  if (byDoctorEl) {
    const rows = data.by_doctor || [];
    byDoctorEl.innerHTML = rows.length ? rows.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>${r.doctor_name || 'Not specified'} <span style="color:var(--muted);font-size:12px">(${r.cnt})</span></span>
        <b style="color:#16a34a">₹${(r.total || 0).toFixed(2)}</b>
      </div>`).join('') : `<div style="color:var(--muted);padding:8px 0">No data for this range</div>`;
  }

  const days = data.by_day || [];
  if (tbody) {
    tbody.innerHTML = days.length ? days.map(d => `
      <tr>
        <td>${d.bill_date || '—'}</td>
        <td style="text-align:right">${d.cnt}</td>
        <td style="text-align:right;font-weight:600;color:var(--success)">₹${(d.total || 0).toFixed(2)}</td>
      </tr>`).join('') : `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:20px">No collections found for this range</td></tr>`;
  }
}

function setCollReportRange(range) {
  const fromEl = document.getElementById('coll-from');
  const toEl   = document.getElementById('coll-to');
  const today  = new Date();
  const iso    = d => d.toISOString().slice(0, 10);

  if (range === 'today') {
    fromEl.value = toEl.value = iso(today);
  } else if (range === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    fromEl.value = toEl.value = iso(y);
  } else if (range === 'week') {
    const day = today.getDay(); // 0 = Sunday
    const diffToMonday = (day === 0 ? 6 : day - 1);
    const monday = new Date(today); monday.setDate(monday.getDate() - diffToMonday);
    fromEl.value = iso(monday);
    toEl.value   = iso(today);
  } else if (range === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    fromEl.value = iso(first);
    toEl.value   = iso(today);
  } else { // 'all'
    fromEl.value = '';
    toEl.value   = '';
  }
  loadCollectionsReport();
}

function exportCollectionsReport(fmt) {
  const from = (document.getElementById('coll-from') || {}).value || '';
  const to   = (document.getElementById('coll-to')   || {}).value || '';
  const params = new URLSearchParams();
  if (from) params.set('from_date', from);
  if (to)   params.set('to_date', to);
  const qs = params.toString();
  const a = document.createElement('a');
  a.href = `/api/export/collections/${fmt}${qs ? '?' + qs : ''}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Downloading ${fmt.toUpperCase()}…`, 'success');
}
 
function resetBillForm() {
  currentBillPatient = null;
  billItems = [];
  _reportBillTests = [];
  document.getElementById('bill-patient-select').value = '';
  const searchBox = document.getElementById('bill-patient-search');
  if (searchBox) searchBox.value = '';
  const resultsBox = document.getElementById('bill-patient-results');
  if (resultsBox) resultsBox.style.display = 'none';
  document.getElementById('bill-patient-card').style.display = 'none';
  document.getElementById('bill-report-tests-section').style.display = 'none';
  document.getElementById('bill-test-section').style.display = 'none';
  document.getElementById('bill-footer-section').style.display = 'none';
}
 
/* ── Test Stages ─────────────────────────────────────────────── */
let selectedStage1Id = null;
let selectedStage2Id = null;
let addingStageLevel = 1;
let _pendingStageFocus = null;
 
/* ── Drag-and-drop helpers ──────────────────────────────────── */
let _dragSrc = null;

function _makeDraggable(listEl, reorderUrl) {
  listEl.querySelectorAll('.stage-item[data-id]').forEach(item => {
    item.addEventListener('dragstart', e => {
      _dragSrc = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      listEl.querySelectorAll('.stage-item').forEach(i => i.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      listEl.querySelectorAll('.stage-item').forEach(i => i.classList.remove('drag-over'));
      if (item !== _dragSrc) item.classList.add('drag-over');
    });
    item.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (!_dragSrc || _dragSrc === item) return;
      const items = [...listEl.querySelectorAll('.stage-item[data-id]')];
      const srcIdx = items.indexOf(_dragSrc);
      const tgtIdx = items.indexOf(item);
      if (srcIdx < tgtIdx) item.after(_dragSrc);
      else item.before(_dragSrc);
      item.classList.remove('drag-over');
      const newOrder = [...listEl.querySelectorAll('.stage-item[data-id]')].map(i => +i.dataset.id);
      await apiFetch(reorderUrl, { method: 'PUT', body: JSON.stringify({ ids: newOrder }) });
    });
  });
}

async function loadStage1() {
  selectedStage1Id = null;
  selectedStage2Id = null;
  document.getElementById('stage2-list').innerHTML = '';
  document.getElementById('stage3-list').innerHTML = '';
  document.getElementById('stage2-hint').style.display = 'block';
  document.getElementById('stage3-hint').style.display = 'block';
  document.getElementById('btn-add-s2').disabled = true;
  document.getElementById('btn-add-s3').disabled = true;

  const data = await apiFetch(`${API}/stage1`);
  const list = document.getElementById('stage1-list');
  if (!data || !data.length) {
    list.innerHTML = '<div class="stage-empty">No test types yet</div>';
    return;
  }
  list.innerHTML = data.map(s => `
    <div class="stage-item" id="s1-${s.id}" data-id="${s.id}" draggable="true" onclick="selectStage1(${s.id}, this)">
      <span class="drag-handle" onclick="event.stopPropagation()">⠿</span>
      <span class="stage-item-name">${s.name}</span>
      <span style="display:flex;gap:3px">
        <button class="stage-del" style="background:rgba(59,130,246,.15);color:#3b82f6;border:none" onclick="event.stopPropagation();openEditStage(1,${s.id},'${s.name.replace(/'/g,"\\'")}')" >✏</button>
        <button class="stage-del" onclick="event.stopPropagation();deleteStage(1,${s.id})">✕</button>
      </span>
    </div>`).join('');
  _makeDraggable(list, `${API}/stage1/reorder`);
}

async function refreshStageViewsIfOpen(stage1Id = null, stage2Id = null) {
  const stagesPage = document.getElementById('page-stages');
  if (!stagesPage || !stagesPage.classList.contains('active')) {
    if (stage1Id) {
      _pendingStageFocus = { stage1Id, stage2Id: stage2Id || null };
    }
    return;
  }

  await loadStage1();
  await openStageBranch(stage1Id, stage2Id);
}

async function applyPendingStageFocus() {
  if (!_pendingStageFocus) return;
  const focus = _pendingStageFocus;
  _pendingStageFocus = null;
  await openStageBranch(focus.stage1Id, focus.stage2Id);
}

async function openStageBranch(stage1Id, stage2Id = null) {
  if (!stage1Id) return;

  const s1El = document.querySelector(`#s1-${stage1Id}`);
  if (!s1El) return;

  await selectStage1(stage1Id, s1El);

  if (stage2Id) {
    const s2El = document.querySelector(`#s2-${stage2Id}`);
    if (s2El) {
      await selectStage2(stage2Id, s2El);
    }
  }
}

async function selectStage1(id, el) {
  selectedStage1Id = id;
  selectedStage2Id = null;
  document.querySelectorAll('#stage1-list .stage-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('btn-add-s2').disabled = false;
  document.getElementById('btn-add-s3').disabled = true;
  document.getElementById('stage2-hint').style.display = 'none';
  document.getElementById('stage3-hint').style.display = 'block';
  document.getElementById('stage3-list').innerHTML = '';

  const data = await apiFetch(`${API}/stage2?stage1_id=${id}`);
  const list = document.getElementById('stage2-list');
  if (!data || !data.length) {
    const categoryName = el.querySelector('.stage-item-name')?.textContent?.trim() || '';
    const fallback = categoryName
      ? await apiFetch(`${API}/tests/subcategories?category=${encodeURIComponent(categoryName)}`)
      : [];
    if (fallback && fallback.length) {
      list.innerHTML = fallback.map((name, idx) => `
        <div class="stage-item" data-id="cat-${id}-${idx}" onclick="selectCatalogStage2(this, ${JSON.stringify(categoryName)}, ${JSON.stringify(name)})">
          <span class="drag-handle">⠿</span>
          <span class="stage-item-name">${name}</span>
          <span></span>
        </div>`).join('');
      return;
    }
    list.innerHTML = '<div class="stage-empty">No tests under this type</div>';
    return;
  }
  list.innerHTML = data.map(s => `
    <div class="stage-item" id="s2-${s.id}" data-id="${s.id}" draggable="true" onclick="selectStage2(${s.id}, this)">
      <span class="drag-handle" onclick="event.stopPropagation()">⠿</span>
      <span class="stage-item-name">${s.name}</span>
      <span style="display:flex;gap:3px">
        <button class="stage-del" style="background:rgba(139,92,246,.15);color:#8b5cf6;border:none" onclick="event.stopPropagation();openEditStage(2,${s.id},'${s.name.replace(/'/g,"\\'")}')" >✏</button>
        <button class="stage-del" onclick="event.stopPropagation();deleteStage(2,${s.id})">✕</button>
      </span>
    </div>`).join('');
  _makeDraggable(list, `${API}/stage2/reorder`);
}

async function selectStage2(id, el) {
  selectedStage2Id = id;
  document.querySelectorAll('#stage2-list .stage-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('btn-add-s3').disabled = false;
  document.getElementById('stage3-hint').style.display = 'none';

  const data = await apiFetch(`${API}/stage3?stage2_id=${id}`);
  const list = document.getElementById('stage3-list');
  if (!data || !data.length) {
    const s1El = document.querySelector(`#s1-${selectedStage1Id} .stage-item-name`);
    const categoryName = s1El ? s1El.textContent.trim() : '';
    const subcategoryName = el.querySelector('.stage-item-name')?.textContent?.trim() || '';
    const fallback = (categoryName && subcategoryName)
      ? await apiFetch(`${API}/tests/by-subcategory?category=${encodeURIComponent(categoryName)}&sub_category=${encodeURIComponent(subcategoryName)}`)
      : [];
    if (fallback && fallback.length) {
      list.innerHTML = fallback.map(name => `
        <div class="stage-item" data-id="cat-${id}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}">
          <span class="drag-handle">⠿</span>
          <span class="stage-item-name">${name}</span>
          <span></span>
        </div>`).join('');
      return;
    }
    list.innerHTML = '<div class="stage-empty">No sub-parameters yet</div>';
    return;
  }
  list.innerHTML = data.map(s => `
    <div class="stage-item" id="s3-${s.id}" data-id="${s.id}" draggable="true">
      <span class="drag-handle">⠿</span>
      <span class="stage-item-name">${s.name}</span>
      <span style="display:flex;gap:3px">
        <button class="stage-del" style="background:rgba(16,185,129,.15);color:#10b981;border:none" onclick="openEditStage(3,${s.id},'${s.name.replace(/'/g,"\\'")}')" >✏</button>
        <button class="stage-del" onclick="deleteStage(3,${s.id})">✕</button>
      </span>
    </div>`).join('');
  _makeDraggable(list, `${API}/stage3/reorder`);
}

async function selectCatalogStage2(el, categoryName, subcategoryName) {
  selectedStage2Id = null;
  document.querySelectorAll('#stage2-list .stage-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('stage3-hint').style.display = 'none';
  const list = document.getElementById('stage3-list');
  const data = categoryName && subcategoryName
    ? await apiFetch(`${API}/tests/by-subcategory?category=${encodeURIComponent(categoryName)}&sub_category=${encodeURIComponent(subcategoryName)}`)
    : [];
  if (!data || !data.length) {
    list.innerHTML = '<div class="stage-empty">No sub-parameters yet</div>';
    return;
  }
  list.innerHTML = data.map(name => `
    <div class="stage-item">
      <span class="drag-handle">⠿</span>
      <span class="stage-item-name">${name}</span>
      <span></span>
    </div>`).join('');
}


// Catalog-only stage modal state
let _smCatalogItems = [];
let _smExistingNames = new Set();
let _smSelectedName = null;

async function openAddStage(level) {
  addingStageLevel = level;
  const titles = { 1: 'Add Category', 2: 'Add Subcategory', 3: 'Add Test Name' };
  const labels = { 1: 'Select Category from Catalog', 2: 'Select Subcategory from Catalog', 3: 'Select Test Name from Catalog' };
  document.getElementById('stage-modal-title').textContent = titles[level];
  document.getElementById('stage-modal-label').textContent = labels[level];
  document.getElementById('stage-new-name').value = '';

  _smCatalogItems = [];
  _smExistingNames = new Set();
  _smSelectedName = null;

  // Reset selection UI
  const selWrap = document.getElementById('stage-modal-selected-wrap');
  selWrap.style.display = 'none';
  const saveBtn = document.getElementById('stage-modal-save-btn');
  saveBtn.disabled = true;

  const info = document.getElementById('stage-modal-parent-info');

  const list = document.getElementById('stage-modal-catalog-list');
  list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:13px">Loading…</div>';

  if (level === 1) {
    info.textContent = '';
    await _loadStage1CatalogSuggestions();
  } else if (level === 2 && selectedStage1Id) {
    const el = document.querySelector(`#s1-${selectedStage1Id} .stage-item-name`);
    info.textContent = `Under: ${el ? el.textContent : ''}`;
    await _loadStage2CatalogSuggestions();
  } else if (level === 3 && selectedStage2Id) {
    const el = document.querySelector(`#s2-${selectedStage2Id} .stage-item-name`);
    info.textContent = `Under: ${el ? el.textContent : ''}`;
    await _loadStage3CatalogSuggestions();
  } else {
    list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:13px">Please select a parent stage first.</div>';
  }

  openModal('stage-modal');
  setTimeout(() => document.getElementById('stage-new-name').focus(), 100);
}

async function _loadStage1CatalogSuggestions() {
  try {
    const [catalog, s1all] = await Promise.all([
      apiFetch(`${API}/tests`),
      apiFetch(`${API}/stage1`),
    ]);
    _smExistingNames = new Set((s1all || []).map(s => s.name.trim().toLowerCase()));
    const cats = [...new Set((catalog || []).map(t => t.category).filter(Boolean))].sort();
    _smCatalogItems = cats.map(c => ({ name: c }));
    renderStageModalCatalog('');
  } catch(e) {
    document.getElementById('stage-modal-catalog-list').innerHTML =
      '<div style="padding:14px;text-align:center;color:#ef4444;font-size:13px">Failed to load catalog.</div>';
  }
}

async function _loadStage2CatalogSuggestions() {
  try {
    const [s1all, s2all] = await Promise.all([
      apiFetch(`${API}/stage1`),
      apiFetch(`${API}/stage2`),
    ]);
    const s1row = (s1all || []).find(s => s.id === selectedStage1Id);
    const s1Name = s1row ? s1row.name.trim().toUpperCase() : null;
    _smExistingNames = new Set(
      (s2all || []).filter(s => s.stage1_id === selectedStage1Id).map(s => s.name.trim().toLowerCase())
    );
    const subcats = s1Name
      ? await apiFetch(`${API}/tests/subcategories?category=${encodeURIComponent(s1Name)}`)
      : await apiFetch(`${API}/tests/subcategories`);
    _smCatalogItems = (subcats || []).map(name => ({ name }));
    renderStageModalCatalog('');
  } catch(e) {
    document.getElementById('stage-modal-catalog-list').innerHTML =
      '<div style="padding:14px;text-align:center;color:#ef4444;font-size:13px">Failed to load catalog.</div>';
  }
}

async function _loadStage3CatalogSuggestions() {
  try {
    const [s1all, s2all, s3all] = await Promise.all([
      apiFetch(`${API}/stage1`),
      apiFetch(`${API}/stage2`),
      apiFetch(`${API}/stage3`),
    ]);
    let s1Name = null, s2Name = null;
    if (selectedStage2Id) {
      const s2row = (s2all || []).find(s => s.id === selectedStage2Id);
      if (s2row) {
        s2Name = s2row.name.trim().toUpperCase();
        const s1row = (s1all || []).find(s => s.id === s2row.stage1_id);
        if (s1row) s1Name = s1row.name.trim().toUpperCase();
      }
    } else if (selectedStage1Id) {
      const s1row = (s1all || []).find(s => s.id === selectedStage1Id);
      if (s1row) s1Name = s1row.name.trim().toUpperCase();
    }
    _smExistingNames = new Set(
      (s3all || []).filter(s => !selectedStage2Id || s.stage2_id === selectedStage2Id).map(s => s.name.trim().toLowerCase())
    );
    let url = `${API}/tests/by-subcategory`;
    const params = [];
    if (s1Name) params.push(`category=${encodeURIComponent(s1Name)}`);
    if (s2Name) params.push(`sub_category=${encodeURIComponent(s2Name)}`);
    if (params.length) url += '?' + params.join('&');
    const testNames = await apiFetch(url);
    _smCatalogItems = (testNames || []).map(name => ({ name }));
    renderStageModalCatalog('');
  } catch(e) {
    document.getElementById('stage-modal-catalog-list').innerHTML =
      '<div style="padding:14px;text-align:center;color:#ef4444;font-size:13px">Failed to load catalog.</div>';
  }
}

function filterStageModalCatalog() {
  renderStageModalCatalog(document.getElementById('stage-new-name').value.trim());
}

function renderStageModalCatalog(q) {
  const list = document.getElementById('stage-modal-catalog-list');
  const ql = q.toLowerCase();
  const available = _smCatalogItems.filter(i => !_smExistingNames.has(i.name.trim().toLowerCase()));
  let items = ql ? available.filter(i => i.name.toLowerCase().includes(ql)) : available;

  if (!_smCatalogItems.length) {
    list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:13px">No entries available in the test catalog for this level.</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = `<div style="padding:14px;text-align:center;color:var(--muted);font-size:13px">${q ? 'No matches found.' : 'All catalog entries have already been added.'}</div>`;
    return;
  }
  list.innerHTML = items.map(i => {
    const isSelected = _smSelectedName && _smSelectedName.trim().toLowerCase() === i.name.trim().toLowerCase();
    const esc = i.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return `<div onclick="pickStageModalCatalog('${esc}')"
      style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
             border-bottom:1px solid var(--border);cursor:pointer;
             background:${isSelected ? 'var(--bg-tertiary,#f0fdf4)' : ''};
             transition:background .12s"
      onmouseenter="this.style.background='var(--bg-tertiary,#f1f5f9)'" onmouseleave="this.style.background='${isSelected ? 'var(--bg-tertiary,#f0fdf4)' : ''}'">
      <span style="font-size:13px">${i.name}</span>
      ${isSelected ? '<span style="font-size:12px;color:#16a34a;font-weight:700">✓</span>' : ''}
    </div>`;
  }).join('');
}

function pickStageModalCatalog(name) {
  _smSelectedName = name;
  document.getElementById('stage-new-name').value = name;
  document.getElementById('stage-modal-selected-label').textContent = name;
  document.getElementById('stage-modal-selected-wrap').style.display = 'block';
  document.getElementById('stage-modal-save-btn').disabled = false;
  renderStageModalCatalog(document.getElementById('stage-new-name').value.trim());
}
 
async function saveStageItem() {
  const name = _smSelectedName ? _smSelectedName.trim() : '';
  if (!name) { toast('Please select an item from the catalog list', 'error'); return; }

  let url, payload;
  if (addingStageLevel === 1) {
    url = `${API}/stage1`; payload = { name };
  } else if (addingStageLevel === 2) {
    if (!selectedStage1Id) { toast('Select a Category first', 'error'); return; }
    url = `${API}/stage2`; payload = { stage1_id: selectedStage1Id, name };
  } else {
    if (!selectedStage2Id) { toast('Select a Subcategory first', 'error'); return; }
    url = `${API}/stage3`; payload = { stage2_id: selectedStage2Id, name };
  }

  const res = await apiFetch(url, { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    toast('Added!', 'success');
    closeModal('stage-modal');
    await buildStageCache();
    if (addingStageLevel === 1) loadStage1();
    else if (addingStageLevel === 2) {
      const el = document.querySelector(`#s1-${selectedStage1Id}`);
      if (el) selectStage1(selectedStage1Id, el);
    } else {
      const el = document.querySelector(`#s2-${selectedStage2Id}`);
      if (el) selectStage2(selectedStage2Id, el);
    }
  }
}
 
async function deleteStage(level, id) {
  if (!confirm('Delete this item? This may affect linked items.')) return;
  const urls = { 1: `${API}/stage1/${id}`, 2: `${API}/stage2/${id}`, 3: `${API}/stage3/${id}` };
  await apiFetch(urls[level], { method: 'DELETE' });
  toast('Deleted', 'success');
  if (level === 1) loadStage1();
  else if (level === 2 && selectedStage1Id) {
    const el = document.querySelector(`#s1-${selectedStage1Id}`);
    if (el) selectStage1(selectedStage1Id, el);
  } else if (level === 3 && selectedStage2Id) {
    const el = document.querySelector(`#s2-${selectedStage2Id}`);
    if (el) selectStage2(selectedStage2Id, el);
  }
}
 
// Allow Enter key to save in stage modal
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('stage-modal').classList.contains('open')) {
    saveStageItem();
  }
});
 
/* ── Init ────────────────────────────────────────────────────── */
loadDashboard();
 
/* ═══════════════════════════════════════════════════════════════
   NEW TEST REPORT — Entry Form + Print
═══════════════════════════════════════════════════════════════ */
 
/* ── Predefined test templates per section ── */
// ── DYNAMIC CATALOG (replaces hardcoded NR_TEMPLATES) ─────────────────────
// _catalogGrouped  : [{category, tests:[{name,unit,ref,ref_m,ref_f,interpretation,amount}]}]
// NR_TEMPLATES     : kept as a live object rebuilt from catalog on each modal open
let _catalogGrouped  = [];   // raw API response
let _catalogLoaded   = false;
let _catalogLoading  = null; // promise guard
// Search index vars declared here (also referenced in buildNrSearchIndex below)
let _nrSearchIndex   = [];
let _nrIndexBuilt    = false;
 
async function loadCatalogGrouped() {
  if (_catalogLoaded) return _catalogGrouped;
  if (_catalogLoading) return _catalogLoading;
  _catalogLoading = apiFetch(`${API}/tests/catalog-grouped`).then(data => {
    _catalogGrouped = data || [];
    _catalogLoaded  = true;
    _catalogLoading = null;
    _buildNrTemplatesFromCatalog();
    return _catalogGrouped;
  });
  return _catalogLoading;
}
 
/** Call this after any test catalog mutation so the next modal open re-fetches. */
function _invalidateCatalogCache() {
  _catalogLoaded  = false;
  _catalogLoading = null;
  _catalogGrouped = [];
  _nrIndexBuilt   = false;
  _nrSearchIndex  = [];
}
 
/** Convert catalog grouped data into the NR_TEMPLATES shape so all existing
 *  section-rendering code keeps working without changes. */
function _buildNrTemplatesFromCatalog() {
  // Clear old entries (keep CUSTOM)
  for (const k of Object.keys(NR_TEMPLATES)) {
    if (k !== 'CUSTOM') delete NR_TEMPLATES[k];
  }
  _catalogGrouped.forEach(({ category, tests }) => {
    // Each category becomes one "group" inside that section
    NR_TEMPLATES[category] = [
      {
        group: category,
        rows: tests.map(t => ({
          name:   t.name,
          unit:   t.unit  || '',
          ref:    t.ref   || '',
          ref_m:  t.ref_m || '',
          ref_f:  t.ref_f || '',
          _interpretation: t.interpretation || '',
        })),
      }
    ];
  });
}
 
// Seed with a minimal placeholder so the object exists immediately
const NR_TEMPLATES = {
  'BIO-CHEMISTRY': [
    { group: 'RANDOM BLOOD SUGAR',    rows: [{ name: 'Random Blood Sugar', unit: 'mg/dl', ref: '80 - 130' }] },
    { group: 'RENAL FUNCTION TEST',   rows: [
        { name: 'Urea',        unit: 'mg/dl', ref: '10 - 40' },
        { name: 'Creatinine',  unit: 'mg/dl', ref: '1.0 - 1.3' },
        { name: 'Uric Acid',   unit: 'mg%',   ref: '2.7 - 6.5' },
    ]},
    { group: 'LIVER FUNCTION TEST',   rows: [
        { name: 'Total Bilirubin',     unit: 'mg/dl', ref: '0.2 - 1.2' },
        { name: 'Direct Bilirubin',    unit: 'mg/dl', ref: '0.0 - 0.3' },
        { name: 'SGOT (AST)',          unit: 'U/L',   ref: '10 - 40' },
        { name: 'SGPT (ALT)',          unit: 'U/L',   ref: '7 - 56' },
        { name: 'Alkaline Phosphatase',unit: 'U/L',   ref: '44 - 147' },
        { name: 'Total Protein',       unit: 'g/dl',  ref: '6.3 - 8.2' },
        { name: 'Albumin',             unit: 'g/dl',  ref: '3.5 - 5.0' },
    ]},
    { group: 'LIPID PROFILE',         rows: [
        { name: 'Total Cholesterol',   unit: 'mg/dl', ref: '< 200' },
        { name: 'Triglycerides',       unit: 'mg/dl', ref: '< 150' },
        { name: 'HDL Cholesterol',     unit: 'mg/dl', ref: '> 40' },
        { name: 'LDL Cholesterol',     unit: 'mg/dl', ref: '< 100' },
        { name: 'VLDL Cholesterol',    unit: 'mg/dl', ref: '< 30' },
    ]},
    { group: 'BLOOD SUGAR FASTING',   rows: [{ name: 'Blood Sugar Fasting', unit: 'mg/dl', ref: '70 - 100' }] },
    { group: 'BLOOD SUGAR PP',        rows: [{ name: 'Blood Sugar PP',      unit: 'mg/dl', ref: '< 140' }] },
    { group: 'HbA1c',                 rows: [{ name: 'HbA1c',              unit: '%',     ref: '< 5.7' }] },
  ],
  'HAEMATOLOGY': [
    { group: 'COMPLETE BLOOD COUNT', rows: [
        { name: 'Haemoglobin',          unit: 'gms%',        ref: '12 - 14.5' },
        { name: 'Red Blood Cells (RBC)',unit: 'millions/cumm',ref: '4.3 - 5.8' },
        { name: 'Total WBC Count',      unit: 'Cells/cumm',  ref: '4000 - 11000' },
        { name: '— Neutrophil',         unit: '%',           ref: '40 - 70' },
        { name: '— Lymphocytes',        unit: '%',           ref: '20 - 40' },
        { name: '— Eosinophil',         unit: '%',           ref: '0 - 8' },
        { name: '— Monocyte',           unit: '%',           ref: '0 - 2' },
        { name: '— Basophil',           unit: '%',           ref: '0 - 1' },
        { name: 'Platelet Count',        unit: 'Lakhs/Cumm', ref: '1.5 - 4.0' },
        { name: 'Packet Cell Value (PCV)',unit: '%',          ref: '40 - 54' },
    ]},
    { group: 'ESR', rows: [{ name: 'ESR', unit: 'mm/hr', ref: '0 - 20' }] },
  ],
  'HORMONES': [
    { group: 'THYROID FUNCTION TEST', rows: [
        { name: 'TSH',     unit: 'µIU/mL', ref: '0.4 - 4.0' },
        { name: 'T3',      unit: 'ng/dL',  ref: '80 - 200' },
        { name: 'T4',      unit: 'µg/dL',  ref: '5.0 - 12.0' },
    ]},
    { group: 'FSH',        rows: [{ name: 'FSH',      unit: 'mIU/mL', ref: '3.5 - 12.5' }] },
    { group: 'LH',         rows: [{ name: 'LH',       unit: 'mIU/mL', ref: '2.4 - 12.6' }] },
    { group: 'PROLACTIN',  rows: [{ name: 'Prolactin',unit: 'ng/mL',  ref: '2.8 - 29.2' }] },
  ],
  'SEROLOGY': [
    { group: 'WIDAL',         rows: [
        { name: 'Salmonella Typhi O',  unit: 'Titre', ref: '< 1:80' },
        { name: 'Salmonella Typhi H',  unit: 'Titre', ref: '< 1:80' },
    ]},
    { group: 'DENGUE TEST',   rows: [
        { name: 'Dengue NS1 Antigen',  unit: '', ref: 'Negative' },
        { name: 'Dengue IgM',          unit: '', ref: 'Negative' },
        { name: 'Dengue IgG',          unit: '', ref: 'Negative' },
    ]},
    { group: 'CRP',           rows: [{ name: 'C-Reactive Protein', unit: 'mg/L', ref: '< 6.0' }] },
    { group: 'HBsAg',         rows: [{ name: 'HBsAg',              unit: '',     ref: 'Non Reactive' }] },
    { group: 'HIV 1 & 2',     rows: [{ name: 'HIV 1 & 2',          unit: '',     ref: 'Non Reactive' }] },
  ],
  'CLINICAL PATHOLOGY': [
    { group: 'URINE EXAMINATION', rows: [
        { name: 'Colour',           unit: '',      ref: 'Pale Yellow' },
        { name: 'Appearance',       unit: '',      ref: 'Clear' },
        { name: 'Reaction (pH)',    unit: '',      ref: '4.5 - 8.0' },
        { name: 'Specific Gravity', unit: '',      ref: '1.005 - 1.030' },
        { name: 'Protein',          unit: '',      ref: 'Nil' },
        { name: 'Sugar',            unit: '',      ref: 'Nil' },
        { name: 'Ketone',           unit: '',      ref: 'Negative' },
        { name: 'Blood',            unit: '',      ref: 'Negative' },
        { name: 'Bilirubin',        unit: '',      ref: 'Negative' },
        { name: 'Urobilinogen',     unit: '',      ref: 'Normal' },
        { name: 'Nitrite',          unit: '',      ref: 'Negative' },
        { name: 'Leucocyte',        unit: '',      ref: 'Negative' },
    ]},
    { group: 'MICROSCOPICAL EXAMINATION', rows: [
        { name: 'Pus Cells',        unit: 'Cells/HPF', ref: '0 - 5' },
        { name: 'RBC',              unit: 'Cells/HPF', ref: 'Nil' },
        { name: 'Epithelial Cells', unit: '',      ref: 'Few' },
        { name: 'Casts',            unit: '',      ref: 'Nil' },
        { name: 'Crystals',         unit: '',      ref: 'Nil' },
        { name: 'Bacteria',         unit: '',      ref: 'Nil' },
    ]},
  ],
  'MOTION EXAMINATION': [
    { group: 'MOTION EXAMINATION', rows: [
        { name: 'Colour',           unit: '',      ref: 'Brown' },
        { name: 'Consistency',      unit: '',      ref: 'Formed' },
        { name: 'Reaction',         unit: '',      ref: 'Neutral' },
        { name: 'Occult Blood',     unit: '',      ref: 'Negative' },
        { name: 'Mucus',            unit: '',      ref: 'Nil' },
        { name: 'Pus Cells',        unit: 'HPF',   ref: 'Nil' },
        { name: 'RBC',              unit: 'HPF',   ref: 'Nil' },
        { name: 'Cysts',            unit: '',      ref: 'Not Seen' },
        { name: 'Ova / Parasite',   unit: '',      ref: 'Not Seen' },
    ]},
  ],
  'MICROBIOLOGY': [
    { group: 'CULTURE & SENSITIVITY', rows: [
        { name: 'Organism',         unit: '',      ref: 'No Growth' },
        { name: 'Colony Count',     unit: 'CFU/mL',ref: '' },
        { name: 'Sensitivity',      unit: '',      ref: '' },
        { name: 'Resistance',       unit: '',      ref: '' },
    ]},
  ],
  'ENDOCRINOLOGY': [
    { group: 'ENDOCRINOLOGY', rows: [
        { name: 'Insulin Fasting',        unit: 'µIU/mL', ref: '2.6 - 24.9' },
        { name: 'Cortisol (AM)',          unit: 'µg/dL',  ref: '6.2 - 19.4' },
        { name: 'Parathyroid Hormone',    unit: 'pg/mL',  ref: '15 - 65' },
    ]},
  ],
  'CUSTOM': [
    { group: '', rows: [{ name: '', unit: '', ref: '' }] }
  ]
};
 
let nrSections = [];   // tracks added sections
let nrSectionIdx = 0;
let nrStep = 1;         // 1 = select tests, 2 = enter results

// 'subcategory' (default) = quick-search stage-2 pick adds only that subcategory.
// 'category' = quick-search stage-2 pick adds the whole parent category instead.
let _nrSubcategoryMode = 'subcategory';
async function _loadNrSubcategoryMode() {
  try {
    const data = await apiFetch(`${API}/settings`);
    _nrSubcategoryMode = (data && data.nr_subcategory_mode) || 'subcategory';
  } catch (e) { /* keep previous/default value */ }
}
 
let _nrPatientMode = 'list'; // 'list' or 'manual'
let _nrDoctorMode  = 'list'; // 'list' or 'manual'
 
// ── Reference Lab override ────────────────────────────────────────────────
let _nrRefLabRanges = {};   // { testName.toUpperCase() -> {ref_m, ref_f, ref_c, unit} }
let _nrRefLabId     = '';   // currently selected other-lab id
 
async function nrLoadOtherLabs() {
  const labs = await apiFetch(`${API}/other-labs`) || [];
  const sel = document.getElementById('nr-ref-lab');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Use default ranges —</option>';
  labs.forEach(l => {
    sel.innerHTML += `<option value="${l.id}">${l.name}</option>`;
  });
}
 
async function nrOnRefLabChange() {
  const sel   = document.getElementById('nr-ref-lab');
  const badge = document.getElementById('nr-ref-lab-badge');
  const lid   = sel.value;
  _nrRefLabId = lid;
  _nrRefLabRanges = {};
 
  if (!lid) {
    badge.style.display = 'none';
    _nrApplyRefLabToAllSections();
    return;
  }
 
  const ranges = await apiFetch(`${API}/other-lab-ranges?lab_id=${lid}`) || [];
  ranges.forEach(r => {
    _nrRefLabRanges[r.test_name.toUpperCase()] = {
      ref_m:  _buildRefStr(r.normal_min_m, r.normal_max_m, r.normal_text_m),
      ref_f:  _buildRefStr(r.normal_min_f, r.normal_max_f, r.normal_text_f),
      ref_c:  _buildRefStr(r.normal_min_c, r.normal_max_c, r.normal_text_c),
      unit:   r.unit || '',
    };
  });
 
  const labName = sel.options[sel.selectedIndex].text;
  badge.textContent = `📋 ${ranges.length} ranges loaded`;
  badge.style.display = '';
 
  _nrApplyRefLabToAllSections();
}
 
function _buildRefStr(mn, mx, txt) {
  if (txt) return txt;
  if (mn != null && mx != null) return `${mn} - ${mx}`;
  if (mn != null) return `> ${mn}`;
  if (mx != null) return `< ${mx}`;
  return '';
}
 
function _nrGetRefForRow(testName, gender) {
  if (!testName) return null;
  const key = testName.toUpperCase();
  const r = _nrRefLabRanges[key];
  if (!r) return null;
  if (gender === 'Male'   && r.ref_m) return { ref: r.ref_m, unit: r.unit };
  if (gender === 'Female' && r.ref_f) return { ref: r.ref_f, unit: r.unit };
  if (gender === 'Child'  && r.ref_c) return { ref: r.ref_c, unit: r.unit };
  // Fallback: pick any non-empty
  return { ref: r.ref_m || r.ref_f || r.ref_c || '', unit: r.unit };
}
 
function _nrApplyRefLabToAllSections() {
  if (!nrSections.length) return;
  const gender = _nrGetCurrentGender();
  nrSections.forEach(sec => {
    sec.groups.forEach(grp => {
      grp.rows.forEach(row => {
        if (!row.name) return;
        if (_nrRefLabId) {
          const override = _nrGetRefForRow(row.name, gender);
          if (override) {
            row.ref  = override.ref;
            if (override.unit) row.unit = override.unit;
          }
        } else {
          // Revert to catalog defaults
          const entry = _nrSearchIndex.find(e => e.name === row.name);
          if (entry) {
            if (entry.ref) row.ref = entry.ref;
            if (!row.unit && entry.unit) row.unit = entry.unit;
          }
        }
      });
    });
  });
  renderNrSections();
}
 
function _nrGetCurrentGender() {
  if (_nrPatientMode === 'manual') {
    return document.getElementById('nr-manual-gender')?.value || '';
  }
  const patSel = document.getElementById('nr-patient');
  return patSel?.options[patSel.selectedIndex]?.dataset.gender || '';
}
 
/** Build a row object, applying ref-lab or catalog ref ranges automatically */
function _nrRowWithRef(name, unit, ref, gender) {
  let resolvedRef  = ref;
  let resolvedUnit = unit;
  let resolvedInterp = '';
 
  if (_nrRefLabId) {
    const override = _nrGetRefForRow(name, gender);
    if (override) {
      resolvedRef  = override.ref;
      if (override.unit) resolvedUnit = override.unit;
    }
  } else {
    // Fall back to catalog
    const entry = _nrSearchIndex.find(e => e.name === name);
    if (entry) {
      if (entry.ref) resolvedRef = entry.ref;
      if (!resolvedUnit && entry.unit) resolvedUnit = entry.unit;
      if (entry._interpretation) resolvedInterp = entry._interpretation;
    }
  }
  return { name, unit: resolvedUnit, ref: resolvedRef, result: '', _interpretation: resolvedInterp };
}
 
function nrSetPatientMode(mode) {
  _nrPatientMode = mode;
  const listDiv   = document.getElementById('nr-list-mode');
  const manualDiv = document.getElementById('nr-manual-mode');
  const btnList   = document.getElementById('nr-toggle-list');
  const btnManual = document.getElementById('nr-toggle-manual');
  const docToggleBtns = document.getElementById('nr-doc-toggle-btns');
 
  if (mode === 'manual') {
    listDiv.style.display   = 'none';
    manualDiv.style.display = '';
    btnManual.style.background = 'var(--primary)';
    btnManual.style.color      = '#fff';
    btnList.style.background   = 'var(--bg)';
    btnList.style.color        = 'var(--muted)';
    // Show doctor toggle buttons in manual patient mode
    if (docToggleBtns) docToggleBtns.style.display = 'flex';
  } else {
    listDiv.style.display   = '';
    manualDiv.style.display = 'none';
    btnList.style.background   = 'var(--primary)';
    btnList.style.color        = '#fff';
    btnManual.style.background = 'var(--bg)';
    btnManual.style.color      = 'var(--muted)';
    // In "From Patient List" mode: force doctor to dropdown only, hide toggle
    if (docToggleBtns) docToggleBtns.style.display = 'none';
    nrSetDoctorMode('list');
  }
}
 
function nrSetDoctorMode(mode) {
  _nrDoctorMode = mode;
  const listDiv   = document.getElementById('nr-doc-list-mode');
  const manualDiv = document.getElementById('nr-doc-manual-mode');
  const btnList   = document.getElementById('nr-doc-toggle-list');
  const btnManual = document.getElementById('nr-doc-toggle-manual');
 
  if (mode === 'manual') {
    listDiv.style.display   = 'none';
    manualDiv.style.display = '';
    btnManual.style.background = 'var(--primary)';
    btnManual.style.color      = '#fff';
    btnList.style.background   = 'var(--bg)';
    btnList.style.color        = 'var(--muted)';
  } else {
    listDiv.style.display   = '';
    manualDiv.style.display = 'none';
    btnList.style.background   = 'var(--primary)';
    btnList.style.color        = '#fff';
    btnManual.style.background = 'var(--bg)';
    btnManual.style.color      = 'var(--muted)';
  }
}
 
function openNewTestReport() {
  nrSections = [];
  nrSectionIdx = 0;
  nrStep = 1;
  applyNrStepVisibility();
  _loadNrSubcategoryMode();
  document.getElementById('nr-sections').innerHTML = '';
  _nrPatientMode = 'list';
  nrSetPatientMode('list');
  _nrDoctorMode = 'list';
  nrSetDoctorMode('list');
 
  // Reset manual fields
  ['nr-manual-name','nr-manual-age','nr-manual-phone','nr-manual-address','nr-manual-greeting'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const gsel = document.getElementById('nr-manual-gender'); if (gsel) gsel.value = '';
 
  // Set default datetime to now
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  document.getElementById('nr-collected').value = local;
  document.getElementById('nr-reported').value = local;
  document.getElementById('nr-patient-no').value = '';
  const nrOpIpEl = document.getElementById('nr-op-ip'); if (nrOpIpEl) nrOpIpEl.value = '';
 
  // Load patients
  apiFetch(`${API}/patients`).then(pts => {
    const sel = document.getElementById('nr-patient');
    sel.innerHTML = '<option value="">Select Patient…</option>';
    (pts || []).forEach(p => {
      sel.innerHTML += `<option value="${p.id}" data-age="${p.age||''}" data-gender="${p.gender||''}" data-phone="${p.phone||''}" data-greeting="${p.greeting||''}" data-address="${(p.address||'').replace(/"/g,'&quot;')}" data-op-ip="${(p.op_ip||'').replace(/"/g,'&quot;')}">${p.name}</option>`;
    });
  });
 
  // Load doctors into dropdown
  apiFetch(`${API}/doctors`).then(docs => {
    const sel = document.getElementById('nr-doctor-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select Doctor…</option>';
    (docs || []).forEach(d => {
      sel.innerHTML += `<option value="${d.name}">${d.name}${d.specialization ? ' — ' + d.specialization : ''}</option>`;
    });
  });
 
  // Clear manual doctor field
  const manDr = document.getElementById('nr-doctor');
  if (manDr) manDr.value = '';
 
  openModal('new-report-modal');
 
  // Reset ref lab
  _nrRefLabId = '';
  _nrRefLabRanges = {};
  const refLabSel = document.getElementById('nr-ref-lab');
  if (refLabSel) refLabSel.value = '';
  const badge = document.getElementById('nr-ref-lab-badge');
  if (badge) badge.style.display = 'none';
  nrLoadOtherLabs();
 
  // Load catalog + stage cache so quick search works for both
  loadCatalogGrouped().then(() => {
    _nrIndexBuilt = false;
    buildNrSearchIndex();
    _nrIndexBuilt = true;
  });
  buildStageCache();
  _loadStage2LinkMap();
}
 
function _titleCase(str) {
  return str.toLowerCase().replace(/(?:^|\s|\/)\S/g, c => c.toUpperCase());
}
 
function fillNrPatient() {
  // patient no auto-fill based on id
  const sel = document.getElementById('nr-patient');
  const opt = sel.options[sel.selectedIndex];
  if (opt.value) {
    document.getElementById('nr-patient-no').value = opt.value;
    const nrOpIpEl = document.getElementById('nr-op-ip');
    if (nrOpIpEl) nrOpIpEl.value = opt.dataset.opIp || '';
  }
  // Re-apply ref-lab (or catalog) ranges for the newly selected patient's gender
  if (nrSections.length) _nrApplyRefLabToAllSections();
}
 
function addNrSection(type) {
  const rawTemplates = NR_TEMPLATES[type] || NR_TEMPLATES['CUSTOM'];
  const templates    = JSON.parse(JSON.stringify(rawTemplates));
 
  // Apply gender-aware ref ranges from catalog
  const patSel = document.getElementById('nr-patient');
  const gender  = patSel?.options[patSel.selectedIndex]?.dataset.gender || '';
 
  if (type !== 'CUSTOM') {
    templates.forEach(grp => {
      grp.rows.forEach(row => {
        const entry = _nrSearchIndex.find(e => e.name === row.name && e.group === grp.group)
                   || _nrSearchIndex.find(e => e.name === row.name);
        if (entry) {
          if (entry.ref) row.ref = entry.ref;
          if (!row.unit && entry.unit) row.unit = entry.unit;
          if (entry._interpretation) row._interpretation = entry._interpretation;
        }
        // ── Override with selected reference lab's ranges ──
        if (_nrRefLabId) {
          const override = _nrGetRefForRow(row.name, gender);
          if (override) {
            row.ref = override.ref;
            if (override.unit) row.unit = override.unit;
          }
        }
      });
    });
  }
 
  const idx = nrSectionIdx++;
  nrSections.push({ type, idx, groups: templates });
  renderNrSections();
}
 
function removeNrSection(idx) {
  nrSections = nrSections.filter(s => s.idx !== idx);
  renderNrSections();
}
 
function renderNrSections() {
  const container = document.getElementById('nr-sections');
  const countEl = document.getElementById('nr-step-count');
  const totalRows = nrSections.reduce((s, sec) => s + sec.groups.reduce((s2, g) => s2 + g.rows.length, 0), 0);
  if (countEl) countEl.textContent = totalRows ? `${totalRows} test${totalRows !== 1 ? 's' : ''} selected` : '';

  if (nrSections.length === 0) {
    container.innerHTML = nrStep === 1
      ? '<div style="color:var(--muted);font-size:13px;padding:10px 0">No tests selected. Search above or add a custom section below.</div>'
      : '<div style="color:var(--muted);font-size:13px;padding:10px 0">No tests selected yet.</div>';
    return;
  }
  container.innerHTML = nrSections.map(sec => {
    // Determine the blue-bar label:
    // - CUSTOM → editable input (user types the category name)
    // - Otherwise → sec.type (the catalog category name)
    const isCustom   = sec.type === 'CUSTOM';
    const headerLabel = isCustom
      ? (nrStep === 1
          ? `<input type="text" placeholder="Type category name (e.g. SEROLOGY, HORMONES…)" value="${sec.groups[0]?.group || ''}" oninput="nrUpdateCustomLabel(${sec.idx}, this.value)" style="font-weight:600;font-size:12px;letter-spacing:1px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.5);color:#fff;outline:none;width:320px;padding:2px 0" />`
          : `<span style="font-weight:600;font-size:12px;letter-spacing:1px">${sec.groups[0]?.group || 'CUSTOM'}</span>`)
      : `<span style="font-weight:600;font-size:12px;letter-spacing:1px">${sec.type}</span>`;

    return `
    <div class="nr-section" data-idx="${sec.idx}" style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;background:#1a5276;color:#fff;padding:6px 10px">
        ${headerLabel}
        ${nrStep === 1 ? `<button onclick="removeNrSection(${sec.idx})" style="background:transparent;border:none;color:#fff;cursor:pointer;font-size:15px;line-height:1">×</button>` : ''}
      </div>
      ${sec.groups.map((grp, gi) => {
        // Only show the sub-group label when it differs from sec.type
        // (avoids "HAEMATOLOGY" appearing twice when group === category)
        const showGroupLabel = !isCustom && grp.group && grp.group !== sec.type && grp.group !== '(General)';

        if (nrStep === 1) {
          // ── STEP 1: compact selection chips — just names, nothing else to fill in ──
          const groupHeader = isCustom
            ? `<button onclick="addNrRow(${sec.idx},${gi})" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;cursor:pointer;color:var(--text)">+ Row</button>`
            : showGroupLabel
              ? `<span style="font-weight:600;font-size:12px;color:#1a5276">${grp.group}</span>
                 <button onclick="addNrRow(${sec.idx},${gi})" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;cursor:pointer;color:var(--text)">+ Row</button>`
              : `<button onclick="addNrRow(${sec.idx},${gi})" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;cursor:pointer;color:var(--text)">+ Row</button>`;

          return `
          <div style="padding:8px 10px;${gi > 0 ? 'border-top:1px solid var(--border)' : ''}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              ${groupHeader}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${grp.rows.map((row, ri) => `
                <span style="display:inline-flex;align-items:center;gap:4px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:3px 4px 3px 12px;font-size:13px">
                  <input type="text" value="${row.name}" placeholder="Test name" oninput="nrUpdateRow(${sec.idx},${gi},${ri},'name',this.value)"
                    size="1" style="border:none;background:transparent;font-size:13px;color:var(--text);min-width:70px;width:${Math.max(70, ((row.name||'Test name').length + 1) * 7)}px;outline:none"/>
                  <button onclick="removeNrRow(${sec.idx},${gi},${ri})" style="color:#c0392b;background:transparent;border:none;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px">×</button>
                </span>
              `).join('')}
            </div>
          </div>`;
        }

        // ── STEP 2: focused results entry — one big Result box per test, rest read-only ──
        return `
        <div style="padding:8px 10px;${gi > 0 ? 'border-top:1px solid var(--border)' : ''}">
          ${showGroupLabel ? `<div style="font-weight:600;font-size:12px;color:#1a5276;margin-bottom:6px">${grp.group}</div>` : ''}
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#1e3a5f">
                <th style="padding:6px 8px;text-align:left;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#e2e8f0;width:32%">Test</th>
                <th style="padding:6px 8px;text-align:left;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#fff;width:26%">Result</th>
                <th style="padding:6px 8px;text-align:left;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#e2e8f0;width:14%">Unit</th>
                <th style="padding:6px 8px;text-align:left;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#e2e8f0;width:22%">Reference Range</th>
              </tr>
            </thead>
            <tbody>
              ${grp.rows.map((row, ri) => `
                <tr data-sec="${sec.idx}" data-grp="${gi}" data-row="${ri}">
                  <td style="padding:6px 8px;color:var(--text)">${row.name || '—'}</td>
                  <td style="padding:3px 5px">
                    <input type="text" value="${row.result||''}" placeholder="Enter result" data-nr-result="1" class="nr-result-input"
                      oninput="nrUpdateRow(${sec.idx},${gi},${ri},'result',this.value)"
                      onkeydown="nrResultKeyNav(event)"
                      style="width:100%;border:2px solid var(--primary);border-radius:6px;padding:7px 9px;font-size:14px;font-weight:600;background:var(--card);color:var(--text)"/>
                  </td>
                  <td style="padding:3px 5px">
                    <input type="text" value="${row.unit}" placeholder="unit" oninput="nrUpdateRow(${sec.idx},${gi},${ri},'unit',this.value)"
                      style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px 6px;font-size:12px;background:var(--card);color:var(--muted)"/>
                  </td>
                  <td style="padding:3px 5px">
                    <input type="text" value="${row.ref}" placeholder="range" oninput="nrUpdateRow(${sec.idx},${gi},${ri},'ref',this.value)"
                      style="width:100%;border:1px solid var(--border);border-radius:4px;padding:5px 6px;font-size:12px;background:var(--card);color:var(--muted)"/>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  if (nrStep === 2) {
    setTimeout(() => {
      const first = container.querySelector('[data-nr-result="1"]');
      if (first) first.focus();
    }, 50);
  }
}

// Enter/ArrowDown/ArrowUp jump between Result boxes in step 2 — no mouse needed
function nrResultKeyNav(e) {
  if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  // Enter/Arrow means this value is "committed" — recalculate right away
  // instead of waiting out the debounce, so any dependent calculated field
  // (VLDL, A/G ratio, absolute counts, etc.) shows up immediately.
  clearTimeout(_nrRecalcTimer);
  const updates = nrRecalcTests();
  _nrApplyCalcUpdatesToForm(updates);
  _nrApplyCalcUpdatesToPreview(updates);
  const inputs = Array.from(document.querySelectorAll('#nr-sections [data-nr-result="1"]'));
  const idx = inputs.indexOf(e.target);
  if (idx === -1) return;
  const nextIdx = idx + (e.key === 'ArrowUp' ? -1 : 1);
  if (nextIdx >= 0 && nextIdx < inputs.length) {
    inputs[nextIdx].focus();
    inputs[nextIdx].select();
  }
}

function applyNrStepVisibility() {
  const selectControls = document.getElementById('nr-select-controls');
  const footer1 = document.getElementById('nr-footer-step1');
  const footer2 = document.getElementById('nr-footer-step2');
  const stepLabel = document.getElementById('nr-step-label');
  if (selectControls) selectControls.style.display = nrStep === 1 ? '' : 'none';
  if (footer1) footer1.style.display = nrStep === 1 ? '' : 'none';
  if (footer2) footer2.style.display = nrStep === 2 ? '' : 'none';
  if (stepLabel) stepLabel.textContent = nrStep === 1 ? 'Step 1 — Select Tests' : 'Step 2 — Enter Results';
}

// Tests are now selected in Step 1 and results are typed directly into the
// print-style preview itself, so this validates the selection and opens that
// preview immediately instead of switching to a separate results table.
function goToResultsStep() {
  const totalRows = nrSections.reduce((s, sec) => s + sec.groups.reduce((s2, g) => s2 + g.rows.length, 0), 0);
  if (totalRows === 0) { toast('Select at least one test first', 'error'); return; }
  const unnamed = nrSections.some(sec => sec.groups.some(g => g.rows.some(r => !r.name || !r.name.trim())));
  if (unnamed) { toast('Give every added test a name before continuing', 'error'); return; }
  previewAndPrintReport();
}

function backToSelection() {
  nrStep = 1;
  applyNrStepVisibility();
  renderNrSections();
}

function nrUpdateGroup(secIdx, gi, field, val) {
  const sec = nrSections.find(s => s.idx === secIdx);
  if (sec) sec.groups[gi][field] = val;
}
function nrUpdateCustomLabel(secIdx, val) {
  const sec = nrSections.find(s => s.idx === secIdx);
  if (sec) sec.groups.forEach(g => g.group = val.toUpperCase());
}
let _nrRecalcTimer = null;
function nrUpdateRow(secIdx, gi, ri, field, val) {
  const sec = nrSections.find(s => s.idx === secIdx);
  if (!sec) return [];
  const row = sec.groups[gi].rows[ri];
  row[field] = val;
  if (field === 'result') {
    // nrUpdateRow is only ever invoked from a person's own keystroke (either
    // directly, or forwarded from the print-preview popup) — never from
    // nrRecalcTests itself — so this is always a manual edit. Mark it as
    // such, which stops future auto-calculation from overwriting it.
    row._calcAuto = false;
    // Debounce: recompute once typing pauses rather than on every keystroke,
    // so a multi-digit value doesn't trigger a full-report rescan per digit.
    clearTimeout(_nrRecalcTimer);
    _nrRecalcTimer = setTimeout(() => {
      const updates = nrRecalcTests();
      _nrApplyCalcUpdatesToForm(updates);
      _nrApplyCalcUpdatesToPreview(updates);
    }, 250);
  }
  return [];
}

// Pushes freshly auto-calculated values straight into the open print-preview
// popup's own inputs (that window keeps a separate DOM, so it won't pick up
// changes to nrSections on its own).
function _nrApplyCalcUpdatesToPreview(updates) {
  if (!updates || !updates.length) return;
  const win = window._nrPreviewWin;
  if (!win || win.closed) return;
  updates.forEach(u => {
    // The preview builds a hidden #rpt-measure-wrap copy of the table to
    // calculate page breaks, then CLONES rows out of it into the visible
    // #rpt-pages-container — the hidden original is left behind in the DOM
    // (just display:none'd) with the same data-sec/grp/row attributes. A
    // plain document-wide selector matches that leftover hidden copy first
    // (it comes first in the DOM), so once pagination has run we must look
    // inside the visible pages container specifically.
    const pagesEl = win.document.getElementById('rpt-pages-container');
    const scope = (pagesEl && pagesEl.children.length) ? pagesEl : win.document;
    const tr = scope.querySelector('tr[data-sec="' + u.sec + '"][data-grp="' + u.gi + '"][data-row="' + u.ri + '"]');
    const input = tr && tr.querySelector('.rpt-result-input');
    if (!input) return;
    input.value = u.value;
    if (win.rptRefreshRowStyle) win.rptRefreshRowStyle(tr);
  });
}

// Pushes freshly auto-calculated values into the main results-entry form's own
// Result boxes (step 2), so a calculated test (VLDL, A/G ratio, absolute counts,
// etc.) shows up right in the form the moment its inputs are typed — not only
// once a print preview happens to be open.
function _nrApplyCalcUpdatesToForm(updates) {
  if (!updates || !updates.length) return;
  const container = document.getElementById('nr-sections');
  if (!container) return;
  updates.forEach(u => {
    const tr = container.querySelector('tr[data-sec="' + u.sec + '"][data-grp="' + u.gi + '"][data-row="' + u.ri + '"]');
    const input = tr && tr.querySelector('.nr-result-input');
    if (!input) return;
    // Don't clobber whatever the person is actively typing into right now.
    if (document.activeElement === input) return;
    input.value = u.value;
  });
}
function addNrRow(secIdx, gi) {
  const sec = nrSections.find(s => s.idx === secIdx);
  if (sec) { sec.groups[gi].rows.push({ name: '', result: '', unit: '', ref: '' }); renderNrSections(); }
}
function removeNrRow(secIdx, gi, ri) {
  const sec = nrSections.find(s => s.idx === secIdx);
  if (sec && sec.groups[gi].rows.length > 1) { sec.groups[gi].rows.splice(ri, 1); renderNrSections(); }
}
 
/* ── Shared helpers for result entry (used both on the initial render and by
   the editable print preview, via window.opener, so the abnormal-value
   highlighting logic lives in exactly one place) ── */
function calcResultRowClass(result, ref) {
  const res = parseFloat(result);
  if (isNaN(res) || !ref) return '';
  const parts = String(ref).replace(/[<>]/g, '').split('-').map(x => parseFloat(x.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    if (res > parts[1]) return 'rpt-high';
    if (res < parts[0]) return 'rpt-low';
    return '';
  }
  if (ref.includes('<') && !isNaN(parseFloat(ref.replace('<', '')))) {
    if (res > parseFloat(ref.replace('<', ''))) return 'rpt-high';
  } else if (ref.includes('>') && !isNaN(parseFloat(ref.replace('>', '')))) {
    if (res < parseFloat(ref.replace('>', ''))) return 'rpt-low';
  }
  return '';
}
window.calcResultRowClass = calcResultRowClass; // reachable from the popup preview via window.opener

/* ── Auto-calculated test results ──────────────────────────────────────────
   Some test-panel entries are always derived from other results already
   typed into the same report (e.g. VLDL from Triglycerides, LDL/HDL Ratio,
   A/G Ratio, Absolute counts from TLC × differential %). Whenever any result
   is typed, we recompute every calculated field whose inputs are all present
   and write the answer straight into that row — no manual entry needed.
   A calculated row is only skipped once the user has typed over it by hand
   (row._calcAuto === false). */
function _nrNormalizeName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// key → list of accepted spellings (normalized) that count as that test
const NR_CALC_ALIASES = {
  triglycerides:      ['TRIGLYCERIDES', 'TRIGLYCERIDESTGL', 'TGL'],
  totalcholesterol:   ['TOTALCHOLESTEROL'],
  ldlcholesterol:     ['LDLCHOLESTEROL', 'LDL'],
  hdlcholesterol:     ['HDLCHOLESTEROL', 'HDL'],
  vldl:               ['VLDLCHOLESTEROL', 'VLDL'],
  ldlhdlratio:        ['LDLHDLRATIO'],
  cholhdlratio:       ['TOTALCHOLESTEROLHDLRATIO', 'CHOLESTEROLHDLRATIO', 'TCHDLRATIO'],
  albumin:            ['ALBUMIN'],
  globulin:           ['GLOBULIN'],
  totalprotein:       ['TOTALPROTEIN', 'TOTALPROTEINS', 'SERUMTOTALPROTEIN'],
  agratio:            ['AGRATIO'],
  totalbilirubin:     ['TOTALBILIRUBIN', 'BILIRUBINTOTAL'],
  directbilirubin:    ['DIRECTBILIRUBIN', 'BILIRUBINDIRECT'],
  indirectbilirubin:  ['INDIRECTBILIRUBIN', 'BILIRUBININDIRECT'],
  tlc:                ['TOTALLEUCOCYTECOUNT', 'TOTALWBCCOUNT', 'WBCCOUNT', 'TLC'],
  neutrophils:        ['NEUTROPHILS', 'NEUTROPHIL', 'POLYMORPHS', 'POLYMORPHONUCLEARLEUCOCYTES'],
  lymphocytes:        ['LYMPHOCYTES', 'LYMPHOCYTE'],
  eosinophils:        ['EOSINOPHILS', 'EOSINOPHIL'],
  monocytes:          ['MONOCYTES', 'MONOCYTE'],
  basophils:          ['BASOPHILS', 'BASOPHIL'],
  absneutrophils:     ['ABSOLUTENEUTROPHILS', 'ABSOLUTENEUTROPHILCOUNT', 'ABSNEUTROPHILCOUNT'],
  abslymphocytes:     ['ABSOLUTELYMPHOCYTES', 'ABSOLUTELYMPHOCYTECOUNT', 'ABSLYMPHOCYTECOUNT', 'ABSLYMPHOCYTESCOUNT'],
  abseosinophils:     ['ABSOLUTEEOSINOPHILS', 'ABSOLUTEEOSINOPHILCOUNT', 'ABSEOSINOPHILCOUNT'],
  absmonocytes:       ['ABSOLUTEMONOCYTES', 'ABSOLUTEMONOCYTECOUNT', 'ABSMONOCYTECOUNT'],
  absbasophils:       ['ABSOLUTEBASOPHILS', 'ABSOLUTEBASOPHILCOUNT', 'ABSBASOPHILCOUNT'],
};

// Each rule: output row's key, the input keys it needs, and how to compute it
const NR_CALC_RULES = [
  { output: 'vldl',              inputs: ['triglycerides'],            decimals: 2, fn: v => v.triglycerides / 5 },
  { output: 'ldlcholesterol',    inputs: ['totalcholesterol', 'hdlcholesterol', 'triglycerides'], decimals: 2, fn: v => v.totalcholesterol - v.hdlcholesterol - (v.triglycerides / 5) },
  { output: 'ldlhdlratio',       inputs: ['ldlcholesterol', 'hdlcholesterol'], decimals: 2, fn: v => v.ldlcholesterol / v.hdlcholesterol },
  { output: 'cholhdlratio',      inputs: ['totalcholesterol', 'hdlcholesterol'], decimals: 2, fn: v => v.totalcholesterol / v.hdlcholesterol },
  { output: 'agratio',           inputs: ['albumin', 'globulin'],       decimals: 2, fn: v => v.albumin / v.globulin },
  { output: 'globulin',          inputs: ['totalprotein', 'albumin'],   decimals: 2, fn: v => v.totalprotein - v.albumin },
  { output: 'indirectbilirubin', inputs: ['totalbilirubin', 'directbilirubin'], decimals: 2, fn: v => v.totalbilirubin - v.directbilirubin },
  { output: 'absneutrophils',    inputs: ['tlc', 'neutrophils'],        decimals: 0, fn: v => v.tlc * v.neutrophils / 100 },
  { output: 'abslymphocytes',    inputs: ['tlc', 'lymphocytes'],        decimals: 0, fn: v => v.tlc * v.lymphocytes / 100 },
  { output: 'abseosinophils',    inputs: ['tlc', 'eosinophils'],        decimals: 0, fn: v => v.tlc * v.eosinophils / 100 },
  { output: 'absmonocytes',      inputs: ['tlc', 'monocytes'],          decimals: 0, fn: v => v.tlc * v.monocytes / 100 },
  { output: 'absbasophils',      inputs: ['tlc', 'basophils'],          decimals: 0, fn: v => v.tlc * v.basophils / 100 },
];

function _nrFindCalcKey(name) {
  const norm = _nrNormalizeName(name);
  if (!norm) return null;
  for (const key in NR_CALC_ALIASES) {
    if (NR_CALC_ALIASES[key].includes(norm)) return key;
  }
  return null;
}

/* Scans every row currently on the report, recomputes any calculated field
   whose inputs are all filled in, and writes the result straight into that
   row's data. Returns the list of rows that changed so the caller (main
   window or the print-preview popup) can refresh the matching input boxes. */
function nrRecalcTests() {
  const updated = [];
  if (window.__nrCalcDebug) {
    console.log('[nrRecalcTests] scanning rows:', nrSections.flatMap(sec => sec.groups.flatMap(grp => grp.rows.map(row =>
      ({ name: row.name, result: row.result, normalized: _nrNormalizeName(row.name), matchedKey: _nrFindCalcKey(row.name) })
    ))));
  }
  for (let pass = 0; pass < 2; pass++) { // 2 passes lets a calculated value feed another calc (e.g. globulin → A/G ratio)
    const values = {};   // key -> numeric result currently on the report
    const targets = {};  // key -> [{sec, gi, ri}] rows that display that key
    const valuesByName  = {}; // normalized test name -> numeric result (for custom rules)
    const targetsByName = {}; // normalized test name -> [{sec, gi, ri}] (for custom rules)
    nrSections.forEach(sec => {
      sec.groups.forEach((grp, gi) => {
        grp.rows.forEach((row, ri) => {
          const num = parseFloat(row.result);
          const norm = _nrNormalizeName(row.name);
          if (norm) {
            (targetsByName[norm] = targetsByName[norm] || []).push({ sec: sec.idx, gi, ri });
            if (!isNaN(num)) valuesByName[norm] = num;
          }
          const key = _nrFindCalcKey(row.name);
          if (!key) return;
          (targets[key] = targets[key] || []).push({ sec: sec.idx, gi, ri });
          if (!isNaN(num)) values[key] = num;
        });
      });
    });

    NR_CALC_RULES.forEach(rule => {
      const rows = targets[rule.output];
      if (!rows || !rows.length) return; // this calculated test isn't on the report
      if (!rule.inputs.every(k => values[k] !== undefined && !isNaN(values[k]))) return;
      let val;
      try { val = rule.fn(values); } catch (e) { return; }
      if (!isFinite(val)) return;
      const rounded = rule.decimals === 0 ? String(Math.round(val)) : val.toFixed(rule.decimals);
      rows.forEach(ref => {
        const sec = nrSections.find(s => s.idx === ref.sec);
        const row = sec && sec.groups[ref.gi] && sec.groups[ref.gi].rows[ref.ri];
        if (!row || row._calcAuto === false) return; // user typed over this one — leave it alone
        if (String(row.result || '').trim() !== rounded) {
          row.result = rounded;
          row._calcAuto = true;
          updated.push({ sec: ref.sec, gi: ref.gi, ri: ref.ri, value: rounded });
        }
      });
      values[rule.output] = val; // feed into any second-pass rule that depends on it
    });

    // Custom rules added via the Calculations tab — matched by exact test
    // name (normalized) rather than the built-in alias dictionary, since
    // the person picked these names directly from the catalog.
    (typeof _calcRules !== 'undefined' ? _calcRules : []).forEach(rule => {
      const outNorm = _nrNormalizeName(rule.output_test);
      const rows = targetsByName[outNorm];
      if (!rows || !rows.length) return; // this output test isn't on the report
      const spec = (typeof CALC_OPERATIONS !== 'undefined') ? CALC_OPERATIONS[rule.operation] : null;
      if (!spec) return;
      const aNorm = _nrNormalizeName(rule.input_a);
      const aVal = valuesByName[aNorm];
      if (aVal === undefined || isNaN(aVal)) return;
      let bVal;
      if (spec.needsB) {
        const bNorm = _nrNormalizeName(rule.input_b || '');
        bVal = valuesByName[bNorm];
        if (bVal === undefined || isNaN(bVal)) return;
      }
      let val;
      try { val = spec.fn(aVal, bVal, rule.constant); } catch (e) { return; }
      if (!isFinite(val)) return;
      const decimals = rule.decimals || 0;
      const rounded = decimals === 0 ? String(Math.round(val)) : val.toFixed(decimals);
      rows.forEach(ref => {
        const sec = nrSections.find(s => s.idx === ref.sec);
        const row = sec && sec.groups[ref.gi] && sec.groups[ref.gi].rows[ref.ri];
        if (!row || row._calcAuto === false) return;
        if (String(row.result || '').trim() !== rounded) {
          row.result = rounded;
          row._calcAuto = true;
          updated.push({ sec: ref.sec, gi: ref.gi, ri: ref.ri, value: rounded });
        }
      });
      valuesByName[outNorm] = val; // feed into any second-pass rule that depends on it
    });
  }
  return updated;
}
window.nrRecalcTests = nrRecalcTests; // reachable from the popup preview via window.opener

function escAttr(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ── Build print HTML and show preview ── */

// Stored state for the interpretation picker flow
let _interpPickerMap  = {};   // { testName: noteText }
let _interpPrintState = null; // everything needed to actually print

function interpPickerSelectAll(checked) {
  document.querySelectorAll('#interp-picker-list input[type=checkbox]').forEach(cb => cb.checked = checked);
}

function confirmInterpPickerAndPrint() {
  if (!_interpPrintState) {
    toast('Print data is not ready. Please try again.', 'error');
    return;
  }

  // Collect only ticked interpretations
  const selectedKeys = new Set(
    [...document.querySelectorAll('#interp-picker-list input[type=checkbox]')]
      .filter(cb => cb.checked)
      .map(cb => cb.value)
  );

  const { fdDesign, patientName, patientAge, patientGender, patientPhone,
          patientNo, opIp, doctorName, collectedRaw, reportedRaw,
          labName, labAddr, labPhone, labEmail,
          buildTableRows, fmtDT, patientId, doctorId, patientAddress } = _interpPrintState;

  // Build interpHtml from only selected entries
  const filteredEntries = Object.entries(_interpPickerMap).filter(([k]) => selectedKeys.has(k));
  const notesSz = fdDesign.notesSize || fdDesign.fontSize || '12px';
  const interpHtml = filteredEntries.length ? `
    <div style="margin-top:12px;border-top:2px solid ${fdDesign.secondary};padding-top:8px">
      <div style="font-weight:700;font-size:${notesSz};color:${fdDesign.secondary};letter-spacing:1px;margin-bottom:6px">CLINICAL NOTES &amp; INTERPRETATIONS</div>
      ${filteredEntries.map(([test, note]) => `
        <div class="rpt-interp-entry" style="margin-bottom:8px;page-break-inside:avoid">
          <div style="font-weight:700;font-size:${notesSz};color:${fdDesign.secondary}">${test}</div>
          <div style="font-size:${notesSz};color:#333;line-height:1.5;margin-top:2px">${note}</div>
        </div>`).join('')}
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;text-align:center;font-size:${notesSz};color:${fdDesign.secondary};font-weight:700;letter-spacing:0.5px">End of the report</div>
    </div>` : '';

  closeModal('interp-picker-modal');
  // Instant window opening
  _doOpenPrintWindow(fdDesign, patientName, patientAge, patientGender, patientPhone,
                     patientNo, doctorName, collectedRaw, reportedRaw,
                     labName, labAddr, labPhone, labEmail,
                     buildTableRows, fmtDT, interpHtml, patientId, doctorId, patientAddress, opIp);
}

function _doOpenPrintWindow(fdDesign, patientName, patientAge, patientGender, patientPhone,
                             patientNo, doctorName, collectedRaw, reportedRaw,
                             labName, labAddr, labPhone, labEmail,
                             buildTableRows, fmtDT, interpHtml, patientId, doctorId, patientAddress, opIp) {
 
  const bodyHTML = fdBuildOrderedBody(fdDesign, {
    titlebar:     { hidden: fdDesign.showTitleBar === false,     html: `<div class="rpt-title-bar">${fdDesign.reportTitle || 'TEST REPORT'}</div>` },
    patientinfo:  { hidden: fdDesign.showPatientInfo === false,  html: fdBuildPatientInfoHTML(fdDesign, {
        name: patientName, age: patientAge ? patientAge + ' Y' : '—', sex: patientGender || '—',
        doctor: doctorName, reportDate: fmtDT(reportedRaw), visitDate: fmtDT(collectedRaw),
        refNo: patientNo || '—', opIp: opIp || '—',
      }) },
    resultstable: { hidden: fdDesign.showResultsTable === false, html: `
      <table class="rpt-table">
        <thead><tr>
          <th style="width:38%">TEST DESCRIPTION</th>
          <th style="width:18%">RESULT</th>
          <th style="width:14%">UNITS</th>
          <th style="width:30%">REFERENCE RANGE</th>
        </tr></thead>
        <tbody>${buildTableRows()}</tbody>
      </table>
      ${interpHtml || `<div style="margin-top:12px;padding-top:8px;border-top:2px solid ${fdDesign.secondary};text-align:center;font-size:${fdDesign.notesSize || fdDesign.fontSize || '12px'};color:${fdDesign.secondary};font-weight:700;letter-spacing:0.5px">End of the report</div>`}` },
  }, []);
 
  // Header is rendered as a repeating slot on every printed page (see rpt-page-header
  // below), not as part of the scrolling/paginated body — this keeps it (or its
  // reserved blank space, when toggled off) consistent across every page instead of
  // appearing only wherever it happened to land in the content flow.
  const headerContentHTML = fdBuildHeader(fdDesign, labName, labAddr, labPhone, labEmail, fdLogoDataUrl || null);
  const headerHTML = (fdDesign.showHeader === false)
    ? `<div style="visibility:hidden">${headerContentHTML}</div>`
    : headerContentHTML;
 
  // Signatures are pinned directly above the footer and, like the footer,
  // repeat on every printed page rather than appearing only on whichever
  // page the content happened to end on. Wrapped with the same 12mm side
  // inset the body content uses (the footer bar below deliberately bleeds
  // edge-to-edge instead, via its own CSS).
  const sigContentHTML = `
      <div class="rpt-signatures">
        ${(fdDesign.sigs || []).map(s => fdBuildSigBoxHTML(s)).join('')}
      </div>`;
  const sigHTML = `<div style="padding:0 12mm;box-sizing:border-box;width:100%;${fdDesign.showSignatures === false ? 'visibility:hidden' : ''}">${sigContentHTML}</div>`;
 
  // Footer content is always built; when toggled off it's wrapped so its
  // height (i.e. its reserved blank space) still shows consistently on every
  // printed page, the same way the header slot behaves. Signatures are
  // bundled into the same slot so they sit right above the footer on every page.
  const footerContentHTML = fdBuildFooterBar(fdDesign, labAddr, labPhone);
  const footerBarHTML = (fdDesign.showFooter === false)
    ? `<div style="visibility:hidden">${footerContentHTML}</div>`
    : footerContentHTML;
  const footerHTML = sigHTML + footerBarHTML;
 
  const reportBodyHtml = `<!DOCTYPE html><html><head>
    <meta charset="utf-8"/>
    <title>Test Report — ${patientName}</title>
    <style>

      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #888; font-family: ${fdDesign.font || 'Arial, sans-serif'}; }

      .print-toolbar {
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        background: #2d2d2d; display: flex; justify-content: center;
        align-items: center; gap: 12px; padding: 10px 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .print-toolbar button { padding: 8px 28px; border-radius: 6px; font-size: 13px; font-weight: 700; cursor: pointer; border: none; letter-spacing: 0.5px; }
      .btn-print { background: #c0392b; color: #fff; }
      .btn-whatsapp { background: #25D366; color: #fff; }
      .btn-whatsapp:disabled { opacity: 0.6; cursor: default; }
      .btn-close  { background: #555;    color: #fff; }
      @media print { .print-toolbar { display: none !important; } }

      .rpt-page-wrap {
        margin: 60px auto 20px;
        background: #fff;
        width: 210mm;
        height: 297mm;
        box-shadow: 0 4px 32px rgba(0,0,0,0.35);
        position: relative;
        overflow: hidden;
        page-break-after: always;
        break-after: page;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .rpt-page-wrap:last-child { margin-bottom: 60px; page-break-after: avoid; break-after: avoid; }

      .rpt-page-content {
        position: absolute;
        top: 0;
        left: 12mm;
        right: 12mm;
        overflow: hidden;
      }

      .rpt-page-footer {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        width: 100%;
        overflow: hidden;
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .rpt-page-footer > * { width: 100%; page-break-inside: avoid; break-inside: avoid; }

      @media print {
        body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .rpt-page-wrap { margin: 0; width: 100%; height: 297mm; box-shadow: none; }
        @page { size: A4 portrait; margin: 0; }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
      ${fdBuildCSS(fdDesign)}
      .rpt-wrap { width:100% !important; padding:0 !important; margin:0 !important; box-shadow:none !important; position:relative !important; overflow:visible !important; }
      .rpt-title-bar { margin-left:-12mm !important; margin-right:-12mm !important; width:calc(100% + 24mm) !important; }
      .rpt-footer-bar { margin-left:0 !important; margin-right:0 !important; width:100% !important; }
      .rpt-footer-spacer, .rpt-footer-block { display:none !important; }
      /* Result/unit/ref are typed directly into this preview. On screen they
         look like light input boxes; for the actual printout they collapse
         back to plain text, and any test still left blank drops out entirely. */
      .rpt-result-input, .rpt-unit-input, .rpt-ref-input { font-family: inherit; }
      .rpt-result-input:focus, .rpt-unit-input:focus, .rpt-ref-input:focus { outline: 2px solid #1a5276; }
      @media print {
        @page { size: A4 portrait; margin: 0; }
        @page :first { size: A4 portrait; margin: 0; }
        #rpt-measure-wrap, #rpt-header-clone, #rpt-footer-clone { display: none !important; }
        .rpt-page-wrap { width: 210mm !important; height: 297mm !important; margin: 0 !important; }
        .rpt-page-wrap { page-break-after: always !important; break-after: page !important; }
        .rpt-page-wrap:last-child { page-break-after: auto !important; break-after: auto !important; }
        tr.rpt-row-empty { display: none !important; }
        .rpt-result-input, .rpt-unit-input, .rpt-ref-input {
          border: none !important; background: transparent !important; padding: 0 !important;
          -webkit-appearance: none; appearance: none;
        }
        .rpt-result-input:focus, .rpt-unit-input:focus, .rpt-ref-input:focus { outline: none !important; }
      }
    </style>
  </head><body>
    <div class="print-toolbar">
      <button class="btn-print" onclick="rptPrintAndSave()">🖨️ Print</button>
      ${((typeof hasFeature !== 'function') || hasFeature('whatsapp')) ? `<button class="btn-whatsapp" id="btn-share-whatsapp" onclick="rptShareWhatsApp()">💬 Share via WhatsApp</button>` : ''}
      <button class="btn-close" onclick="window.close()">✕ Close</button>
    </div>
    <div id="rpt-measure-wrap" style="position:absolute;top:60px;left:50%;transform:translateX(-50%);width:calc(210mm - 24mm);visibility:hidden;pointer-events:none;z-index:-1;">
      <div class="rpt-wrap" style="position:relative">${fdBuildWatermark(fdDesign)}${bodyHTML}</div>
    </div>
    <div id="rpt-header-clone" style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:calc(210mm - 24mm);visibility:hidden;pointer-events:none;z-index:-1;">
      ${headerHTML}
    </div>
    <div id="rpt-footer-clone" style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:210mm;visibility:hidden;pointer-events:none;z-index:-1;">
      ${footerHTML}
    </div>
    <div id="rpt-pages-container"></div>

  <script>
  /* Result/unit/ref are typed straight into this preview. Every keystroke
     writes back into the opener window's report data (window.opener is the
     same-origin app tab this preview was opened from) so nothing is lost if
     this window is closed before printing, and re-checks the abnormal
     high/low styling using the same logic the opener used to build the row. */
  // Finds a row's <tr> for auto-calc push-back. After pagination has run,
  // the hidden #rpt-measure-wrap copy is left behind in the DOM (display:none,
  // but still matching the same data-sec/grp/row attributes) while the real,
  // visible row lives in #rpt-pages-container as a clone — so once pages
  // exist we must search inside the pages container specifically, or a plain
  // document-wide selector silently updates the invisible original instead.
  function _rptFindRow(sec, gi, ri) {
    var pagesEl = document.getElementById('rpt-pages-container');
    var scope = (pagesEl && pagesEl.children.length) ? pagesEl : document;
    return scope.querySelector('tr[data-sec="' + sec + '"][data-grp="' + gi + '"][data-row="' + ri + '"]');
  }

  // Saves the report exactly once, with whatever's actually been typed in,
  // right when Print is clicked — then prints. Runs before window.print()
  // so the saved copy always matches what went to the printer.
  var _nrAlreadySaved = false;
  // buildPages() itself is declared inside the pagination IIFE further down
  // this script (so it stays out of the way of everything above), which
  // means this outer scope can't call it directly by name. That IIFE
  // assigns itself here right after defining it, so rptRepaginateForPrint()
  // below has a way to re-run pagination on demand.
  var _rptBuildPagesRef = null;
  // Copies every live-typed Result/Unit/Reference value into the matching
  // row of the hidden #rpt-measure-wrap master copy (which still holds
  // whatever was there when this popup first opened), then recomputes
  // .rpt-row-empty on those rows -- and on the reference-tables and
  // subgroup headers tied to them -- the same way rptRefreshRowStyle /
  // rptRefreshGroupHeader do for the live copy. Needed so the pre-print
  // repagination below (rptRepaginateForPrint) measures the CURRENT,
  // just-typed state rather than the stale one from when the popup opened.
  function rptSyncMeasureWrapFromLive() {
    var measureWrap = document.getElementById('rpt-measure-wrap');
    var pagesEl = document.getElementById('rpt-pages-container');
    if (!measureWrap || !pagesEl) return;

    Array.prototype.slice.call(pagesEl.querySelectorAll('[data-field]')).forEach(function(liveInp) {
      var tr = liveInp.closest('tr');
      if (!tr) return;
      var sec = tr.getAttribute('data-sec'), grp = tr.getAttribute('data-grp'), row = tr.getAttribute('data-row');
      if (sec === null || grp === null || row === null) return;
      var field = liveInp.getAttribute('data-field');
      var mwRow = measureWrap.querySelector('tr.rpt-result-row[data-sec="' + sec + '"][data-grp="' + grp + '"][data-row="' + row + '"]');
      var mwInp = mwRow && mwRow.querySelector('[data-field="' + field + '"]');
      // Use the value ATTRIBUTE, not the JS property: buildPages() clones
      // these nodes with cloneNode(true), and a clone only reliably picks
      // up an <input>'s current text via its value attribute, not a value
      // assigned later purely as a property.
      if (mwInp) mwInp.setAttribute('value', liveInp.value || '');
    });

    Array.prototype.slice.call(measureWrap.querySelectorAll('tr.rpt-result-row')).forEach(function(tr) {
      var resultInput = tr.querySelector('.rpt-result-input');
      var hasResult = !!(resultInput && (resultInput.value || '').trim() !== '');
      tr.classList.toggle('rpt-row-empty', !hasResult);
      var sec = tr.getAttribute('data-sec'), grp = tr.getAttribute('data-grp'), row = tr.getAttribute('data-row');
      var refRow = measureWrap.querySelector('tr.rpt-refnote-row[data-sec="' + sec + '"][data-grp="' + grp + '"][data-row="' + row + '"]');
      if (refRow) refRow.classList.toggle('rpt-row-empty', !hasResult);
    });
    Array.prototype.slice.call(measureWrap.querySelectorAll('tr.rpt-subgroup-row')).forEach(function(header) {
      var sec = header.getAttribute('data-sec'), grp = header.getAttribute('data-grp');
      var groupRows = measureWrap.querySelectorAll('tr.rpt-result-row[data-sec="' + sec + '"][data-grp="' + grp + '"]');
      var anyResult = false;
      groupRows.forEach(function(r) {
        var inp = r.querySelector('.rpt-result-input');
        if (inp && (inp.value || '').trim() !== '') anyResult = true;
      });
      header.classList.toggle('rpt-row-empty', !anyResult);
    });
  }

  // Re-runs pagination once, right before printing, with still-blank rows
  // collapsed the same way @media print collapses them -- so the page
  // breaks the browser actually prints match what's on screen, instead of
  // the generous (nothing-clips-while-typing) page breaks buildPages()
  // computed when the popup first opened. See the comment on
  // forcePrintRebuild in buildPages() and on the collapse branch inside its
  // measureNodeHeight() for why this can't just be the default measurement
  // used throughout editing.
  function rptRepaginateForPrint() {
    var measureWrap = document.getElementById('rpt-measure-wrap');
    var headerClone = document.getElementById('rpt-header-clone');
    var footerClone = document.getElementById('rpt-footer-clone');
    if (!measureWrap || typeof _rptBuildPagesRef !== 'function') return;
    rptSyncMeasureWrapFromLive();
    // buildPages() re-hides all three of these at the end of every run
    // (successful or not), so there is nothing to restore here afterwards.
    measureWrap.style.display = '';
    if (headerClone) headerClone.style.display = '';
    if (footerClone) footerClone.style.display = '';
    _rptBuildPagesRef(true);
  }

  // The saved html_content is later turned into a PDF by xhtml2pdf on
  // the server, which does not render <input> values as visible text at
  // all — a saved/printed report built from live <input> boxes would
  // come out permanently blank there even though the typed values are
  // technically present. So the save gets a separate, static-text copy:
  // read what's actually in each editable Result/Unit/Reference box now,
  // then swap each one for a plain span with that text in a clone of the
  // page (the live popup itself, and its inputs, are left untouched).
  function rptBuildHtmlSnapshot() {
    var liveValues = Array.prototype.slice.call(
      document.querySelectorAll('.rpt-result-input, .rpt-unit-input, .rpt-ref-input')
    ).map(function(inp) { return inp.value; });
    var clone = document.documentElement.cloneNode(true);
    var cloneInputs = clone.querySelectorAll('.rpt-result-input, .rpt-unit-input, .rpt-ref-input');
    for (var i = 0; i < cloneInputs.length; i++) {
      var inp = cloneInputs[i];
      var span = document.createElement('span');
      span.textContent = liveValues[i] || '';
      if (inp.className.indexOf('rpt-result-input') !== -1) span.style.fontWeight = '600';
      inp.parentNode.replaceChild(span, inp);
    }
    return '<!DOCTYPE html>\\n' + clone.outerHTML;
  }

  function rptPrintAndSave() {
    // Snapshot the current, generous/editable page layout before rebuilding
    // it for print below. The rebuild is only correct for the printed
    // output (it assumes still-blank rows collapse away, which is only
    // true under @media print) -- shown plainly on screen instead, that
    // same rebuilt layout overflows its fixed-height page boxes and a page
    // can appear to vanish. So once the print dialog closes, whether the
    // person actually printed or hit Cancel, put this original layout back.
    var pagesEl = document.getElementById('rpt-pages-container');
    // innerHTML serializes <input> elements from their "value" ATTRIBUTE, not
    // the live .value property that typing actually changes (rptFieldInput
    // above only ever sets the property). Without this sync, the snapshot
    // below silently captures the stale/blank values from when this popup
    // was first built, and restoreOriginalPages() then paints that stale
    // snapshot back onto the screen once afterprint fires -- which happens
    // whether Print or Cancel was clicked -- making typed values disappear.
    if (pagesEl) {
      Array.prototype.slice.call(pagesEl.querySelectorAll('[data-field]')).forEach(function(inp) {
        inp.setAttribute('value', inp.value || '');
      });
    }
    var originalPagesHTML = pagesEl ? pagesEl.innerHTML : null;
    if (pagesEl && originalPagesHTML !== null) {
      var restoreOriginalPages = function() {
        pagesEl.innerHTML = originalPagesHTML;
        window.removeEventListener('afterprint', restoreOriginalPages);
      };
      window.addEventListener('afterprint', restoreOriginalPages);
    }

    rptRepaginateForPrint();
    if (!_nrAlreadySaved && window.opener && !window.opener.closed && window._nrSaveMeta && window.opener.nrSaveReportFromPreview) {
      _nrAlreadySaved = true;
      var htmlSnapshot = rptBuildHtmlSnapshot();
      Promise.resolve(window.opener.nrSaveReportFromPreview(window._nrSaveMeta, htmlSnapshot))
        .then(function(id) { if (id) _nrSavedReportId = id; });
    }
    window.print();
  }

  // ── Share via WhatsApp (no printing) ──────────────────────────────────
  // Reuses the same save-workflow endpoint Print uses, so the report is
  // guaranteed to exist on the server (and therefore have a downloadable
  // PDF) before we hand it off to WhatsApp — saving is a prerequisite for
  // sharing, not something the person has to remember to do first.
  var _nrSavedReportId = null;
  var _nrSaveInFlight = null;
  var _nrWaShareInFlight = false;

  // Saves the report exactly once (whatever's typed so far) without opening
  // the print dialog, and resolves with the saved report's id. Safe to call
  // more than once -- after the first successful save (from here or from
  // Print), later calls just resolve with that same id instead of saving
  // again.
  function rptSaveReportOnceForShare() {
    if (_nrSavedReportId) return Promise.resolve(_nrSavedReportId);
    if (_nrSaveInFlight) return _nrSaveInFlight;
    if (!(window.opener && !window.opener.closed && window._nrSaveMeta && window.opener.nrSaveReportFromPreview)) {
      return Promise.resolve(null);
    }

    // Same before/after snapshot trick rptPrintAndSave uses for the
    // afterprint restore, but since nothing here ever calls window.print()
    // (so 'afterprint' would never fire), the editable layout is put back
    // immediately instead, right after the print-ready copy is captured.
    var pagesEl = document.getElementById('rpt-pages-container');
    if (pagesEl) {
      Array.prototype.slice.call(pagesEl.querySelectorAll('[data-field]')).forEach(function(inp) {
        inp.setAttribute('value', inp.value || '');
      });
    }
    var originalPagesHTML = pagesEl ? pagesEl.innerHTML : null;

    rptRepaginateForPrint();
    var htmlSnapshot = rptBuildHtmlSnapshot();

    if (pagesEl && originalPagesHTML !== null) {
      pagesEl.innerHTML = originalPagesHTML;
    }

    _nrAlreadySaved = true;
    _nrSaveInFlight = Promise.resolve(window.opener.nrSaveReportFromPreview(window._nrSaveMeta, htmlSnapshot))
      .then(function(id) { _nrSavedReportId = id; _nrSaveInFlight = null; return id; })
      .catch(function(err) { console.error('Report save failed:', err); _nrSaveInFlight = null; return null; });
    return _nrSaveInFlight;
  }

  function rptShareWhatsApp() {
    if (_nrWaShareInFlight) return;
    if (window.opener && typeof window.opener.guardFeature === 'function' &&
        !window.opener.guardFeature('whatsapp')) return;
    var meta = window._nrSaveMeta || {};
    var waPhone = (window.opener && window.opener.normalizeWhatsAppPhone)
      ? window.opener.normalizeWhatsAppPhone(meta.patientPhone)
      : String(meta.patientPhone || '').replace(/\D/g, '');
    if (!waPhone) {
      alert('No phone number on file for this patient — add one first, then try sharing again.');
      return;
    }
    if (!(window.opener && !window.opener.closed && window.opener.nrSaveReportFromPreview)) {
      alert('The main LabSoft window is no longer open. Please reopen this preview and try again.');
      return;
    }

    var btn = document.getElementById('btn-share-whatsapp');
    _nrWaShareInFlight = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparing…'; }

    // Open the WhatsApp tab right now, synchronously, on the click itself —
    // if we wait until after the save + PDF-download network calls below
    // finish, the browser no longer considers window.open() to be a direct
    // result of the user's click and silently blocks it as a popup (this is
    // also why routing this through window.opener didn't work: the click
    // happened in THIS window, not the opener, so the opener's window.open()
    // call had no attached user gesture at all). We just redirect this same
    // blank tab to the real wa.me link once everything is ready.
    var waWin = window.open('about:blank', '_blank');
    if (waWin && waWin.document) {
      try {
        waWin.document.write('<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666"><div><h3>Preparing report…</h3></div></body></html>');
      } catch (e) {}
    } else {
      _nrWaShareInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '💬 Share via WhatsApp'; }
      alert('Popup blocked! Please allow popups for this site, then try again.');
      return;
    }

    var apiBase = (window.opener && window.opener.API) || '/api';

    rptSaveReportOnceForShare().then(function(id) {
      if (!id) {
        throw new Error('Could not save the report');
      }
      return fetch(apiBase + '/reports/' + id + '/download').then(function(res) {
        var contentType = res.headers.get('content-type') || '';
        if (!res.ok || contentType.indexOf('application/json') !== -1) {
          return res.json().catch(function() { return {}; }).then(function(data) {
            throw new Error(data.error || ('Server error (' + res.status + ')'));
          });
        }
        return res.blob();
      }).then(function(blob) {
        // Save the fetched PDF locally so it's ready to attach.
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        var safePatient = String(meta.patientName || 'Patient').replace(/[^A-Za-z0-9_-]+/g, '_');
        var safeTitle = String(meta.reportTitle || 'Lab_Report').replace(/[^A-Za-z0-9_-]+/g, '_');
        a.download = safePatient + '_' + safeTitle + '_RPT-' + String(id).padStart(5, '0') + '.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 10000);

        var message = 'Hi ' + (meta.patientName || '') + ', please find your lab report "' + (meta.reportTitle || 'Lab Report') + '" attached.';
        var waUrl = 'https://wa.me/' + waPhone + '?text=' + encodeURIComponent(message);
        if (waWin && !waWin.closed) {
          waWin.location.href = waUrl;
        } else {
          window.open(waUrl, '_blank');
        }
        alert('Report downloaded — attach it in the WhatsApp chat (📎) that just opened.');
      });
    }).catch(function(err) {
      console.error('Share via WhatsApp failed:', err);
      if (waWin && !waWin.closed) waWin.close();
      alert('Could not prepare the report for sharing: ' + (err && err.message ? err.message : err));
    }).finally(function() {
      _nrWaShareInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '💬 Share via WhatsApp'; }
    });
  }

  function rptRefreshRowStyle(tr) {
    var resultInput = tr.querySelector('.rpt-result-input');
    var refInput = tr.querySelector('.rpt-ref-input');
    var td = resultInput ? resultInput.closest('td') : null;
    if (td) {
      var cls = (window.opener && window.opener.calcResultRowClass)
        ? (window.opener.calcResultRowClass(resultInput.value, refInput ? refInput.value : '') || '')
        : '';
      td.classList.remove('rpt-high', 'rpt-low');
      td.style.fontWeight = cls ? '700' : '400';
      if (cls) td.classList.add(cls);
    }
    tr.classList.toggle('rpt-row-empty', !resultInput || resultInput.value.trim() === '');
    rptRefreshGroupHeader(tr);
  }

  // A subcategory header (e.g. "DIFFERENTIAL COUNT") should only print when at
  // least one of its rows has a result — keeps this in sync as results are typed.
  function rptRefreshGroupHeader(tr) {
    var secIdx = tr.getAttribute('data-sec');
    var gi = tr.getAttribute('data-grp');
    if (secIdx === null || gi === null) return;
    var body = tr.closest('tbody') || document;
    var groupRows = body.querySelectorAll('tr.rpt-result-row[data-sec="' + secIdx + '"][data-grp="' + gi + '"]');
    var anyResult = false;
    groupRows.forEach(function (r) {
      var inp = r.querySelector('.rpt-result-input');
      if (inp && inp.value.trim() !== '') anyResult = true;
    });
    var header = body.querySelector('tr.rpt-subgroup-row[data-sec="' + secIdx + '"][data-grp="' + gi + '"]');
    if (header) header.classList.toggle('rpt-row-empty', !anyResult);
  }

  function rptFieldInput(inputEl) {
    var tr = inputEl.closest('tr');
    if (!tr) return;
    var secIdx = parseInt(tr.getAttribute('data-sec'), 10);
    var gi = parseInt(tr.getAttribute('data-grp'), 10);
    var ri = parseInt(tr.getAttribute('data-row'), 10);
    var field = inputEl.getAttribute('data-field');
    var val = inputEl.value;
    if (window.opener && window.opener.nrUpdateRow) {
      window.opener.nrUpdateRow(secIdx, gi, ri, field, val);
    }
    rptRefreshRowStyle(tr);
  }

  // Enter/ArrowDown/ArrowUp jump between Result boxes — no mouse needed
  function rptResultKeyNav(e) {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    // Enter/Arrow means this value is "committed" — recalc right away in the
    // opener and pull the results back in immediately, instead of waiting out
    // the 250ms debounce, so a dependent calculated field (VLDL, A/G ratio,
    // absolute counts, etc.) shows up in this same preview without delay.
    if (window.opener && window.opener.nrRecalcTests) {
      try {
        var __updates = window.opener.nrRecalcTests();
        console.log('[rptResultKeyNav] nrRecalcTests() returned', __updates.length, 'update(s):', __updates);
        __updates.forEach(function(u) {
          var utr = _rptFindRow(u.sec, u.gi, u.ri);
          console.log('[rptResultKeyNav] looking for row', u.sec, u.gi, u.ri, '-> found tr?', !!utr);
          var uinput = utr && utr.querySelector('.rpt-result-input');
          if (!uinput) return;
          uinput.value = u.value;
          rptRefreshRowStyle(utr);
        });
        if (window.opener._nrApplyCalcUpdatesToForm) window.opener._nrApplyCalcUpdatesToForm(__updates);
      } catch (e) { console.error('[rptResultKeyNav] recalc failed:', e); }
    } else {
      console.log('[rptResultKeyNav] no window.opener.nrRecalcTests available — opener:', !!window.opener);
    }
    var inputs = Array.prototype.slice.call(document.querySelectorAll('.rpt-result-input'));
    var idx = inputs.indexOf(e.target);
    if (idx === -1) return;
    var nextIdx = idx + (e.key === 'ArrowUp' ? -1 : 1);
    if (nextIdx >= 0 && nextIdx < inputs.length) {
      inputs[nextIdx].focus();
      inputs[nextIdx].select();
    }
  }
  (function() {
    // Publish buildPages (declared further down, but hoisted to the top of
    // this IIFE) to the outer scope, since rptPrintAndSave()/
    // rptRepaginateForPrint() above are declared outside this IIFE and have
    // no other way to call it for the pre-print repagination pass.
    _rptBuildPagesRef = buildPages;

    // Catch up on any calculated fields (VLDL, A/G ratio, absolute counts, etc.)
    // right when this preview finishes loading. The opener already recalculates
    // before opening this window, but that snapshot can be stale by the time this
    // popup's own HTML is written (e.g. a result was still being typed, or a
    // calculated test's row was added right before printing) — so redo it here,
    // against the opener's live data, before pagination measures row heights.
    try {
      if (window.opener && !window.opener.closed && window.opener.nrRecalcTests) {
        var __calcUpdates = window.opener.nrRecalcTests();
        (__calcUpdates || []).forEach(function(u) {
          var tr = _rptFindRow(u.sec, u.gi, u.ri);
          var input = tr && tr.querySelector('.rpt-result-input');
          if (!input) return;
          input.value = u.value;
          if (typeof rptRefreshRowStyle === 'function') rptRefreshRowStyle(tr);
        });
      }
    } catch (e) { console.error('[preview load] recalc catch-up failed:', e); }

    var MM = 96 / 25.4;
    var PAGE_H_MM = 297;
    var FOOTER_TOP_PAD_MM = 4;
    var HEADER_BOTTOM_PAD_MM = 4;

    function measureFooterHeight(footerClone) {
      if (!footerClone) return 0;
      var prev = {
        position: footerClone.style.position,
        visibility: footerClone.style.visibility,
        opacity: footerClone.style.opacity,
        zIndex: footerClone.style.zIndex,
        top: footerClone.style.top,
        left: footerClone.style.left,
        transform: footerClone.style.transform
      };
      footerClone.style.position = 'relative';
      footerClone.style.visibility = 'hidden';
      footerClone.style.opacity = '0';
      footerClone.style.zIndex = '-1';
      footerClone.style.top = '';
      footerClone.style.left = '';
      footerClone.style.transform = '';
      var h = footerClone.getBoundingClientRect().height;
      footerClone.style.position = prev.position;
      footerClone.style.visibility = prev.visibility;
      footerClone.style.opacity = prev.opacity;
      footerClone.style.zIndex = prev.zIndex;
      footerClone.style.top = prev.top;
      footerClone.style.left = prev.left;
      footerClone.style.transform = prev.transform;
      return h;
    }

    function buildPages(forcePrintRebuild) {
      var measureWrap = document.getElementById('rpt-measure-wrap');
      var headerClone = document.getElementById('rpt-header-clone');
      var footerClone = document.getElementById('rpt-footer-clone');
      var container   = document.getElementById('rpt-pages-container');
      if (!measureWrap || !container) return;
      // Guard: measureWrap only gets display:none set at the very end of a
      // successful build (see below). If it is ALREADY display:none when we
      // get here, this call is happening on a REOPENED saved/reprinted report
      // (its saved HTML snapshot already has that inline style baked in from
      // when it was first built and saved), not a fresh live preview. In that
      // case #rpt-pages-container already holds the final static content, so
      // skip the rebuild entirely -- recomputing "children" below filters on
      // offsetParent, which is null for every descendant of a display:none
      // element, so a rebuild here would wipe the container and leave the
      // reopened report permanently blank.
      // forcePrintRebuild (set only by the pre-print pass in rptPrintAndSave)
      // bypasses this guard on purpose, since that pass explicitly re-shows
      // measureWrap/headerClone/footerClone right before calling buildPages()
      // again with the person's latest typed-in values.
      if (measureWrap.style.display === "none" && !forcePrintRebuild) return;

      var footerHTML = footerClone ? footerClone.innerHTML : '';
      var hasFooter = !!(footerHTML && footerHTML.trim());
      var footerHpx  = hasFooter ? measureFooterHeight(footerClone) : 0;
      if (hasFooter && footerHpx <= 0 && footerClone && footerClone.innerHTML.trim()) {
        var innerBar = footerClone.querySelector('.rpt-footer-bar');
        if (innerBar) {
          var cs = window.getComputedStyle(innerBar);
          var minH = parseFloat(cs.minHeight) || 0;
          var paddingH = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
          footerHpx = Math.max(minH, paddingH, 30 * MM);
        } else {
          footerHpx = 30 * MM;
        }
      }
      var footerHmm  = footerHpx / MM;
      var footerSlotHmm = hasFooter ? (footerHmm + FOOTER_TOP_PAD_MM) : 0;

      // Header slot — measured the same way as the footer, and reserved on
      // EVERY page (not just wherever it would have landed in the flowing
      // content). If the header is toggled off its markup is still present
      // (wrapped in visibility:hidden by the caller), so this height still
      // reflects the reserved blank space, kept consistent across all pages.
      var headerHTML = headerClone ? headerClone.innerHTML : '';
      var hasHeader = !!(headerHTML && headerHTML.trim());
      var headerHpx = hasHeader ? measureFooterHeight(headerClone) : 0;
      var headerMinPx = ${(fdDesign.headerHeight || 80)};
      if (hasHeader && headerHpx <= 0) {
        headerHpx = headerMinPx;
      }
      var headerHmm = headerHpx / MM;
      var headerSlotHmm = hasHeader ? (headerHmm + HEADER_BOTTOM_PAD_MM) : 0;

      function getUsableHpx(pageIndex) {
        return (PAGE_H_MM - footerSlotHmm - headerSlotHmm - 2) * MM;
      }

      var children = Array.from(measureWrap.querySelectorAll(':scope > .rpt-wrap > *')).filter(function(el) {
        return !el.classList.contains('rpt-watermark-wrap') && !el.classList.contains('rpt-custom-img-layer') && el.offsetParent !== null;
      });

      function measureNodeHeight(node) {
        var probe = document.createElement('div');
        probe.style.position = 'absolute';
        probe.style.left = '0';
        probe.style.top = '0';
        probe.style.width = 'calc(210mm - 24mm)';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        var clone = node.cloneNode(true);
        // Rows still blank of a result collapse to display:none at actual
        // print time (see the .rpt-row-empty rule under @media print), but
        // on screen — where this measurement normally runs — they are
        // still fully rendered with their input boxes. During the very
        // first, live-editing build we deliberately measure them at their
        // full on-screen height: the person hasn't finished typing yet, and
        // treating still-blank rows as zero height here would under-allocate
        // pages and clip/hide rows they haven't gotten to. Only the
        // dedicated pre-print rebuild (forcePrintRebuild, run once against
        // the final typed-in values right before window.print()) collapses
        // them, so that pass — and only that pass — matches what will
        // actually print and lets later content (e.g. interpretations) move
        // up into the space blank rows free up.
        if (forcePrintRebuild) {
          (clone.classList && clone.classList.contains('rpt-row-empty') ? [clone] : []).concat(
            Array.prototype.slice.call(clone.querySelectorAll ? clone.querySelectorAll('.rpt-row-empty') : [])
          ).forEach(function(el) { el.style.display = 'none'; });
        }
        probe.appendChild(clone);
        measureWrap.appendChild(probe);
        var h = probe.getBoundingClientRect().height;
        measureWrap.removeChild(probe);
        return h;
      }

      function splitTableChild(child, targetPx) {
        var table = (child.matches && child.matches('table.rpt-table')) ? child : child.querySelector('table.rpt-table');
        var tbody = table && table.querySelector('tbody');
        if (!tbody) return null;
        var rows = Array.from(tbody.querySelectorAll(':scope > tr'));
        if (rows.length < 2) return null;

        function isHeadingRow(tr) {
          return tr.classList.contains('rpt-section-row') || tr.classList.contains('rpt-subgroup-row');
        }

        var first = child.cloneNode(true);
        var rest = child.cloneNode(true);
        var firstTable = (first.matches && first.matches('table.rpt-table')) ? first : first.querySelector('table.rpt-table');
        var restTable = (rest.matches && rest.matches('table.rpt-table')) ? rest : rest.querySelector('table.rpt-table');
        var firstBody = firstTable && firstTable.querySelector('tbody');
        var restBody = restTable && restTable.querySelector('tbody');
        if (!firstBody || !restBody) return null;
        firstBody.innerHTML = '';
        restBody.innerHTML = '';

        var added = 0;
        for (var i = 0; i < rows.length; i++) {
          firstBody.appendChild(rows[i].cloneNode(true));
          var h = measureNodeHeight(first);
          if (h > targetPx && added > 0) {
            firstBody.removeChild(firstBody.lastElementChild);
            break;
          }
          if (h > targetPx && added === 0) {
            firstBody.innerHTML = '';
            return null;
          }
          added++;
        }
        if (added === 0) return null;

        // Don't strand a category/sub-group heading as the last thing on a
        // page with no result rows under it — walk back past any trailing
        // heading row(s) so the break lands before them instead.
        while (added > 0 && isHeadingRow(firstBody.lastElementChild)) {
          firstBody.removeChild(firstBody.lastElementChild);
          added--;
        }
        if (added === 0) return null;

        for (var j = added; j < rows.length; j++) {
          restBody.appendChild(rows[j].cloneNode(true));
        }

        // Keep post-table interpretation/notes only with the final chunk.
        var firstTableNode = (first.matches && first.matches('table.rpt-table')) ? first : first.querySelector('table.rpt-table');
        if (firstTableNode) {
          var next = firstTableNode.nextSibling;
          while (next) {
            var rm = next;
            next = next.nextSibling;
            if (rm.parentNode) rm.parentNode.removeChild(rm);
          }
        }

        if (!restBody.children.length) return { first: first, rest: null };
        return { first: first, rest: rest };
      }

      function splitNotesChild(child, targetPx) {
        var entries = Array.from(child.querySelectorAll('.rpt-interp-entry'));
        if (entries.length < 2) return null;

        var first = child.cloneNode(true);
        var rest = child.cloneNode(true);
        var firstEntries = Array.from(first.querySelectorAll('.rpt-interp-entry'));
        var restEntries = Array.from(rest.querySelectorAll('.rpt-interp-entry'));
        if (!firstEntries.length || !restEntries.length) return null;

        var firstParent = firstEntries[0].parentNode;
        var restParent = restEntries[0].parentNode;
        if (!firstParent || !restParent) return null;

        firstEntries.forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });
        restEntries.forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });

        function findEndMarker(parent) {
          var nodes = Array.from(parent.querySelectorAll('div, p, span'));
          for (var k = 0; k < nodes.length; k++) {
            var txt = (nodes[k].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (txt === 'end of the report') return nodes[k];
          }
          return null;
        }
        function appendBeforeEnd(parent, node) {
          var endMarker = findEndMarker(parent);
          if (endMarker && endMarker.parentNode === parent) parent.insertBefore(node, endMarker);
          else parent.appendChild(node);
        }

        var added = 0;
        for (var i = 0; i < entries.length; i++) {
          var insertedNode = entries[i].cloneNode(true);
          appendBeforeEnd(firstParent, insertedNode);
          var h = measureNodeHeight(first);
          if (h > targetPx && added > 0) {
            if (insertedNode.parentNode) insertedNode.parentNode.removeChild(insertedNode);
            break;
          }
          if (h > targetPx && added === 0) {
            firstParent.innerHTML = '';
            return null;
          }
          added++;
        }
        if (added === 0) return null;

        for (var j = added; j < entries.length; j++) {
          appendBeforeEnd(restParent, entries[j].cloneNode(true));
        }

        function stripEndOfReport(root) {
          Array.from(root.querySelectorAll('div, p, span')).forEach(function(n) {
            var txt = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (txt === 'end of the report') {
              if (n.parentNode) n.parentNode.removeChild(n);
            }
          });
        }

        // Keep the closing "End of the report" only on the final notes chunk.
        if (restParent.children.length) {
          stripEndOfReport(first);
        }

        if (!restParent.children.length) return { first: first, rest: null };
        return { first: first, rest: rest };
      }

      var pages = [];
      var bucket = [];
      var used = 0;
      var pageIndex = 0;
      var queue = children.map(function(el) { return el.cloneNode(true); });

      while (queue.length) {
        var child = queue.shift();
        var h = measureNodeHeight(child);

        // Near-zero-height nodes (stray spacers, empty wrappers, collapsed
        // margins) shouldn't be able to trigger a page break on their own —
        // just carry them onto the current page without affecting the
        // overflow decision below.
        if (h < 1) {
          bucket.push(child);
          continue;
        }

        var pageUsableHpx = getUsableHpx(pageIndex);
        var remaining = pageUsableHpx - used;

        if (bucket.length > 0 && h > remaining) {
          var splitFit = splitTableChild(child, remaining);
          if (!splitFit) splitFit = splitNotesChild(child, remaining);
          if (splitFit) {
            var firstH = measureNodeHeight(splitFit.first);
            bucket.push(splitFit.first);
            used += firstH;
            pages.push(bucket);
            bucket = [];
            used = 0;
            pageIndex++;
            if (splitFit.rest) queue.unshift(splitFit.rest);
            continue;
          }
          pages.push(bucket);
          bucket = [];
          used = 0;
          pageIndex++;
          queue.unshift(child);
          continue;
        }

        if (h > pageUsableHpx) {
          var splitFull = splitTableChild(child, pageUsableHpx);
          if (!splitFull) splitFull = splitNotesChild(child, pageUsableHpx);
          if (splitFull) {
            bucket.push(splitFull.first);
            pages.push(bucket);
            bucket = [];
            used = 0;
            pageIndex++;
            if (splitFull.rest) queue.unshift(splitFull.rest);
            continue;
          }
        }

        bucket.push(child);
        used += h;
      }
      if (bucket.length) pages.push(bucket);

      // Safety net: if the last page(s) ended up with no actual visible
      // content, drop them instead of printing a blank trailing page.
      function pageHasVisibleContent(pageChildren) {
        for (var i = 0; i < pageChildren.length; i++) {
          var el = pageChildren[i];
          if ((el.textContent || '').replace(/\s+/g, '') !== '') return true;
          if (el.querySelector && el.querySelector('img, table, canvas, svg')) return true;
        }
        return false;
      }
      while (pages.length > 1 && !pageHasVisibleContent(pages[pages.length - 1])) {
        pages.pop();
      }

      container.innerHTML = '';

      pages.forEach(function(pageChildren, idx) {
        var pageWrap = document.createElement('div');
        pageWrap.className = 'rpt-page-wrap';

        // Header slot — same content (or same reserved blank space) on every page.
        if (hasHeader) {
          var hDiv = document.createElement('div');
          hDiv.className = 'rpt-page-header';
          hDiv.style.position = 'absolute';
          hDiv.style.top = '0';
          hDiv.style.left = '12mm';
          hDiv.style.right = '12mm';
          hDiv.style.height = headerSlotHmm + 'mm';
          hDiv.style.overflow = 'hidden';
          hDiv.style.boxSizing = 'border-box';
          hDiv.style.pageBreakInside = 'avoid';
          hDiv.style.breakInside = 'avoid';
          hDiv.innerHTML = headerHTML;
          pageWrap.appendChild(hDiv);
        }

        var contentDiv = document.createElement('div');
        contentDiv.className = 'rpt-page-content';
        contentDiv.style.top = headerSlotHmm + 'mm';
        contentDiv.style.bottom = footerSlotHmm + 'mm';
        contentDiv.style.height = (PAGE_H_MM - footerSlotHmm - headerSlotHmm) + 'mm';
        pageChildren.forEach(function(c) { contentDiv.appendChild(c); });
        pageWrap.appendChild(contentDiv);

        if (footerHTML) {
          var fDiv = document.createElement('div');
          fDiv.className = 'rpt-page-footer';
          fDiv.style.height = footerSlotHmm + 'mm';
          fDiv.style.paddingTop = FOOTER_TOP_PAD_MM + 'mm';
          fDiv.style.boxSizing = 'border-box';
          fDiv.innerHTML = footerHTML;
          pageWrap.appendChild(fDiv);
        }

        container.appendChild(pageWrap);
      });

      measureWrap.style.display = 'none';
      if (headerClone) headerClone.style.display = 'none';
      if (footerClone) footerClone.style.display = 'none';
    }

    function runBuildPages() {
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          buildPages();
        });
      });
    }

    if (document.readyState === 'complete') { runBuildPages(); }
    else { window.addEventListener('load', runBuildPages); }
  })();
  <\/script>
  </body></html>`;
 
  const w = window.open('', '_blank');
  const rDate = reportedRaw ? reportedRaw.split('T')[0] : new Date().toISOString().split('T')[0];
  const rTitle = fdDesign.reportTitle || 'Test Report';
  if (w) {
    w.document.open();
    w.document.write(reportBodyHtml);
    w.document.close();
    w.focus();
    window._nrPreviewWin = w; // lets nrUpdateRow push auto-calculated values back in after the debounce
    // Results are typed directly into this preview, so there's nothing worth
    // saving yet at open time — save once, with whatever's actually been
    // filled in, when the person clicks Print inside the preview (see
    // rptPrintAndSave() in the popup's own script, and nrSaveReportFromPreview
    // below). This also avoids creating two report records (one empty snapshot
    // at open time, one real one later) for a single report.
    w._nrSaveMeta = { patientId, patientName, patientAge, patientGender, patientPhone,
      patientAddress, patientNo, doctorId, doctorName, reportTitle: rTitle, reportDate: rDate };
  } else {
    toast('Popup blocked! Please allow popups for this site.', 'error');
  }
}

// Called once by the print-preview popup — either via rptPrintAndSave right
// before window.print(), or via rptShareWhatsApp when sharing without
// printing — with the live HTML from that window, i.e. after whatever the
// person actually typed into the Result boxes, not a snapshot from before
// they'd entered anything. Returns the saved report's id (or null on
// failure) so the popup can use it to fetch/share the generated PDF.
async function nrSaveReportFromPreview(meta, htmlContent) {
  if (!meta) return null;
  const data = await apiFetch(`${API}/reports/save-workflow`, {
    method: 'POST',
    body: JSON.stringify({
      patient_id: meta.patientId,
      patient_name: meta.patientName,
      patient_age: meta.patientAge,
      patient_gender: meta.patientGender,
      patient_phone: meta.patientPhone,
      patient_address: meta.patientAddress,
      patient_no: meta.patientNo,
      doctor_id: meta.doctorId,
      doctor_name: meta.doctorName,
      report_title: meta.reportTitle,
      report_date: meta.reportDate,
      html_content: htmlContent
    })
  });
  if (document.getElementById('page-reports').classList.contains('active')) {
    loadReports();
  }
  return data ? data.id : null;
}

// Guards against a second click firing while the first request is still in
// flight — previewAndPrintReport does several sequential awaited lookups
// (settings, then one per test for interpretations) before it opens the
// preview and saves, so an impatient double-click could otherwise kick off
// the whole flow twice and save the same report twice.
let _nrPrintInFlight = false;
async function previewAndPrintReport() {
  if (_nrPrintInFlight) return;
  _nrPrintInFlight = true;
  const btn = document.querySelector('#nr-footer-step1 .btn-primary');
  if (btn) { btn.disabled = true; btn.dataset._origText = btn.dataset._origText || btn.textContent; btn.textContent = 'Preparing report…'; }
  try {
    await _previewAndPrintReportImpl();
  } finally {
    _nrPrintInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset._origText; }
  }
}
async function _previewAndPrintReportImpl() {
  nrRecalcTests(); // catch up on any calculated fields (e.g. tests added after results were already typed once)
  const patSel = document.getElementById('nr-patient');
  const patOpt = patSel.options[patSel.selectedIndex];

  let patientId = null, patientName, patientAge, patientGender, patientPhone, patientAddress;

  if (_nrPatientMode === 'manual') {
    patientName    = (document.getElementById('nr-manual-name').value || '').trim();
    patientAge     = (document.getElementById('nr-manual-age').value  || '').trim();
    patientGender  = document.getElementById('nr-manual-gender').value || '—';
    patientPhone   = (document.getElementById('nr-manual-phone').value   || '').trim();
    patientAddress = (document.getElementById('nr-manual-address').value || '').trim();
    const manualGreeting = document.getElementById('nr-manual-greeting').value || '';
    if (!patientName) { toast('Please enter patient name', 'error'); return; }
    if (patientAge && (isNaN(patientAge) || Number(patientAge) < 0)) { toast('Please enter a valid age', 'error'); document.getElementById('nr-manual-age').focus(); return; }
    if (!patientGender || patientGender === '—') { toast('Patient gender is required', 'error'); document.getElementById('nr-manual-gender').focus(); return; }
    patientName = prefixedName(patientName, patientGender, patientAge, manualGreeting);
  } else {
    if (!patOpt.value) { toast('Please select a patient', 'error'); return; }
    patientId      = patOpt.value;
    patientAge     = patOpt.dataset.age    || '—';
    patientGender  = patOpt.dataset.gender || '—';
    patientName    = prefixedName(patOpt.text, patientGender, patientAge, patOpt.dataset.greeting);
    patientPhone   = patOpt.dataset.phone  || '';
    patientAddress = patOpt.dataset.address || '';
  }

  const nrDoctorInput = document.getElementById('nr-doctor');
  const nrDoctorSelect = document.getElementById('nr-doctor-select');
  const doctorName = (_nrDoctorMode === 'manual'
    ? (nrDoctorInput?.value.trim() || '')
    : (nrDoctorSelect?.value.trim() || '')
  ) || '—';

  let doctorId = _nrDoctorMode === 'list' && nrDoctorSelect ? nrDoctorSelect.options[nrDoctorSelect.selectedIndex]?.dataset.id : null;

  const settings = await apiFetch(`${API}/settings`) || {};
  if (settings.form_design) {
    try { Object.assign(fdDesign, JSON.parse(settings.form_design)); fdMigrateCustomImages(); if (fdDesign.logoDataUrl) fdLogoDataUrl = fdDesign.logoDataUrl; } catch(e) {}
  }
  const labName  = settings.lab_name    || 'Diagnostic Lab';
  const labAddr  = settings.lab_address || '';
  const labPhone = settings.lab_phone   || '';
  const labEmail = settings.lab_email   || '';

  const patientNo = document.getElementById('nr-patient-no').value || (patOpt && patOpt.value ? patOpt.value : '');
  const opIp = document.getElementById('nr-op-ip')?.value || (patOpt && patOpt.dataset ? (patOpt.dataset.opIp || '') : '');

  const collectedRaw = document.getElementById('nr-collected').value;
  const reportedRaw  = document.getElementById('nr-reported').value;

  function fmtDT(s) {
    if (!s) return '—';
    const d = new Date(s);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = d.getFullYear();
    const hh = d.getHours() % 12 || 12;
    const min = String(d.getMinutes()).padStart(2,'0');
    const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
    return `${dd}-${mm}-${yy} ${hh}:${min} ${ampm}`;
  }

  /* Build test table rows — every selected test gets an editable result/unit/ref
     row (typed directly in the preview). Rows still empty of a result are marked
     .rpt-row-empty so they drop out of the physical printout (see @media print
     rule below) while staying visible, on screen, for entry. */
  function buildTableRows() {
    if (nrSections.length === 0) return '<tr><td colspan="4" style="text-align:center;padding:12px;color:#888">No test data entered</td></tr>';
    let html = '';
    let anyRow = false;

    nrSections.forEach(sec => {
      let secHtml = '';
      const sectionLabel = sec.type === 'CUSTOM'
        ? (sec.groups[0]?.group || 'CUSTOM')
        : sec.type;

      sec.groups.forEach((grp, gi) => {
        if (grp.rows.length === 0) return;

        const showSubGroup = sec.type !== 'CUSTOM' && grp.group && grp.group !== sec.type && grp.group !== '(General)';
        if (showSubGroup) {
          const groupHasResult = grp.rows.some(r => r.result !== undefined && String(r.result).trim() !== '');
          secHtml += `<tr class="rpt-subgroup-row${groupHasResult ? '' : ' rpt-row-empty'}" data-sec="${sec.idx}" data-grp="${gi}">
          <td class="rpt-test-name" colspan="4" style="font-weight:700;background:#f5f5f5;font-size:10.5px">${grp.group}</td>
        </tr>`;
        }

        grp.rows.forEach((row, ri) => {
          const resultClass = calcResultRowClass(row.result, row.ref);
          const nameClass = row.name.startsWith('\u2014') || row.name.startsWith('-') ? 'rpt-subtest' : 'rpt-test-name';
          const hasResult = row.result !== undefined && String(row.result).trim() !== '';
          secHtml += `<tr class="rpt-result-row${hasResult ? '' : ' rpt-row-empty'}" data-sec="${sec.idx}" data-grp="${gi}" data-row="${ri}">
            <td class="${nameClass}">${row.name || '\u2014'}</td>
            <td class="rpt-result-td ${resultClass}" style="font-weight:${resultClass?'700':'400'}">
              <input type="text" class="rpt-result-input" data-field="result" value="${escAttr(row.result)}" placeholder="Enter result"
                oninput="rptFieldInput(this)" onkeydown="rptResultKeyNav(event)"
                style="width:100%;border:1.5px solid #1a5276;border-radius:4px;padding:4px 6px;font:inherit;font-weight:inherit;color:inherit;background:#fffef0"/>
            </td>
            <td>
              <input type="text" class="rpt-unit-input" data-field="unit" value="${escAttr(row.unit)}" placeholder="unit"
                oninput="rptFieldInput(this)"
                style="width:100%;border:1px solid #ccc;border-radius:3px;padding:3px 5px;font-size:11px;color:#555;background:#fffef0"/>
            </td>
            <td>
              <input type="text" class="rpt-ref-input" data-field="ref" value="${escAttr(row.ref)}" placeholder="range"
                oninput="rptFieldInput(this)"
                style="width:100%;border:1px solid #ccc;border-radius:3px;padding:3px 5px;font-size:11px;color:#555;background:#fffef0"/>
            </td>
          </tr>`;
          anyRow = true;

          // Constant reference table (e.g. HbA1c's Non Diabetics / Goal / Good
          // Control / Action Suggested) — printed as its own small boxed table
          // right under the result row it belongs to. Only shown once a result
          // has actually been entered, same as the row it's attached to, and
          // hidden the same way (rpt-row-empty) so toggling the result blank
          // hides this along with it instead of leaving it stranded.
          if (row._refTable && row._refTable.length) {
            const refRowsHtml = row._refTable.map(r => `
              <tr>
                <td style="border:1px solid #999;padding:4px 10px;font-weight:600;background:#f7f7f7;white-space:nowrap">${escAttr(r.label)}</td>
                <td style="border:1px solid #999;padding:4px 10px">${escAttr(r.value)}</td>
              </tr>`).join('');
            secHtml += `<tr class="rpt-refnote-row${hasResult ? '' : ' rpt-row-empty'}" data-sec="${sec.idx}" data-grp="${gi}" data-row="${ri}">
              <td colspan="4" style="border:none;padding:2px 8px 12px 8px">
                <table style="width:auto;border-collapse:collapse;font-size:11px">
                  <tbody>${refRowsHtml}</tbody>
                </table>
              </td>
            </tr>`;
          }
        });
      });

      if (secHtml) {
        html += `<tr class="rpt-section-row"><td colspan="4">${sectionLabel}</td></tr>`;
        html += secHtml;
      }
    });

    if (!anyRow) return '<tr><td colspan="4" style="text-align:center;padding:12px;color:#888">No tests selected</td></tr>';
    return html;
  }

  // ── Collect interpretations from all rows ──
  _interpPickerMap = {};
  nrSections.forEach(sec => {
    sec.groups.forEach(grp => {
      grp.rows.forEach(row => {
        if (row._interpretation && row.name) _interpPickerMap[row.name] = row._interpretation;
      });
    });
  });
  // Fetch interpretations from test catalog for rows that don't already have one
  for (const sec of nrSections) {
    for (const grp of sec.groups) {
      // Look up group-level interpretation
      const grpInfo = await getTestRangeForGender(grp.group, '');
      if (grpInfo?.interpretation) _interpPickerMap[grp.group] = grpInfo.interpretation;
      // Look up row-level interpretations for tests not already in the map
      for (const row of grp.rows) {
        if (!row.name) continue;
        // Constant reference table (e.g. HbA1c) needs looking up regardless of
        // whether an interpretation was already cached for this row, so this
        // lookup can't be skipped by the same "already have it" check above.
        if (!row._refTable) {
          const rt = await getTestRangeForGender(row.name);
          if (rt?.refTable) row._refTable = rt.refTable;
          if (!_interpPickerMap[row.name] && rt?.interpretation) {
            _interpPickerMap[row.name] = rt.interpretation;
            row._interpretation = rt.interpretation;
          }
        }
      }
    }
  }

  // ── Inject fdDesign CSS ──
  let _dynStyle = document.getElementById('fd-dynamic-print-css');
  if (!_dynStyle) {
    _dynStyle = document.createElement('style');
    _dynStyle.id = 'fd-dynamic-print-css';
    document.head.appendChild(_dynStyle);
  }
  _dynStyle.textContent = fdBuildCSS(fdDesign);

  // ── Store print state for use after picker confirms ──
  _interpPrintState = { fdDesign: { ...fdDesign }, patientName, patientAge, patientGender,
    patientPhone, patientAddress, patientNo, opIp, doctorName, collectedRaw, reportedRaw,
    labName, labAddr, labPhone, labEmail, buildTableRows, fmtDT, patientId, doctorId };

  // ── If no interpretations at all, print immediately ──
  if (Object.keys(_interpPickerMap).length === 0) {
    _doOpenPrintWindow(fdDesign, patientName, patientAge, patientGender, patientPhone,
                       patientNo, doctorName, collectedRaw, reportedRaw,
                       labName, labAddr, labPhone, labEmail, buildTableRows, fmtDT, '', patientId, doctorId, patientAddress, opIp);
    return;
  }

  // ── Populate picker modal and open it ──
  const listEl = document.getElementById('interp-picker-list');
  listEl.innerHTML = Object.entries(_interpPickerMap).map(([testName, note]) => `
    <label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;
                  border:1px solid var(--border);border-radius:8px;cursor:pointer;
                  background:var(--card);transition:background .15s"
           onmouseover="this.style.background='var(--hover)'" onmouseout="this.style.background='var(--card)'">
      <input type="checkbox" value="${testName.replace(/"/g,'&quot;')}" checked
             style="margin-top:2px;accent-color:var(--primary);width:15px;height:15px;flex-shrink:0"/>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:12px;color:var(--text);margin-bottom:3px">${testName}</div>
        <div style="font-size:11px;color:var(--muted);line-height:1.5;
                    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
          ${note}
        </div>
      </div>
    </label>`).join('');

  openModal('interp-picker-modal');
}

function closePrintPreview() {
  const printArea = document.getElementById('print-area');
  printArea.classList.remove('preview-mode');
  printArea.innerHTML = '';
  document.body.style.overflow = '';
}
 
 
/* ═══════════════════════════════════════════════════════════════
   ENHANCED TEST CATALOG FEATURES
   - Test name autocomplete with unit/range auto-fill
   - Gender-aware reference range selection
   - Interpretation on printed report
═══════════════════════════════════════════════════════════════ */
 
// Full unit list from New Care Lab documents
const ALL_UNITS = [
  '%', '/HPF', 'Absent', 'Cells/cumm', 'cells/mL', 'Cubic Micron', 'EU/mL',
  'fL', 'g/dl', 'gm/dL', 'gms%', 'Hpf', 'Index', 'IU/L', 'IU/mL',
  'Lakhs/Cumm', 'mcg/dL', 'mEq/L', 'mg%', 'mg/dl', 'mg/dL', 'mg/l', 'mg/L',
  'millions/cumm', 'Minutes', 'mIU/L', 'mIU/mL', 'mm', 'mm/1hour', 'mmol/L',
  'ng/dL', 'ng/mL', 'pg', 'pg/dl', 'pg/mL', 'Seconds', 'text', 'U/L',
  'U/mL', 'ug/dl', 'UI/mL', 'µg/dL', 'µIU/mL'
];
 
// Fetch test catalog and return reference range for a given gender
async function getTestRangeForGender(testName) {
  try {
    const data = await fetchTestByNameSilent(`${API}/tests/by-name?name=${encodeURIComponent(testName)}`);
    if (!data || !data.test_name) return null;
    const range = data.normal_text
      || (data.normal_min != null && data.normal_max != null ? `${data.normal_min} - ${data.normal_max}` : '')
      || (data.normal_min != null ? `> ${data.normal_min}` : '')
      || (data.normal_max != null ? `< ${data.normal_max}` : '');
    // ref_table holds a fixed, patient-independent set of label/value rows (e.g.
    // HbA1c's Non Diabetics / Goal / Good Control / Action Suggested targets) that
    // gets printed as a small table under this test's result row. Parsed here and
    // passed through as refTable; malformed/empty JSON just yields no extra table.
    let refTable = null;
    if (data.ref_table) {
      try {
        const parsed = JSON.parse(data.ref_table);
        if (Array.isArray(parsed) && parsed.length) refTable = parsed;
      } catch (e) { /* ignore malformed ref_table */ }
    }
    return {
      unit:           data.unit || '',
      amount:         data.amount || 0,
      interpretation: data.interpretation || '',
      refTable,
      range,
    };
  } catch (e) { return null; }
}
 
// Override addNrRow to include autocomplete on test name inputs
const _origRenderNrSections = renderNrSections;
// Patch renderNrSections to inject autocomplete after render
const _patchedRender = function() {
  _origRenderNrSections();
  // After render, attach autocomplete to all test name inputs
  setTimeout(() => attachTestAutocomplete(), 50);
};
// Replace globally
window.renderNrSections = _patchedRender;
 
// Also patch openNewTestReport to use patched render
const _origOpenNTR = openNewTestReport;
window.openNewTestReport = function() {
  _origOpenNTR();
  setTimeout(() => attachTestAutocomplete(), 200);
};
 
// Auto-complete for test name fields in the report entry form
function attachTestAutocomplete() {
  document.querySelectorAll('#nr-sections input[placeholder="Test name"]').forEach(inp => {
    if (inp._autocompleteAttached) return;
    inp._autocompleteAttached = true;
    inp.addEventListener('blur', async function() {
      const name = this.value.trim();
      if (!name) return;
      // Figure out secIdx and gi from parent tr
      const tr = this.closest('tr');
      const tbody = tr.closest('tbody');
      const ri = Array.from(tbody.rows).indexOf(tr);
      const section = this.closest('[data-idx]');
      const secIdx = parseInt(section.dataset.idx);
      const tables = section.querySelectorAll('table');
      let gi = 0;
      for (let i = 0; i < tables.length; i++) {
        if (tables[i].contains(tr)) { gi = i; break; }
      }
 
      // Get patient gender
      const patSel = document.getElementById('nr-patient');
      const gender = patSel?.options[patSel.selectedIndex]?.dataset.gender || '';
 
      const info = await getTestRangeForGender(name);
      if (info) {
        // Fill unit
        const unitInp = tr.querySelectorAll('input')[2];
        if (unitInp && !unitInp.value) unitInp.value = info.unit;
        // Fill range
        const rangeInp = tr.querySelectorAll('input')[3];
        if (rangeInp && !rangeInp.value) rangeInp.value = info.range;
        // Update state
        nrUpdateRow(secIdx, gi, ri, 'unit', unitInp?.value || '');
        nrUpdateRow(secIdx, gi, ri, 'ref', rangeInp?.value || '');
        if (info.interpretation) {
          nrUpdateRow(secIdx, gi, ri, '_interpretation', info.interpretation);
        }
      }
    });
  });
}
 
 
/* ═══════════════════════════════════════════════════════════════
   INTERPRETATIONS PAGE
═══════════════════════════════════════════════════════════════ */
let _allInterpTests = [];
 
async function loadInterpretations() {
  const tests = await apiFetch(`${API}/tests`);
  if (tests) _allTests = tests; // fix: keep cache in sync so edit works
  _allInterpTests = (tests || []).filter(t => t.interpretation);
  renderInterpretations(_allInterpTests);
}
 
function renderInterpretations(list) {
  const el = document.getElementById('interp-list');
  if (!list.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">No interpretations found. Click <b>＋ Add</b> to add one.</div>';
    return;
  }
  el.innerHTML = list.map(t => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:10px;background:var(--card)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-weight:600;font-size:14px;color:var(--primary)">${t.test_name}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:2px 10px;color:var(--muted)">${t.category}</span>
          <button class="btn btn-sm btn-outline" style="padding:2px 10px;font-size:11px" data-id="${t.id}" data-name="${t.test_name.replace(/"/g,'&quot;')}" data-interp="${(t.interpretation||'').replace(/"/g,'&quot;').replace(/\n/g,'&#10;')}" onclick="openEditInterpFromBtn(this)">✏ Edit</button>
          <button class="btn btn-sm btn-danger" style="padding:2px 10px;font-size:11px" onclick="deleteInterp(${t.id},'${t.test_name.replace(/'/g,"\\'")}')">🗑 Delete</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text);line-height:1.65;white-space:pre-wrap">${t.interpretation}</div>
    </div>
  `).join('');
}
 
function filterInterpretations(q) {
  const filtered = _allInterpTests.filter(t =>
    t.test_name.toLowerCase().includes(q.toLowerCase()) ||
    (t.interpretation || '').toLowerCase().includes(q.toLowerCase())
  );
  renderInterpretations(filtered);
}
 
/* ── Reference Tables page ──────────────────────────────────────
   Dedicated section (separate from the Test Catalog edit modal) for
   browsing/adding/editing the fixed, patient-independent reference
   tables attached to tests (e.g. HbA1c's Non Diabetics / Goal / Good
   Control / Action Suggested rows). Reuses the same test_catalog.ref_table
   field and the renderRefTableRows/addRefTableRow/collectRefTableRows
   editor helpers defined near saveTest(). */
let _allRefTableTests = [];

function _parseRefTable(t) {
  if (!t.ref_table) return [];
  try {
    const parsed = JSON.parse(t.ref_table);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

async function loadRefTables() {
  const tests = await apiFetch(`${API}/tests`);
  if (tests) _allTests = tests; // keep shared cache in sync, same as loadInterpretations()
  _allRefTableTests = (tests || []).filter(t => _parseRefTable(t).length);
  renderRefTableList(_allRefTableTests);
}

function renderRefTableList(list) {
  const el = document.getElementById('reftable-list');
  if (!list.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">No reference tables found. Click <b>＋ Add</b> to add one.</div>';
    return;
  }
  el.innerHTML = list.map(t => {
    const rows = _parseRefTable(t);
    const rowsHtml = rows.map(r => `
      <tr>
        <td style="border:1px solid var(--border);padding:4px 10px;font-weight:600;background:var(--bg)">${escAttr(r.label)}</td>
        <td style="border:1px solid var(--border);padding:4px 10px">${escAttr(r.value)}</td>
      </tr>`).join('');
    return `
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:10px;background:var(--card)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600;font-size:14px;color:var(--primary)">${t.test_name}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:2px 10px;color:var(--muted)">${t.category||''}</span>
          <button class="btn btn-sm btn-outline" style="padding:2px 10px;font-size:11px" onclick="openEditRefTable(${t.id})">✏ Edit</button>
          <button class="btn btn-sm btn-danger" style="padding:2px 10px;font-size:11px" onclick="deleteRefTable(${t.id},'${t.test_name.replace(/'/g,"\\'")}')">🗑 Delete</button>
        </div>
      </div>
      <table style="border-collapse:collapse;font-size:12px"><tbody>${rowsHtml}</tbody></table>
    </div>`;
  }).join('');
}

function filterRefTables(q) {
  const filtered = _allRefTableTests.filter(t =>
    t.test_name.toLowerCase().includes(q.toLowerCase()) ||
    _parseRefTable(t).some(r => (r.label||'').toLowerCase().includes(q.toLowerCase()) || (r.value||'').toLowerCase().includes(q.toLowerCase()))
  );
  renderRefTableList(filtered);
}

function openEditRefTable(id) {
  const t = _allTests.find(x => x.id === id) || _allRefTableTests.find(x => x.id === id);
  if (!t) { toast('Could not find test', 'error'); return; }
  document.getElementById('ert-id').value   = t.id;
  document.getElementById('ert-name').value = t.test_name;
  renderRefTableRows('ert', _parseRefTable(t));
  openModal('edit-reftable-modal');
}

async function saveEditRefTable() {
  const id = document.getElementById('ert-id').value;
  const rows = collectRefTableRows('ert');
  if (!rows.length) { toast('Add at least one label/value row', 'error'); return; }
  let existing = _allTests.find(x => x.id === parseInt(id));
  if (!existing) {
    const fresh = await apiFetch(`${API}/tests`);
    if (fresh) { _allTests = fresh; existing = _allTests.find(x => x.id === parseInt(id)); }
  }
  if (!existing) { toast('Could not find test', 'error'); return; }
  const payload = {
    test_name:      existing.test_name,
    category:       existing.category,
    sub_category:   existing.sub_category,
    unit:           existing.unit,
    normal_min:     existing.normal_min,
    normal_max:     existing.normal_max,
    normal_text:    existing.normal_text,
    description:    existing.description,
    interpretation: existing.interpretation,
    amount:         existing.amount,
    ref_table:      JSON.stringify(rows),
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
    toast('Reference table saved!', 'success');
    closeModal('edit-reftable-modal');
    loadRefTables();
    const data = await apiFetch(`${API}/tests`);
    if (data) _allTests = data;
  }
}

function openAddRefTable() {
  document.getElementById('art-name').value     = '';
  document.getElementById('art-test-id').value  = '';
  document.getElementById('art-category').value = '';
  document.getElementById('art-suggestions').style.display = 'none';
  renderRefTableRows('art', []);
  openModal('add-reftable-modal');
}

async function searchRefTableTest(q) {
  const box = document.getElementById('art-suggestions');
  document.getElementById('art-test-id').value  = '';
  document.getElementById('art-category').value = '';
  if (!q || q.length < 1) { box.style.display = 'none'; return; }
  let src = _allTests;
  if (!src.length) { const d = await apiFetch(`${API}/tests`); if (d) { _allTests = d; src = d; } }
  const matches = src.filter(t => t.test_name.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  if (!matches.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = matches.map(t => `
    <div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)"
         onmousedown="selectRefTableTest(${t.id},'${t.test_name.replace(/'/g,"\\'")}','${(t.category||'').replace(/'/g,"\\'")}')">
      <b>${t.test_name}</b> <span style="color:var(--muted);font-size:11px">${t.category||''}</span>
    </div>`).join('');
}

function selectRefTableTest(id, name, category) {
  document.getElementById('art-test-id').value  = id;
  document.getElementById('art-name').value     = name;
  document.getElementById('art-category').value = category;
  document.getElementById('art-suggestions').style.display = 'none';
  const existing = _allTests.find(x => x.id === id);
  renderRefTableRows('art', existing ? _parseRefTable(existing) : []);
}

async function saveAddRefTable() {
  const id = document.getElementById('art-test-id').value;
  const rows = collectRefTableRows('art');
  if (!id)        { toast('Please select a test from the list', 'error'); return; }
  if (!rows.length) { toast('Add at least one label/value row', 'error'); return; }
  const existing = _allTests.find(x => x.id === parseInt(id));
  if (!existing) { toast('Test not found', 'error'); return; }
  const payload = {
    test_name:      existing.test_name,
    category:       existing.category,
    sub_category:   existing.sub_category,
    unit:           existing.unit,
    normal_min:     existing.normal_min,
    normal_max:     existing.normal_max,
    normal_text:    existing.normal_text,
    description:    existing.description,
    interpretation: existing.interpretation,
    amount:         existing.amount,
    ref_table:      JSON.stringify(rows),
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
    toast('Reference table added!', 'success');
    closeModal('add-reftable-modal');
    loadRefTables();
    const data = await apiFetch(`${API}/tests`);
    if (data) _allTests = data;
  }
}

async function deleteRefTable(id, name) {
  if (!confirm(`Remove the reference table for "${name}"?\n\nThe test itself will remain, only these reference rows will be cleared.`)) return;
  const existing = _allTests.find(x => x.id === parseInt(id));
  if (!existing) { toast('Could not find test', 'error'); return; }
  const payload = {
    test_name:      existing.test_name,
    category:       existing.category,
    sub_category:   existing.sub_category,
    unit:           existing.unit,
    normal_min:     existing.normal_min,
    normal_max:     existing.normal_max,
    normal_text:    existing.normal_text,
    description:    existing.description,
    interpretation: existing.interpretation,
    amount:         existing.amount,
    ref_table:      null,
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
    toast('Reference table deleted', 'success');
    loadRefTables();
    const data = await apiFetch(`${API}/tests`);
    if (data) _allTests = data;
  }
}

// Patch showPage to handle interpretations
const _origShowPage = showPage;
window.showPage = function(name) {
  _origShowPage(name);
  if (name === 'interpretations') loadInterpretations();
  if (name === 'reftables') loadRefTables();
  if (name === 'calculations') loadCalcRulesPage();
};
 
// Patch the page title map
const _origTitleMap = {
  dashboard: 'Dashboard', patients: 'Patients', doctors: 'Doctors', reports: 'Reports',
  appointments: 'Appointments', tests: 'Test Catalog', stages: 'Test Stages',
  labtest: 'Lab Test Bill', settings: 'Settings', interpretations: 'Test Interpretations',
  reftables: 'Reference Tables', calculations: 'Calculations'
};
 
/* ══════════════════════════════════════════════════════════════
   CALCULATIONS — custom auto-calc rules (output test derived from
   1-2 other test results), plus a read-only view of the built-in
   ones that ship with the app (VLDL, ratios, absolute counts...).
   Backend: /api/calc-rules (GET/POST/PUT/DELETE), table calc_rules.
══════════════════════════════════════════════════════════════ */
let _calcRules = [];          // custom rules from the backend
let _dynCalcRulesLoaded = false;

const CALC_OPERATIONS = {
  axb_div100:   { label: 'A × B ÷ 100', needsB: true,  needsConst: false, fn: (a, b, k) => a * b / 100 },
  a_div_b:      { label: 'A ÷ B',       needsB: true,  needsConst: false, fn: (a, b, k) => a / b },
  a_plus_b:     { label: 'A + B',       needsB: true,  needsConst: false, fn: (a, b, k) => a + b },
  a_minus_b:    { label: 'A − B',       needsB: true,  needsConst: false, fn: (a, b, k) => a - b },
  a_div_const:  { label: 'A ÷ constant',needsB: false, needsConst: true,  fn: (a, b, k) => a / k },
  a_mult_const: { label: 'A × constant',needsB: false, needsConst: true,  fn: (a, b, k) => a * k },
};

// Read-only display list of the calculations already hardcoded into
// nrRecalcTests() via NR_CALC_RULES/NR_CALC_ALIASES — purely informational,
// these are always active and aren't stored in calc_rules.
const BUILTIN_CALC_INFO = [
  { output: 'VLDL Cholesterol',           formula: 'Triglycerides ÷ 5' },
  { output: 'LDL Cholesterol',            formula: 'Total Cholesterol − HDL Cholesterol − (Triglycerides ÷ 5)' },
  { output: 'LDL/HDL Ratio',              formula: 'LDL Cholesterol ÷ HDL Cholesterol' },
  { output: 'Total Cholesterol/HDL Ratio',formula: 'Total Cholesterol ÷ HDL Cholesterol' },
  { output: 'A/G Ratio',                  formula: 'Albumin ÷ Globulin' },
  { output: 'Globulin',                   formula: 'Total Protein − Albumin' },
  { output: 'Indirect Bilirubin',         formula: 'Total Bilirubin − Direct Bilirubin' },
  { output: 'Absolute Neutrophils',       formula: 'Total WBC Count × Neutrophils ÷ 100' },
  { output: 'Absolute Lymphocytes',       formula: 'Total WBC Count × Lymphocytes ÷ 100' },
  { output: 'Absolute Eosinophils',       formula: 'Total WBC Count × Eosinophils ÷ 100' },
  { output: 'Absolute Monocytes',         formula: 'Total WBC Count × Monocytes ÷ 100' },
  { output: 'Absolute Basophils',         formula: 'Total WBC Count × Basophils ÷ 100' },
];

/** Fetches custom calc rules from the backend and caches them so
 *  nrRecalcTests() can apply them during report entry. Safe to call
 *  repeatedly (e.g. after add/edit/delete) to refresh the cache. */
async function loadDynCalcRules() {
  const rows = await apiFetch(`${API}/calc-rules`);
  _calcRules = rows || [];
  _dynCalcRulesLoaded = true;
  return _calcRules;
}

async function loadCalcRulesPage() {
  await loadDynCalcRules();
  renderCalcRulesList(_calcRules);
}

function renderCalcRulesList(customRules) {
  const el = document.getElementById('calc-rules-list');
  const builtinHtml = `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:6px 4px">Built-in</div>
    ${BUILTIN_CALC_INFO.map(r => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 16px;margin-bottom:8px;background:var(--card);display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-weight:600;font-size:13px;color:var(--primary)">${r.output}</div>
        <div style="font-size:12px;color:var(--muted)">= ${r.formula}</div></div>
        <span style="font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:2px 10px;color:var(--muted)">Always on</span>
      </div>`).join('')}
  `;
  const customHtml = !customRules.length
    ? '<div style="color:var(--muted);padding:20px;text-align:center">No custom calculations yet. Click <b>＋ Add Calculation</b> to add one.</div>'
    : customRules.map(r => {
        const spec = CALC_OPERATIONS[r.operation] || {};
        const rhs = spec.needsB
          ? `${r.input_a} ${spec.label.replace('A','').replace('B','').trim()} ${r.input_b}`
          : `${r.input_a} ${spec.label.replace('A','').replace('constant', r.constant).trim()}`;
        return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px 16px;margin-bottom:8px;background:var(--card);display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600;font-size:13px;color:var(--primary)">${escAttr(r.output_test)}</div>
            <div style="font-size:12px;color:var(--muted)">= ${escAttr(r.input_a)} ${escAttr(spec.label || r.operation)} ${r.input_b ? escAttr(r.input_b) : (r.constant ?? '')}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-sm btn-outline" style="padding:2px 10px;font-size:11px" onclick="openEditCalcRule(${r.id})">✏ Edit</button>
            <button class="btn btn-sm btn-danger" style="padding:2px 10px;font-size:11px" onclick="deleteCalcRuleRow(${r.id},'${escAttr(r.output_test).replace(/'/g,"\\'")}')">🗑 Delete</button>
          </div>
        </div>`;
      }).join('');
  el.innerHTML = `
    ${builtinHtml}
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 4px 6px">Custom</div>
    ${customHtml}
  `;
}

function filterCalcRules(q) {
  const query = (q || '').toLowerCase();
  const filtered = _calcRules.filter(r =>
    r.output_test.toLowerCase().includes(query) ||
    r.input_a.toLowerCase().includes(query) ||
    (r.input_b || '').toLowerCase().includes(query)
  );
  renderCalcRulesList(filtered);
}

/* ── Test-name autocomplete for the calc-rule modal (Output / Input A / Input B) ── */
async function crSearchTest(q, field) {
  const box = document.getElementById(`cr-${field}-suggestions`);
  if (!q || q.length < 1) { box.style.display = 'none'; return; }
  let src = _allTests;
  if (!src || !src.length) { const d = await apiFetch(`${API}/tests`); if (d) { _allTests = d; src = d; } }
  const matches = (src || []).filter(t => t.test_name.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  if (!matches.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = matches.map(t => `
    <div onmousedown="crSelectTest('${field}','${t.test_name.replace(/'/g,"\\'")}')">
      <b>${t.test_name}</b> <span style="color:var(--muted);font-size:11px">${t.category||''}</span>
    </div>`).join('');
}

function crSelectTest(field, name) {
  const inputId = field === 'output' ? 'cr-output' : (field === 'input_a' ? 'cr-input-a' : 'cr-input-b');
  document.getElementById(inputId).value = name;
  document.getElementById(`cr-${field}-suggestions`).style.display = 'none';
}

function crApplyOperationVisibility() {
  const op = document.getElementById('cr-operation').value;
  const spec = CALC_OPERATIONS[op];
  document.getElementById('cr-input-b-group').style.display = spec.needsB ? '' : 'none';
  document.getElementById('cr-const-group').style.display   = spec.needsConst ? '' : 'none';
}

function openAddCalcRule() {
  document.getElementById('calc-rule-modal-title').textContent = '➕ Add Calculation';
  document.getElementById('cr-id').value = '';
  document.getElementById('cr-output').value = '';
  document.getElementById('cr-input-a').value = '';
  document.getElementById('cr-input-b').value = '';
  document.getElementById('cr-constant').value = '';
  document.getElementById('cr-operation').value = 'axb_div100';
  document.getElementById('cr-decimals').value = '0';
  crApplyOperationVisibility();
  openModal('calc-rule-modal');
}

function openEditCalcRule(id) {
  const r = _calcRules.find(x => x.id === id);
  if (!r) { toast('Could not find calculation', 'error'); return; }
  document.getElementById('calc-rule-modal-title').textContent = '✏️ Edit Calculation';
  document.getElementById('cr-id').value = r.id;
  document.getElementById('cr-output').value = r.output_test;
  document.getElementById('cr-input-a').value = r.input_a;
  document.getElementById('cr-input-b').value = r.input_b || '';
  document.getElementById('cr-constant').value = r.constant ?? '';
  document.getElementById('cr-operation').value = r.operation;
  document.getElementById('cr-decimals').value = String(r.decimals ?? 0);
  crApplyOperationVisibility();
  openModal('calc-rule-modal');
}

async function saveCalcRule() {
  const id = document.getElementById('cr-id').value;
  const output_test = document.getElementById('cr-output').value.trim();
  const input_a      = document.getElementById('cr-input-a').value.trim();
  const input_b      = document.getElementById('cr-input-b').value.trim();
  const operation     = document.getElementById('cr-operation').value;
  const constant      = document.getElementById('cr-constant').value;
  const decimals      = document.getElementById('cr-decimals').value;
  const spec = CALC_OPERATIONS[operation];
  if (!output_test) { toast('Pick the test that should be auto-filled', 'error'); return; }
  if (!input_a)      { toast('Pick Input A', 'error'); return; }
  if (spec.needsB && !input_b) { toast('This operation needs Input B', 'error'); return; }
  if (spec.needsConst && constant === '') { toast('This operation needs a constant value', 'error'); return; }
  const payload = {
    output_test, input_a,
    input_b: spec.needsB ? input_b : null,
    operation,
    constant: spec.needsConst ? parseFloat(constant) : null,
    decimals: parseInt(decimals, 10) || 0,
  };
  const res = id
    ? await apiFetch(`${API}/calc-rules/${id}`, { method: 'PUT',  body: JSON.stringify(payload) })
    : await apiFetch(`${API}/calc-rules`,        { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    toast(id ? 'Calculation updated' : 'Calculation added', 'success');
    closeModal('calc-rule-modal');
    loadCalcRulesPage();
  }
}

async function deleteCalcRuleRow(id, name) {
  if (!confirm(`Delete the calculation for "${name}"?`)) return;
  const res = await apiFetch(`${API}/calc-rules/${id}`, { method: 'DELETE' });
  if (res) {
    toast('Calculation deleted', 'success');
    loadCalcRulesPage();
  }
}

// Load custom calc rules once at startup so they're already cached by the
// time a report is opened and nrRecalcTests() needs them.
loadDynCalcRules();
 
 
/* ══════════════════════════════════════════════════════════════
   FORM DESIGNER
══════════════════════════════════════════════════════════════ */
 
/* ── Default design config ── */
const FD_DEFAULTS = {
  primary:       '#c0392b',
  secondary:     '#1a5276',
  headerText:    '#ffffff',
  tableHead:     '#1a5276',
  highColor:     '#c0392b',
  lowColor:      '#1a5276',
  font:          'Arial, sans-serif',
  fontSize:      '13px',
  labNameSize:   '30px',
  titleSize:     '15px',
  patientInfoSize: '12px',
  tableHeadSize: '13px',
  tableBodySize: '13px',
  footerSize:    '11px',
  notesSize:     '12px',
  headerStyle:   'classic',
  tagline:       'YOUR GOOD HEALTH IS OUR CONCERN',
  reportTitle:   'TEST REPORT',
  footerText:    'HOME COLLECTION AVAILABLE',
  showLogo:      true,
  showTagline:   true,
  showFooterBar: true,
  zebra:         true,
  showBorder:    true,
  boldAbnormal:  true,
  // Logo placement
  logoPosition:  'header',   // 'header' | 'top-left' | 'top-right' | 'top-center'
  logoSize:      '60',       // px height
  // Watermark (separate from header logo)
  wmEnabled:     false,
  wmPosition:    'center',   // 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  wmSize:        '50',       // % of page width
  wmOpacity:     '10',       // % opacity (kept low, 3-40)
  wmRotate:      '-30',      // degrees rotation
  sigs: [
    { name: 'Lab Director', qual: 'M.Sc, M.Phil, PhD', shiftX: 0 },
    { name: 'Lab Technician', qual: 'DMLT', shiftX: 0 },
  ],
  // Report element visibility
  showHeader:      true,
  showTitleBar:    true,
  showPatientInfo: true,
  showResultsTable:true,
  showSignatures:  true,
  showFooter:      true,
  elementOrder: ['header','titlebar','patientinfo','resultstable','signatures','footer'],
  customImages: [],
  // Header / Footer sizing
  headerHeight:    80,    // min height of header area in px
  headerPaddingTop: 0,    // extra px added above header content
  footerPaddingTop: 0,    // extra px added above footer bar content
  footerHeight:    80,    // min height of footer bar in px
  footerPaddingBottom: 4, // extra px added below footer bar content in px
  // Images pinned inside header / footer
  headerImages: [],       // [{dataUrl, xPct, yPct, w, h, opacity}]
  footerImages: [],       // [{dataUrl, xPct, yPct, w, h, opacity}]
  // Logo stored as base64 so it survives page reload
  logoDataUrl: null,
  // Patient info block: 'grid' (default fixed layout) or 'custom' (free-positioned fields,
  // useful when printing onto a pre-printed letterhead that already has labelled blanks)
  patientInfoLayout: 'grid',
  patientInfoHeight: 115, // px — height of the positioning area when layout is 'custom'
  patientFields: [
    // xPct/yPct default positions are tuned for a typical 3-row letterhead layout
    // (Name/Age/Sex, Doctor/Visit Date, Report Date/Ref No/OP-IP) — adjust per your paper.
    // "label" is only shown in the settings list to identify the field; the printed
    // value has no label since the letterhead paper already has one preprinted.
    { key: 'name',       label: "Patient's Name", xPct: 22, yPct: 20, fontSize: 12, bold: true,  visible: true },
    { key: 'age',        label: 'Age',            xPct: 63, yPct: 20, fontSize: 12, bold: false, visible: true },
    { key: 'sex',        label: 'Sex',            xPct: 82, yPct: 20, fontSize: 12, bold: false, visible: true },
    { key: 'doctor',     label: 'Ref. by Dr.',    xPct: 22, yPct: 48, fontSize: 12, bold: false, visible: true },
    { key: 'visitDate',  label: 'Date of Visit',  xPct: 70, yPct: 48, fontSize: 12, bold: false, visible: true },
    { key: 'reportDate', label: 'Date of Report', xPct: 22, yPct: 80, fontSize: 12, bold: false, visible: true },
    { key: 'refNo',      label: 'Ref. No.',       xPct: 50, yPct: 80, fontSize: 12, bold: false, visible: true },
    { key: 'opIp',       label: 'OP / IP',        xPct: 78, yPct: 80, fontSize: 12, bold: false, visible: true },
  ],
};
 
let fdDesign = JSON.parse(JSON.stringify(FD_DEFAULTS));
let fdLogoDataUrl = null;  // base64 logo for live preview

/* ── Migrate legacy yPx → yPct for saved custom images ── */
function fdMigrateCustomImages() {
  if (!fdDesign.customImages) return;
  // A4 page content height ~267mm @96dpi ~1010px — reference height when yPx was set.
  const LEGACY_HEIGHT_PX = 1010;
  fdDesign.customImages.forEach(img => {
    if (img.yPct === undefined && img.yPx !== undefined) {
      img.yPct = Math.round((img.yPx / LEGACY_HEIGHT_PX) * 1000) / 10;
    }
  });
  // Older saved designs won't have the patient-field positioning settings — backfill defaults.
  if (!fdDesign.patientInfoLayout) fdDesign.patientInfoLayout = 'grid';
  if (!fdDesign.patientInfoHeight) fdDesign.patientInfoHeight = 115;
  if (!fdDesign.patientFields || !fdDesign.patientFields.length) {
    fdDesign.patientFields = JSON.parse(JSON.stringify(FD_DEFAULTS.patientFields));
  }
}
 
/* ── Tab switching ── */
function switchSettingsTab(tab) {
  if (tab === 'design' && typeof guardFeature === 'function' && !guardFeature('form_designer')) return;
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('stab-' + tab).classList.add('active');
  ['lab','design','links'].forEach(t => {
    document.getElementById('stab-content-' + t).style.display = t === tab ? '' : 'none';
  });
  if (tab === 'design') fdUpdate();
  if (tab === 'links') loadLinkGroups();
}
 
/* ── Sync lab info inputs → preview ── */
function fdSyncLabInfo() { fdUpdate(); }
 
/* ── Logo upload in Form Designer (updates fdLogoDataUrl + thumb) ── */
function fdHandleLogoUpload(input) {
  if (!input.files || !input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    fdLogoDataUrl = e.target.result;
    fdDesign.logoDataUrl = fdLogoDataUrl;  // persist with design
    // Show thumb in both logo sections
    const thumbEl = document.getElementById('fd-logo-thumb');
    const previewEl = document.getElementById('s-logo-preview');
    const imgTag = `<img src="${fdLogoDataUrl}" style="max-height:60px;max-width:180px;border-radius:4px;border:1px solid var(--border)"/>`;
    if (thumbEl) thumbEl.innerHTML = imgTag;
    if (previewEl) previewEl.innerHTML = imgTag;
    fdUpdate();
  };
  reader.readAsDataURL(input.files[0]);
}
 
function fdLogoSizeDisplay(el) {
  const v = document.getElementById('fd-logo-size-val');
  if (v) v.textContent = el.value + 'px';
}
 
/* ── Watermark helpers ── */
function fdToggleWatermark() {
  const enabled = document.getElementById('fd-wm-enabled')?.checked;
  const controls = document.getElementById('fd-wm-controls');
  if (controls) controls.style.display = enabled ? '' : 'none';
}
 
function fdHandleWmUpload(input) {
  if (!input.files || !input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    window.fdWmDataUrl = e.target.result;
    const thumb = document.getElementById('fd-wm-thumb');
    if (thumb) thumb.innerHTML = `<img src="${window.fdWmDataUrl}" style="max-height:50px;max-width:160px;border-radius:4px;border:1px solid var(--border);opacity:0.5"/>`;
    fdUpdate();
  };
  reader.readAsDataURL(input.files[0]);
}
 
function fdWmSizeDisplay(el) {
  const v = document.getElementById('fd-wm-size-val');
  if (v) v.textContent = el.value + '%';
}
function fdWmOpacityDisplay(el) {
  const v = document.getElementById('fd-wm-opacity-val');
  if (v) v.textContent = el.value + '%';
}
function fdWmRotateDisplay(el) {
  // Slider changed → sync the number input
  const num = document.getElementById('fd-wm-rotate-num');
  if (num) num.value = el.value;
}
function fdWmRotateNumInput(el) {
  // Number input changed → clamp, sync slider, update preview
  let val = parseInt(el.value);
  if (isNaN(val)) return;
  val = Math.max(-180, Math.min(180, val));
  el.value = val;
  const slider = document.getElementById('fd-wm-rotate');
  if (slider) slider.value = val;
  fdUpdate();
}
 
/* ── Header / Footer pinned image helpers ── */

function fdHeaderPaddingDisplay() {
  const el = document.getElementById('fd-header-padding-top');
  const lbl = document.getElementById('fd-header-padding-val');
  if (el && lbl) lbl.textContent = el.value + 'px';
}
function fdFooterPaddingDisplay() {
  const el = document.getElementById('fd-footer-padding-top');
  const lbl = document.getElementById('fd-footer-padding-val');
  if (el && lbl) lbl.textContent = el.value + 'px';
}
function fdHeaderHeightDisplay() {
  const el = document.getElementById('fd-header-height');
  const lbl = document.getElementById('fd-header-height-val');
  if (el && lbl) lbl.textContent = el.value + 'px';
}
function fdFooterHeightDisplay() {
  const el = document.getElementById('fd-footer-height');
  const lbl = document.getElementById('fd-footer-height-val');
  if (el && lbl) lbl.textContent = el.value + 'px';
}
function fdFooterPaddingBottomDisplay() {
  const el = document.getElementById('fd-footer-padding-bottom');
  const lbl = document.getElementById('fd-footer-padding-bottom-val');
  if (el && lbl) lbl.textContent = el.value + 'px';
}

/* ── Patient Info field positioning ── */
function fdPatientInfoLayoutChange(val) {
  fdDesign.patientInfoLayout = val;
  const panel = document.getElementById('fd-patientinfo-custom-panel');
  if (panel) panel.style.display = val === 'custom' ? '' : 'none';
  if (val === 'custom') fdRenderPatientFields();
  fdUpdate();
}
function fdPatientInfoHeightDisplay() {
  const el = document.getElementById('fd-patientinfo-height');
  const lbl = document.getElementById('fd-patientinfo-height-val');
  if (el && lbl) lbl.textContent = el.value + 'px';
  fdDesign.patientInfoHeight = el ? +el.value : fdDesign.patientInfoHeight;
}
function fdPatientFieldProp(i, prop, val) {
  if (!fdDesign.patientFields || !fdDesign.patientFields[i]) return;
  if (prop === 'visible' || prop === 'bold') {
    fdDesign.patientFields[i][prop] = !!val;
  } else {
    fdDesign.patientFields[i][prop] = +val;
  }
  fdUpdate();
}
function fdRenderPatientFields() {
  const c = document.getElementById('fd-patient-fields-list');
  if (!c) return;
  if (!fdDesign.patientFields || !fdDesign.patientFields.length) {
    fdDesign.patientFields = JSON.parse(JSON.stringify(FD_DEFAULTS.patientFields));
  }
  const fields = fdDesign.patientFields;
  c.innerHTML = fields.map((f, i) => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:6px">
        <input type="checkbox" ${f.visible !== false ? 'checked' : ''} style="width:14px;height:14px" onchange="fdPatientFieldProp(${i},'visible',this.checked)"/> ${f.label}
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:11px">
        <label>X % <input type="number" min="0" max="100" step="1" value="${f.xPct}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdPatientFieldProp(${i},'xPct',this.value)"/></label>
        <label>Y % <input type="number" min="0" max="100" step="1" value="${f.yPct}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdPatientFieldProp(${i},'yPct',this.value)"/></label>
        <label>Font px <input type="number" min="8" max="30" step="1" value="${f.fontSize||12}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdPatientFieldProp(${i},'fontSize',this.value)"/></label>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;margin-top:6px">
        <input type="checkbox" ${f.bold ? 'checked' : ''} style="width:13px;height:13px" onchange="fdPatientFieldProp(${i},'bold',this.checked)"/> Bold
      </label>
    </div>`).join('');
}

// ── Header pinned images ──
function fdAddHeaderImage() {
  if (!fdDesign.headerImages) fdDesign.headerImages = [];
  fdDesign.headerImages.push({ dataUrl: null, xPct: 2, yPct: 10, w: 80, h: 60, opacity: 1 });
  fdRenderHeaderImages();
}
function fdRemoveHeaderImage(i) {
  fdDesign.headerImages.splice(i, 1);
  fdRenderHeaderImages();
  fdUpdate();
}
function fdUpdateHeaderImageFile(i, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    fdDesign.headerImages[i].dataUrl = e.target.result;
    fdRenderHeaderImages();
    fdUpdate();
  };
  reader.readAsDataURL(file);
}
function fdHeaderImgProp(i, prop, val) {
  if (!fdDesign.headerImages[i]) return;
  fdDesign.headerImages[i][prop] = +val;
  fdUpdate();
}
function fdRenderHeaderImages() {
  const c = document.getElementById('fd-header-images-list');
  if (!c) return;
  const imgs = fdDesign.headerImages || [];
  if (!imgs.length) { c.innerHTML = '<div style="font-size:11px;color:var(--muted)">No images added yet.</div>'; return; }
  c.innerHTML = imgs.map((img, i) => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;position:relative">
      <button onclick="fdRemoveHeaderImage(${i})" style="position:absolute;top:4px;right:4px;width:18px;height:18px;border-radius:50%;background:#e74c3c;color:#fff;border:none;cursor:pointer;font-size:10px">✕</button>
      ${img.dataUrl ? `<img src="${img.dataUrl}" style="max-height:40px;max-width:120px;object-fit:contain;border-radius:3px;border:1px solid var(--border);display:block;margin-bottom:6px"/>` : ''}
      <input type="file" accept="image/*" style="font-size:11px;margin-bottom:6px;width:100%" onchange="fdUpdateHeaderImageFile(${i},this)"/>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
        <label>Left % <input type="number" min="0" max="100" step="1" value="${img.xPct||2}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdHeaderImgProp(${i},'xPct',this.value)"/></label>
        <label>Top % <input type="number" min="0" max="100" step="1" value="${img.yPct||10}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdHeaderImgProp(${i},'yPct',this.value)"/></label>
        <label>Width px <input type="number" min="10" max="400" step="4" value="${img.w||80}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdHeaderImgProp(${i},'w',this.value)"/></label>
        <label>Height px <input type="number" min="10" max="300" step="4" value="${img.h||60}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdHeaderImgProp(${i},'h',this.value)"/></label>
        <label style="grid-column:1/-1">Opacity <input type="range" min="0.05" max="1" step="0.05" value="${img.opacity!==undefined?img.opacity:1}" style="width:100%" oninput="fdHeaderImgProp(${i},'opacity',this.value)"/></label>
      </div>
    </div>`).join('');
}

// ── Footer pinned images ──
function fdAddFooterImage() {
  if (!fdDesign.footerImages) fdDesign.footerImages = [];
  fdDesign.footerImages.push({ dataUrl: null, xPct: 2, yPct: 10, w: 80, h: 40, opacity: 1 });
  fdRenderFooterImages();
}
function fdRemoveFooterImage(i) {
  fdDesign.footerImages.splice(i, 1);
  fdRenderFooterImages();
  fdUpdate();
}
function fdUpdateFooterImageFile(i, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    fdDesign.footerImages[i].dataUrl = e.target.result;
    fdRenderFooterImages();
    fdUpdate();
  };
  reader.readAsDataURL(file);
}
function fdFooterImgProp(i, prop, val) {
  if (!fdDesign.footerImages[i]) return;
  fdDesign.footerImages[i][prop] = +val;
  fdUpdate();
}
function fdRenderFooterImages() {
  const c = document.getElementById('fd-footer-images-list');
  if (!c) return;
  const imgs = fdDesign.footerImages || [];
  if (!imgs.length) { c.innerHTML = '<div style="font-size:11px;color:var(--muted)">No images added yet.</div>'; return; }
  c.innerHTML = imgs.map((img, i) => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;position:relative">
      <button onclick="fdRemoveFooterImage(${i})" style="position:absolute;top:4px;right:4px;width:18px;height:18px;border-radius:50%;background:#e74c3c;color:#fff;border:none;cursor:pointer;font-size:10px">✕</button>
      ${img.dataUrl ? `<img src="${img.dataUrl}" style="max-height:40px;max-width:120px;object-fit:contain;border-radius:3px;border:1px solid var(--border);display:block;margin-bottom:6px"/>` : ''}
      <input type="file" accept="image/*" style="font-size:11px;margin-bottom:6px;width:100%" onchange="fdUpdateFooterImageFile(${i},this)"/>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
        <label>Left % <input type="number" min="0" max="100" step="1" value="${img.xPct||2}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdFooterImgProp(${i},'xPct',this.value)"/></label>
        <label>Top % <input type="number" min="0" max="100" step="1" value="${img.yPct||10}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdFooterImgProp(${i},'yPct',this.value)"/></label>
        <label>Width px <input type="number" min="10" max="400" step="4" value="${img.w||80}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdFooterImgProp(${i},'w',this.value)"/></label>
        <label>Height px <input type="number" min="10" max="200" step="4" value="${img.h||40}" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdFooterImgProp(${i},'h',this.value)"/></label>
        <label style="grid-column:1/-1">Opacity <input type="range" min="0.05" max="1" step="0.05" value="${img.opacity!==undefined?img.opacity:1}" style="width:100%" oninput="fdFooterImgProp(${i},'opacity',this.value)"/></label>
      </div>
    </div>`).join('');
}

/* ── Logo file preview (for Lab Info tab logo upload — also sets fdLogoDataUrl) ── */
function fdLogoPreview(input) {
  if (!input.files || !input.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    fdLogoDataUrl = e.target.result;
    fdDesign.logoDataUrl = fdLogoDataUrl;  // persist with design
    const imgTag = `<img src="${fdLogoDataUrl}" style="max-height:60px;max-width:180px;border-radius:4px;border:1px solid var(--border)"/>`;
    document.getElementById('s-logo-preview').innerHTML = imgTag;
    const thumb = document.getElementById('fd-logo-thumb');
    if (thumb) thumb.innerHTML = imgTag;
    fdUpdateAppLogo(fdLogoDataUrl);
    fdUpdate();
  };
  reader.readAsDataURL(input.files[0]);
}

function fdNormalizeLogoPath(rawPath) {
  if (!rawPath) return '';
  if (/^data:image\//i.test(rawPath)) return rawPath;
  if (rawPath.startsWith('/static/')) return rawPath;
  const normalized = String(rawPath).replace(/\\/g, '/');
  const idx = normalized.toLowerCase().indexOf('/static/');
  return idx >= 0 ? normalized.slice(idx) : '';
}

function fdUpdateAppLogo(logoSrc) {
  // Always show the fixed app logo regardless of settings
  const logoIcon = document.querySelector('.sidebar-logo .logo-icon');
  if (!logoIcon) return;
  logoIcon.classList.add('has-image');
  logoIcon.innerHTML = `<img src="/static/logos/krisc-logo.jpeg" alt="App Logo">`;
}
 
/* ── Read current values from controls ── */
function fdRead() {
  fdDesign.primary       = document.getElementById('fd-primary').value;
  fdDesign.secondary     = document.getElementById('fd-secondary').value;
  fdDesign.headerText    = document.getElementById('fd-header-text').value;
  fdDesign.tableHead     = document.getElementById('fd-table-head').value;
  fdDesign.highColor     = document.getElementById('fd-high-color').value;
  fdDesign.lowColor      = document.getElementById('fd-low-color').value;
  fdDesign.font          = document.getElementById('fd-font').value;
  fdDesign.fontSize      = document.getElementById('fd-fontsize').value;
  fdDesign.labNameSize   = document.getElementById('fd-labname-size').value;
  fdDesign.titleSize     = (document.getElementById('fd-title-size')   || {}).value || '15px';
  fdDesign.patientInfoSize=(document.getElementById('fd-patient-size') || {}).value || '12px';
  fdDesign.tableHeadSize = (document.getElementById('fd-theader-size') || {}).value || '13px';
  fdDesign.tableBodySize = (document.getElementById('fd-tbody-size')   || {}).value || '13px';
  fdDesign.footerSize    = (document.getElementById('fd-footer-size')  || {}).value || '11px';
  fdDesign.headerStyle   = document.getElementById('fd-header-style').value;
  fdDesign.tagline       = document.getElementById('fd-tagline').value;
  fdDesign.reportTitle   = document.getElementById('fd-report-title').value;
  fdDesign.footerText    = document.getElementById('fd-footer-text').value;
  fdDesign.showLogo      = document.getElementById('fd-show-logo').checked;
  fdDesign.showTagline   = document.getElementById('fd-show-tagline').checked;
  fdDesign.showFooterBar = document.getElementById('fd-show-footer-bar').checked;
  fdDesign.zebra         = document.getElementById('fd-zebra').checked;
  fdDesign.showBorder    = document.getElementById('fd-show-border').checked;
  fdDesign.boldAbnormal  = document.getElementById('fd-bold-abnormal').checked;
  // Logo placement
  fdDesign.logoPosition  = (document.getElementById('fd-logo-position')  || {}).value || 'header';
  fdDesign.logoSize      = (document.getElementById('fd-logo-size')      || {}).value || '60';
  // Watermark
  fdDesign.wmEnabled     = !!(document.getElementById('fd-wm-enabled')   || {}).checked;
  fdDesign.wmPosition    = (document.getElementById('fd-wm-position')    || {}).value || 'center';
  fdDesign.wmSize        = (document.getElementById('fd-wm-size')        || {}).value || '50';
  fdDesign.wmOpacity     = (document.getElementById('fd-wm-opacity')     || {}).value || '10';
  fdDesign.wmRotate      = (document.getElementById('fd-wm-rotate')      || {}).value || '-30';
  // Read sigs (preserve each row's uploaded image and shift — they aren't a text input)
  const _existingSigs = fdDesign.sigs || [];
  fdDesign.sigs = [];
  document.querySelectorAll('.fd-sig-row').forEach((row, i) => {
    const inputs = row.querySelectorAll('input[type=text]');
    if (inputs.length >= 2) {
      fdDesign.sigs.push({
        name: inputs[0].value, qual: inputs[1].value,
        image: (_existingSigs[i] && _existingSigs[i].image) || null,
        shiftX: (_existingSigs[i] && _existingSigs[i].shiftX) || 0,
      });
    }
  });
  // Element visibility flags are managed via fdToggleElement, not read from inputs
  // Header / Footer sizing
  const hh = document.getElementById('fd-header-height');
  fdDesign.headerHeight = hh ? +hh.value : 80;
  const hpt = document.getElementById('fd-header-padding-top');
  fdDesign.headerPaddingTop = hpt ? +hpt.value : 0;
  const fpt = document.getElementById('fd-footer-padding-top');
  fdDesign.footerPaddingTop = fpt ? +fpt.value : 0;
  const fh = document.getElementById('fd-footer-height');
  fdDesign.footerHeight = fh ? +fh.value : 80;
  const fpb = document.getElementById('fd-footer-padding-bottom');
  fdDesign.footerPaddingBottom = fpb ? +fpb.value : 4;
}
 
/* ── Write current fdDesign → controls ── */
function fdWrite() {
  // Sync element toggle buttons
  fdSyncElementButtons();
  fdRenderCustomImages();
  document.getElementById('fd-primary').value       = fdDesign.primary;
  document.getElementById('fd-primary-hex').value   = fdDesign.primary;
  document.getElementById('fd-secondary').value     = fdDesign.secondary;
  document.getElementById('fd-secondary-hex').value = fdDesign.secondary;
  document.getElementById('fd-header-text').value       = fdDesign.headerText;
  document.getElementById('fd-header-text-hex').value   = fdDesign.headerText;
  document.getElementById('fd-table-head').value        = fdDesign.tableHead;
  document.getElementById('fd-table-head-hex').value    = fdDesign.tableHead;
  document.getElementById('fd-high-color').value        = fdDesign.highColor;
  document.getElementById('fd-high-color-hex').value    = fdDesign.highColor;
  document.getElementById('fd-low-color').value         = fdDesign.lowColor;
  document.getElementById('fd-low-color-hex').value     = fdDesign.lowColor;
  document.getElementById('fd-font').value          = fdDesign.font;
  document.getElementById('fd-fontsize').value      = fdDesign.fontSize;
  document.getElementById('fd-labname-size').value  = fdDesign.labNameSize;
  document.getElementById('fd-fontsize-display').textContent  = fdDesign.fontSize;
  document.getElementById('fd-labname-display').textContent   = fdDesign.labNameSize;
  if(document.getElementById('fd-title-size')) {
    document.getElementById('fd-title-size').value    = fdDesign.titleSize || '15px';
    document.getElementById('fd-title-display').textContent    = fdDesign.titleSize || '15px';
    document.getElementById('fd-patient-size').value  = fdDesign.patientInfoSize || '12px';
    document.getElementById('fd-patient-display').textContent  = fdDesign.patientInfoSize || '12px';
    document.getElementById('fd-theader-size').value  = fdDesign.tableHeadSize || '13px';
    document.getElementById('fd-theader-display').textContent  = fdDesign.tableHeadSize || '13px';
    document.getElementById('fd-tbody-size').value    = fdDesign.tableBodySize || '13px';
    document.getElementById('fd-tbody-display').textContent    = fdDesign.tableBodySize || '13px';
    document.getElementById('fd-footer-size').value   = fdDesign.footerSize || '11px';
    document.getElementById('fd-footer-display').textContent   = fdDesign.footerSize || '11px';
  }
  document.getElementById('fd-header-style').value  = fdDesign.headerStyle;
  document.getElementById('fd-tagline').value       = fdDesign.tagline;
  document.getElementById('fd-report-title').value  = fdDesign.reportTitle;
  document.getElementById('fd-footer-text').value   = fdDesign.footerText;
  document.getElementById('fd-show-logo').checked      = fdDesign.showLogo;
  document.getElementById('fd-show-tagline').checked   = fdDesign.showTagline;
  document.getElementById('fd-show-footer-bar').checked = fdDesign.showFooterBar;
  document.getElementById('fd-zebra').checked          = fdDesign.zebra;
  document.getElementById('fd-show-border').checked    = fdDesign.showBorder;
  document.getElementById('fd-bold-abnormal').checked  = fdDesign.boldAbnormal;
  // Logo placement
  if (document.getElementById('fd-logo-position'))  document.getElementById('fd-logo-position').value  = fdDesign.logoPosition  || 'header';
  if (document.getElementById('fd-logo-size'))      document.getElementById('fd-logo-size').value      = fdDesign.logoSize      || '60';
  if (document.getElementById('fd-logo-size-val'))  document.getElementById('fd-logo-size-val').textContent = (fdDesign.logoSize || '60') + 'px';
  // Watermark
  const wmCb = document.getElementById('fd-wm-enabled');
  if (wmCb) { wmCb.checked = !!fdDesign.wmEnabled; fdToggleWatermark(); }
  if (document.getElementById('fd-wm-position'))  document.getElementById('fd-wm-position').value  = fdDesign.wmPosition || 'center';
  if (document.getElementById('fd-wm-size'))    { document.getElementById('fd-wm-size').value    = fdDesign.wmSize    || '50'; document.getElementById('fd-wm-size-val').textContent    = (fdDesign.wmSize    || '50') + '%'; }
  if (document.getElementById('fd-wm-opacity')) { document.getElementById('fd-wm-opacity').value = fdDesign.wmOpacity || '10'; document.getElementById('fd-wm-opacity-val').textContent = (fdDesign.wmOpacity || '10') + '%'; }
  if (document.getElementById('fd-wm-rotate'))  { const _rot = fdDesign.wmRotate !== undefined ? fdDesign.wmRotate : '-30'; document.getElementById('fd-wm-rotate').value = _rot; const _rnum = document.getElementById('fd-wm-rotate-num'); if (_rnum) _rnum.value = _rot; }
  fdRenderSigs();
  // Header / Footer sizing
  const hhEl = document.getElementById('fd-header-height');
  if (hhEl) { hhEl.value = fdDesign.headerHeight || 80; fdHeaderHeightDisplay(); }
  const hptEl = document.getElementById('fd-header-padding-top');
  if (hptEl) { hptEl.value = fdDesign.headerPaddingTop || 0; fdHeaderPaddingDisplay(); }
  const fptEl = document.getElementById('fd-footer-padding-top');
  if (fptEl) { fptEl.value = fdDesign.footerPaddingTop || 0; fdFooterPaddingDisplay(); }
  const fhEl = document.getElementById('fd-footer-height');
  if (fhEl) { fhEl.value = fdDesign.footerHeight || 80; fdFooterHeightDisplay(); }
  const fpbEl = document.getElementById('fd-footer-padding-bottom');
  if (fpbEl) { fpbEl.value = fdDesign.footerPaddingBottom || 4; fdFooterPaddingBottomDisplay(); }
  // Pinned images
  fdRenderHeaderImages();
  fdRenderFooterImages();
  // Patient info field positioning
  const pilEl = document.getElementById('fd-patientinfo-layout');
  if (pilEl) pilEl.value = fdDesign.patientInfoLayout || 'grid';
  const pipanel = document.getElementById('fd-patientinfo-custom-panel');
  if (pipanel) pipanel.style.display = (fdDesign.patientInfoLayout === 'custom') ? '' : 'none';
  const pihEl = document.getElementById('fd-patientinfo-height');
  if (pihEl) { pihEl.value = fdDesign.patientInfoHeight || 115; fdPatientInfoHeightDisplay(); }
  fdRenderPatientFields();
}
 
/* ── Report Elements: drag-and-drop order + visibility ── */
 
const FD_ELEMENT_META = {
  header:       { label: '🏷️ Header',           desc: 'Lab name, address, contact info' },
  titlebar:     { label: '📋 Report Title Bar',  desc: 'Colored bar with report title text' },
  patientinfo:  { label: '👤 Patient Info',       desc: 'Name, age, gender, doctor, dates' },
  resultstable: { label: '🧪 Results Table',      desc: 'Test results, values, reference ranges' },
  signatures:   { label: '✍️ Signatures',         desc: 'Doctor / pathologist signature block' },
  footer:       { label: '🔻 Footer',             desc: 'Footer bar with address and contact' },
};
 
const FD_DEFAULT_ELEMENT_ORDER = ['header','titlebar','patientinfo','resultstable','signatures','footer'];
 
const _fdElementKeys = {
  header:       'showHeader',
  titlebar:     'showTitleBar',
  patientinfo:  'showPatientInfo',
  resultstable: 'showResultsTable',
  signatures:   'showSignatures',
  footer:       'showFooter',
};
 
let _fdDragSrc = null;
 
function fdRenderElementList() {
  const list = document.getElementById('fd-elements-list');
  if (!list) return;
  const order = fdDesign.elementOrder || FD_DEFAULT_ELEMENT_ORDER;
  list.innerHTML = '';
  order.forEach(key => {
    const meta = FD_ELEMENT_META[key];
    if (!meta) return;
    const prop = _fdElementKeys[key];
    const on = fdDesign[prop] !== false;
    const row = document.createElement('div');
    row.dataset.key = key;
    row.draggable = true;
    row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:default;transition:opacity .15s,box-shadow .15s;user-select:none`;
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span class="fd-drag-handle" style="cursor:grab;font-size:15px;color:var(--muted);padding:0 2px;line-height:1" title="Drag to reorder">☰</span>
        <div>
          <span style="font-size:12px;font-weight:600">${meta.label}</span>
          <div style="font-size:10px;color:var(--muted)">${meta.desc}</div>
        </div>
      </div>
      <button onclick="fdToggleElement('${key}')"
        style="padding:4px 12px;font-size:11px;font-weight:600;border:none;border-radius:5px;cursor:pointer;background:${on ? '#16a34a' : '#dc2626'};color:#fff;min-width:70px;transition:.2s;flex-shrink:0">
        ${on ? '✓ Shown' : '✕ Hidden'}
      </button>`;
 
    // Drag events
    row.addEventListener('dragstart', e => {
      _fdDragSrc = key;
      e.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '0.45';
      row.style.boxShadow = '0 0 0 2px var(--primary)';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      row.style.boxShadow = '';
      list.querySelectorAll('[data-key]').forEach(r => r.style.borderColor = '');
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.style.borderColor = 'var(--primary)';
    });
    row.addEventListener('dragleave', () => { row.style.borderColor = ''; });
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.style.borderColor = '';
      if (!_fdDragSrc || _fdDragSrc === key) return;
      const order = [...(fdDesign.elementOrder || FD_DEFAULT_ELEMENT_ORDER)];
      const fromIdx = order.indexOf(_fdDragSrc);
      const toIdx   = order.indexOf(key);
      if (fromIdx < 0 || toIdx < 0) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, _fdDragSrc);
      fdDesign.elementOrder = order;
      fdRenderElementList();
      fdUpdate();
    });
 
    list.appendChild(row);
  });
}
 
function fdToggleElement(key) {
  const prop = _fdElementKeys[key];
  if (!prop) return;
  fdDesign[prop] = !fdDesign[prop];
  fdRenderElementList();
  fdUpdate();
}
 
function fdSyncElementButtons() { fdRenderElementList(); }

/* ── Preview drag-and-drop (pointer-based, placeholder preserves space) ── */
let _fdPrevDrag = {
  active: false,
  key: null,
  srcEl: null,
  placeholder: null,
  ghost: null,
  offsetX: 0,
  offsetY: 0,
};

function fdInitPreviewDrag() {
  const wrap = document.getElementById('fd-preview-wrap');
  if (!wrap) return;
  const sections = Array.from(wrap.querySelectorAll('.fd-preview-section'));

  sections.forEach(section => {
    const handle = section.querySelector('.fd-preview-drag-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);

      const key = section.dataset.key;
      const rect = section.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();

      // Create a placeholder that holds exactly the same space
      const ph = document.createElement('div');
      ph.className = 'fd-preview-placeholder';
      ph.style.cssText = `height:${rect.height}px;box-sizing:border-box;border:2px dashed var(--primary,#c0392b);border-radius:4px;background:rgba(192,57,43,0.06);margin:0;flex-shrink:0;`;
      section.parentNode.insertBefore(ph, section);

      // Create a floating ghost (clone of the section)
      const ghost = section.cloneNode(true);
      ghost.style.cssText = `
        position:fixed;
        left:${rect.left}px;
        top:${rect.top}px;
        width:${rect.width}px;
        pointer-events:none;
        z-index:9999;
        opacity:0.85;
        box-shadow:0 8px 32px rgba(0,0,0,0.22);
        border-radius:4px;
        background:#fff;
        transition:none;
        outline:2px solid var(--primary,#c0392b);
      `;
      document.body.appendChild(ghost);

      // Hide the original (not visibility:hidden — use opacity so it still holds no space via placeholder)
      section.style.display = 'none';

      _fdPrevDrag = {
        active: true,
        key,
        srcEl: section,
        placeholder: ph,
        ghost,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
    });

    handle.addEventListener('pointermove', e => {
      if (!_fdPrevDrag.active) return;
      e.preventDefault();

      const { ghost, placeholder, srcEl } = _fdPrevDrag;

      // Move ghost
      ghost.style.left = `${e.clientX - _fdPrevDrag.offsetX}px`;
      ghost.style.top  = `${e.clientY - _fdPrevDrag.offsetY}px`;

      // Find which section the pointer is over (excluding src and placeholder)
      const allSections = Array.from(wrap.querySelectorAll('.fd-preview-section'))
        .filter(s => s !== srcEl);

      // Clear indicators
      wrap.querySelectorAll('.fd-preview-section').forEach(s => {
        s.classList.remove('fd-preview-drag-over-top', 'fd-preview-drag-over-bottom');
      });
      placeholder.style.marginTop = '';
      placeholder.style.marginBottom = '';

      let targetSection = null;
      let insertBefore = true;

      for (const s of allSections) {
        const r = s.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          targetSection = s;
          insertBefore = e.clientY < r.top + r.height / 2;
          break;
        }
      }

      if (targetSection) {
        if (insertBefore) {
          targetSection.classList.add('fd-preview-drag-over-top');
          targetSection.parentNode.insertBefore(placeholder, targetSection);
        } else {
          targetSection.classList.add('fd-preview-drag-over-bottom');
          targetSection.parentNode.insertBefore(placeholder, targetSection.nextSibling);
        }
      }
    });

    handle.addEventListener('pointerup', e => {
      if (!_fdPrevDrag.active) return;

      const { key, srcEl, placeholder, ghost } = _fdPrevDrag;
      _fdPrevDrag.active = false;

      // Remove ghost
      ghost.remove();

      // Clear indicators
      wrap.querySelectorAll('.fd-preview-section').forEach(s => {
        s.classList.remove('fd-preview-drag-over-top', 'fd-preview-drag-over-bottom');
      });

      // Determine new order by reading DOM order of placeholders + sections
      const allNodes = Array.from(wrap.querySelectorAll('.fd-preview-section, .fd-preview-placeholder'));
      const newOrder = [];
      const order = fdDesign.elementOrder || FD_DEFAULT_ELEMENT_ORDER;

      allNodes.forEach(node => {
        if (node.classList.contains('fd-preview-placeholder')) {
          // This is where the dragged element goes
          newOrder.push(key);
        } else {
          const k = node.dataset.key;
          if (k && k !== key) newOrder.push(k);
        }
      });

      // Remove placeholder
      placeholder.remove();

      // Restore src element visibility
      srcEl.style.display = '';

      // Apply new order (only include keys that exist in original order)
      const validKeys = order.filter(k => k !== key);
      // Build final order from newOrder, filtering only valid entries
      const finalOrder = newOrder.filter((k, i, arr) => {
        return (k === key || validKeys.includes(k)) && arr.indexOf(k) === i;
      });
      // Ensure all original keys are present
      order.forEach(k => { if (!finalOrder.includes(k)) finalOrder.push(k); });

      fdDesign.elementOrder = finalOrder;
      fdRenderElementList();
      fdUpdate();
    });

    handle.addEventListener('pointercancel', () => {
      if (!_fdPrevDrag.active) return;
      _fdPrevDrag.active = false;
      _fdPrevDrag.ghost?.remove();
      _fdPrevDrag.placeholder?.remove();
      if (_fdPrevDrag.srcEl) _fdPrevDrag.srcEl.style.display = '';
      wrap.querySelectorAll('.fd-preview-section').forEach(s => {
        s.classList.remove('fd-preview-drag-over-top', 'fd-preview-drag-over-bottom');
      });
    });
  });
}
 
/* ── Custom Images ── */
 
/* ════════════════════════════════════════════════════════════
   FREE-POSITION IMAGE SYSTEM  (Word-like drag & resize)
   ════════════════════════════════════════════════════════════ */
 
let _fdSelImg = null;   // index of selected image
 
/* Render left-panel thumbnail list */
function fdRenderCustomImages() {
  const container = document.getElementById('fd-custom-images-list');
  if (!container) return;
  container.innerHTML = '';
  (fdDesign.customImages || []).forEach((img, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:8px 10px;background:var(--bg);display:flex;flex-direction:column;gap:6px';
    const isSelected = _fdSelImg === i;
    row.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:12px;font-weight:600;cursor:pointer;color:${isSelected?'var(--primary)':'inherit'}"
          onclick="fdSelectImage(${i})">
          ${isSelected ? '▶ ' : ''}Image ${i + 1}${img.dataUrl ? '' : ' (no file)'}
        </span>
        <button onclick="fdRemoveCustomImage(${i})" style="background:#dc2626;color:#fff;border:none;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer">✕</button>
      </div>
      ${img.dataUrl ? `<img src="${img.dataUrl}" style="max-height:48px;border-radius:4px;object-fit:contain;border:1px solid var(--border);cursor:pointer" onclick="fdSelectImage(${i})"/>` : ''}
      <input type="file" accept="image/*" style="font-size:11px" onchange="fdUpdateCustomImageFile(${i}, this)"/>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;font-size:11px">
        <div>
          <div style="font-size:10px;color:var(--muted)">Width (px)</div>
          <input type="number" min="20" max="800" value="${img.w||120}"
            oninput="fdImgProp(${i},'w',+this.value)"
            style="width:100%;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:11px"/>
        </div>
        <div>
          <div style="font-size:10px;color:var(--muted)">Height (px)</div>
          <input type="number" min="10" max="600" value="${img.h||80}"
            oninput="fdImgProp(${i},'h',+this.value)"
            style="width:100%;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:11px"/>
        </div>
        <div>
          <div style="font-size:10px;color:var(--muted)">X pos (%)</div>
          <input type="number" min="0" max="100" step="0.5" value="${img.xPct !== undefined ? img.xPct : 5}"
            oninput="fdImgProp(${i},'xPct',+this.value)"
            style="width:100%;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:11px"/>
        </div>
        <div>
          <div style="font-size:10px;color:var(--muted)">Y pos (px)</div>
          <input type="number" min="0" max="2000" value="${img.yPx !== undefined ? img.yPx : 40}"
            oninput="fdImgProp(${i},'yPx',+this.value)"
            style="width:100%;padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg);font-size:11px"/>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" ${img.opacity!==undefined&&img.opacity<1?'':'checked'}
            onchange="fdImgProp(${i},'opacity',this.checked?1:0.5)"/> Opaque
        </label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" ${img.behindText?'checked':''}
            onchange="fdImgProp(${i},'behindText',this.checked)"/> Behind text
        </label>
      </div>`;
    container.appendChild(row);
  });
}
 
function fdSelectImage(i) {
  _fdSelImg = (_fdSelImg === i) ? null : i;
  fdRenderCustomImages();
  fdRenderImageOverlay();
}
 
function fdAddCustomImage() {
  if (!fdDesign.customImages) fdDesign.customImages = [];
  const i = fdDesign.customImages.length;
  fdDesign.customImages.push({ dataUrl: null, xPct: 5, yPx: 40 + i * 90, w: 120, h: 80, opacity: 1, behindText: false });
  _fdSelImg = i;
  fdRenderCustomImages();
  fdRenderImageOverlay();
}
 
function fdRemoveCustomImage(i) {
  fdDesign.customImages.splice(i, 1);
  if (_fdSelImg === i) _fdSelImg = null;
  else if (_fdSelImg > i) _fdSelImg--;
  fdRenderCustomImages();
  fdUpdate();
}
 
function fdUpdateCustomImageFile(i, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    fdDesign.customImages[i].dataUrl = e.target.result;
    _fdSelImg = i;
    fdRenderCustomImages();
    fdUpdate();
  };
  reader.readAsDataURL(file);
}
 
function fdImgProp(i, prop, val) {
  if (!fdDesign.customImages[i]) return;
  fdDesign.customImages[i][prop] = val;
  fdRenderImageOverlay();
  // Update the numeric inputs in side panel silently (no full re-render needed)
}
 
/* ── Render draggable image handles on the preview overlay ── */
function fdRenderImageOverlay() {
  const overlay = document.getElementById('fd-image-overlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  overlay.style.pointerEvents = 'none';
 
  (fdDesign.customImages || []).forEach((img, i) => {
    if (!img.dataUrl) return;
    const isSelected = _fdSelImg === i;
    const wrapper = document.createElement('div');
    wrapper.dataset.imgIdx = i;
    const xPct = img.xPct !== undefined ? img.xPct : 5;
    const yPx  = img.yPx  !== undefined ? img.yPx  : 40;
    const w    = img.w || 120;
    const h    = img.h || 80;
    const op   = img.opacity !== undefined ? img.opacity : 1;
    const zBase = img.behindText ? 1 : 11;
 
    wrapper.style.cssText = `
      position:absolute;
      left:${xPct}%;
      top:${yPx}px;
      width:${w}px;
      height:${h}px;
      opacity:${op};
      z-index:${isSelected ? zBase + 10 : zBase};
      cursor:move;
      pointer-events:auto;
      box-sizing:border-box;
      border:${isSelected ? '2px solid var(--primary,#c0392b)' : '2px dashed transparent'};
      border-radius:2px;
      user-select:none;
    `;
 
    // The image
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;';
    wrapper.appendChild(imgEl);
 
    // Selection indicator label
    if (isSelected) {
      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:absolute;top:-18px;left:0;font-size:9px;font-weight:700;color:var(--primary,#c0392b);white-space:nowrap;background:#fff;padding:1px 4px;border-radius:3px;pointer-events:none';
      lbl.textContent = `Image ${i+1}  ${Math.round(xPct)}% , ${Math.round(yPx)}px`;
      lbl.id = `fd-img-lbl-${i}`;
      wrapper.appendChild(lbl);
 
      // Resize handle
      const rh = document.createElement('div');
      rh.style.cssText = 'position:absolute;bottom:-1px;right:-1px;width:14px;height:14px;background:var(--primary,#c0392b);cursor:se-resize;border-radius:2px 0 2px 0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;pointer-events:auto;';
      rh.textContent = '↘';
      rh.addEventListener('mousedown', e => fdResizeStart(e, i));
      wrapper.appendChild(rh);
 
      // Delete shortcut
      const del = document.createElement('div');
      del.style.cssText = 'position:absolute;top:-1px;right:-1px;width:14px;height:14px;background:#dc2626;cursor:pointer;border-radius:0 2px 0 2px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;pointer-events:auto;';
      del.textContent = '✕';
      del.addEventListener('mousedown', e => { e.stopPropagation(); fdRemoveCustomImage(i); });
      wrapper.appendChild(del);
    }
 
    // Click to select
    wrapper.addEventListener('mousedown', e => {
      if (e.target.style && e.target.style.cursor === 'se-resize') return;
      fdDragStart(e, i);
    });
 
    overlay.appendChild(wrapper);
  });
}
 
/* ── Drag to reposition ── */
function fdDragStart(e, i) {
  e.preventDefault();
  e.stopPropagation();
 
  if (_fdSelImg !== i) {
    _fdSelImg = i;
    fdRenderCustomImages();
    return;
  }
 
  const overlay  = document.getElementById('fd-image-overlay');
  const canvas   = document.getElementById('fd-canvas-wrap');
  const canvasRect = canvas.getBoundingClientRect();
  const img = fdDesign.customImages[i];
  const startX = e.clientX;
  const startY = e.clientY;
  const startXPct = img.xPct !== undefined ? img.xPct : 5;
  const startYPx  = img.yPx  !== undefined ? img.yPx  : 40;
 
  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const newXPct = Math.max(0, Math.min(95, startXPct + (dx / canvasRect.width) * 100));
    const newYPx  = Math.max(0, startYPx + dy);
    fdDesign.customImages[i].xPct = Math.round(newXPct * 10) / 10;
    fdDesign.customImages[i].yPx  = Math.round(newYPx);
    fdRenderImageOverlay();
    // Update label
    const lbl = document.getElementById(`fd-img-lbl-${i}`);
    if (lbl) lbl.textContent = `Image ${i+1}  ${Math.round(newXPct)}% , ${Math.round(newYPx)}px`;
  }
 
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    fdRenderCustomImages(); // refresh side panel coords
  }
 
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
 
/* ── Resize handle ── */
function fdResizeStart(e, i) {
  e.preventDefault();
  e.stopPropagation();
  const img = fdDesign.customImages[i];
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = img.w || 120;
  const startH = img.h || 80;
 
  function onMove(ev) {
    const nw = Math.max(20, startW + (ev.clientX - startX));
    const nh = Math.max(10, startH + (ev.clientY - startY));
    fdDesign.customImages[i].w = Math.round(nw);
    fdDesign.customImages[i].h = Math.round(nh);
    fdRenderImageOverlay();
  }
 
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    fdRenderCustomImages();
  }
 
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
 
/* Escape key deselects */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _fdSelImg !== null) {
    _fdSelImg = null;
    fdRenderImageOverlay();
  }
});
 
/* ── Build HTML for print: absolutely-positioned images ── */
function fdCustomImageHtml(position, images) {
  // Legacy flow-position fallback — not used when free-position is active
  return '';
}
 
/* ── Build interactive footer bar for preview (with resizable images) ── */
function fdBuildFooterBarPreview(d, labAddr, labPhone) {
  if (!d.showFooterBar) return '';
  // Create resizable images with handles
  const fImgs = (d.footerImages || []).filter(img => img.dataUrl).map((img, i) => {
    const xPct = img.xPct !== undefined ? img.xPct : 2;
    const yPct = img.yPct !== undefined ? img.yPct : 10;
    const w = img.w || 80; const h = img.h || 40;
    const op = img.opacity !== undefined ? img.opacity : 1;
    return `<div class="fd-footer-img-wrapper" data-idx="${i}" style="position:absolute;left:${xPct}%;top:${yPct}%;width:${w}px;height:${h}px;cursor:move;z-index:10;border:2px dashed #0066cc;border-radius:4px;display:none" onmousedown="fdFooterImgMouseDown(event, ${i})">
      <img src="${img.dataUrl}" style="width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:${op}"/>
      <div class="fd-resize-handle" style="position:absolute;bottom:-6px;right:-6px;width:12px;height:12px;background:#0066cc;border-radius:50%;cursor:nwse-resize;z-index:15" onmousedown="fdFooterImgResizeMouseDown(event, ${i})"></div>
    </div>`;
  }).join('');
  const fImgLayer = fImgs ? `<div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;">${fImgs}</div>` : '';
  return `<div class="rpt-footer-bar" style="position:relative;" onmouseover="document.querySelectorAll('.fd-footer-img-wrapper').forEach(e=>e.style.display='block')" onmouseout="document.querySelectorAll('.fd-footer-img-wrapper').forEach(e=>e.style.display='none')">${fImgLayer}${d.footerText || 'HOME COLLECTION AVAILABLE'}</div>
          <div class="rpt-footer-addr">${labAddr} | Mob: ${labPhone}</div>`;
}

/* ── Footer image resize tracking ── */
let _fdFooterImgResize = { active: false, idx: -1, startX: 0, startY: 0, startW: 0, startH: 0 };

function fdFooterImgResizeMouseDown(event, idx) {
  event.preventDefault();
  event.stopPropagation();
  _fdFooterImgResize = { active: true, idx: idx, startX: event.clientX, startY: event.clientY, startW: fdDesign.footerImages[idx].w, startH: fdDesign.footerImages[idx].h };
  document.addEventListener('mousemove', fdFooterImgResizeMouseMove);
  document.addEventListener('mouseup', fdFooterImgResizeMouseUp);
}

function fdFooterImgResizeMouseMove(e) {
  if (!_fdFooterImgResize.active) return;
  const idx = _fdFooterImgResize.idx;
  const deltaX = e.clientX - _fdFooterImgResize.startX;
  const deltaY = e.clientY - _fdFooterImgResize.startY;
  const newW = Math.max(20, _fdFooterImgResize.startW + deltaX);
  const newH = Math.max(20, _fdFooterImgResize.startH + deltaY);
  fdDesign.footerImages[idx].w = newW;
  fdDesign.footerImages[idx].h = newH;
  fdRenderFooterImages();
  fdUpdate();
}

function fdFooterImgResizeMouseUp(e) {
  _fdFooterImgResize.active = false;
  document.removeEventListener('mousemove', fdFooterImgResizeMouseMove);
  document.removeEventListener('mouseup', fdFooterImgResizeMouseUp);
}

function fdFooterImgMouseDown(event, idx) {
  if (event.target.classList.contains('fd-resize-handle')) return;
  event.preventDefault();
  const wrapper = event.currentTarget;
  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = fdDesign.footerImages[idx].xPct || 2;
  const startTop = fdDesign.footerImages[idx].yPct || 10;
  const footer = document.querySelector('.rpt-footer-bar');
  const footerRect = footer ? footer.getBoundingClientRect() : null;
  
  function handleMouseMove(e) {
    if (!footerRect) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const pxPerPct = footerRect.width / 100;
    const newXPct = Math.max(0, Math.min(100, startLeft + (deltaX / pxPerPct)));
    const newYPct = Math.max(0, Math.min(100, startTop + (deltaY / pxPerPct)));
    fdDesign.footerImages[idx].xPct = Math.round(newXPct * 10) / 10;
    fdDesign.footerImages[idx].yPct = Math.round(newYPct * 10) / 10;
    fdUpdate();
  }
  
  function handleMouseUp() {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }
  
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
}

/* ── Build footer bar HTML (shared by preview + PDF generation) ── */
function fdBuildFooterBar(d, labAddr, labPhone) {
  // Pinned images inside footer bar
  const fImgs = (d.footerImages || []).filter(img => img.dataUrl).map(img => {
    const xPct = img.xPct !== undefined ? img.xPct : 2;
    const yPct = img.yPct !== undefined ? img.yPct : 10;
    const w = img.w || 80; const h = img.h || 40;
    const op = img.opacity !== undefined ? img.opacity : 1;
    return `<img src="${img.dataUrl}" style="position:absolute;left:${xPct}%;top:${yPct}%;width:${w}px;height:${h}px;opacity:${op};object-fit:contain;pointer-events:none;z-index:5;"/>`;
  }).join('');
  const fImgLayer = fImgs ? `<div style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;">${fImgs}</div>` : '';
  // If footer bar (coloured band) is hidden, only render the address line
  if (!d.showFooterBar) {
    const addrLine = (labAddr || labPhone) ? `<div class="rpt-footer-addr" style="text-align:center;padding:4px 0;">${labAddr}${labAddr && labPhone ? ' | Mob: ' : ''}${labPhone}</div>` : '';
    return addrLine ? `<div style="page-break-inside:avoid;break-inside:avoid">${addrLine}</div>` : '';
  }
  return `<div style="page-break-inside:avoid;break-inside:avoid"><div class="rpt-footer-bar" style="position:relative">${fImgLayer}${d.footerText || 'HOME COLLECTION AVAILABLE'}</div><div class="rpt-footer-addr">${labAddr} | Mob: ${labPhone}</div></div>`;
}

/* Build the absolutely-positioned image layer for print/PDF */
function fdBuildCustomImageLayer(images, containerHeight) {
  if (!images || !images.length) return '';
  const items = images.filter(img => img.dataUrl).map(img => {
    const xPct = img.xPct !== undefined ? img.xPct : 5;
    const yPx  = img.yPx  !== undefined ? img.yPx  : 40;
    const w    = img.w || 120;
    const h    = img.h || 80;
    const op   = img.opacity !== undefined ? img.opacity : 1;
    const z    = img.behindText ? 0 : 10;
    return `<div style="position:absolute;left:${xPct}%;top:${yPx}px;width:${w}px;height:${h}px;opacity:${op};z-index:${z};pointer-events:none;margin:0;padding:0;">
      <img src="${img.dataUrl}" style="width:100%;height:100%;object-fit:contain;display:block;"/>
    </div>`;
  }).join('');
  // Wrap in a zero-size absolutely-positioned container so images never affect
  // document flow or shift position between screen preview and print.
  return `<div style="position:absolute;top:0;left:0;width:100%;height:0;overflow:visible;pointer-events:none;z-index:10;margin:0;padding:0;">${items}</div>`;
}
 
/* ── Hex input sync ── */
function fdHexSync(key) {
 
  const hexEl = document.getElementById(`fd-${key}-hex`);
  const pickerEl = document.getElementById(`fd-${key}`);
  const val = hexEl.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) { pickerEl.value = val; fdUpdate(); }
}
 
/* ── Sig management ── */
function fdRenderSigs() {
  const c = document.getElementById('fd-sigs-container');
  c.innerHTML = (fdDesign.sigs || []).map((s, i) => `
    <div class="fd-sig-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <input type="text" class="form-input" value="${s.name}" placeholder="Name" oninput="fdUpdate()"/>
      <input type="text" class="form-input" value="${s.qual}" placeholder="Qualification" oninput="fdUpdate()"/>
      <label style="display:flex;align-items:center;gap:4px;flex-shrink:0;font-size:11px;color:var(--muted)" title="Shift left (negative) or right (positive), in px">
        ↔ <input type="number" step="5" value="${s.shiftX||0}" style="width:56px;font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)" oninput="fdSigShiftInput(${i},this.value)"/>
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0" title="Upload signature image">
        ${s.image
          ? `<img src="${s.image}" style="height:28px;max-width:60px;object-fit:contain;border:1px solid var(--border);border-radius:4px;background:#fff"/>`
          : `<span style="font-size:18px">🖊️</span>`}
        <input type="file" accept="image/*" style="display:none" onchange="fdHandleSigImageUpload(${i}, this)"/>
      </label>
      ${s.image ? `<button onclick="fdRemoveSigImage(${i})" title="Remove image" style="background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:12px;padding:2px 6px;flex-shrink:0">🗑️</button>` : ''}
      <button onclick="fdRemoveSig(${i})" style="background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 6px;flex-shrink:0">×</button>
    </div>`).join('');
}
function fdSigShiftInput(i, val) {
  if (!fdDesign.sigs || !fdDesign.sigs[i]) return;
  fdDesign.sigs[i].shiftX = +val || 0;
  fdUpdate();
}
function fdAddSig() {
  fdRead();
  fdDesign.sigs.push({ name: '', qual: '', image: null, shiftX: 0 });
  fdRenderSigs();
  fdUpdate();
}
function fdRemoveSig(i) {
  fdRead();
  fdDesign.sigs.splice(i, 1);
  fdRenderSigs();
  fdUpdate();
}
function fdHandleSigImageUpload(i, input) {
  if (!input.files || !input.files[0]) return;
  fdRead();
  const reader = new FileReader();
  reader.onload = e => {
    fdDesign.sigs[i].image = e.target.result;
    fdRenderSigs();
    fdUpdate();
  };
  reader.readAsDataURL(input.files[0]);
}
function fdRemoveSigImage(i) {
  fdRead();
  fdDesign.sigs[i].image = null;
  fdRenderSigs();
  fdUpdate();
}
 
/* ── Color presets ── */
const FD_PRESETS = {
  classic: { primary:'#c0392b', secondary:'#1a5276', headerText:'#ffffff', tableHead:'#1a5276', highColor:'#c0392b', lowColor:'#1a5276' },
  navy:    { primary:'#1a4a7a', secondary:'#0d9488', headerText:'#ffffff', tableHead:'#1a4a7a', highColor:'#c0392b', lowColor:'#1a4a7a' },
  teal:    { primary:'#0d9488', secondary:'#1a4a7a', headerText:'#ffffff', tableHead:'#0d9488', highColor:'#dc2626', lowColor:'#0d9488' },
  purple:  { primary:'#7c3aed', secondary:'#1e1b4b', headerText:'#ffffff', tableHead:'#7c3aed', highColor:'#dc2626', lowColor:'#7c3aed' },
  forest:  { primary:'#065f46', secondary:'#1f2937', headerText:'#ffffff', tableHead:'#065f46', highColor:'#b91c1c', lowColor:'#065f46' },
  slate:   { primary:'#334155', secondary:'#1e293b', headerText:'#f1f5f9', tableHead:'#334155', highColor:'#dc2626', lowColor:'#1d4ed8' },
  maroon:  { primary:'#881337', secondary:'#1f2937', headerText:'#ffffff', tableHead:'#881337', highColor:'#881337', lowColor:'#1e40af' },
  orange:  { primary:'#c2410c', secondary:'#1c1917', headerText:'#ffffff', tableHead:'#c2410c', highColor:'#c2410c', lowColor:'#1d4ed8' },
};
function fdApplyPreset(name) {
  fdRead();
  Object.assign(fdDesign, FD_PRESETS[name]);
  fdWrite();
  fdUpdate();
}
 
/* ── Build the CSS from current fdDesign ── */
/* ── Build the CSS from current fdDesign ── */
function fdBuildCSS(d) {
  const border = d.showBorder ? '1px solid #ddd' : 'none';
  const zebraRule = d.zebra ? `#fd-preview-wrap .rpt-table tr:nth-child(even) td, .rpt-wrap .rpt-table tr:nth-child(even) td { background: #f9f9f9; }` : '';
  // Compute scaled font sizes relative to the base
  const base = parseFloat(d.fontSize) || 13;
  const fs = (ratio) => (base * ratio).toFixed(1) + 'px';
  return `
    .rpt-wrap { font-family: ${d.font}; font-size: ${d.fontSize}; color: #111; background: #fff; width: 100%; box-sizing:border-box; display:flex; flex-direction:column; min-height:277mm; height:auto; }
    .rpt-header { display:flex; justify-content:space-between; align-items:flex-start; padding-top:${d.headerPaddingTop||0}px; padding-bottom:6px; border-bottom:2px solid ${d.primary}; margin-bottom:6px; }
    .rpt-header-centered { text-align:center; padding-top:${d.headerPaddingTop||0}px; padding-bottom:6px; border-bottom:2px solid ${d.primary}; margin-bottom:6px; }
    .rpt-header-banner { background:${d.primary}; color:${d.headerText}; padding-top:${Math.max(10,(d.headerPaddingTop||0)+10)}px; padding-bottom:10px; padding-left:14px; padding-right:14px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; margin-left:-12mm; margin-right:-12mm; width: 100%; }
    .rpt-lab-name { font-size:${d.labNameSize}; font-weight:900; color:${d.primary}; letter-spacing:-0.5px; line-height:1; }
    .rpt-lab-name-white { font-size:${d.labNameSize}; font-weight:900; color:${d.headerText}; letter-spacing:-0.5px; line-height:1; }
    .rpt-lab-sub { font-size:${fs(1.0)}; color:${d.secondary}; font-weight:700; letter-spacing:1px; text-transform:uppercase; }
    .rpt-lab-sub-white { font-size:${fs(1.0)}; color:${d.headerText}; opacity:0.85; font-weight:600; }
    .rpt-lab-tagline { font-size:${fs(0.77)}; color:#888; margin-top:1px; }
    .rpt-lab-tagline-white { font-size:${fs(0.77)}; color:${d.headerText}; opacity:0.7; margin-top:1px; }
    .rpt-contact { text-align:right; font-size:${fs(0.85)}; color:#333; line-height:1.7; }
    .rpt-contact-white { text-align:right; font-size:${fs(0.85)}; color:${d.headerText}; opacity:0.85; line-height:1.7; }
    .rpt-title-bar { background:${d.primary}; color:${d.headerText}; text-align:center; font-size:${d.titleSize||fs(1.15)}; font-weight:700; letter-spacing:2px; padding:5px 0; margin:0 -12mm 7px -12mm; width: calc(100% + 24mm); }
    .rpt-patient-grid { display:grid; grid-template-columns:1fr 1fr; gap:2px 20px; margin-bottom:8px; font-size:${d.patientInfoSize||fs(0.92)}; border-bottom:1px solid #ddd; padding-bottom:6px; }
    .rpt-patient-grid .rpt-row { display:flex; gap:4px; }
    .rpt-patient-grid .rpt-label { font-weight:600; min-width:105px; }
    .rpt-table { width:100%; border-collapse:collapse; font-size:${d.tableBodySize||fs(1.0)}; }
    .rpt-table th { background:${d.tableHead}; color:#fff; padding:6px 8px; text-align:left; font-weight:700; font-size:${d.tableHeadSize||fs(1.0)}; letter-spacing:0.5px; border:${border}; }
    .rpt-table td { padding:5px 8px; border:${border}; vertical-align:top; }
    .rpt-table tr { page-break-inside: avoid !important; }
    .rpt-table .rpt-test-name { font-weight:600; color:#1a1a1a; }
    .rpt-table .rpt-subtest { padding-left:16px; color:#333; }
    .rpt-table .rpt-high { color:${d.highColor}; font-weight:${d.boldAbnormal ? '700' : '400'}; }
    .rpt-table .rpt-low  { color:${d.lowColor};  font-weight:${d.boldAbnormal ? '700' : '400'}; }
    .rpt-table .rpt-section-row td { background:#eef2f7; font-weight:700; font-size:${d.tableBodySize ? d.tableBodySize : fs(0.92)}; letter-spacing:1.5px; border-top:2px solid ${d.secondary}; padding:5px 8px; color:${d.secondary}; text-align:center; page-break-after: avoid !important; }
    /* SIGNATURE FIXES HERE */
    .rpt-signatures { display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid #ddd; flex-wrap:wrap; gap:10px; margin-bottom:12px; width: 100%; page-break-inside: avoid !important; break-inside: avoid !important; }
    .rpt-sig-box { text-align:center; min-width:120px; flex:1; page-break-inside: avoid !important; break-inside: avoid !important; }
    .rpt-sig-img { display:block; max-height:42px; max-width:130px; margin:0 auto 2px; object-fit:contain; }
    .rpt-sig-line { display:block; height:0; border-top:1px solid #555; width:120px; margin:32px auto 4px; }
    .rpt-sig-name { font-weight:700; font-size:${d.footerSize ? d.footerSize : fs(0.92)}; }
    .rpt-sig-qual { font-size:${d.footerSize ? d.footerSize : fs(0.8)}; color:#555; }
    .rpt-footer-bar { background:${d.primary}; color:${d.headerText}; text-align:center; font-size:${d.footerSize||fs(0.85)}; font-weight:700; letter-spacing:1px; padding-top:${Math.max(5,(d.footerPaddingTop||0)+5)}px; padding-bottom:${d.footerPaddingBottom||4}px; margin:0 -12mm 0 -12mm; width: calc(100% + 24mm); position:relative; min-height:${d.footerHeight||80}px; display:flex; align-items:center; justify-content:center; }
    .rpt-footer-addr { text-align:center; font-size:${d.footerSize ? d.footerSize : fs(0.77)}; color:#555; margin-top:3px; }
    .rpt-footer-spacer { flex:1; }
    .rpt-footer-block { margin-top:auto; page-break-inside:avoid !important; break-inside:avoid !important; }
    @media print {
      /* Footer: fixed at page bottom, repeats on every printed page */
      .rpt-footer-block {
        display: block !important;
        position: fixed !important;
        bottom: 0 !important;
        left: 0 !important;
        right: 0 !important;
        width: 100% !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        z-index: 1000 !important;
      }
      /* Spacer is not needed with fixed positioning */
      .rpt-footer-spacer { display: none !important; }
      .rpt-footer-bar {
        margin-left: 0 !important;
        margin-right: 0 !important;
        width: 100% !important;
        min-height: ${d.footerHeight || 80}px !important;
      }
      .rpt-footer-addr {
        width: 100% !important;
        background: #fff !important;
        padding: 3px 0 5px 0 !important;
      }
      /* rpt-wrap: normal flow, no flex tricks needed */
      .rpt-wrap {
        display: block !important;
        height: auto !important;
        min-height: 0 !important;
        position: relative !important;
        overflow: visible !important;
      }
      /* title/header bars fill full width */
      .rpt-title-bar, .rpt-header-banner {
        margin-left: 0 !important; margin-right: 0 !important; width: 100% !important;
      }
      /* @page bottom margin = footer height so content never overlaps fixed footer */
      @page { size: A4 portrait; margin-top: 10mm; margin-bottom: ${Math.ceil(((d.footerHeight || 80) + 28) * 0.2646)}mm; margin-left: 0; margin-right: 0; }
      @page :first { margin-top: 0mm; margin-bottom: ${Math.ceil(((d.footerHeight || 80) + 28) * 0.2646)}mm; }
      .rpt-table tr { page-break-inside: avoid !important; }
      .rpt-table .rpt-section-row td { page-break-after: avoid !important; }
      .rpt-interp-entry { page-break-inside: avoid !important; }
    }
    /* LOGO FIX HERE */
    .rpt-logo { object-fit:contain; page-break-inside: avoid !important; break-inside: avoid !important; }
    ${zebraRule}
  `;
}
 
/* ── Build watermark overlay HTML (position-aware, separate from logo) ── */
function fdBuildWatermark(d) {
  if (!d.wmEnabled) return '';
  const src = window.fdWmDataUrl || fdLogoDataUrl;  // use wm image, fallback to header logo
  if (!src) return '';
 
  const op      = (parseInt(d.wmOpacity) || 10) / 100;
  const sz      = parseInt(d.wmSize) || 50;
  // Use Number() so that '0' correctly parses as 0 (parseInt('0')||fallback wrongly gives fallback)
  const rot     = (d.wmRotate !== undefined && d.wmRotate !== '') ? Number(d.wmRotate) : -30;
  const pos     = d.wmPosition || 'center';
 
  // All positions include transform-origin:center so rotation always pivots around the element's centre
  const posStyles = {
    'center':       'top:50%;left:50%;transform:translate(-50%,-50%) rotate('+rot+'deg);transform-origin:center',
    'top-left':     'top:10%;left:5%;transform:rotate('+rot+'deg);transform-origin:center',
    'top-right':    'top:10%;right:5%;transform:rotate('+rot+'deg);transform-origin:center',
    'bottom-left':  'bottom:10%;left:5%;transform:rotate('+rot+'deg);transform-origin:center',
    'bottom-right': 'bottom:10%;right:5%;transform:rotate('+rot+'deg);transform-origin:center',
  };
  const style = posStyles[pos] || posStyles['center'];
 
  return `<div class="rpt-watermark-wrap" style="position:absolute;top:0;left:0;width:100%;height:277mm;overflow:hidden;pointer-events:none;z-index:0;">
    <div style="position:absolute;${style};width:${sz}%;opacity:${op};">
      <img src="${src}" style="width:100%;max-width:100%;object-fit:contain;display:block;pointer-events:none;"/>
    </div>
  </div>`;
}
 
/* ── Build the HTML for the report header based on style + logo placement ── */
/* ── Single signature box, with optional left/right shift for aligning to a letterhead ── */
function fdBuildSigBoxHTML(s) {
  const shift = (s && s.shiftX) ? s.shiftX : 0;
  const shiftStyle = shift ? ` style="transform:translateX(${shift}px)"` : '';
  return `
          <div class="rpt-sig-box"${shiftStyle}>
            ${s.image ? `<img src="${s.image}" class="rpt-sig-img" alt="signature"/>` : `<div class="rpt-sig-line"></div>`}
            <div class="rpt-sig-name">${s.name || ''}</div>
            <div class="rpt-sig-qual">${s.qual || ''}</div>
          </div>`;
}

/* ── Patient info block: fixed grid, or free-positioned fields for pre-printed letterheads ── */
function fdBuildPatientInfoHTML(d, vals) {
  // vals: { name, age, sex, doctor, reportDate, visitDate, refNo, opIp } — already display-ready strings
  const v = Object.assign({ name:'—', age:'—', sex:'—', doctor:'—', reportDate:'—', visitDate:'—', refNo:'—', opIp:'—' }, vals || {});

  if ((d.patientInfoLayout || 'grid') !== 'custom') {
    return `
      <div class="rpt-patient-grid">
        <div class="rpt-row"><span class="rpt-label">Patient's Name</span><span>: <b>${v.name}</b></span></div>
        <div class="rpt-row"><span class="rpt-label">Age</span><span>: ${v.age}</span></div>
        <div class="rpt-row"><span class="rpt-label">Ref. by Dr.</span><span>: ${v.doctor}</span></div>
        <div class="rpt-row"><span class="rpt-label">Sex</span><span>: ${v.sex}</span></div>
        <div class="rpt-row"><span class="rpt-label">Date of Report</span><span>: ${v.reportDate}</span></div>
        <div class="rpt-row"><span class="rpt-label">Date of Visit</span><span>: ${v.visitDate}</span></div>
        <div class="rpt-row"><span class="rpt-label">Ref. No.</span><span>: ${v.refNo}</span></div>
        <div class="rpt-row"><span class="rpt-label">OP / IP</span><span>: ${v.opIp}</span></div>
      </div>`;
  }

  const height = parseInt(d.patientInfoHeight) || 115;
  const fields = (d.patientFields && d.patientFields.length) ? d.patientFields : FD_DEFAULTS.patientFields;
  const items = fields.filter(f => f.visible !== false).map(f => {
    const val = v[f.key] !== undefined ? v[f.key] : '—';
    const fw = f.bold ? 700 : 400;
    // No label here by design — the letterhead paper already has the label preprinted;
    // this places just the value at the configured spot.
    return `<div style="position:absolute;left:${f.xPct}%;top:${f.yPct}%;font-size:${f.fontSize||12}px;font-weight:${fw};white-space:nowrap;">${val}</div>`;
  }).join('');
  return `<div style="position:relative;width:100%;height:${height}px;margin-bottom:8px;">${items}</div>`;
}

function fdBuildHeader(d, labName, labAddr, labPhone, labEmail, logoSrc) {
  const logoH   = parseInt(d.logoSize) || 60;
  const logoPos = d.logoPosition || 'header';
  const taglineHtml = d.showTagline && d.tagline
    ? `<div class="rpt-lab-tagline">${d.tagline}</div>` : '';
 
  function logoImg(extraStyle='') {
    if (!d.showLogo || !logoSrc) return '';
    return `<img src="${logoSrc}" style="height:${logoH}px;max-width:${logoH*2}px;object-fit:contain;${extraStyle}" class="rpt-logo"/>`;
  }
 
  const inlineLogo = logoImg('margin-right:10px;flex-shrink:0');

  // Pinned images inside header
  const hImgs = (d.headerImages || []).filter(img => img.dataUrl).map(img => {
    const xPct = img.xPct !== undefined ? img.xPct : 2;
    const yPct = img.yPct !== undefined ? img.yPct : 10;
    const w = img.w || 80; const h = img.h || 60;
    const op = img.opacity !== undefined ? img.opacity : 1;
    return `<img src="${img.dataUrl}" style="position:absolute;left:${xPct}%;top:${yPct}%;width:${w}px;height:${h}px;opacity:${op};object-fit:contain;pointer-events:none;z-index:5;"/>`;
  }).join('');
  const hImgLayer = hImgs ? `<div style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;">${hImgs}</div>` : '';
 
  // Top-left / top-right / top-center: logo sits ABOVE the header divider
  if (d.showLogo && logoSrc && logoPos === 'top-left') {
    return `
      <div style="margin-bottom:4px;text-align:left">${logoImg()}</div>
      <div class="rpt-header" style="position:relative">
        ${hImgLayer}
        <div><div class="rpt-lab-name">${labName.toUpperCase()}</div><div class="rpt-lab-sub">${labAddr}</div>${taglineHtml}</div>
        <div class="rpt-contact">✉ ${labEmail}<br/>📞 ${labPhone}</div>
      </div>`;
  }
  if (d.showLogo && logoSrc && logoPos === 'top-right') {
    return `
      <div style="margin-bottom:4px;text-align:right">${logoImg()}</div>
      <div class="rpt-header" style="position:relative">
        ${hImgLayer}
        <div><div class="rpt-lab-name">${labName.toUpperCase()}</div><div class="rpt-lab-sub">${labAddr}</div>${taglineHtml}</div>
        <div class="rpt-contact">✉ ${labEmail}<br/>📞 ${labPhone}</div>
      </div>`;
  }
  if (d.showLogo && logoSrc && logoPos === 'top-center') {
    return `
      <div style="margin-bottom:6px;text-align:center">${logoImg()}</div>
      <div class="rpt-header-centered" style="position:relative">
        ${hImgLayer}
        <div class="rpt-lab-name" style="text-align:center">${labName.toUpperCase()}</div>
        <div class="rpt-lab-sub" style="text-align:center">${labAddr}</div>
        ${taglineHtml}
        <div class="rpt-contact" style="text-align:center;margin-top:2px">📞 ${labPhone} &nbsp;|&nbsp; ✉ ${labEmail}</div>
      </div>`;
  }

  // headerStyle-driven layouts (logo inline in header)
  if (d.headerStyle === 'centered') {
    return `
      <div class="rpt-header-centered" style="position:relative">
        ${hImgLayer}
        ${d.showLogo && logoSrc ? `<div style="text-align:center;margin-bottom:4px">${logoImg()}</div>` : ''}
        <div class="rpt-lab-name" style="text-align:center">${labName.toUpperCase()}</div>
        <div class="rpt-lab-sub" style="text-align:center">${labAddr}</div>
        ${taglineHtml}
        <div class="rpt-contact" style="text-align:center;margin-top:2px">📞 ${labPhone} &nbsp;|&nbsp; ✉ ${labEmail}</div>
      </div>`;
  }
  if (d.headerStyle === 'banner') {
    return `
      <div class="rpt-header-banner" style="position:relative">
        ${hImgLayer}
        <div style="display:flex;align-items:center;gap:10px">
          ${d.showLogo && logoSrc ? logoImg('margin-right:8px') : ''}
          <div>
            <div class="rpt-lab-name-white">${labName.toUpperCase()}</div>
            <div class="rpt-lab-sub-white">${labAddr}</div>
            ${d.showTagline && d.tagline ? `<div class="rpt-lab-tagline-white">${d.tagline}</div>` : ''}
          </div>
        </div>
        <div class="rpt-contact-white">📞 ${labPhone}<br/>✉ ${labEmail}</div>
      </div>`;
  }
  if (d.headerStyle === 'logo-left') {
    return `
      <div class="rpt-header" style="position:relative">
        ${hImgLayer}
        <div style="display:flex;align-items:center;gap:10px">
          ${d.showLogo && logoSrc ? inlineLogo : ''}
          <div>
            <div class="rpt-lab-name">${labName.toUpperCase()}</div>
            <div class="rpt-lab-sub">${labAddr}</div>
            ${taglineHtml}
          </div>
        </div>
        <div class="rpt-contact">📞 ${labPhone}<br/>✉ ${labEmail}</div>
      </div>`;
  }
  // classic (default)
  return `
    <div class="rpt-header" style="position:relative">
      ${hImgLayer}
      <div style="display:flex;align-items:flex-start;gap:8px">
        ${d.showLogo && logoSrc ? inlineLogo : ''}
        <div>
          <div class="rpt-lab-name">${labName.toUpperCase()}</div>
          <div class="rpt-lab-sub">Diagnostic Laboratory</div>
          ${taglineHtml}
        </div>
      </div>
      <div class="rpt-contact">✉ ${labEmail}<br/>📞 ${labPhone}</div>
    </div>`;
}
 
/* ── Build sample preview HTML ── */
function fdBuildPreview(d) {
  const labName  = (document.getElementById('s-lab-name')  || {}).value || 'Your Lab Name';
  const labAddr  = (document.getElementById('s-lab-addr')  || {}).value || '123 Health Street, City';
  const labPhone = (document.getElementById('s-lab-phone') || {}).value || '+91-9999999999';
  const labEmail = (document.getElementById('s-lab-email') || {}).value || 'lab@example.com';
  const logoSrc  = fdLogoDataUrl || null;
  const ci = d.customImages || [];
 
  const sigs = (d.sigs || []).map(s => fdBuildSigBoxHTML(Object.assign({}, s, { name: s.name || 'Signatory' })).trim()).join('');
 
  const footerBar = fdBuildFooterBarPreview(d, labAddr, labPhone);
 
  // Build element HTML map — always build full HTML, mark hidden so space is preserved
  const elemHtml = {
    header:       { hidden: d.showHeader === false,       html: fdBuildHeader(d, labName, labAddr, labPhone, labEmail, logoSrc) },
    titlebar:     { hidden: d.showTitleBar === false,     html: `<div class="rpt-title-bar">${d.reportTitle || 'TEST REPORT'}</div>` },
    patientinfo:  { hidden: d.showPatientInfo === false,  html: fdBuildPatientInfoHTML(d, {
        name: 'Sample Patient', age: '35 Y', sex: 'Male', doctor: 'Dr. Sample',
        reportDate: '04-04-2026 12:00 PM', visitDate: '04-04-2026 10:30 AM', refNo: '1001', opIp: 'OP-1023',
      }) },
    resultstable: { hidden: d.showResultsTable === false, html: `
      <table class="rpt-table">
        <thead><tr>
          <th style="width:38%">TEST DESCRIPTION</th>
          <th style="width:18%">RESULT</th>
          <th style="width:14%">UNITS</th>
          <th style="width:30%">REFERENCE RANGE</th>
        </tr></thead>
        <tbody>
          <tr class="rpt-section-row"><td colspan="4">HAEMATOLOGY</td></tr>
          <tr><td class="rpt-test-name" colspan="4" style="font-weight:700;background:#f5f5f5;font-size:10.5px">COMPLETE BLOOD COUNT</td></tr>
          <tr><td class="rpt-test-name">Haemoglobin</td><td>13.5</td><td>gms%</td><td>12.0 - 17.0</td></tr>
          <tr><td class="rpt-subtest">— Neutrophil</td><td class="rpt-high">82</td><td>%</td><td>40 - 70</td></tr>
          <tr><td class="rpt-subtest">— Lymphocytes</td><td class="rpt-low">15</td><td>%</td><td>20 - 40</td></tr>
          <tr><td class="rpt-test-name">Platelet Count</td><td>2.8</td><td>Lakhs/Cumm</td><td>1.5 - 4.0</td></tr>
          <tr class="rpt-section-row"><td colspan="4">BIO-CHEMISTRY</td></tr>
          <tr><td class="rpt-test-name" colspan="4" style="font-weight:700;background:#f5f5f5;font-size:10.5px">RENAL FUNCTION TEST</td></tr>
          <tr><td class="rpt-test-name">Urea</td><td>28</td><td>mg/dl</td><td>10 - 40</td></tr>
          <tr><td class="rpt-test-name">Creatinine</td><td class="rpt-high">1.8</td><td>mg/dl</td><td>0.5 - 1.4</td></tr>
        </tbody>
      </table>` },
    signatures:   { hidden: d.showSignatures === false,   html: `<div class="rpt-signatures">${sigs}</div>` },
    footer:       { hidden: d.showFooter === false,       html: footerBar },
  };
 
  // Custom image position → after which element key
  const ciAfterMap = {
    'before-header':      'before-header',
    'after-header':       'header',
    'after-titlebar':     'titlebar',
    'after-patientinfo':  'patientinfo',
    'after-table':        'resultstable',
    'before-footer':      'signatures',
  };
 
  function ciFor(pos) { return ''; } // images are now absolutely positioned
 
  // Render in order (fdBuildOrderedBody handles visibility:hidden for hidden elements)
  // For preview, wrap each element with a draggable section container
  const order = (d.elementOrder && d.elementOrder.length) ? d.elementOrder : FD_DEFAULT_ELEMENT_ORDER;
  let previewBody = '';
  order.forEach(key => {
    const entry = elemHtml[key];
    if (!entry) return;
    const content = entry.html || '';
    const hidden  = !!entry.hidden;
    if (!content) return;

    const meta = FD_ELEMENT_META[key];
    const label = meta ? meta.label : key;
    const visStyle = hidden ? 'visibility:hidden;' : '';

    if (key === 'footer') {
      // Footer is rendered in rpt-page-footer slot, not in the scrollable body
      return;
    } else {
      previewBody += `
        <div class="fd-preview-section" data-key="${key}" style="${visStyle}position:relative;">
          <div class="fd-preview-drag-handle" title="Drag to reorder ${label}">☰</div>
          ${content}
        </div>`;
    }
  });

  // Inject absolutely-positioned images
  previewBody += fdBuildCustomImageLayer([]);

  return `
    <style>
      ${fdBuildCSS(d)}
      /* Multi-page preview styles */
      .rpt-page {
        background:#fff;
        width:100%;
        min-height:277mm;
        position:relative;
        box-sizing:border-box;
        display:flex;
        flex-direction:column;
        overflow:hidden;
      }
      .rpt-page-break {
        width:calc(100% + 24mm);
        margin:0 -12mm;
        height:6px;
        background:repeating-linear-gradient(90deg,#c0392b 0,#c0392b 8px,transparent 8px,transparent 16px);
        position:relative;
      }
      .rpt-page-break::after {
        content:'--- page break ---';
        position:absolute;
        left:50%;transform:translateX(-50%);
        top:-9px;
        background:#fff;
        color:#c0392b;
        font-size:10px;
        font-weight:700;
        letter-spacing:1px;
        padding:0 8px;
        white-space:nowrap;
      }
      .rpt-page-footer {
        margin-top:auto;
      }
    </style>
    <div class="rpt-multi-page-preview">
      <div class="rpt-wrap rpt-page" style="position:relative">
        ${fdBuildWatermark(d)}
        <div class="rpt-page-content">
          ${previewBody}
        </div>
        <div class="rpt-page-footer">
          ${d.showFooter === false ? '' : `<div class="fd-preview-section rpt-footer-block" data-key="footer" style="position:relative"><div class="fd-preview-drag-handle" title="Drag to reorder Footer">☰</div>${footerBar}</div>`}
        </div>
      </div>
    </div>`;
}
 
 
 
/* ── Build ordered element body for print/PDF (with real patient data) ── */
function fdBuildOrderedBody(d, elemHtmlMap, ci) {
  // elemHtmlMap values can be:
  //   { html: '...', hidden: true }  → render with visibility:hidden (preserves space)
  //   { html: '...', hidden: false } → render normally
  //   '...' (plain string)           → render normally (legacy)
  //   ''                             → skip entirely
  const order = (d.elementOrder && d.elementOrder.length) ? d.elementOrder : FD_DEFAULT_ELEMENT_ORDER;
  let html = '';
  let hasFooter = false;

  order.forEach(key => {
    const entry   = elemHtmlMap[key];
    if (!entry) return;
    const isObj   = typeof entry === 'object';
    const content = isObj ? (entry.html || '') : entry;
    const hidden  = isObj ? !!entry.hidden : false;
    if (!content) return;

    if (key === 'footer') {
      hasFooter = true;
      // Wrap spacer + footer together so they are never split across pages
      const visStyle = hidden ? ' style="visibility:hidden"' : '';
      html += `<div class="rpt-footer-spacer"></div>`;
      html += `<div class="rpt-footer-block"${visStyle}>${content}</div>`;
    } else if (hidden) {
      // Hidden non-footer: wrap in visibility:hidden div to preserve space
      html += `<div style="visibility:hidden">${content}</div>`;
    } else {
      // Visible: output content directly — no wrapper div so flex layout is not disrupted
      html += content;
    }
  });

  return html;
}
 
/* ── Main update function ── */
function fdStepFont(type, delta) {
  if (type === 'base') {
    const cur = parseInt(fdDesign.fontSize) || 13;
    const next = Math.min(20, Math.max(8, cur + delta));
    fdDesign.fontSize = next + 'px';
    if(document.getElementById('fd-fontsize')) document.getElementById('fd-fontsize').value = fdDesign.fontSize;
    if(document.getElementById('fd-fontsize-display')) document.getElementById('fd-fontsize-display').textContent = fdDesign.fontSize;
  } else if (type === 'lab') {
    const cur = parseInt(fdDesign.labNameSize) || 30;
    const next = Math.min(48, Math.max(16, cur + delta));
    fdDesign.labNameSize = next + 'px';
    if(document.getElementById('fd-labname-size')) document.getElementById('fd-labname-size').value = fdDesign.labNameSize;
    if(document.getElementById('fd-labname-display')) document.getElementById('fd-labname-display').textContent = fdDesign.labNameSize;
  } else if (type === 'title') {
    const cur = parseInt(fdDesign.titleSize) || 15;
    const next = Math.min(30, Math.max(10, cur + delta));
    fdDesign.titleSize = next + 'px';
    if (document.getElementById('fd-title-size')) {
      document.getElementById('fd-title-size').value = fdDesign.titleSize;
      document.getElementById('fd-title-display').textContent = fdDesign.titleSize;
    }
  } else if (type === 'patient') {
    const cur = parseInt(fdDesign.patientInfoSize) || 12;
    const next = Math.min(20, Math.max(8, cur + delta));
    fdDesign.patientInfoSize = next + 'px';
    if (document.getElementById('fd-patient-size')) {
      document.getElementById('fd-patient-size').value = fdDesign.patientInfoSize;
      document.getElementById('fd-patient-display').textContent = fdDesign.patientInfoSize;
    }
  } else if (type === 'theader') {
    const cur = parseInt(fdDesign.tableHeadSize) || 13;
    const next = Math.min(20, Math.max(8, cur + delta));
    fdDesign.tableHeadSize = next + 'px';
    if (document.getElementById('fd-theader-size')) {
      document.getElementById('fd-theader-size').value = fdDesign.tableHeadSize;
      document.getElementById('fd-theader-display').textContent = fdDesign.tableHeadSize;
    }
  } else if (type === 'tbody') {
    const cur = parseInt(fdDesign.tableBodySize) || 13;
    const next = Math.min(20, Math.max(8, cur + delta));
    fdDesign.tableBodySize = next + 'px';
    if (document.getElementById('fd-tbody-size')) {
      document.getElementById('fd-tbody-size').value = fdDesign.tableBodySize;
      document.getElementById('fd-tbody-display').textContent = fdDesign.tableBodySize;
    }
  } else if (type === 'footer') {
    const cur = parseInt(fdDesign.footerSize) || 11;
    const next = Math.min(18, Math.max(6, cur + delta));
    fdDesign.footerSize = next + 'px';
    if (document.getElementById('fd-footer-size')) {
      document.getElementById('fd-footer-size').value = fdDesign.footerSize;
      document.getElementById('fd-footer-display').textContent = fdDesign.footerSize;
    }
  } else if (type === 'notes') {
    const cur = parseInt(fdDesign.notesSize) || 12;
    const next = Math.min(20, Math.max(8, cur + delta));
    fdDesign.notesSize = next + 'px';
    if (document.getElementById('fd-notes-size')) {
      document.getElementById('fd-notes-size').value = fdDesign.notesSize;
      document.getElementById('fd-notes-display').textContent = fdDesign.notesSize;
    }
  }
  fdUpdate();
}

/* ---- Multi-page preview pagination ---------------------------------------- */
function fdPaginatePreview() {
  const wrap  = document.getElementById('fd-preview-wrap');
  if (!wrap) return;
  const multi = wrap.querySelector('.rpt-multi-page-preview');
  if (!multi) return;

  const A4_PX   = Math.round(297 * 96 / 25.4);
  const PAD_TOP = Math.round(10  * 96 / 25.4);
  const PAD_BOT = Math.round(8   * 96 / 25.4);
  const PAGE_H  = A4_PX - PAD_TOP - PAD_BOT;

  const firstPage  = multi.querySelector('.rpt-page');
  if (!firstPage) return;
  const contentDiv = firstPage.querySelector('.rpt-page-content');
  const footerDiv  = firstPage.querySelector('.rpt-page-footer');
  if (!contentDiv) return;

  const footerH  = footerDiv ? footerDiv.offsetHeight : 0;
  const contentH = contentDiv.scrollHeight;
  const usableH  = PAGE_H - footerH - 4;

  if (contentH <= usableH + 20) return; // fits in one page

  const numPages   = Math.ceil(contentH / usableH);
  const footerHTML = footerDiv ? footerDiv.innerHTML : '';
  const wmEl       = firstPage.querySelector('.rpt-watermark-overlay');
  const wmHTML     = wmEl ? wmEl.outerHTML : '';

  // Clip first page content
  contentDiv.style.height   = usableH + 'px';
  contentDiv.style.overflow = 'hidden';
  firstPage.style.minHeight = PAGE_H + 'px';
  firstPage.style.height    = PAGE_H + 'px';

  for (let p = 1; p < numPages; p++) {
    const scrollOffset = p * usableH;
    const isLast       = (p === numPages - 1);

    // Page break rule
    const breakEl = document.createElement('div');
    breakEl.className = 'rpt-page-break';
    multi.appendChild(breakEl);

    // New page container
    const pageEl = document.createElement('div');
    pageEl.className = 'rpt-wrap rpt-page';
    pageEl.style.minHeight = PAGE_H + 'px';
    pageEl.style.height    = isLast ? 'auto' : PAGE_H + 'px';
    if (wmHTML) pageEl.innerHTML = wmHTML;

    // Content window (cloned, shifted upward)
    const newContent = document.createElement('div');
    newContent.className      = 'rpt-page-content';
    newContent.style.height   = usableH + 'px';
    newContent.style.overflow = 'hidden';
    newContent.style.position = 'relative';

    const clone = contentDiv.cloneNode(true);
    clone.style.height   = 'auto';
    clone.style.overflow = 'visible';
    clone.style.position = 'absolute';
    clone.style.top      = (-scrollOffset) + 'px';
    clone.style.left     = '0';
    clone.style.width    = '100%';
    newContent.appendChild(clone);
    pageEl.appendChild(newContent);

    // Footer repeated on every page
    const newFooter = document.createElement('div');
    newFooter.className = 'rpt-page-footer';
    newFooter.innerHTML = footerHTML;
    pageEl.appendChild(newFooter);

    multi.appendChild(pageEl);
  }
}

function fdUpdate() {
  fdRead();
  fdRenderElementList();
  const wrap = document.getElementById('fd-preview-wrap');
  if (wrap) wrap.innerHTML = fdBuildPreview(fdDesign);
  // Wire up preview section drag-and-drop
  fdInitPreviewDrag();
  // Render draggable image overlay on top
  fdRenderImageOverlay();
  // Paginate preview into A4 page blocks (runs after layout is painted)
  requestAnimationFrame(() => requestAnimationFrame(fdPaginatePreview));
  // Also sync color hex inputs
  ['primary','secondary','header-text','table-head','high-color','low-color'].forEach(key => {
    const picker = document.getElementById(`fd-${key}`);
    const hex = document.getElementById(`fd-${key}-hex`);
    if (picker && hex) hex.value = picker.value;
  });
}
 
/* ── Save design to server ── */
async function fdSave() {
  fdRead();
  const payload = {
    lab_name:    (document.getElementById('s-lab-name')  || {}).value || '',
    lab_address: (document.getElementById('s-lab-addr')  || {}).value || '',
    lab_phone:   (document.getElementById('s-lab-phone') || {}).value || '',
    lab_email:   (document.getElementById('s-lab-email') || {}).value || '',
    form_design: JSON.stringify(fdDesign),
    nr_subcategory_mode: (document.getElementById('s-nr-subcategory-mode') || {}).value || 'subcategory',
  };
  const res = await apiFetch(`${API}/settings`, { method: 'POST', body: JSON.stringify(payload) });
  if (res) {
    toast('Form design saved!', 'success');
    _nrSubcategoryMode = payload.nr_subcategory_mode;
  }
}
 
/* ── Reset to defaults ── */
function fdReset() {
  fdDesign = JSON.parse(JSON.stringify(FD_DEFAULTS));
  fdLogoDataUrl = null;
  window.fdWmDataUrl = null;
  const wmThumb = document.getElementById('fd-wm-thumb');
  if (wmThumb) wmThumb.innerHTML = '';
  const logoThumb = document.getElementById('fd-logo-thumb');
  if (logoThumb) logoThumb.innerHTML = '';
  const logoPreview = document.getElementById('s-logo-preview');
  if (logoPreview) logoPreview.innerHTML = '';
  fdUpdateAppLogo('');
  fdWrite();
  fdUpdate();
  toast('Design reset to defaults', 'success');
}
 
/* ── Load design from server settings ── */
async function fdLoad() {
  const data = await apiFetch(`${API}/settings`);
  const logoFromSettingsPath = fdNormalizeLogoPath((data || {}).logo_path);
  if (data && data.form_design) {
    try {
      const saved = JSON.parse(data.form_design);
      fdDesign = Object.assign(JSON.parse(JSON.stringify(FD_DEFAULTS)), saved);
    } catch(e) { fdDesign = JSON.parse(JSON.stringify(FD_DEFAULTS)); }
  }
  // Restore lab info fields
  if (data) {
    const f = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
    f("s-lab-name",  data.lab_name);
    f("s-lab-addr",  data.lab_address);
    f("s-lab-phone", data.lab_phone);
    f("s-lab-email", data.lab_email);
    f("s-nr-subcategory-mode", data.nr_subcategory_mode || 'subcategory');
    _nrSubcategoryMode = data.nr_subcategory_mode || 'subcategory';
  }
  // Restore logo from saved design
  if (fdDesign.logoDataUrl) {
    fdLogoDataUrl = fdDesign.logoDataUrl;
    const imgTag = `<img src="${fdLogoDataUrl}" style="max-height:60px;max-width:180px;border-radius:4px;border:1px solid var(--border)"/>`;
    const thumb = document.getElementById('fd-logo-thumb');
    if (thumb) thumb.innerHTML = imgTag;
    const preview = document.getElementById('s-logo-preview');
    if (preview) preview.innerHTML = imgTag;
  } else if (logoFromSettingsPath) {
    fdLogoDataUrl = logoFromSettingsPath;
    const imgTag = `<img src="${fdLogoDataUrl}" style="max-height:60px;max-width:180px;border-radius:4px;border:1px solid var(--border)"/>`;
    const thumb = document.getElementById('fd-logo-thumb');
    if (thumb) thumb.innerHTML = imgTag;
    const preview = document.getElementById('s-logo-preview');
    if (preview) preview.innerHTML = imgTag;
  } else {
    fdLogoDataUrl = null;
  }
  fdUpdateAppLogo(fdLogoDataUrl || logoFromSettingsPath || '');
  fdWrite();
  fdRenderSigs();
  fdRenderElementList();
  fdRenderCustomImages();
  fdRenderHeaderImages();
  fdRenderFooterImages();
  fdUpdate();
}
 
/* ── Patch showPage to load design when settings opens ── */
const _fdOrigShowPage = window.showPage;
window.showPage = function(name) {
  _fdOrigShowPage(name);
  if (name === 'settings') fdLoad();
};
 
 
 
/* ── BACKUP & RESTORE ─────────────────────────────────────── */
 
async function loadBackupStats() {
  try {
    const res = await fetch('/api/backup/stats');
    const s = await res.json();
    document.getElementById('bk-patients').textContent = s.patients ?? '—';
    document.getElementById('bk-reports').textContent  = s.reports  ?? '—';
    document.getElementById('bk-doctors').textContent  = s.doctors  ?? '—';
    document.getElementById('bk-bills').textContent    = s.bills    ?? '—';
  } catch(e) {
    console.error('Backup stats error', e);
  }
}
 
function backupFormat(fmt) {
  const endpoints = { db: '/api/backup/download', excel: '/api/backup/excel', pdf: '/api/backup/pdf' };
  const labels    = { db: '⬇ Download .db', excel: '⬇ Download .xlsx', pdf: '⬇ Download .pdf' };
  const btn = document.getElementById(`backup-btn-${fmt}`);
  const status = document.getElementById('backup-status');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '⏳ Preparing...';
  status.textContent = '';
 
  const a = document.createElement('a');
  a.href = endpoints[fmt];
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
 
  const names = { db: 'Database (.db)', excel: 'Excel (.xlsx)', pdf: 'PDF (.pdf)' };
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = labels[fmt];
    status.innerHTML = `<span style="color:#10b981">✔ ${names[fmt]} backup downloaded successfully!</span>`;
  }, 1500);
}
 
let restoreFileObj = null;
 
function previewRestoreFile(input) {
  const file = input.files[0];
  if (!file) return;
  restoreFileObj = file;
  const sizeMB = (file.size / 1024 / 1024).toFixed(2);
  document.getElementById('restore-file-info').innerHTML =
    `<strong>${file.name}</strong> &nbsp;·&nbsp; ${sizeMB} MB &nbsp;·&nbsp; Last modified: ${new Date(file.lastModified).toLocaleString()}`;
  document.getElementById('restore-preview').style.display = 'block';
  document.getElementById('restore-status').textContent = '';
}
 
function handleRestoreDrop(event) {
  event.preventDefault();
  document.getElementById('restore-drop-zone').style.borderColor = 'var(--border)';
  const file = event.dataTransfer.files[0];
  if (!file || !file.name.endsWith('.db')) {
    showToast('Please drop a valid .db backup file');
    return;
  }
  restoreFileObj = file;
  const input = document.getElementById('restore-file-input');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  previewRestoreFile(input);
}
 
function clearRestoreSelection() {
  restoreFileObj = null;
  document.getElementById('restore-file-input').value = '';
  document.getElementById('restore-preview').style.display = 'none';
  document.getElementById('restore-status').textContent = '';
}
 
async function restoreDB() {
  if (!restoreFileObj) return;
  const confirmed = confirm(
    '⚠️ Are you sure?\n\nThis will REPLACE all current data with the backup.\nThe app will reload after restore.'
  );
  if (!confirmed) return;
 
  const btn = document.getElementById('restore-btn');
  const status = document.getElementById('restore-status');
  btn.disabled = true;
  btn.textContent = '⏳ Restoring...';
  status.textContent = '';
 
  const fd = new FormData();
  fd.append('db_file', restoreFileObj);
 
  try {
    const res = await fetch('/api/backup/restore', { method: 'POST', body: fd });
    const data = await res.json();
    if (res.ok) {
      status.innerHTML = '<span style="color:#10b981">✔ ' + data.message + '. Reloading...</span>';
      setTimeout(() => location.reload(), 1800);
    } else {
      status.innerHTML = '<span style="color:#ef4444">✘ ' + (data.error || 'Restore failed') + '</span>';
      btn.disabled = false;
      btn.textContent = '🔄 Restore Now';
    }
  } catch(e) {
    status.innerHTML = '<span style="color:#ef4444">✘ Network error during restore</span>';
    btn.disabled = false;
    btn.textContent = '🔄 Restore Now';
  }
}
 
/* ── EXPORT HELPER ───────────────────────────────────────────── */
function exportPage(type, fmt) {
  const urls = {
    catalog:         `/api/export/catalog/${fmt}`,
    interpretations: `/api/export/interpretations/${fmt}`,
    stages:          `/api/export/stages/${fmt}`,
  };
  const a = document.createElement('a');
  a.href = urls[type];
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Downloading ${fmt.toUpperCase()}…`, 'success');
}
 
/* ── EDIT TEST ───────────────────────────────────────────────── */
let _allTests = [];
 
// Patch loadTests to cache data
const _origLoadTests = loadTests;
window.loadTests = async function(category) {
  await _origLoadTests(category);
  // re-fetch all for cache
  const data = await apiFetch(`${API}/tests`);
  if (data) _allTests = data;
};
 
async function openEditTest(id) {
  const t = _allTests.find(x => x.id === id);
  if (!t) { toast('Could not load test data', 'error'); return; }
  document.getElementById('et-id').value             = t.id;
  document.getElementById('et-name').value           = t.test_name || '';
  document.getElementById('et-cat').value            = t.category  || '';
  document.getElementById('et-unit').value           = t.unit      || '';
  document.getElementById('et-min').value            = t.normal_min != null ? t.normal_min : '';
  document.getElementById('et-max').value            = t.normal_max != null ? t.normal_max : '';
  document.getElementById('et-normal-text').value    = t.normal_text   || '';
  document.getElementById('et-desc').value           = t.description   || '';
  document.getElementById('et-amount').value         = t.amount != null ? t.amount : '';
  document.getElementById('et-interpretation').value = t.interpretation || '';
  // Constant reference table (e.g. HbA1c's Non Diabetics / Goal / Good Control
  // rows) — stored as a JSON string on the catalog row; malformed/empty JSON
  // just yields an empty editor rather than blocking the rest of the modal.
  let existingRefRows = [];
  if (t.ref_table) {
    try {
      const parsed = JSON.parse(t.ref_table);
      if (Array.isArray(parsed)) existingRefRows = parsed;
    } catch (e) { /* ignore malformed ref_table */ }
  }
  renderRefTableRows('et', existingRefRows);

  await _populateStage1Dropdown('et-stage1', null);
  document.getElementById('et-stage1').value = '';
  document.getElementById('et-stage23-wrap').style.display = 'none';
  document.getElementById('et-stage3').value = '';

  // Look up existing stage assignment from cache and pre-select
  const asS3 = _stageCache.find(e => e.s3 && e.s3.toLowerCase() === (t.test_name||'').toLowerCase());
  const asS2 = !asS3 && _stageCache.find(e => e.s2 && e.s2.toLowerCase() === (t.test_name||'').toLowerCase() && !e.s3id);
  if (asS3) {
    document.getElementById('et-stage1').value = asS3.s1id;
    document.getElementById('et-cat').value = asS3.s1 || '';
    document.getElementById('et-stage23-wrap').style.display = '';
    await _populateStage2ForStage1('et-stage2', asS3.s1id, asS3.s2id);
    document.getElementById('et-stage3').value = asS3.s3 || t.test_name || '';
  } else if (asS2) {
    document.getElementById('et-stage1').value = asS2.s1id;
    document.getElementById('et-cat').value = asS2.s1 || '';
    document.getElementById('et-stage23-wrap').style.display = '';
    await _populateStage2ForStage1('et-stage2', asS2.s1id, null);
    document.getElementById('et-stage3').value = t.test_name || '';
  } else {
    // No stage match — show fields empty but reveal them so user can assign
    document.getElementById('et-stage23-wrap').style.display = '';
    document.getElementById('et-stage3').value = t.test_name || '';
    if (t.category) {
      const s1sel = document.getElementById('et-stage1');
      const targetCat = (t.category || '').trim().toUpperCase();
      const opt = Array.from(s1sel.options || []).find(o => (o.textContent || '').trim().toUpperCase() === targetCat);
      if (opt) {
        s1sel.value = opt.value;
        await _populateStage2ForStage1('et-stage2', parseInt(opt.value), null);
        const s2sel = document.getElementById('et-stage2');
        if (t.sub_category && s2sel) {
          const targetSub = (t.sub_category || '').trim().toUpperCase();
          const s2opt = Array.from(s2sel.options || []).find(o => (o.textContent || '').trim().toUpperCase() === targetSub);
          if (s2opt) s2sel.value = s2opt.value;
        }
      }
    }
  }

  openModal('edit-test-modal');
}
 
async function saveEditTest() {
  const id = document.getElementById('et-id').value;
  const name = (document.getElementById('et-stage3').value || '').trim() || document.getElementById('et-name').value.trim();
  if (!name) { toast('Test name required', 'error'); return; }
  document.getElementById('et-name').value = name;
  const s1sel = document.getElementById('et-stage1');
  if (s1sel.value) document.getElementById('et-cat').value = s1sel.options[s1sel.selectedIndex].textContent;

  // Capture sub_category before any async operations that could re-render the dropdown
  const etS2sel = document.getElementById('et-stage2');
  const etS2val = etS2sel ? etS2sel.value : '';
  let capturedSubCategory = '';
  if (etS2val === '__new__') {
    capturedSubCategory = (document.getElementById('et-stage2-new').value || '').trim().toUpperCase();
  } else if (etS2val && etS2val !== '') {
    const opt = etS2sel.options[etS2sel.selectedIndex];
    capturedSubCategory = opt ? opt.textContent.trim() : '';
  }

  const payload = {
    test_name:       name,
    category:        document.getElementById('et-cat').value,
    sub_category:    capturedSubCategory || null,
    unit:            document.getElementById('et-unit').value,
    normal_min:      document.getElementById('et-min').value   || null,
    normal_max:      document.getElementById('et-max').value   || null,
    normal_text:     document.getElementById('et-normal-text').value,
    description:     document.getElementById('et-desc').value,
    amount:          document.getElementById('et-amount').value || 0,
    interpretation:  document.getElementById('et-interpretation').value,
    ref_table:       (() => { const r = collectRefTableRows('et'); return r.length ? JSON.stringify(r) : null; })(),
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
  const s1id = document.getElementById('et-stage1').value;
  let s2id = etS2val;
  let savedStage2Id = null;
  const s3name = name;

  if (s1id) {
    if (etS2val === '__new__' && capturedSubCategory) {
      const createdS2 = await apiFetch(`${API}/stage2`, { method: 'POST',
        body: JSON.stringify({ stage1_id: parseInt(s1id), name: capturedSubCategory }) });
      if (!createdS2 || !createdS2.id) { toast('Could not create subcategory', 'error'); return; }
      s2id = String(createdS2.id);
    }
    if (!s2id || s2id === '__new__') s2id = await _getOrCreateBridgeStage2(s1id);
    if (s2id) {
      await buildStageCache();
      const exists = _stageCache.find(e => e.s2id === parseInt(s2id) &&
        e.s3 && e.s3.toLowerCase() === s3name.toLowerCase());
        if (!exists) {
          await apiFetch(`${API}/stage3`, { method: 'POST',
            body: JSON.stringify({ stage2_id: parseInt(s2id), name: s3name }) });
        }
        savedStage2Id = parseInt(s2id);
      }
    }

    await buildStageCache();
    toast('Test updated!', 'success');
    closeModal('edit-test-modal');
    const etS2New = document.getElementById('et-stage2-new');
    if (etS2New) { etS2New.value = ''; etS2New.style.display = 'none'; }
    _invalidateCatalogCache();
    loadTests();
    await refreshStageViewsIfOpen(s1id ? parseInt(s1id) : null, savedStage2Id);
  }
}
 
/* ── EDIT STAGE ──────────────────────────────────────────────── */
function openEditStage(level, id, name) {
  const titles = { 1: '✏️ Edit Test Type', 2: '✏️ Edit Test Name', 3: '✏️ Edit Sub-Parameter' };
  const labels = { 1: 'Test Type Name',    2: 'Test Name',         3: 'Sub-Parameter Name'  };
  document.getElementById('edit-stage-modal-title').textContent = titles[level];
  document.getElementById('es-label').textContent               = labels[level];
  document.getElementById('es-level').value = level;
  document.getElementById('es-id').value    = id;
  document.getElementById('es-name').value  = name;
  openModal('edit-stage-modal');
  setTimeout(() => document.getElementById('es-name').focus(), 100);
}
 
async function saveEditStage() {
  const level = parseInt(document.getElementById('es-level').value);
  const id    = document.getElementById('es-id').value;
  const name  = document.getElementById('es-name').value.trim();
  if (!name) { toast('Name cannot be empty', 'error'); return; }
  const urls = { 1: `${API}/stage1/${id}`, 2: `${API}/stage2/${id}`, 3: `${API}/stage3/${id}` };
  const res = await apiFetch(urls[level], { method: 'PUT', body: JSON.stringify({ name }) });
  if (res) {
    toast('Updated!', 'success');
    closeModal('edit-stage-modal');
    if (level === 1) loadStage1();
    else if (level === 2 && selectedStage1Id) {
      const el = document.querySelector(`#s1-${selectedStage1Id}`);
      if (el) selectStage1(selectedStage1Id, el);
    } else if (level === 3 && selectedStage2Id) {
      const el = document.querySelector(`#s2-${selectedStage2Id}`);
      if (el) selectStage2(selectedStage2Id, el);
    }
  }
}
 
/* ── EDIT INTERPRETATION ─────────────────────────────────────── */
// Read interpretation text safely from data attributes (avoids quote/JSON breakage in onclick)
function openEditInterpFromBtn(btn) {
  const id   = btn.dataset.id;
  const name = btn.dataset.name.replace(/&quot;/g, '"');
  const text = btn.dataset.interp.replace(/&quot;/g, '"').replace(/&#10;/g, '\n');
  openEditInterp(id, name, text);
}
 
function openEditInterp(id, name, interpText) {
  document.getElementById('ei-id').value   = id;
  document.getElementById('ei-name').value = name;
  document.getElementById('ei-text').value = interpText || '';
  openModal('edit-interp-modal');
}
 
async function saveEditInterp() {
  const id   = document.getElementById('ei-id').value;
  const text = document.getElementById('ei-text').value.trim();
  if (!text) { toast('Interpretation text is required', 'error'); return; }
  // Re-fetch latest test data to preserve all other fields
  let existing = _allTests.find(x => x.id === parseInt(id));
  if (!existing) {
    // fallback: fetch directly if cache missing
    const fresh = await apiFetch(`${API}/tests`);
    if (fresh) { _allTests = fresh; existing = _allTests.find(x => x.id === parseInt(id)); }
  }
  if (!existing) { toast('Could not find test', 'error'); return; }
  const payload = {
    test_name:      existing.test_name,
    category:       existing.category,
    unit:           existing.unit,
    normal_min:     existing.normal_min,
    normal_max:     existing.normal_max,
    normal_text:    existing.normal_text,
    description:    existing.description,
    interpretation: text,
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
    toast('Interpretation saved!', 'success');
    closeModal('edit-interp-modal');
    loadInterpretations();
    const data = await apiFetch(`${API}/tests`);
    if (data) _allTests = data;
  }
}
 
/* ── ADD INTERPRETATION ──────────────────────────────────────── */
function openAddInterp() {
  document.getElementById('ai-name').value     = '';
  document.getElementById('ai-test-id').value  = '';
  document.getElementById('ai-category').value = '';
  document.getElementById('ai-text').value     = '';
  document.getElementById('ai-suggestions').style.display = 'none';
  openModal('add-interp-modal');
}
 
async function searchInterpTest(q) {
  const box = document.getElementById('ai-suggestions');
  document.getElementById('ai-test-id').value  = '';
  document.getElementById('ai-category').value = '';
  if (!q || q.length < 1) { box.style.display = 'none'; return; }
  // Search from cached tests, fallback to fetch
  let src = _allTests;
  if (!src.length) { const d = await apiFetch(`${API}/tests`); if (d) { _allTests = d; src = d; } }
  const matches = src.filter(t => t.test_name.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  if (!matches.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = matches.map(t => `
    <div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)"
         onmousedown="selectInterpTest(${t.id},'${t.test_name.replace(/'/g,"\\'")}','${(t.category||'').replace(/'/g,"\\'")}')">
      <b>${t.test_name}</b> <span style="color:var(--muted);font-size:11px">${t.category||''}</span>
    </div>`).join('');
}
 
function selectInterpTest(id, name, category) {
  document.getElementById('ai-test-id').value  = id;
  document.getElementById('ai-name').value     = name;
  document.getElementById('ai-category').value = category;
  document.getElementById('ai-suggestions').style.display = 'none';
}
 
async function saveAddInterp() {
  const id   = document.getElementById('ai-test-id').value;
  const text = document.getElementById('ai-text').value.trim();
  if (!id)   { toast('Please select a test from the list', 'error'); return; }
  if (!text) { toast('Interpretation text is required', 'error'); return; }
  const existing = _allTests.find(x => x.id === parseInt(id));
  if (!existing) { toast('Test not found', 'error'); return; }
  const payload = {
    test_name:      existing.test_name,
    category:       existing.category,
    unit:           existing.unit,
    normal_min:     existing.normal_min,
    normal_max:     existing.normal_max,
    normal_text:    existing.normal_text,
    description:    existing.description,
    interpretation: text,
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
    toast('Interpretation added!', 'success');
    closeModal('add-interp-modal');
    loadInterpretations();
    const data = await apiFetch(`${API}/tests`);
    if (data) _allTests = data;
  }
}
 
/* ── DELETE INTERPRETATION ───────────────────────────────────── */
async function deleteInterp(id, name) {
  if (!confirm(`Remove interpretation for "${name}"?\n\nThe test itself will remain, only the interpretation text will be cleared.`)) return;
  const existing = _allTests.find(x => x.id === parseInt(id));
  if (!existing) { toast('Could not find test', 'error'); return; }
  const payload = {
    test_name:      existing.test_name,
    category:       existing.category,
    unit:           existing.unit,
    normal_min:     existing.normal_min,
    normal_max:     existing.normal_max,
    normal_text:    existing.normal_text,
    description:    existing.description,
    interpretation: '',
  };
  const res = await apiFetch(`${API}/tests/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (res) {
    toast('Interpretation deleted', 'success');
    loadInterpretations();
    const data = await apiFetch(`${API}/tests`);
    if (data) _allTests = data;
  }
}
 
/* ── QUICK SEARCH FOR REPORT / BILL TEST ENTRY ───────────────── */
 
let _stageCache = [];       // flat list of {s1id, s1, s2id, s2, s3id, s3, rate}
let _qsHighlight = -1;      // keyboard nav index

// Map of stage2_id -> [other stage2_ids in the same linked group] (see Settings →
// Linked Subcategories). Used by nrQuickSelect() to pull in e.g. DC whenever CBC
// is picked, and vice versa.
let _stage2LinkMap = {};
async function _loadStage2LinkMap() {
  try {
    const groups = await apiFetch(`${API}/stage2-links`);
    const map = {};
    (groups || []).forEach(g => {
      const ids = (g.members || []).map(m => m.stage2_id);
      ids.forEach(id => {
        map[id] = ids.filter(other => other !== id);
      });
    });
    _stage2LinkMap = map;
  } catch (e) { /* keep previous value */ }
}
 
async function buildStageCache() {
  _stageCache = [];
  const [s1list, s2list, s3list, rates] = await Promise.all([
    apiFetch(`${API}/stage1`),
    apiFetch(`${API}/stage2`),
    apiFetch(`${API}/stage3`),
    apiFetch(`${API}/test-rates`).catch(() => []),
  ]);
  if (!s2list) return;
 
  const s1map = {};
  (s1list || []).forEach(s => s1map[s.id] = s.name);
  const s2map = {};
  (s2list || []).forEach(s => s2map[s.id] = { name: s.name, s1id: s.stage1_id });
 
  (s2list || []).forEach(s2 => {
    // entries WITH stage3
    const children = (s3list || []).filter(s3 => s3.stage2_id === s2.id);
    if (children.length) {
      children.forEach(s3 => {
        const rateRow = (rates || []).find(r =>
          r.stage1_name === s1map[s2.stage1_id] &&
          r.stage2_name === s2.name &&
          r.stage3_name === s3.name
        );
        _stageCache.push({
          s1id: s2.stage1_id, s1: s1map[s2.stage1_id] || '',
          s2id: s2.id,        s2: s2.name,
          s3id: s3.id,        s3: s3.name,
          rate: rateRow ? rateRow.rate : 0,
          label: `${s3.name}`,
          sub:   `${s1map[s2.stage1_id]} › ${s2.name}`,
        });
      });
    } else {
      // Stage 2 with no stage3 children — searchable directly
      const rateRow = (rates || []).find(r =>
        r.stage1_name === s1map[s2.stage1_id] &&
        r.stage2_name === s2.name &&
        (!r.stage3_name || r.stage3_name === '')
      );
      _stageCache.push({
        s1id: s2.stage1_id, s1: s1map[s2.stage1_id] || '',
        s2id: s2.id,        s2: s2.name,
        s3id: null,         s3: '',
        rate: rateRow ? rateRow.rate : 0,
        label: `${s2.name}`,
        sub:   `${s1map[s2.stage1_id]}`,
      });
    }
  });
}
 
// Also fetch flat rates list
apiFetch = (function(_orig) {
  return async function(url, opts) {
    return _orig(url, opts);
  };
})(apiFetch);
 
async function fetchAllRates() {
  // We'll fetch via the existing per-item endpoint lazily; cache is populated from bill_items history
}
 
function quickSearchTests(q) {
  const box   = document.getElementById('te-quick-results');
  _qsHighlight = -1;
  if (!q || q.trim().length < 1) { box.style.display = 'none'; return; }
  const term = q.toLowerCase();
  const hits = _stageCache.filter(e =>
    e.label.toLowerCase().includes(term) ||
    e.s2.toLowerCase().includes(term) ||
    e.s1.toLowerCase().includes(term)
  ).slice(0, 20);
 
  if (!hits.length) {
    box.innerHTML = `<div style="padding:12px 14px;color:var(--muted);font-size:13px">No tests found for "${q}"</div>`;
    box.style.display = 'block';
    return;
  }
 
  box.innerHTML = hits.map((h, i) => `
    <div class="qs-item" data-idx="${i}"
      style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border2);display:flex;justify-content:space-between;align-items:center"
      onmouseenter="qsHover(${i})"
      onclick="quickSelectTest(${i})">
      <div>
        <div style="font-weight:600;font-size:13px;color:var(--text)">${highlightMatch(h.label, q)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px">${h.sub}</div>
      </div>
      <div style="font-size:12px;color:#10b981;font-weight:700;white-space:nowrap;margin-left:12px">
        ${h.rate ? '₹' + h.rate : ''}
      </div>
    </div>
  `).join('');
  box.style.display = 'block';
  box._hits = hits;
 
  // close on outside click
  document.addEventListener('click', closeQuickSearch, { once: true });
}
 
function highlightMatch(text, q) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return text.slice(0, idx) +
    `<span style="background:rgba(59,130,246,.25);color:#60a5fa;border-radius:2px;padding:0 1px">${text.slice(idx, idx + q.length)}</span>` +
    text.slice(idx + q.length);
}
 
function qsHover(i) {
  _qsHighlight = i;
  document.querySelectorAll('.qs-item').forEach((el, idx) => {
    el.style.background = idx === i ? 'var(--surface2)' : '';
  });
}
 
function quickSearchKeyNav(e) {
  const box  = document.getElementById('te-quick-results');
  const items = box.querySelectorAll('.qs-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _qsHighlight = Math.min(_qsHighlight + 1, items.length - 1);
    items.forEach((el, i) => el.style.background = i === _qsHighlight ? 'var(--surface2)' : '');
    items[_qsHighlight]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _qsHighlight = Math.max(_qsHighlight - 1, 0);
    items.forEach((el, i) => el.style.background = i === _qsHighlight ? 'var(--surface2)' : '');
    items[_qsHighlight]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && _qsHighlight >= 0) {
    e.preventDefault();
    quickSelectTest(_qsHighlight);
  } else if (e.key === 'Escape') {
    closeQuickSearch();
  }
}
 
async function quickSelectTest(i) {
  const box = document.getElementById('te-quick-results');
  const hits = box._hits;
  if (!hits || !hits[i]) return;
  const h = hits[i];
 
  // Fill Stage 1
  const s1sel = document.getElementById('te-stage1');
  s1sel.value = h.s1id;
 
  // Load and fill Stage 2
  await loadBillStage2();
  const s2sel = document.getElementById('te-stage2');
  s2sel.value = h.s2id;
 
  // Load and fill Stage 3
  await loadBillStage3();
  if (h.s3id) {
    const s3sel = document.getElementById('te-stage3');
    s3sel.value = h.s3id;
  }
 
  // Fill rate
  document.getElementById('te-rate').value = h.rate || '';
  if (!h.rate && (h.s3id || h.s2id)) await autoFillRate();
 
  // Clear search
  document.getElementById('te-quick-search').value = '';
  box.style.display = 'none';
  box._hits = null;
 
  // Flash the Add button to signal ready
  const addBtn = document.querySelector('#bill-test-section .btn-primary');
  if (addBtn) {
    addBtn.style.transform = 'scale(1.1)';
    addBtn.style.background = '#10b981';
    setTimeout(() => { addBtn.style.transform = ''; addBtn.style.background = ''; }, 400);
  }
}
 
function clearQuickSearch() {
  document.getElementById('te-quick-search').value = '';
  const box = document.getElementById('te-quick-results');
  box.style.display = 'none';
  box._hits = null;
  // also reset dropdowns
  document.getElementById('te-stage1').value = '';
  document.getElementById('te-stage2').innerHTML = '<option value="">—</option>';
  document.getElementById('te-stage3').innerHTML = '<option value="">—</option>';
  document.getElementById('te-rate').value = '';
}
 
function closeQuickSearch(e) {
  const box    = document.getElementById('te-quick-results');
  const input  = document.getElementById('te-quick-search');
  if (e && (box.contains(e.target) || input.contains(e.target))) return;
  box.style.display = 'none';
}
 
/* ── REPORT PAGE QUICK SEARCH ────────────────────────────────── */
 
// Build a flat index from NR_TEMPLATES for instant search
// (_nrSearchIndex and _nrIndexBuilt declared near top of catalog block)
function buildNrSearchIndex() {
  _nrSearchIndex = [];
  Object.entries(NR_TEMPLATES).forEach(([sectionType, groups]) => {
    if (sectionType === 'CUSTOM') return;
    groups.forEach(grp => {
      grp.rows.forEach(row => {
        if (!row.name) return;
        _nrSearchIndex.push({
          sectionType,
          group:  grp.group,
          name:   row.name,
          unit:   row.unit  || '',
          ref:    row.ref   || '',
          ref_m:  row.ref_m || '',
          ref_f:  row.ref_f || '',
          _interpretation: row._interpretation || '',
          label:  row.name,
          sub:    `${sectionType} › ${grp.group}`,
        });
      });
      // Also make the group itself searchable (adds entire group)
      _nrSearchIndex.push({
        sectionType,
        group:     grp.group,
        name:      null,          // null = add whole group
        unit:      '',
        ref:       '',
        label:     grp.group,
        sub:       `${sectionType} — add all tests`,
        isGroup:   true,
      });
    });
  });
}
 
// Build index once NR_TEMPLATES is defined (called on first modal open)
// (_nrIndexBuilt declared near top of catalog block)
function ensureNrIndex() {
  if (!_nrIndexBuilt) { buildNrSearchIndex(); _nrIndexBuilt = true; }
}
 
let _nrQsHl = -1;
let _nrQsHits = [];
 
function nrQuickSearch(q) {
  const box = document.getElementById('nr-quick-results');
  _nrQsHl = -1;
  if (!q || !q.trim()) { box.style.display = 'none'; return; }
 
  const term = q.toLowerCase();
 
  // Build hits from _stageCache — deduplicate by stage level:
  //   stage1 match  → show as Stage1 entry (expands all s2+s3 under it)
  //   stage2 match  → show as Stage2 entry (expands all s3 under it)
  //   stage3 match  → show as Stage3 entry (adds that test only)
  const seen = new Set();
  _nrQsHits = [];
 
  _stageCache.forEach(e => {
    const s1Match = e.s1 && e.s1.toLowerCase().includes(term);
    const s2Match = e.s2 && e.s2.toLowerCase().includes(term);
    const s3Match = e.s3 && e.s3.toLowerCase().includes(term);
 
    if (s1Match) {
      const key = `s1:${e.s1id}`;
      if (!seen.has(key)) {
        seen.add(key);
        _nrQsHits.push({ _stageLevel: 1, s1id: e.s1id, s1: e.s1, label: e.s1, sub: 'Category — adds all tests' });
      }
    }
    if (s2Match) {
      const key = `s2:${e.s2id}`;
      if (!seen.has(key)) {
        seen.add(key);
        _nrQsHits.push({ _stageLevel: 2, s1id: e.s1id, s1: e.s1, s2id: e.s2id, s2: e.s2, label: e.s2, sub: e.s1 + ' — adds all sub-tests' });
      }
    }
    if (s3Match) {
      const key = `s3:${e.s3id}`;
      if (!seen.has(key)) {
        seen.add(key);
        _nrQsHits.push({ _stageLevel: 3, s1id: e.s1id, s1: e.s1, s2id: e.s2id, s2: e.s2, s3id: e.s3id, s3: e.s3, label: e.s3, sub: e.s1 + ' › ' + e.s2 });
      }
    }
  });
 
  _nrQsHits = _nrQsHits.slice(0, 25);
 
  if (!_nrQsHits.length) {
    box.innerHTML = `<div style="padding:12px 14px;color:var(--muted);font-size:13px">No tests found for "<b>${q}</b>"</div>`;
    box.style.display = 'block';
    return;
  }
 
  const iconMap = { 1: '🗂️', 2: '📋', 3: '🧪' };
  const colorMap = { 1: '#f59e0b', 2: '#3b82f6', 3: 'var(--text)' };
 
  box.innerHTML = _nrQsHits.map((h, i) => `
    <div class="nr-qs-item"
      data-i="${i}"
      style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border2);display:flex;justify-content:space-between;align-items:center;transition:background .1s"
      onmouseenter="nrQsHover(${i})"
      onclick="nrQuickSelect(${i})">
      <div>
        <div style="font-weight:600;font-size:13px;color:${colorMap[h._stageLevel]}">
          ${iconMap[h._stageLevel]} ${nrHlMatch(h.label, q)}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px">${h.sub}</div>
      </div>
    </div>
  `).join('');
  box.style.display = 'block';
  document.addEventListener('mousedown', nrQsClickOutside, { once: true });
}
 
function nrHlMatch(text, q) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return text.slice(0, i) +
    `<span style="background:rgba(59,130,246,.25);color:#93c5fd;border-radius:2px;padding:0 1px">${text.slice(i, i + q.length)}</span>` +
    text.slice(i + q.length);
}
 
function nrQsHover(i) {
  _nrQsHl = i;
  document.querySelectorAll('.nr-qs-item').forEach((el, idx) => {
    el.style.background = idx === i ? 'var(--surface2)' : '';
  });
}
 
function nrQuickKeyNav(e) {
  const box = document.getElementById('nr-quick-results');
  const items = box.querySelectorAll('.nr-qs-item');
  if (!items.length && e.key !== 'Escape') return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _nrQsHl = Math.min(_nrQsHl + 1, items.length - 1);
    items.forEach((el, i) => el.style.background = i === _nrQsHl ? 'var(--surface2)' : '');
    items[_nrQsHl]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _nrQsHl = Math.max(_nrQsHl - 1, 0);
    items.forEach((el, i) => el.style.background = i === _nrQsHl ? 'var(--surface2)' : '');
    items[_nrQsHl]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && _nrQsHl >= 0) {
    e.preventDefault();
    nrQuickSelect(_nrQsHl);
  } else if (e.key === 'Escape') {
    nrQsClose();
  }
}
 
function nrQsClickOutside(e) {
  const box   = document.getElementById('nr-quick-results');
  const input = document.getElementById('nr-quick-search');
  if (box && (box.contains(e.target) || (input && input.contains(e.target)))) {
    document.addEventListener('mousedown', nrQsClickOutside, { once: true });
    return;
  }
  nrQsClose();
}
 
function nrQsClose() {
  const box = document.getElementById('nr-quick-results');
  if (box) box.style.display = 'none';
}
 
function nrQuickSelect(i) {
  const h = _nrQsHits[i];
  if (!h) return;
 
  nrQsClose();
  document.getElementById('nr-quick-search').value = '';
 
  // Helper: find or create a CUSTOM section to hold stage-based rows
  function getOrCreateStageSection(sectionName) {
    let sec = nrSections.find(s => s.type === sectionName);
    if (!sec) {
      nrSections.push({ type: sectionName, idx: nrSectionIdx++, groups: [] });
      sec = nrSections[nrSections.length - 1];
    }
    return sec;
  }
 
  // Helper: collect all stage3 entries under a given s2id from _stageCache
  function getS3ForS2(s2id) {
    return _stageCache.filter(e => e.s2id === s2id && e.s3);
  }
 
  // Helper: collect all unique s2ids under a given s1id
  function getS2ForS1(s1id) {
    const map = {};
    _stageCache.filter(e => e.s1id === s1id).forEach(e => {
      if (!map[e.s2id]) map[e.s2id] = { s2id: e.s2id, s2: e.s2 };
    });
    return Object.values(map);
  }
 
  // Helper: add a group of rows into a section, skip if group already exists
  function addGroupToSection(sec, groupName, rows) {
    if (sec.groups.find(g => g.group === groupName)) return false;
    sec.groups.push({ group: groupName, rows });
    return true;
  }
 
  // ── STAGE 1 selected: add all stage2 groups, each with their stage3 rows ──
  if (h._stageLevel === 1) {
    const sec = getOrCreateStageSection(h.s1);
    const s2list = getS2ForS1(h.s1id);
    if (!s2list.length) { toast(`No tests found under "${h.s1}"`, 'error'); return; }
    let added = 0;
    const _qs_gender = _nrGetCurrentGender();
    s2list.forEach(s2 => {
      const s3rows = getS3ForS2(s2.s2id);
      const rows = s3rows.length
        ? s3rows.map(e => _nrRowWithRef(e.s3, '', '', _qs_gender))
        : [_nrRowWithRef(s2.s2, '', '', _qs_gender)];
      if (addGroupToSection(sec, s2.s2, rows)) added++;
    });
    renderNrSections();
    toast(`✔ ${h.s1}: added ${added} group${added !== 1 ? 's' : ''}`, 'success');
    setTimeout(() => {
      const secEl = document.querySelector(`[data-idx="${sec.idx}"]`);
      if (secEl) secEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
    return;
  }
 
  // ── STAGE 2 selected: behavior depends on the "New Report — Quick Search"
  //    setting (Settings → Lab Info). 'subcategory' (default) adds only the
  //    picked subcategory's group; 'category' adds the whole parent category,
  //    same as picking the stage-1 category directly. ──
  if (h._stageLevel === 2) {
    const sec = getOrCreateStageSection(h.s1);
    const _qs_gender = _nrGetCurrentGender();

    if (_nrSubcategoryMode === 'category') {
      const s2list = getS2ForS1(h.s1id);
      if (!s2list.length) { toast(`No tests found under "${h.s1}"`, 'error'); return; }
      let added = 0;
      s2list.forEach(s2 => {
        const s3rows = getS3ForS2(s2.s2id);
        const rows = s3rows.length
          ? s3rows.map(e => _nrRowWithRef(e.s3, '', '', _qs_gender))
          : [_nrRowWithRef(s2.s2, '', '', _qs_gender)];
        if (addGroupToSection(sec, s2.s2, rows)) added++;
      });
      renderNrSections();
      toast(`✔ ${h.s1}: added ${added} group${added !== 1 ? 's' : ''}`, 'success');
      setTimeout(() => {
        const secEl = document.querySelector(`[data-idx="${sec.idx}"]`);
        if (secEl) secEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
      return;
    }

    const s3rows = getS3ForS2(h.s2id);
    const rows = s3rows.length
      ? s3rows.map(e => _nrRowWithRef(e.s3, '', '', _qs_gender))
      : [_nrRowWithRef(h.s2, '', '', _qs_gender)];
    const added = addGroupToSection(sec, h.s2, rows) ? 1 : 0;
    if (added === 0) {
      toast(`"${h.s2}" already added`, 'error'); return;
    }

    // Pull in any linked subcategories (Settings → Linked Subcategories),
    // e.g. adding DC automatically when CBC is picked.
    let linkedAdded = 0;
    (_stage2LinkMap[h.s2id] || []).forEach(linkedS2id => {
      const entry = _stageCache.find(e => e.s2id === linkedS2id);
      if (!entry) return;
      const linkedSec = getOrCreateStageSection(entry.s1);
      const linkedRows = getS3ForS2(linkedS2id);
      const rowsForLinked = linkedRows.length
        ? linkedRows.map(e => _nrRowWithRef(e.s3, '', '', _qs_gender))
        : [_nrRowWithRef(entry.s2, '', '', _qs_gender)];
      if (addGroupToSection(linkedSec, entry.s2, rowsForLinked)) linkedAdded++;
    });

    renderNrSections();
    toast(`✔ Added: ${h.s2}${linkedAdded ? ` (+${linkedAdded} linked)` : ''}`, 'success');
    setTimeout(() => {
      const secEl = document.querySelector(`[data-idx="${sec.idx}"]`);
      if (secEl) secEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
    return;
  }
 
  // ── STAGE 3 selected: add just this single test ──
  if (h._stageLevel === 3) {
    const sec = getOrCreateStageSection(h.s1);
    let grp = sec.groups.find(g => g.group === h.s2);
    if (!grp) {
      grp = { group: h.s2, rows: [] };
      sec.groups.push(grp);
    }
    if (grp.rows.find(r => r.name === h.s3)) {
      toast(`"${h.s3}" already in report`, 'error'); return;
    }
    grp.rows.push(_nrRowWithRef(h.s3, '', '', _nrGetCurrentGender()));
    renderNrSections();
    toast(`✔ Added: ${h.s3}`, 'success');
    setTimeout(() => {
      const secEl = document.querySelector(`[data-idx="${sec.idx}"]`);
      if (secEl) secEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
    return;
  }
}
 
/* ══════════════════════════════════════════════════════════════
   OTHER LAB TESTS — Full CRUD with per-lab reference ranges
   ══════════════════════════════════════════════════════════════ */
 
let _currentOlrLabId   = null;
let _currentOlrLabName = '';
let _olrAllRows        = [];   // full list for client-side search
 
/* ── Labs panel ──────────────────────────────────────────────── */
async function loadOtherLabs() {
  const labs = await apiFetch(`${API}/other-labs`) || [];
  const list = document.getElementById('other-labs-list');
  if (!labs.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px 0">No labs added yet</div>`;
    return;
  }
  list.innerHTML = labs.map(l => `
    <div class="olr-lab-item ${l.id === _currentOlrLabId ? 'active' : ''}"
         id="lab-item-${l.id}"
         onclick="selectOtherLab(${l.id}, '${l.name.replace(/'/g,"\\'")}')">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.name}</span>
      <button class="btn btn-sm btn-danger" style="padding:2px 7px;font-size:11px;opacity:.7"
              onclick="event.stopPropagation();deleteOtherLab(${l.id},'${l.name.replace(/'/g,"\\'")}')">✕</button>
    </div>`).join('');
}
 
async function addOtherLab() {
  const inp = document.getElementById('new-lab-name');
  const name = inp.value.trim();
  if (!name) { toast('Enter a lab name', 'error'); return; }
  const res = await apiFetch(`${API}/other-labs`, {
    method: 'POST', body: JSON.stringify({ name })
  });
  if (res && res.id) {
    inp.value = '';
    toast(`Lab "${name}" added`, 'success');
    await loadOtherLabs();
    selectOtherLab(res.id, name);
  }
}
 
async function deleteOtherLab(id, name) {
  if (!confirm(`Delete lab "${name}" and ALL its test ranges?`)) return;
  await apiFetch(`${API}/other-labs/${id}`, { method: 'DELETE' });
  toast('Lab deleted', 'success');
  if (_currentOlrLabId === id) {
    _currentOlrLabId = null;
    _currentOlrLabName = '';
    document.getElementById('olr-lab-title').textContent = '← Select a lab to manage its tests';
    document.getElementById('olr-actions').style.display = 'none';
    closeOlrForm();
    renderOlrTable([]);
  }
  loadOtherLabs();
}
 
async function selectOtherLab(id, name) {
  _currentOlrLabId   = id;
  _currentOlrLabName = name;
  // highlight
  document.querySelectorAll('.olr-lab-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById(`lab-item-${id}`);
  if (item) item.classList.add('active');
  // header
  document.getElementById('olr-lab-title').textContent = `🏥 ${name}`;
  document.getElementById('olr-actions').style.display = 'flex';
  closeOlrForm();
  await loadOlrTests();
}
 
/* ── Test ranges ─────────────────────────────────────────────── */
async function loadOlrTests() {
  if (!_currentOlrLabId) return;
  const rows = await apiFetch(`${API}/other-lab-ranges?lab_id=${_currentOlrLabId}`) || [];
  _olrAllRows = rows;
  renderOlrTable(rows);
}
 
function renderOlrTable(rows) {
  const tbody = document.getElementById('olr-tbody');
  const count = document.getElementById('olr-count');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:40px">No tests yet — click "+ Add Test" to add one</td></tr>`;
    count.textContent = '';
    return;
  }
  function rangeStr(mn, mx, txt) {
    if (txt) return txt;
    if (mn != null && mx != null) return `${mn} – ${mx}`;
    if (mn != null) return `> ${mn}`;
    if (mx != null) return `< ${mx}`;
    return '—';
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>${r.test_name}</b></td>
      <td><span class="badge" style="background:rgba(139,92,246,.12);color:#a78bfa;font-size:11px">${r.category || '—'}</span></td>
      <td style="font-family:monospace;font-size:12px">${r.unit || '—'}</td>
      <td style="font-size:12px;color:var(--green)">${rangeStr(r.normal_min_m, r.normal_max_m, r.normal_text_m)}</td>
      <td style="font-size:12px;color:#f472b6">${rangeStr(r.normal_min_f, r.normal_max_f, r.normal_text_f)}</td>
      <td style="font-size:12px;color:var(--amber)">${rangeStr(r.normal_min_c, r.normal_max_c, r.normal_text_c)}</td>
      <td style="font-size:12px">${r.amount ? '₹' + r.amount : '—'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-outline" style="margin-right:4px" onclick="openOlrEditForm(${r.id})">✏</button>
        <button class="btn btn-sm btn-danger" onclick="deleteOlrTest(${r.id})">✕</button>
      </td>
    </tr>`).join('');
  count.textContent = `${rows.length} test${rows.length !== 1 ? 's' : ''} in this lab`;
}
 
function filterOlrTests() {
  const q = (document.getElementById('olr-search').value || '').toLowerCase();
  const filtered = q ? _olrAllRows.filter(r =>
    r.test_name.toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q)
  ) : _olrAllRows;
  renderOlrTable(filtered);
}
 
/* ── Form open/close ─────────────────────────────────────────── */
function openOlrForm() {
  document.getElementById('olr-form-title').textContent = 'Add Test Range';
  document.getElementById('olr-edit-id').value = '';
  ['olr-name','olr-category','olr-unit','olr-amount',
   'olr-min-m','olr-max-m','olr-text-m',
   'olr-min-f','olr-max-f','olr-text-f',
   'olr-min-c','olr-max-c','olr-text-c',
   'olr-desc','olr-interpretation'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('olr-form-wrap').style.display = 'block';
  document.getElementById('olr-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
 
function openOlrEditForm(id) {
  const row = _olrAllRows.find(r => r.id === id);
  if (!row) return;
  document.getElementById('olr-form-title').textContent = `✏️ Edit — ${row.test_name}`;
  document.getElementById('olr-edit-id').value = id;
  document.getElementById('olr-name').value          = row.test_name || '';
  document.getElementById('olr-category').value      = row.category || '';
  document.getElementById('olr-unit').value          = row.unit || '';
  document.getElementById('olr-amount').value        = row.amount || '';
  document.getElementById('olr-min-m').value         = row.normal_min_m ?? '';
  document.getElementById('olr-max-m').value         = row.normal_max_m ?? '';
  document.getElementById('olr-text-m').value        = row.normal_text_m || '';
  document.getElementById('olr-min-f').value         = row.normal_min_f ?? '';
  document.getElementById('olr-max-f').value         = row.normal_max_f ?? '';
  document.getElementById('olr-text-f').value        = row.normal_text_f || '';
  document.getElementById('olr-min-c').value         = row.normal_min_c ?? '';
  document.getElementById('olr-max-c').value         = row.normal_max_c ?? '';
  document.getElementById('olr-text-c').value        = row.normal_text_c || '';
  document.getElementById('olr-desc').value          = row.description || '';
  document.getElementById('olr-interpretation').value = row.interpretation || '';
  document.getElementById('olr-form-wrap').style.display = 'block';
  document.getElementById('olr-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
 
function closeOlrForm() {
  document.getElementById('olr-form-wrap').style.display = 'none';
}
 
/* ── Save ────────────────────────────────────────────────────── */
async function saveOlrTest() {
  if (!_currentOlrLabId) { toast('Select a lab first', 'error'); return; }
  const name = document.getElementById('olr-name').value.trim();
  if (!name) { toast('Test name is required', 'error'); return; }
  const editId = document.getElementById('olr-edit-id').value;
  const payload = {
    lab_id:        _currentOlrLabId,
    test_name:     name,
    category:      document.getElementById('olr-category').value.trim(),
    unit:          document.getElementById('olr-unit').value.trim(),
    amount:        parseFloat(document.getElementById('olr-amount').value) || 0,
    normal_min_m:  document.getElementById('olr-min-m').value || null,
    normal_max_m:  document.getElementById('olr-max-m').value || null,
    normal_text_m: document.getElementById('olr-text-m').value.trim(),
    normal_min_f:  document.getElementById('olr-min-f').value || null,
    normal_max_f:  document.getElementById('olr-max-f').value || null,
    normal_text_f: document.getElementById('olr-text-f').value.trim(),
    normal_min_c:  document.getElementById('olr-min-c').value || null,
    normal_max_c:  document.getElementById('olr-max-c').value || null,
    normal_text_c: document.getElementById('olr-text-c').value.trim(),
    description:       document.getElementById('olr-desc').value.trim(),
    interpretation:    document.getElementById('olr-interpretation').value.trim(),
  };
  let res;
  if (editId) {
    res = await apiFetch(`${API}/other-lab-ranges/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
  } else {
    res = await apiFetch(`${API}/other-lab-ranges`, { method: 'POST', body: JSON.stringify(payload) });
  }
  if (res) {
    toast(editId ? 'Test updated!' : 'Test added!', 'success');
    closeOlrForm();
    await loadOlrTests();
  }
}
 
async function deleteOlrTest(id) {
  if (!confirm('Remove this test range?')) return;
  await apiFetch(`${API}/other-lab-ranges/${id}`, { method: 'DELETE' });
  toast('Deleted', 'success');
  await loadOlrTests();
}
 
/* ── Enter key on lab name input ─────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('new-lab-name');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') addOtherLab(); });
  // Load saved design on startup so settings UI reflects persisted values immediately
  if (typeof fdLoad === 'function') fdLoad();
});
/* ── Dropdown toggle helper ───────────────────────────────────────────── */
function toggleDropdown(id, featureKey) {
  if (featureKey && typeof guardFeature === 'function' && !guardFeature(featureKey)) return;
  const menu = document.getElementById(id);
  if (!menu) return;
  const isOpen = menu.style.display === 'block';
  // close all open dropdown menus first
  document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
  menu.style.display = isOpen ? 'none' : 'block';
}
// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
  }
});

/* ── File upload trigger helper ──────────────────────────────────────── */
function triggerFileUpload(inputId) {
  document.querySelectorAll('.dropdown-menu').forEach(m => m.style.display = 'none');
  document.getElementById(inputId)?.click();
}

/* ── Patients: upload Excel / DB ─────────────────────────────────────── */
async function uploadPatientsFile(input, type) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  input.value = '';
  const formData = new FormData();
  formData.append('file', file);
  const endpoint = type === 'excel'
    ? `${API}/patients/upload/excel`
    : type === 'pdf'
    ? `${API}/patients/upload/pdf`
    : `${API}/patients/upload/db`;
  try {
    toast('Uploading…', 'info');
    const res = await fetch(endpoint, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast(data.message || 'Import successful!', 'success');
    await loadPatients();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── Doctors: upload Excel / DB ──────────────────────────────────────── */
async function uploadDoctorsFile(input, type) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  input.value = '';
  const formData = new FormData();
  formData.append('file', file);
  const endpoint = type === 'excel'
    ? `${API}/doctors/upload/excel`
    : type === 'pdf'
    ? `${API}/doctors/upload/pdf`
    : `${API}/doctors/upload/db`;
  try {
    toast('Uploading…', 'info');
    const res = await fetch(endpoint, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast(data.message || 'Import successful!', 'success');
    await loadDoctors();
  } catch (err) {
    toast(err.message, 'error');
  }
}
