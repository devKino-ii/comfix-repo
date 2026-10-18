const state = { f: { q: "", from: "", to: "", qsort: "priority", fsort: "newest" }, user: null, data: null, profile: null, view: "feed", authRole: "citizen", authMode: "login", sel: null, pin: null, photo: null, map: null, pickMap: null };
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const statuses = ["New", "Verified", "In progress", "Resolved"];
const categories = ["Flooding", "Road damage", "Streetlight", "Garbage", "Safety hazard"];
const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { ...options, headers: { "Content-Type": "application/json" } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
const isAdmin = () => state.user?.role === "admin";
const key = r => r.ids.join(","), sc = s => "s-" + s.toLowerCase().replaceAll(" ", "-");
const ago = h => h < 1 ? "Just now" : h < 24 ? `${Math.round(h)}h ago` : `${Math.floor(h / 24)}d ago`;
const initials = n => esc(String(n).split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function toast(message) { const t = $("#toast"); t.textContent = message; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 3200); }

async function loadGoogleMaps() {
  try {
    const { googleMapsApiKey } = await api("config");
    if (!googleMapsApiKey) return;
    await new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleMapsApiKey)}&loading=async`; s.onload = resolve; s.onerror = reject; document.head.append(s); });
  } catch { /* OpenStreetMap stays available */ }
}

/* ---------- sign in ---------- */
function showAuth() { $("#appView").hidden = true; $("#authView").hidden = false; $("#authError").textContent = ""; }
function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === "register", staff = state.authRole === "admin";
  $("#authTitle").textContent = reg ? (staff ? "Create a staff account" : "Create an account") : (staff ? "Office sign in" : "Welcome back");
  $("#authDescription").textContent = reg ? (staff ? "For community office staff. You need the staff code." : "Create a resident account to send reports.") : (staff ? "For community office staff only." : "Sign in to send and follow reports.");
  $("#authSubmit").textContent = reg ? "Create account" : "Sign in";
  $("#authPrompt").textContent = reg ? "Already have an account?" : (staff ? "New office staff?" : "New to ComFix?");
  $("#authSwitch").textContent = reg ? "Sign in" : (staff ? "Create a staff account" : "Create a resident account");
  $("#staffField").hidden = !(reg && staff);
  $("#password").autocomplete = reg ? "new-password" : "current-password";
  $("#authError").textContent = "";
}
function setAuthRole(role) {
  state.authRole = role;
  $(".role-tabs").dataset.role = role;
  $("#tabCitizen").setAttribute("aria-selected", role === "citizen");
  $("#tabAdmin").setAttribute("aria-selected", role === "admin");
  setAuthMode("login");
}
$("#tabCitizen").addEventListener("click", () => setAuthRole("citizen"));
$("#tabAdmin").addEventListener("click", () => setAuthRole("admin"));
$("#authSwitch").addEventListener("click", () => setAuthMode(state.authMode === "login" ? "register" : "login"));
$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#authError").textContent = "";
  const reg = state.authMode === "register";
  const payload = { username: $("#username").value.trim(), password: $("#password").value };
  if (reg && state.authRole === "admin") payload.staffCode = $("#staffCode").value.trim();
  try {
    const { user } = await post(reg ? "register" : "login", payload);
    const expected = state.authRole === "admin" ? "admin" : "citizen";
    if (user.role !== expected) {
      await post("logout");
      throw new Error(expected === "admin" ? "That isn't an office account. Use the Resident tab." : "That is an office account. Use the Office staff tab.");
    }
    await showApp(user);
  } catch (error) {
    $("#authError").textContent = error.message;
    const form = $("#authForm"); form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
  } finally { $("#authSubmit").classList.remove("loading"); }
});
$("#authForm").addEventListener("submit", () => $("#authSubmit").classList.add("loading"), true);
$("#pwToggle").addEventListener("click", () => { const show = $("#password").type === "password"; $("#password").type = show ? "text" : "password"; $("#pwToggle").textContent = show ? "Hide" : "Show"; });
async function signOut() { await post("logout"); closeDetail(); document.body.className = ""; showAuth(); }

/* ---------- app ---------- */
const hrs = ts => (Date.now() / 1000 - ts) / 3600;
const when = r => ago(r.createdAt ? hrs(r.createdAt) : r.ageHours);
const fmtDate = ts => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ts * 1000));
const placeCache = new Map();
async function placeName(pin) {
  const k = pin.map(n => n.toFixed(4)).join(",");
  if (placeCache.has(k)) return placeCache.get(k);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${pin[0]}&lon=${pin[1]}`, { headers: { "Accept-Language": "en" } });
    const j = await res.json(), a = j.address || {};
    const road = a.road || a.pedestrian || a.footway || a.neighbourhood, area = a.suburb || a.village || a.town || a.municipality || a.city;
    const name = [road, area].filter(Boolean).join(", ") || (j.display_name || "").split(",").slice(0, 3).join(",");
    placeCache.set(k, name); return name;
  } catch { return null; }
}
async function showApp(user) {
  state.user = user;
  $("#authView").hidden = true; $("#appView").hidden = false;
  document.body.classList.toggle("role-admin", isAdmin());
  document.body.classList.toggle("role-citizen", !isAdmin());
  $("#meName").textContent = user.username; $("#meRole").textContent = isAdmin() ? "Community office" : "Resident";
  $("#avatar").textContent = initials(user.username); $("#meMobile").textContent = initials(user.username);
  $("[data-view=feed] .lbl").textContent = isAdmin() ? "Queue" : "Feed";
  $("[data-view=fixed] .lbl").textContent = isAdmin() ? "Resolved" : "Fixed";
  state.profile = await api("profile");
  $("#pName").value = state.profile.fullName; $("#pAddress").value = state.profile.address; $("#pPhone").value = state.profile.phone;
  await loadDashboard();
  showView("feed");
}
async function loadDashboard() { state.data = await api("dashboard"); render(); }
function reportsFor(view) {
  const d = state.data, f = state.f;
  if (view === "fixed") {
    let l = [...d.resolvedReports];
    if (isAdmin()) {
      if (f.q) { const q = f.q.toLowerCase(); l = l.filter(r => `${r.title} ${r.category}`.toLowerCase().includes(q)); }
      if (f.from) l = l.filter(r => r.resolvedAt >= new Date(f.from).getTime() / 1000);
      if (f.to) l = l.filter(r => r.resolvedAt <= new Date(f.to).getTime() / 1000 + 86400);
    }
    return l.sort((a, b) => f.fsort === "oldest" ? a.resolvedAt - b.resolvedAt : b.resolvedAt - a.resolvedAt);
  }
  if (view === "mine") return [...d.openReports, ...d.resolvedReports].filter(r => r.mine);
  const open = [...d.openReports];
  if (!isAdmin()) return open.sort((a, b) => b.createdAt - a.createdAt);
  const by = { severity: (a, b) => b.severity - a.severity || b.priority - a.priority, reports: (a, b) => b.count - a.count || b.priority - a.priority, newest: (a, b) => b.createdAt - a.createdAt }[f.qsort] || ((a, b) => b.priority - a.priority);
  return open.sort(by);
}
function render() {
  $("#navCount").textContent = state.data.openReportCount;
  if (isAdmin() && ["feed", "fixed"].includes(state.view)) $("#dash").innerHTML = dashHTML(state.view);
  if (state.view === "map") renderMap(); else if (state.view !== "profile") renderFeed();
  if (state.sel) showDetail();
}
function dashHTML(view) {
  const d = state.data, week = Date.now() / 1000 - 7 * 86400;
  const today = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  let tiles;
  if (view === "fixed") {
    const rs = d.resolvedReports, counts = {};
    rs.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const days = rs.length ? rs.reduce((s, r) => s + (r.resolvedAt - r.createdAt), 0) / rs.length / 86400 : 0;
    tiles = [[rs.length, "Resolved in total"], [rs.filter(r => r.resolvedAt >= week).length, "Resolved this week"], [`${days.toFixed(1)} days`, "Average time to fix"], [top ? top[0] : "None", "Most common problem"]];
  } else tiles = [[d.reportsReceived, "Reports submitted"], [d.openReportCount, "Open now"], [d.openReports.filter(r => r.severity >= 4).length, "Urgent"], [d.resolvedReportCount, "Resolved"]];
  return `<div class="dash-date"><small>Today</small><b>${today}</b></div>${tiles.map(([v, l], i) => `<div class="dtile ${i === 2 && view !== "fixed" ? "alert" : ""}"><b>${esc(v)}</b><span>${l}</span></div>`).join("")}`;
}
function toolsHTML(view) {
  const f = state.f, opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`;
  if (view === "feed") return `<label class="tool">Sort by <select id="sortSel">${opt("priority", "Priority", f.qsort)}${opt("severity", "Severity", f.qsort)}${opt("reports", "Most reported", f.qsort)}${opt("newest", "Newest", f.qsort)}</select></label><span class="note">The top left report needs attention first.</span>`;
  return `<input id="qIn" class="tool-in" type="search" placeholder="Search resolved reports" value="${esc(f.q)}" aria-label="Search resolved reports"><label class="tool">From <input id="fromIn" type="date" value="${f.from}"></label><label class="tool">To <input id="toIn" type="date" value="${f.to}"></label><label class="tool">Sort <select id="sortSel">${opt("newest", "Newest first", f.fsort)}${opt("oldest", "Oldest first", f.fsort)}</select></label><button id="printBtn" class="btn primary" type="button">Print weekly summary</button>`;
}
function showView(view) {
  state.view = view; closeDetail();
  $$(".nav button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#meBtn").classList.toggle("active", view === "profile");
  $("#feedView").hidden = !["feed", "mine", "fixed"].includes(view);
  $("#mapView").hidden = view !== "map"; $("#profileView").hidden = view !== "profile"; $("#bar").hidden = view === "map";
  const adminList = isAdmin() && ["feed", "fixed"].includes(view);
  $("#dash").hidden = !adminList; $("#tools").hidden = !adminList;
  if (adminList) { $("#dash").innerHTML = dashHTML(view); $("#tools").innerHTML = toolsHTML(view); }
  const first = state.user.username;
  const titles = {
    feed: isAdmin() ? ["Reports to review", "Highest priority first. Open a report to see photos and who to contact."] : [`Hi, ${first}`, "What your neighbours are reporting in Morong."],
    mine: ["My reports", "Problems you have sent."], fixed: [isAdmin() ? "Resolved reports" : "Fixed in Morong", isAdmin() ? "Most recently resolved first. Search or filter by date to find an older report." : "Problems the community office has resolved."],
    profile: ["Your profile", "So the office can reach you about your reports."],
  }[view];
  if (titles) { $("#pageTitle").textContent = titles[0]; $("#pageSub").textContent = titles[1]; }
  $("#composer").hidden = isAdmin() || view !== "feed";
  if (view === "map") { ensureMap(); renderMap(); } else if (view !== "profile") renderFeed();
}

/* ---------- feed ---------- */
function supportButton(r) {
  if (r.status === "Resolved") return "";
  if (r.mine) return `<span class="note">Your report</span>`;
  return `<button class="support ${r.supported ? "on" : ""}" data-support="${key(r)}" ${r.supported ? "disabled" : ""}>${r.supported ? "You see this too" : "I see this too"}</button>`;
}
function statusSelect(r) { return `<select class="status-select ${sc(r.status)}" data-ids="${key(r)}" aria-label="Change status">${statuses.map(s => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select>`; }
function card(r) {
  const who = r.reporters[0]?.name || "Morong resident";
  return `<article class="card ${key(r) === state.sel ? "sel" : ""}" data-ids="${key(r)}" tabindex="0">
    <header><span class="avatar sm">${initials(who)}</span><div><b>${esc(who)}</b><small>${when(r)}</small></div><span class="pill ${sc(r.status)}">${r.status}</span></header>
    <h3>${esc(r.title)}</h3><p class="tags"><span>${esc(r.category)}</span>${r.severity >= 4 ? `<span class="hot">Urgent</span>` : ""}</p>
    ${r.image ? `<img class="shot" src="${r.image}" alt="Photo of the problem" loading="lazy">` : ""}
    <footer>${supportButton(r)}<span class="note">${plural(r.count, "resident", "residents")} reported this</span></footer></article>`;
}
function tile(r, i) {
  const meter = Math.min(100, Math.max(5, r.priority / 20 * 100));
  return `<article class="tile ${key(r) === state.sel ? "sel" : ""}" data-ids="${key(r)}" tabindex="0">
    <div class="tile-top"><b class="rank ${i === 0 ? "first" : ""}">#${i + 1}</b><span class="pill ${sc(r.status)}">${r.status}</span></div>
    <h3>${esc(r.title)}</h3>
    <p class="tags"><span>${esc(r.category)}</span>${r.severity >= 4 ? `<span class="hot">Urgent</span>` : ""}<span>${plural(r.count, "resident", "residents")}</span></p>
    <div class="meter" title="Priority ${r.priority}"><i style="width:${meter}%"></i></div>
    <div class="tile-foot"><small class="note">Priority ${r.priority}, ${when(r)}</small>${statusSelect(r)}</div></article>`;
}
function doneTile(r) {
  const took = r.resolvedAt && r.createdAt ? Math.max(0, Math.round((r.resolvedAt - r.createdAt) / 86400)) : null;
  return `<article class="tile done ${key(r) === state.sel ? "sel" : ""}" data-ids="${key(r)}" tabindex="0">
    <div class="tile-top"><b class="rank ok">✓</b><span class="pill s-resolved">Resolved ${r.resolvedAt ? fmtDate(r.resolvedAt) : ""}</span></div>
    <h3>${esc(r.title)}</h3><p class="tags"><span>${esc(r.category)}</span><span>${plural(r.count, "resident", "residents")}</span></p>
    <div class="tile-foot"><small class="note">${took === null ? "" : `Fixed in ${plural(took, "day", "days")}`}</small><button class="btn ghost small" data-reopen="${key(r)}" type="button">Reopen</button></div></article>`;
}
function renderFeed() {
  const list = reportsFor(state.view), a = isAdmin();
  $("#feedList").className = a ? "grid" : "feed";
  $("#feedList").innerHTML = list.map((r, i) => a ? (state.view === "fixed" ? doneTile(r) : tile(r, i)) : card(r)).join("");
  $("#empty").hidden = list.length > 0;
  $("#empty").textContent = state.view === "fixed" && a ? "No resolved reports match. Clear the search or dates." : "Nothing here yet.";
}

/* ---------- map and detail drawer ---------- */
function ensureMap() {
  if (!state.map) { state.map = new ComfixMap($("#mainMap")); state.map.map?.scrollWheelZoom?.enable?.(); }
  requestAnimationFrame(() => state.map.resize());
}
function renderMap() {
  const list = reportsFor("feed");
  state.map.setReports(list.map((r, i) => ({ ...r, displayNumber: i + 1 })), r => openDetail(r.ids));
  $("#mapList").innerHTML = `<h2>Open reports <small>${list.length}</small></h2>` + list.map((r, i) => `<button class="mini ${key(r) === state.sel ? "sel" : ""}" data-ids="${key(r)}"><b class="num">${i + 1}</b><span><strong>${esc(r.title)}</strong><small>${esc(r.category)}, ${when(r)}</small></span></button>`).join("");
}
const findReport = ids => [...state.data.openReports, ...state.data.resolvedReports].find(r => key(r) === ids);
function openDetail(ids) {
  state.sel = Array.isArray(ids) ? ids.join(",") : ids;
  showDetail();
  $$(".card,.mini,.tile").forEach(c => c.classList.toggle("sel", c.dataset.ids === state.sel));
  const r = findReport(state.sel);
  if (state.view === "map" && r) { state.map?.openReport(r.ids); if (r.pin) state.map?.focus(r.pin); }
}
function closeDetail() {
  const had = state.sel; state.sel = null; $("#detail").hidden = true;
  $$(".card.sel,.mini.sel,.tile.sel").forEach(c => c.classList.remove("sel"));
  if (had && state.view === "map") state.map?.reset?.();
}
function showDetail() {
  const r = findReport(state.sel);
  if (!r) return closeDetail();
  const a = isAdmin(), sel = state.sel;
  const people = r.reporters.length ? r.reporters.map(p => `<li><b>${esc(p.name)}</b>${a && p.address ? `<span>${esc(p.address)}</span>` : ""}${a && p.phone ? `<span>${esc(p.phone)}</span>` : ""}</li>`).join("") : "<li><b>Community report</b></li>";
  $("#detail").innerHTML = `<button class="x" id="closeDetail" aria-label="Close">×</button>
    ${r.image ? `<img class="hero-img" src="${r.image}" alt="Photo of the problem">` : ""}
    <div class="dbody"><span class="pill ${sc(r.status)}">${r.status}</span><h2>${esc(r.title)}</h2>
    <p class="meta">${esc(r.category)}, first reported ${when(r)}${r.resolvedAt ? `, resolved ${fmtDate(r.resolvedAt)}` : ""}</p>
    <div class="facts"><div><b>${r.count}</b><span>${r.count === 1 ? "resident" : "residents"}</span></div><div><b>${r.severity}/5</b><span>severity</span></div>${a ? `<div><b>${r.priority}</b><span>priority</span></div>` : ""}</div>
    <div class="actions">${a ? `<label class="stat">Status ${statusSelect(r)}</label>` : supportButton(r)}</div>
    ${!a && r.status !== "Resolved" && !r.mine ? `<p class="hint">Backing a report tells the office more neighbours are affected, so you don't need to send a duplicate.</p>` : ""}
    <h3>Where it is</h3>${r.pin ? `<p id="place" class="place">Finding the street name...</p><p class="note">${r.pin[0].toFixed(5)}, ${r.pin[1].toFixed(5)}</p>${a ? `<a class="btn ghost small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${r.pin[0]},${r.pin[1]}">Get directions</a>` : ""}` : `<p>No pin was added. See the description.</p>`}
    <h3>What residents said</h3><ul class="said">${r.reports.map(x => `<li>${esc(x.text)}</li>`).join("")}</ul>
    <h3>${a ? "Who to contact" : "Reported by"}</h3><ul class="people">${people}</ul></div>`;
  $("#detail").hidden = false;
  if (r.pin) placeName(r.pin).then(n => { if (state.sel === sel && $("#place")) $("#place").textContent = n || "Street name not available. Use the coordinates below."; });
}
function printWeekly() {
  const d = state.data, end = Date.now() / 1000, start = end - 7 * 86400;
  const all = [...d.openReports, ...d.resolvedReports], cats = {};
  all.forEach(r => { cats[r.category] = (cats[r.category] || 0) + r.count; });
  const fixed = d.resolvedReports.filter(r => r.resolvedAt >= start).sort((a, b) => b.resolvedAt - a.resolvedAt);
  const open = [...d.openReports].sort((a, b) => b.priority - a.priority).slice(0, 8);
  const rows = (l, f) => l.length ? l.map(f).join("") : `<tr><td colspan="3">None this week.</td></tr>`;
  $("#printSheet").innerHTML = `<h1>ComFix weekly summary</h1><p>Morong, Rizal. ${fmtDate(start)} to ${fmtDate(end)}</p>
    <div class="ps-stats"><div><b>${all.filter(r => r.createdAt >= start).length}</b>New problems reported</div><div><b>${fixed.length}</b>Resolved</div><div><b>${d.openReportCount}</b>Still open</div></div>
    <h2>Resolved this week</h2><table><tr><th>Problem</th><th>Category</th><th>Resolved</th></tr>${rows(fixed, r => `<tr><td>${esc(r.title)}</td><td>${esc(r.category)}</td><td>${fmtDate(r.resolvedAt)}</td></tr>`)}</table>
    <h2>Still open, highest priority first</h2><table><tr><th>Problem</th><th>Category</th><th>Status</th></tr>${rows(open, r => `<tr><td>${esc(r.title)}</td><td>${esc(r.category)}</td><td>${r.status}</td></tr>`)}</table>
    <h2>Residents affected, by category</h2><table>${Object.entries(cats).map(([c, n]) => `<tr><td>${esc(c)}</td><td colspan="2">${n}</td></tr>`).join("")}</table>
    <p class="ps-foot">Prepared ${fmtDate(end)} from ComFix for the Morong community.</p>`;
  window.print();
}

document.addEventListener("click", async event => {
  const t = event.target;
  const sup = t.closest("[data-support]");
  if (sup) {
    try { await post("support", { ids: sup.dataset.support.split(",").map(Number) }); await loadDashboard(); toast("Thanks. The office now sees one more resident affected."); } catch (e) { toast(e.message); }
    return;
  }
  const re = t.closest("[data-reopen]");
  if (re) {
    try { await post("status", { ids: re.dataset.reopen.split(",").map(Number), status: "New" }); await loadDashboard(); toast("Report reopened. It is back in the queue."); } catch (e) { toast(e.message); }
    return;
  }
  if (t.closest("#closeDetail")) return closeDetail();
  if (t.closest("select,input")) return;
  const nav = t.closest(".nav button"); if (nav) return showView(nav.dataset.view);
  if (t.closest("#meBtn,#meMobile")) return showView("profile");
  if (t.closest("[data-signout]")) return $("#logoutDialog").showModal();
  if (t.closest("#stayBtn")) return $("#logoutDialog").close();
  if (t.closest("#confirmLogout")) { $("#logoutDialog").close(); return signOut(); }
  if (t.closest("#printBtn")) return printWeekly();
  if (t.closest("#newReport,#composerBtn")) return openReportDialog();
  const item = t.closest(".card,.mini,.tile"); if (item) openDetail(item.dataset.ids);
});
document.addEventListener("change", async event => {
  const s = event.target.closest(".status-select"); if (!s) return;
  try { await post("status", { ids: s.dataset.ids.split(",").map(Number), status: s.value }); await loadDashboard(); toast(`Status changed to ${s.value}.`); } catch (e) { toast(e.message); }
});
document.addEventListener("input", event => {
  const id = event.target.id, map = { qIn: "q", fromIn: "from", toIn: "to" };
  if (map[id]) { state.f[map[id]] = event.target.value; renderFeed(); }
  else if (id === "sortSel") { state.f[state.view === "fixed" ? "fsort" : "qsort"] = event.target.value; renderFeed(); }
});

/* ---------- profile ---------- */
$("#profileForm").addEventListener("submit", async event => {
  event.preventDefault(); $("#profileError").textContent = "";
  try { state.profile = await post("profile", { fullName: $("#pName").value.trim(), address: $("#pAddress").value.trim(), phone: $("#pPhone").value.trim() }); toast("Profile saved."); } catch (e) { $("#profileError").textContent = e.message; }
});

/* ---------- report dialog ---------- */
function selectCategory(name) { $("#reportCategory").value = name; $$("#catChips .chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.cat === name)); }
$("#reportCategory").innerHTML = categories.map(c => `<option>${esc(c)}</option>`).join("");
$("#catChips").innerHTML = categories.map(c => `<button type="button" class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
$("#catChips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (c) selectCategory(c.dataset.cat); });
function openReportDialog() {
  if (!state.profile?.fullName || !state.profile?.address) { toast("Add your name and address first so the office can reach you."); return showView("profile"); }
  $("#reportError").textContent = ""; $("#reportText").value = ""; $("#reportSeverity").value = 3; $("#severityValue").value = "3 / 5";
  $("#reportPhoto").value = ""; $("#photoPreview").hidden = true; state.photo = null; state.pin = null;
  $("#clearPin").hidden = true; $("#selectedLocation").textContent = "Tap the map to drop a pin.";
  selectCategory(categories[0]); $("#reportDialog").showModal();
  if (!state.pickMap) state.pickMap = new ComfixMap($("#reportMap"), pin => { state.pin = pin; state.pickMap.setPin(pin); $("#selectedLocation").textContent = "Finding the street name..."; placeName(pin).then(n => { if (state.pin === pin) $("#selectedLocation").textContent = n || `${pin[0].toFixed(5)}, ${pin[1].toFixed(5)}`; }); $("#clearPin").hidden = false; });
  state.pickMap.clearPin();
  requestAnimationFrame(() => state.pickMap.resize());
}
$("#reportPhoto").addEventListener("change", async event => {
  state.photo = null; $("#photoPreview").hidden = true;
  const file = event.target.files[0]; if (!file) return;
  try {
    const img = await createImageBitmap(file), scale = Math.min(1, 960 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    state.photo = canvas.toDataURL("image/jpeg", 0.72); $("#photoPreview").src = state.photo; $("#photoPreview").hidden = false;
  } catch { $("#reportError").textContent = "That photo couldn't be read. Try a JPG or PNG."; }
});
$("#closeDialog").addEventListener("click", () => $("#reportDialog").close());
$("#cancelReport").addEventListener("click", () => $("#reportDialog").close());
$("#reportSeverity").addEventListener("input", e => { $("#severityValue").value = `${e.target.value} / 5`; });
$("#clearPin").addEventListener("click", () => { state.pin = null; state.pickMap?.clearPin(); $("#selectedLocation").textContent = "Tap the map to drop a pin."; $("#clearPin").hidden = true; });
$("#reportForm").addEventListener("submit", async event => {
  event.preventDefault(); $("#reportError").textContent = "";
  try {
    const result = await post("reports", { category: $("#reportCategory").value, severity: Number($("#reportSeverity").value), text: $("#reportText").value.trim(), pin: state.pin, image: state.photo });
    $("#reportDialog").close(); await loadDashboard(); showView("feed");
    toast(result.groupCount > 1 ? `${result.ticket} sent and added to a similar report.` : `${result.ticket} sent. Thank you.`);
  } catch (e) { $("#reportError").textContent = e.message; }
});

(async () => {
  setAuthRole("citizen");
  await loadGoogleMaps();
  try { const { user } = await api("session"); if (user) await showApp(user); else showAuth(); } catch { showAuth(); }
})();
