const $ = (s) => document.querySelector(s);
const getToken = () => localStorage.getItem("nova_token");
(() => { const m = /^#join=([\w-]{6,16})$/.exec(location.hash); if (m) try { localStorage.setItem("nova_join", m[1]); } catch {} })();  // tautan undangan: simpan dulu, belum tentu sudah login

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (getToken()) headers.Authorization = "Bearer " + getToken();
  const res = await fetch("/api" + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && /dashboard/.test(location.pathname)) {  // sesi sudah tidak berlaku (mis. password diganti di perangkat lain)
      localStorage.removeItem("nova_token"); try { sessionStorage.setItem("nova_notice", "Sesimu berakhir. Silakan masuk lagi."); } catch {}
      location.href = "login.html";
    }
    if (res.status === 503 && data.maint && /dashboard/.test(location.pathname) && !document.querySelector(".mnt")) {  // mode perawatan: staf tetap bisa masuk
      const o = document.createElement("div"); o.className = "mnt"; const h = document.createElement("h2"); h.textContent = "Sedang perawatan";
      const p = document.createElement("p"); p.textContent = data.error; const b = document.createElement("button"); b.className = "btn"; b.textContent = "Coba lagi"; b.onclick = () => location.reload();
      o.append(h, p, b); document.body.append(o);
    }
    if (res.status === 403 && data.banned) {  // akun diblokir owner: keluar dan tampilkan alasannya di halaman masuk
      localStorage.removeItem("nova_token"); try { sessionStorage.setItem("nova_notice", data.error); } catch {}
      if (!/login/.test(location.pathname)) location.href = "login.html";
    }
    const err = new Error(data.error || "Terjadi kesalahan"); err.data = data; throw err;
  }
  return data;
}

function logout() {
  localStorage.removeItem("nova_token");
  location.href = "login.html";
}

/* ---------- Login / Register ---------- */
function initLogin() {
  if (getToken()) { location.href = "dashboard.html"; return; }
  const msg = $("#msg");
  try { const note = sessionStorage.getItem("nova_notice"); if (note) { msg.textContent = note; sessionStorage.removeItem("nova_notice"); } } catch {}
  const lv = $("#lv");
  if (lv) {
    const nc = navigator.connection || {};
    const slow = nc.saveData || ["slow-2g","2g","3g"].includes(nc.effectiveType);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && !slow && document.visibilityState !== "hidden") lv.play().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") lv.pause(); else if (!reduced && !slow) lv.play().catch(() => {}); });
  }
  const yi = document.querySelector('#register-form [name="birth_year"]');
  if (yi) {
    const cy = new Date().getFullYear();
    yi.max = cy - 13; yi.min = cy - 120; yi.placeholder = String(cy - 25);
    yi.addEventListener("invalid", () => yi.setCustomValidity(yi.validity.rangeOverflow ? "Kamu harus berusia minimal 13 tahun untuk memakai NOVA WAWA." : yi.validity.rangeUnderflow ? "Tahun lahir tidak valid." : ""));
    yi.addEventListener("input", () => yi.setCustomValidity(""));
  }
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $("#login-form").hidden = t.dataset.tab !== "login";
      $("#register-form").hidden = t.dataset.tab !== "register";
      msg.textContent = "";
    })
  );
  const submit = (form, path) =>
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button");
      btn.disabled = true; msg.textContent = "";
      try {
        const body = Object.fromEntries(new FormData(form));
        const data = await api(path, { method: "POST", body: JSON.stringify(body) });
        localStorage.setItem("nova_token", data.token);
        localStorage.setItem("nova_weakpw", path === "/login" && data.weak ? "1" : "0");
        location.href = "dashboard.html";
      } catch (err) {
        msg.textContent = err.message;
        if (err.data && err.data.need_2fa && !form.querySelector('[name="code"]')) {  // akun memakai 2FA: minta kode 6 digit
          const lab = document.createElement("label"), inp = document.createElement("input");
          lab.textContent = "Kode 2FA"; inp.name = "code"; inp.inputMode = "numeric"; inp.maxLength = 8; inp.autocomplete = "one-time-code"; inp.required = true; lab.append(inp);
          form.querySelector("button").before(lab); inp.focus();
        } else if (form.querySelector('[name="code"]')) form.querySelector('[name="code"]').value = "";
        btn.disabled = false;
      }
    });
  submit($("#login-form"), "/login");
  submit($("#register-form"), "/register");
}

/* ---------- Dashboard: chat, grup, saluran, story, panggilan, profil ---------- */
async function initDashboard() {
  if (!getToken()) return logout();
  let me;
  try { me = (await api("/me")).user; } catch { return logout(); }
  const st = { contacts: [], rooms: [], stories: [], calls: [], cur: null, unread: {}, last: {}, lastT: {}, seen: {}, filter: "all", tab: "home" };
  const mk = (tag, txt, cls) => { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
  const hue = (n) => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  const safeImg = (u) => (/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}|logo\.png)$/.test(u || "") ? u : "");
  const av = (n, img) => { const g = safeImg(img), e = mk("div", g ? "" : (n[0] || "?").toUpperCase(), "av"); e.style.background = g ? "url(" + g + ") center/cover" : "hsl(" + hue(n) + ",85%,78%)"; return e; };
  const toast = (msg) => {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = mk("div", msg, "toast"); t.setAttribute("role", "status"); document.body.append(t);
    setTimeout(() => t.remove(), 3600);
  };
  const STK = /^\[stk:([0-9a-f]{24})\]$/;
  const stkId = (b) => { const m = STK.exec(b || ""); return m && m[1]; };
  const MED = /^\[med:(i|v)(o?):([0-9a-f]{24})\]$/;
  const medOf = (b) => { const m = MED.exec(b || ""); return m && { kind: m[1] === "v" ? "video" : "image", once: !!m[2], id: m[3] }; };
  const DEL = "[del]";  /* penanda isi pesan yang sudah dihapus pengirimnya */
  const POLL = /^\[poll:(\d{1,9})\]$/;
  const pollOf = (b) => { const m = POLL.exec(b || ""); return m && { id: Number(m[1]) }; };
  const VN = /^\[vn:([0-9a-f]{24})\]$/;
  const vnOf = (b) => { const m = VN.exec(b || ""); return m && { id: m[1] }; };
  const lastText = (b) => { if (b === DEL) return "Pesan dihapus"; if (VN.test(b || "")) return "Pesan suara"; if (POLL.test(b || "")) return "Polling"; const k = medOf(b); return k ? (k.kind === "video" ? "Video" : "Foto") + (k.once ? " 1x lihat" : "") : stkId(b) ? "Stiker" : b; };
  const fmtDur = (n) => Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
  const sha24 = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
  /* Kotak dialog bergaya NOVA, pengganti prompt() bawaan browser. Hasil: objek isian, atau null kalau dibatalkan. */
  function dialog({ title, desc, fields = [], contacts = null, ok = "Simpan", actions = [], cancel = null }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const back = mk("div", null, "dlg-back"), box = mk("div", null, "dlg"), form = mk("form");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "dlg-t");
      const h = mk("h2", title); h.id = "dlg-t"; form.append(h);
      if (desc) form.append(mk("p", desc, "dlg-d"));
      actions.forEach((a) => { const b = mk("button", a.label, "btn full" + (a.danger ? "" : " ghost")); b.type = "button"; b.onclick = () => done({ action: a.key }); form.append(b); });
      const els = {};
      fields.forEach((f) => {
        const lab = mk("label"), inp = mk(f.multiline ? "textarea" : "input");
        inp.value = f.value || ""; inp.placeholder = f.placeholder || ""; inp.autocomplete = f.auto || "off"; if (f.type) inp.type = f.type;
        if (f.max) inp.maxLength = f.max;
        if (f.multiline) inp.rows = 4;
        if (f.inputmode) inp.inputMode = f.inputmode;
        lab.append(mk("span", f.label), inp);
        if (f.multiline && f.max) { const c = mk("small", inp.value.length + "/" + f.max, "dlg-c"); inp.addEventListener("input", () => (c.textContent = inp.value.length + "/" + f.max)); lab.append(c); }
        form.append(lab); els[f.name] = inp;
      });
      const checks = [];
      if (contacts) {
        form.append(mk("span", "Tambah anggota dari teman tersimpan", "dlg-l"));
        if (!contacts.length) form.append(mk("p", "Belum ada teman tersimpan. Simpan ID teman dulu, atau isi ID lain di atas.", "dlg-d"));
        else {
          const list = mk("div", null, "dlg-pick");
          contacts.forEach((c) => { const l = mk("label", null, "pk"), cb = mk("input"); cb.type = "checkbox"; cb.value = c.player_id; checks.push(cb); l.append(cb, av(c.full_name, c.avatar), mk("span", c.full_name)); list.append(l); });
          form.append(list);
        }
      }
      const err = mk("p", "", "dlg-e"); err.setAttribute("role", "alert"); form.append(err);
      const row = mk("div", null, "dlg-b"), no = mk("button", cancel || "Batal", "btn ghost"), yes = mk("button", ok, "btn");
      no.type = "button"; yes.type = "submit"; if (ok === null) { no.textContent = cancel || "Tutup"; row.append(no); } else row.append(no, yes); form.append(row);
      box.append(form); back.append(box); document.body.append(back);
      const done = (v) => { document.removeEventListener("keydown", onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        if (e.key === "Tab") {
          const f = [...box.querySelectorAll("input,textarea,button")], a = f[0], z = f[f.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
          else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      no.onclick = () => done(null);
      back.addEventListener("pointerdown", (e) => { if (e.target === back) done(null); });
      form.onsubmit = (e) => {
        e.preventDefault();
        const out = {};
        for (const f of fields) {
          out[f.name] = f.type === "password" ? els[f.name].value : els[f.name].value.trim();
          if (f.required && !out[f.name]) { err.textContent = f.label + " wajib diisi."; els[f.name].focus(); return; }
        }
        out.members = checks.filter((c) => c.checked).map((c) => c.value);
        done(out);
      };
      const first = form.querySelector("input,textarea,button"); if (first) first.focus();
    });
  }
  const isRoom = (p) => p.startsWith("R-");
  const roomOf = (p) => st.rooms.find((r) => "R-" + r.id === p);
  const contact = (p) => st.contacts.find((c) => c.player_id === p);
  const saved = (p) => !!contact(p);
  const OFFICIAL = "NOVA";
  const VIS = { all: "Semua yang menyimpan ID-ku", mutual: "Hanya kontak yang juga kusimpan", none: "Tidak ada" };
  const nameOf = (p) => (p === me.player_id ? me.full_name : p === OFFICIAL ? "NOVA WAWA" : isRoom(p) ? (roomOf(p) || { name: "Grup" }).name : (contact(p) || { full_name: p }).full_name);
  const imgOf = (p) => (p === me.player_id ? me.avatar : p === OFFICIAL ? "logo.png" : (contact(p) || {}).avatar);
  const fmt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const NS = "http://www.w3.org/2000/svg";
  const ic = (n, cls) => { const s = document.createElementNS(NS, "svg"), u = document.createElementNS(NS, "use"); s.setAttribute("class", "ic" + (cls ? " " + cls : "")); u.setAttribute("href", "#i-" + n); s.append(u); return s; };
  const tm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const short = (t) => (new Date(t).toDateString() === new Date().toDateString() ? tm(t) : new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }));
  const RB = { blue: "RESMI", yellow: "PILIHAN" };
  const hasStory = (p) => st.stories.some((s) => s.owner === p);
  const send = (to, kind, body, reply) => api("/send", { method: "POST", body: JSON.stringify(reply ? { to, kind, body, reply } : { to, kind, body }) });
  const chAv = (k, img, nm) => { const g = safeImg(img); if (g) return av(nm || "?", g); const e = mk("div", null, "av ico " + k); e.append(ic(k === "group" ? "users" : "channel")); return e; };
  const row = (img, name, sub, onclick, o = {}) => {
    const li = mk("li", null, "item"), box = mk("div", null, "txt"), w = mk("div", null, "avw");
    const nb = mk("b", name);
    if (o.vb) nb.append(ic("seal", "seal " + o.vb));
    if (o.tag) nb.append(mk("i", o.tag, "own" + (o.tag === "CC" ? " cc" : "")));
    box.append(nb, mk("small", sub));
    w.append(o.avEl || av(name, img));
    if (o.online) w.append(mk("i", null, "on-dot"));
    li.append(w, box);
    if (o.time || o.badge || o.icon) {
      const m = mk("div", null, "meta");
      if (o.time) m.append(mk("span", o.time));
      if (o.icon) m.append(o.icon);
      if (o.badge) m.append(mk("i", o.badge, "dot"));
      li.append(m);
    }
    li.tabIndex = 0; li.onclick = onclick; li.onkeydown = (e) => e.key === "Enter" && onclick();
    return li;
  };
  const resize = (file, max, q, lim) => new Promise((res) => {
    const im = new Image();
    im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = im.width * k; c.height = im.height * k; c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); let out = c.toDataURL("image/jpeg", q); while (lim && out.length > lim && q > 0.25) { q -= 0.1; out = c.toDataURL("image/jpeg", q); } res(out); };
    im.src = URL.createObjectURL(file);
  });
  const pick = (max, q, lim) => new Promise((res) => { const f = $("#pick"); f.value = ""; f.onchange = () => f.files[0] && resize(f.files[0], max, q, lim).then(res); f.click(); });

  const SCREENS = ["home", "upd", "calls", "profile", "room", "explore", "admin"];
  const loaders = { upd: () => { loadStories(); loadRooms(); }, calls: loadCalls, explore: loadRooms, profile: () => refreshPush(), admin: () => { $("#abanner").value = me.announce || ""; loadAdmin(); } };
  const TITLES = { home: "NOVA WAWA", upd: "Pembaruan", calls: "Panggilan", profile: "Profil", explore: "Cari Saluran", admin: "Panel Owner" };
  function show(id) {
    const wide = matchMedia("(min-width:900px)").matches;  // komputer: daftar chat tetap terlihat di kiri saat chat dibuka di kanan
    st.screen = id; if (id !== "room" && id !== "explore" && id !== "admin") st.tab = id;
    const base = wide && id === "room" ? st.tab : id;
    SCREENS.forEach((s) => ($("#" + s).hidden = s !== id && !(wide && id === "room" && s === st.tab)));
    if (TITLES[id]) {
      $("#htitle").textContent = TITLES[id]; $("#top").classList.toggle("c", id !== "home");
      $("#clock").hidden = id !== "home"; $("#hback").hidden = !["explore", "admin"].includes(id); $("#hnew").hidden = id !== "upd";
    }
    $("#fab").hidden = !["home", "upd"].includes(base); $("#fabt").hidden = base !== "upd";
    $(".nav").hidden = (id === "room" && !wide) || id === "explore";
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.s === (base === "explore" ? "upd" : base === "admin" ? "profile" : base)));
    if (loaders[id]) loaders[id]();
    render();
  }
  function render() {
    const q = $("#search").value.trim().toLowerCase();
    const ring = (el, on) => { const g = mk("div", null, "rg" + (on ? " on" : "")); g.append(el); return g; };
    const mine = mk("button", null, "story plus");
    mine.append(ring(av(me.full_name, me.avatar), hasStory(me.player_id)), mk("span", "Story saya"));
    mine.onclick = () => (hasStory(me.player_id) ? viewStories(me.player_id) : storyText());
    $("#stories").replaceChildren(mine, ...st.contacts.map((c) => {
      const b = mk("button", null, "story");
      b.append(ring(av(c.full_name, c.avatar), hasStory(c.player_id)), mk("span", c.full_name));
      b.onclick = () => (hasStory(c.player_id) ? viewStories(c.player_id) : open(c.player_id));
      return b;
    }));
    const E = st.contacts.map((c) => ({ p: c.player_id, n: c.full_name, i: c.avatar, k: "dm", bdg: c.badge, tag: c.owner ? "OWNER" : c.mod ? "MOD" : c.cc ? "CC" : "" }));
    st.rooms.filter((r) => r.kind === "group" || r.joined).forEach((r) => E.push({ p: "R-" + r.id, n: r.name, k: r.kind, i: r.avatar, bdg: r.bdg, tag: RB[r.bdg] || "" }));
    Object.keys(st.last).forEach((k) => { if (!isRoom(k) && !saved(k) && k !== me.player_id) E.push({ p: k, n: nameOf(k), i: imgOf(k), k: "dm", v: k === OFFICIAL, tag: k === OFFICIAL ? "RESMI" : "" }); });
    const F = E.filter((e) => (st.filter === "all" || e.k === st.filter) && (e.n + e.p).toLowerCase().includes(q))
      .sort((a, b) => (st.cpins.has(b.p) - st.cpins.has(a.p)) || (Date.parse(st.lastT[b.p]) || 0) - (Date.parse(st.lastT[a.p]) || 0));
    $("#empty-list").hidden = F.length > 0;
    $("#empty-list").textContent = E.length ? "Tidak ada chat yang cocok." : "Belum ada chat. Tap + lalu masukkan ID temanmu untuk menyimpannya.";
    $("#list").replaceChildren(...F.map((e) => row(e.i, e.n, (st.cpins.has(e.p) ? "📌 " : "") + lastText(st.last[e.p]) || (e.k === "dm" ? e.p : e.k === "group" ? "Grup" : "Saluran"), () => open(e.p),
      { time: st.lastT[e.p] ? short(st.lastT[e.p]) : "", badge: st.unread[e.p] || "", vb: e.bdg, tag: e.tag, avEl: e.k === "dm" ? null : chAv(e.k, e.i, e.n), online: e.k === "dm" && !!(st.seen[e.p] && st.seen[e.p].online) })));

    /* Pembaruan: kartu status */
    const card = (o, label, onclick) => {
      const l = st.stories.filter((s) => s.owner === o), s = l[l.length - 1], b = mk("button", null, "sc");
      if (!s) b.classList.add("empty");
      else if (s.kind === "img") b.style.backgroundImage = 'url("' + safeImg(s.body) + '")';
      else if (s.kind === "vid") { b.style.background = "#111"; b.append(ic("play", "pl")); const vm = medOf(s.body); if (vm) needMeta(vm.id, (mt) => { if (mt.thumb) b.style.background = 'url("' + mt.thumb + '") center/cover'; }); }
      else { b.style.background = "linear-gradient(160deg,hsl(" + hue(s.body) + ",85%,62%),hsl(" + ((hue(s.body) + 50) % 360) + ",80%,48%))"; b.append(mk("p", s.body, "sct")); }
      b.append(av(nameOf(o), imgOf(o)), mk("span", label, "scn"));
      b.onclick = onclick;
      return b;
    };
    const others = [...new Set(st.stories.map((s) => s.owner))].filter((o) => o !== me.player_id);
    $("#sgrid").replaceChildren(card(me.player_id, "Status saya", () => (hasStory(me.player_id) ? viewStories(me.player_id) : storyText())), ...others.map((o) => card(o, nameOf(o), () => viewStories(o))));

    /* Saluran */
    const chs = st.rooms.filter((r) => r.kind === "channel");
    const chRow = (r) => row(null, r.name, r.count + " pengikut" + (r.about ? " · " + r.about : ""), () => (r.joined ? open("R-" + r.id) : joinCh(r.id)),
      { vb: r.bdg, tag: RB[r.bdg] || "", avEl: chAv("channel", r.avatar, r.name), badge: r.owner === me.player_id ? "ADMIN" : st.unread["R-" + r.id] || "", icon: r.joined ? null : ic("plus", "pbtn") });
    const mineCh = chs.filter((r) => r.joined), finds = chs.filter((r) => !r.joined);
    $("#mych").replaceChildren(...mineCh.map(chRow));
    $("#find-h").hidden = !finds.length;
    $("#finds").replaceChildren(...finds.slice(0, 5).map(chRow));
    const xq = $("#xsearch").value.trim().toLowerCase(), X = chs.filter((r) => r.name.toLowerCase().includes(xq));
    $("#xlist").replaceChildren(...X.map(chRow));
    $("#empty-x").hidden = X.length > 0;

    const ST = { answered: "Terjawab", missed: "Tidak terjawab", rejected: "Ditolak" };
    $("#calllist").replaceChildren(...st.calls.map((c) => row(imgOf(c.peer), nameOf(c.peer), (c.out ? "Keluar" : "Masuk") + " · " + (c.video ? "Video" : "Suara") + " · " + ST[c.status], () => open(c.peer), { time: short(c.t), icon: ic(c.video ? "video" : "phone", c.status !== "answered" && !c.out ? "miss" : "") })));
    $("#empty-calls").hidden = st.calls.length > 0;
    $("#pav").replaceChildren(av(me.full_name, me.avatar));
    $("#pname").textContent = me.full_name; $("#pstat").textContent = me.status || "Belum ada status";
    $("#pid").textContent = me.player_id; $("#pyear").textContent = "Lahir " + me.birth_year;
    $("#pcover").style.backgroundImage = safeImg(me.cover) ? 'url("' + me.cover + '")' : "";
    $("#pver").toggleAttribute("hidden", !me.badge); $("#pver").className = "ic seal" + (me.badge ? " " + me.badge : ""); $("#pown").hidden = !(me.owner || me.mod || me.cc); $("#pown").textContent = me.owner ? "OWNER" : me.mod ? "MOD" : "CC"; $("#pown").classList.toggle("cc", !me.owner && !me.mod && !!me.cc); $("#admbtn").hidden = !me.is_staff; $("#admtitle").textContent = me.is_owner ? "Panel Owner" : "Panel Moderator"; $("#admsub").textContent = me.is_owner ? "Kelola pengguna, banner, laporan, dan pengumuman" : "Tangani laporan dan blokir pengguna"; $("#pvb").toggleAttribute("hidden", !me.verified); $("#copysub").textContent = me.player_id;
    $("#swpub").setAttribute("aria-checked", String(me.public !== false)); $("#storysub").textContent = VIS[me.story_vis || "all"]; $("#seensub").textContent = VIS[me.seen_vis || "all"]; $("#verifybtn").hidden = !(me.mail && !me.email_verified);
  }
  async function loadContacts() { st.contacts = (await api("/contacts")).contacts; render(); }
  async function loadStories() { try { st.stories = (await api("/stories")).stories; render(); } catch {} }
  async function loadCalls() { try { st.calls = (await api("/calls")).calls; render(); } catch {} }
  async function loadChats() {
    try {
      (await api("/chats")).chats.forEach((c) => {
        if (c.key === me.player_id || (st.lastT[c.key] && Date.parse(st.lastT[c.key]) > Date.parse(c.t))) return;
        st.last[c.key] = c.body; st.lastT[c.key] = c.t;
      });
      render();
    } catch {}
  }
  async function loadPresence() {
    try {
      const r = await api("/presence"); st.seen = r.presence;
      if (r.announce && r.announce !== me.announce) { me.announce = r.announce; $("#annt").textContent = $("#annt2").textContent = r.announce; }
      refreshTicks(); roomSub(); render();
    } catch {}
  }
  async function loadRooms() { try { st.rooms = (await api("/rooms")).rooms; render(); } catch {} }
  const joinCh = (id) => api("/rooms/" + id + "/join", { method: "POST" }).then(loadRooms);
  $("#search").oninput = render;
  document.querySelectorAll("#chips button").forEach((b) => (b.onclick = () => {
    st.filter = b.dataset.f;
    document.querySelectorAll("#chips button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  }));
  const clock = () => ($("#clock span").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
  clock(); setInterval(clock, 1000);
  $("#annt").textContent = $("#annt2").textContent = me.announce || "Selamat datang di NOVA WAWA";
  document.querySelectorAll(".nav button").forEach((b) => (b.onclick = () => show(b.dataset.s)));
  $("#logout").onclick = logout;
  $("#copy").onclick = () => navigator.clipboard.writeText(me.player_id).then(() => ($("#copysub").textContent = "Tersalin"));

  const tick = (m) => { if (m.pending) return ic("clock", "tk"); const seen = !isRoom(m.to) && st.seen[m.to] && Date.parse(st.seen[m.to].seen) >= Date.parse(m.t); return ic(seen ? "check2" : "check", "tk" + (seen ? " seen" : "")); };
  function refreshTicks() {
    document.querySelectorAll("#msgs .bub.out").forEach((d) => { const t = d.querySelector(".tk"); if (t) t.replaceWith(tick({ to: d.dataset.to, t: d.dataset.t })); });
  }
  function roomSub() {
    if (!st.cur || isRoom(st.cur)) return;
    if (st.cur === OFFICIAL) { $("#rid").className = ""; $("#rid").textContent = "Akun resmi · hanya pengumuman"; return; }
    const s = st.seen[st.cur], el = $("#rid");
    el.className = s && s.online ? "on" : "";
    el.textContent = Date.now() - (st.typing[st.cur] || 0) < 4000 ? "mengetik..." : s ? (s.online ? "online" : "terakhir dilihat " + fmt(s.seen)) : st.cur;
  }
  /* ----- balas pesan: kutipan di gelembung, bar balasan, menu tekan-lama, geser ke kanan ----- */
  st.replyTo = null; st.typing = {}; st.pin = null; st.cpins = new Set();
  const whoName = (p) => (p === me.player_id ? "Kamu" : nameOf(p));
  function quoteEl(rp) {
    const q = mk("div", null, "quote");
    if (rp.gone) { q.classList.add("gone"); q.append(mk("span", "Pesan tidak tersedia")); return q; }
    q.append(mk("b", whoName(rp.sender)), mk("span", lastText(rp.body)));
    q.onclick = (e) => { e.stopPropagation(); jumpTo(rp.id); };
    return q;
  }
  function jumpTo(id) {
    const el = $("#msgs").querySelector('.bub[data-id="' + Number(id) + '"]');
    if (!el) return toast("Pesan aslinya ada di bagian yang lebih lama.");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }
  function clearReply() { st.replyTo = null; const bar = $("#replybar"); bar.hidden = true; bar.replaceChildren(); }
  function setReply(m) {
    if (!m || !m.id) return toast("Pesan masih dikirim. Coba lagi sebentar.");
    st.replyTo = { id: m.id, sender: m.sender, body: m.body };
    const bar = $("#replybar"), rq = mk("div", null, "rq"), x = mk("button", null, "hb");
    rq.append(mk("b", m.sender === me.player_id ? "Membalas pesanmu" : "Membalas " + nameOf(m.sender)), mk("span", lastText(m.body)));
    x.type = "button"; x.setAttribute("aria-label", "Batalkan balasan"); x.append(ic("x")); x.onclick = clearReply;
    bar.replaceChildren(rq, x); bar.hidden = false; $("#text").focus();
  }
  $("#text").addEventListener("keydown", (e) => { if (e.key === "Escape" && st.replyTo) clearReply(); });
  let menuBusy = false;
  /* teruskan teks atau stiker ke chat, grup, atau saluran lain (foto, video, dan suara belum bisa diteruskan) */
  async function forwardMsg(m) {
    const dest = [];
    st.rooms.filter((r) => r.joined && (r.kind === "group" || r.owner === me.player_id)).forEach((r) => dest.push({ to: "R-" + r.id, label: (r.kind === "group" ? "Grup: " : "Saluran: ") + r.name }));
    st.contacts.forEach((c) => dest.push({ to: c.player_id, label: c.full_name }));
    const list = dest.slice(0, 40);
    if (!list.length) return toast("Belum ada tujuan. Simpan ID teman dulu.");
    const a = await dialog({ title: "Teruskan ke...", desc: lastText(m.body).slice(0, 80), ok: null, actions: list.map((d, i) => ({ key: String(i), label: d.label })) });
    if (!a) return;
    const d = list[Number(a.action)]; if (!d) return;
    try {
      const r = await send(d.to, "text", m.body);
      st.last[d.to] = r.body; st.lastT[d.to] = r.t;
      if (st.cur === d.to) addMsg(r);
      render(); toast("Diteruskan ke " + d.label.replace(/^(Grup|Saluran): /, ""));
    } catch (e) { toast("Gagal meneruskan: " + e.message); }
  }
  /* teks pesan dengan @mention disorot (aman: hanya node teks) */
  function rich(body) {
    const sp = mk("span"); let i = 0; const re = /(^|\s)(@[\w.\-]{2,30})/g; let m;
    while ((m = re.exec(body))) { const at = m.index + m[1].length; if (at > i) sp.append(document.createTextNode(body.slice(i, at))); sp.append(mk("b", m[2], "mn")); i = at + m[2].length; }
    sp.append(document.createTextNode(body.slice(i))); return sp;
  }
  const REACTS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
  function renderReacts(d) {
    const old = d.querySelector(":scope > .rx"); if (old) old.remove();
    const rx = d._m && d._m.reactions; if (!rx || d._m.body === DEL) return;
    const keys = Object.keys(rx).filter((k) => rx[k].length); if (!keys.length) return;
    const box = mk("div", null, "rx");
    keys.forEach((k) => { const b = mk("button", k + (rx[k].length > 1 ? " " + rx[k].length : ""), "rxc" + (rx[k].includes(me.player_id) ? " me" : "")); b.type = "button"; b.setAttribute("aria-label", "Reaksi " + k); b.onclick = (e) => { e.stopPropagation(); reactTo(d, k); }; box.append(b); });
    d.append(box);
  }
  function setReaction(d, pid, emoji) {
    const m = d._m; if (!m) return; m.reactions = m.reactions || {};
    Object.keys(m.reactions).forEach((k) => { m.reactions[k] = m.reactions[k].filter((x) => x !== pid); });
    if (emoji) (m.reactions[emoji] = m.reactions[emoji] || []).push(pid);
    renderReacts(d);
  }
  async function reactTo(d, emoji) {
    const m = d._m; if (!m || !m.id) return;
    try { const r = await api("/messages/" + m.id + "/react", { method: "POST", body: JSON.stringify({ emoji }) }); setReaction(d, me.player_id, r.emoji); } catch (e) { toast(e.message); }
  }
  function markEdited(d, body) {
    const sp = d.querySelector(":scope > div > span:not(.who)"); if (sp && d._m && !stkId(d._m.body) && !medOf(d._m.body)) sp.replaceWith(rich(body));
    if (d._m) { d._m.body = body; d._m.edited = true; }
    const mt = d.querySelector(".mt"); if (mt && !mt.querySelector(".ed")) mt.prepend(mk("small", "diedit", "ed"));
  }
  /* ubah gelembung jadi "Pesan ini telah dihapus" (dipakai saat kita menghapus, saat lawan menghapus, dan saat riwayat dimuat) */
  function markDeleted(d) {
    d.classList.remove("sticker", "media"); d.classList.add("deleted");
    const box = d.firstElementChild;
    [...box.children].forEach((c) => { if (!c.classList.contains("who")) c.remove(); });
    box.append(mk("span", "Pesan ini telah dihapus", "delt"));
    const rxe = d.querySelector(":scope > .rx"); if (rxe) rxe.remove();
    if (d._m) { d._m.body = DEL; d._m.reply = undefined; d._m.reactions = undefined; }
  }
  async function bubbleMenu(d) {
    const m = d._m; if (!m || menuBusy || m.body === DEL) return;
    menuBusy = true;
    try {
      const plain = !stkId(m.body) && !medOf(m.body) && !vnOf(m.body) && !pollOf(m.body), acts = [];
      if (!$("#form").hidden) acts.push({ key: "reply", label: "Balas" });
      if (plain) acts.push({ key: "copy", label: "Salin teks" });
      if (m.id && !m.pending) acts.push({ key: "react", label: "Beri reaksi" });
      if (m.id && !m.pending && !medOf(m.body) && !vnOf(m.body) && !pollOf(m.body)) acts.push({ key: "fwd", label: "Teruskan" });
      if (m.id && !m.pending && st.cur !== OFFICIAL) acts.push({ key: "pin", label: st.pin && st.pin.id === m.id ? "Lepas sematan pesan" : "Sematkan pesan" });
      if (m.sender === me.player_id && m.id && !m.pending && plain && Date.now() - Date.parse(m.t) < 15 * 60000) acts.push({ key: "edit", label: "Edit pesan" });
      if (m.sender === me.player_id && m.id && !m.pending) acts.push({ key: "del", label: "Hapus untuk semua" });
      if (!acts.length) return;
      const a = await dialog({ title: m.sender === me.player_id ? "Pesanmu" : nameOf(m.sender), desc: lastText(m.body).slice(0, 120), ok: null, actions: acts });
      if (!a) return;
      if (a.action === "reply") setReply(m);
      else if (a.action === "copy") navigator.clipboard.writeText(m.body).then(() => toast("Teks disalin"), () => toast("Tidak bisa menyalin teks"));
      else if (a.action === "fwd") await forwardMsg(m);
      else if (a.action === "react") {
        const e = await dialog({ title: "Beri reaksi", ok: null, actions: REACTS.map((x) => ({ key: x, label: x })) });
        if (e) reactTo(d, e.action);
      } else if (a.action === "pin") pinMsg(m);
      else if (a.action === "edit") {
        const f = await dialog({ title: "Edit pesan", fields: [{ name: "t", label: "Isi pesan", value: m.body, multiline: true, max: 4000, required: true }], ok: "Simpan" });
        if (f && f.t.trim() && f.t.trim() !== m.body) { try { await api("/messages/" + m.id + "/edit", { method: "POST", body: JSON.stringify({ body: f.t.trim() }) }); markEdited(d, f.t.trim()); if (st.last[m.to] === m.body) st.last[m.to] = f.t.trim(); render(); } catch (e) { toast(e.message); } }
      }
      else if (a.action === "del") {
        const ok = await dialog({ title: "Hapus pesan?", desc: "Pesan ini akan hilang untuk semua orang di chat ini.", ok: "Hapus" });
        if (!ok) return;
        try {
          await api("/messages/" + m.id + "/delete", { method: "POST" });
          if (st.last[m.to] === m.body) st.last[m.to] = DEL;
          markDeleted(d); render();
        } catch (e) { toast("Gagal menghapus: " + e.message); }
      }
    } finally { menuBusy = false; }
  }
  function bubbleGestures(d) {
    let sx = 0, sy = 0, dx = 0, pid = null, lp = null, eat = false;
    const stopLp = () => { clearTimeout(lp); lp = null; };
    d.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;  // komputer: menu lewat klik kanan, jadi seleksi teks pakai mouse tidak terganggu
      sx = e.clientX; sy = e.clientY; dx = 0; pid = e.pointerId; eat = false;
      stopLp(); lp = setTimeout(() => { lp = null; eat = true; pid = null; bubbleMenu(d); }, 520);  // tekan lama = menu
    });
    d.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (Math.abs(mx) > 8 || Math.abs(my) > 8) stopLp();
      if (mx > 12 && mx > Math.abs(my) * 1.5 && !$("#form").hidden) { d.classList.add("sw"); dx = Math.min(mx, 80); d.style.transform = "translateX(" + dx + "px)"; }  // geser ke kanan = balas
    });
    const end = () => {
      stopLp(); pid = null;
      const go = dx >= 60;
      if (dx) { dx = 0; d.classList.remove("sw"); d.style.transform = ""; }
      if (go) { eat = true; setReply(d._m); }
      setTimeout(() => { eat = false; }, 350);
    };
    d.addEventListener("pointerup", end); d.addEventListener("pointercancel", end);
    d.addEventListener("click", (e) => { if (eat) { e.stopPropagation(); e.preventDefault(); eat = false; } }, true);  // jangan buka foto/video setelah geser atau tekan-lama
    d.addEventListener("contextmenu", (e) => { e.preventDefault(); bubbleMenu(d); });  // klik kanan di komputer
    const prevTab = $("#msgs").querySelector('.bub[tabindex="0"]'); if (prevTab) prevTab.tabIndex = -1;  // satu perhentian Tab saja untuk seluruh daftar pesan
    d.tabIndex = 0;
    d.addEventListener("keydown", (e) => {  // papan ketik: panah atas/bawah pindah pesan, Enter = menu
      if (e.target !== d) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bubbleMenu(d); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const n = e.key === "ArrowUp" ? d.previousElementSibling : d.nextElementSibling;
        if (n && n.classList.contains("bub")) { e.preventDefault(); d.tabIndex = -1; n.tabIndex = 0; n.focus(); }
      }
    });
  }
  function addMsg(m) {
    const mine = m.sender === me.player_id, key = isRoom(m.to) || mine ? m.to : m.sender;
    st.last[key] = m.body; st.lastT[key] = m.t;
    const r = roomOf(st.cur || ""), sid = stkId(m.body), md = medOf(m.body), vn = vnOf(m.body), d = mk("div", null, "bub " + (mine ? "out" : "in") + (sid ? " sticker" : "") + (md ? " media" : "")), box = mk("div"), mt = mk("div", null, "mt");
    if (!mine && r && r.kind === "group") box.append(mk("small", nameOf(m.sender), "who"));
    if (m.reply) box.append(quoteEl(m.reply));
    if (sid) { const im = mk("img", null, "smsg"); im.src = m.local || "/api/stickers/" + sid; im.alt = "Stiker"; box.append(im); }
    else if (md) box.append(...mediaBox(m, md));
    else if (vn) box.append(voiceEl(m, vn));
    else if (pollOf(m.body)) box.append(pollEl(pollOf(m.body).id));
    else box.append(rich(m.body));
    if (m.edited) mt.append(mk("small", "diedit", "ed"));
    mt.append(mk("time", tm(m.t)));
    if (mine) { d.dataset.to = m.to; d.dataset.t = m.t; mt.append(tick(m)); }
    d.append(box, mt);
    d._m = m; if (m.id) d.dataset.id = m.id; bubbleGestures(d);
    if (m.body === DEL) markDeleted(d); else renderReacts(d);
    $("#msgs").append(d); $("#msgs").scrollTop = 1e9;
    return d;
  }
  async function open(p) {
    clearReply(); cancelVoice(); st.cur = p; st.unread[p] = 0;
    const r = roomOf(p);
    $("#rtitle").textContent = nameOf(p);
    const ct = contact(p); if (ct && ct.owner) $("#rtitle").append(mk("i", "OWNER", "own")); if (p === OFFICIAL) $("#rtitle").append(mk("i", "RESMI", "own"));
    if (r && r.bdg) $("#rtitle").append(ic("seal", "seal " + r.bdg), mk("i", RB[r.bdg], "own"));
    $("#rav").replaceChildren(r ? chAv(r.kind, r.avatar, r.name) : av(nameOf(p), imgOf(p)));
    $("#rid").className = ""; $("#rid").textContent = r ? (r.kind === "group" ? "Grup" : "Saluran · " + r.count + " pengikut") : p;
    roomSub(); $("#tray").hidden = true;
    $("#savebtn").hidden = !!r || saved(p) || p === OFFICIAL; $("#morebtn").hidden = p === OFFICIAL; $("#vbtn").hidden = $("#abtn").hidden = !!r || p === OFFICIAL;
    $("#form").hidden = (!!r && r.kind === "channel" && r.owner !== me.player_id) || p === OFFICIAL;
    $("#msgs").replaceChildren(); show("room");
    document.querySelectorAll(".pinbar,.msearch").forEach((x) => x.remove()); st.pin = null;
    (await api("/history?peer=" + encodeURIComponent(p))).messages.forEach(addMsg);
    render(); loadPin();
  }
  document.addEventListener("keydown", (e) => {  // komputer: Esc menutup chat yang terbuka (kalau tidak ada kotak dialog)
    if (e.key === "Escape" && st.screen === "room" && matchMedia("(min-width:900px)").matches && !document.querySelector(".dlg-back, .mv, .sv, .call:not([hidden])") && !e.defaultPrevented) $("#back").click();
  });
  $("#back").onclick = () => { cancelVoice(); if (curAud) curAud.pause(); st.cur = null; show(st.tab); };
  $("#form").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("#text").value.trim();
    if (!v || !st.cur) return;
    $("#text").value = ""; upd();
    const rp = st.replyTo; clearReply();
    const to = st.cur, el = addMsg({ sender: me.player_id, to, kind: "text", body: v, t: new Date().toISOString(), pending: true, reply: rp ? { id: rp.id, sender: rp.sender, body: rp.body } : undefined });
    try {
      const m = await send(to, "text", v, rp && rp.id);
      st.last[to] = m.body; st.lastT[to] = m.t; el.dataset.t = m.t; el.dataset.id = m.id; if (el._m) el._m.id = m.id;
      el.querySelector("time").textContent = tm(m.t); el.querySelector(".tk").replaceWith(tick(m)); render();
    } catch (err) { el.querySelector(".tk").replaceWith(ic("x", "tk fail")); toast("Pesan gagal terkirim: " + err.message); }
  };
  let typedAt = 0;
  const upd = () => { const has = $("#text").value.trim().length > 0;
    if (has && st.cur && !isRoom(st.cur) && st.cur !== OFFICIAL && Date.now() - typedAt > 3500) { typedAt = Date.now(); send(st.cur, "sig", JSON.stringify({ type: "typing", data: {} })).catch(() => {}); } $("#sendb").hidden = !has; $("#mic").hidden = has; $("#vnrec").hidden = has; };
  $("#text").oninput = upd;
  const EMO = "😀😃😄😁😆😅😂🤣🙂😉😊😇🥰😍😘😋😎🤩🥳😏😒😞😔😢😭😤😠🤯😱😳🤔🙄😴🤒🤢🙏👍👎👏🙌💪👀🔥✨🎉💯❤️💔💙💚💛🧡💜🖤".match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [];
  let trayTab = "emoji";
  const UPK = "nova_stk_up";
  const upGet = () => { try { return new Set(JSON.parse(localStorage.getItem(UPK) || "[]")); } catch { return new Set(); } };
  async function ensureSticker(src, force) {  // unggah stiker ke server sekali saja (id = hash isinya)
    const id = await sha24(src), up = upGet();
    if (force || !up.has(id)) {
      await api("/stickers", { method: "POST", body: JSON.stringify({ data: src }) });
      up.add(id); try { localStorage.setItem(UPK, JSON.stringify([...up].slice(-300))); } catch {}
    }
    return id;
  }
  async function sendSticker(src) {
    if (!st.cur) return;
    const to = st.cur; $("#tray").hidden = true;
    let id; try { id = await sha24(src); } catch { return toast("Browser ini belum mendukung kirim stiker."); }
    const body = "[stk:" + id + "]";
    const el = addMsg({ sender: me.player_id, to, kind: "text", body, local: src, t: new Date().toISOString(), pending: true });
    try {
      await ensureSticker(src);
      let m;
      try { m = await send(to, "text", body); }
      catch (e) { if (!/Stiker/.test(e.message)) throw e; await ensureSticker(src, true); m = await send(to, "text", body); }
      st.last[to] = m.body; st.lastT[to] = m.t; el.dataset.t = m.t; el.dataset.id = m.id; if (el._m) el._m.id = m.id;
      el.querySelector("time").textContent = tm(m.t); el.querySelector(".tk").replaceWith(tick(m)); render();
    } catch (err) { el.querySelector(".tk").replaceWith(ic("x", "tk fail")); toast("Stiker gagal terkirim: " + err.message); }
  }
  function renderPanel() {
    const t = $("#tray"), tabs = mk("div", null, "tp-tabs"), tg = mk("div", null, trayTab === "emoji" ? "emo" : "sc-grid");
    [["emoji", "😀 Emoji"], ["stiker", "Stiker"]].forEach(([k, label]) => {
      const b = mk("button", label, "pill" + (trayTab === k ? " on" : "")); b.type = "button"; b.setAttribute("aria-pressed", String(trayTab === k));
      b.onclick = () => { trayTab = k; renderPanel(); }; tabs.append(b);
    });
    if (trayTab === "emoji") EMO.forEach((em) => { const b = mk("button", em); b.type = "button"; b.setAttribute("aria-label", "Emoji " + em); b.onclick = () => { $("#text").value += em; upd(); $("#text").focus(); }; tg.append(b); });
    else {
      const nb = mk("button", null, "cell addn"); nb.type = "button"; nb.append(ic("edit"), mk("span", "Buat stiker"));
      nb.onclick = async () => { await stickerMaker(); renderPanel(); };
      tg.append(nb);
      mySt().forEach((src, i) => {
        const cell = mk("div", null, "cell"), b = mk("button"), im = mk("img"); b.type = "button"; b.setAttribute("aria-label", "Kirim stiker " + (i + 1)); im.src = src; im.alt = ""; b.append(im); b.onclick = () => sendSticker(src);
        const x = mk("button", "×", "rm"); x.type = "button"; x.setAttribute("aria-label", "Hapus stiker " + (i + 1));
        x.onclick = () => { const a = mySt(); a.splice(i, 1); saveMySt(a); renderPanel(); };
        cell.append(b, x); tg.append(cell);
      });
    }
    t.replaceChildren(tabs, tg);
    if (trayTab === "stiker" && !mySt().length) t.append(mk("p", "Belum ada stiker. Tap Buat stiker untuk membuatnya dari fotomu.", "hint"));
  }
  $("#attach").onclick = async () => {
    if (!st.cur) return;
    const f = await pickMedia();
    if (!st.cur || !(await checkMedia(f, false))) return;
    const to = st.cur, o = await mediaComposer(f, !isRoom(to), false);
    if (o) sendMedia(to, o, false);
  };
  $("#plus").onclick = () => { const t = $("#tray"); t.hidden = !t.hidden; if (!t.hidden) renderPanel(); };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec;
  $("#mic").onclick = () => {
    if (!SR) return toast("Browser ini belum mendukung dikte suara. Coba Chrome di Android.");
    if (rec) return rec.stop();
    rec = new SR(); rec.lang = "id-ID"; $("#mic").classList.add("rec");
    rec.onresult = (e) => { $("#text").value = ($("#text").value + " " + e.results[0][0].transcript).trim(); upd(); };
    rec.onerror = (e) => { if (e.error === "not-allowed") toast("Izin mikrofon ditolak."); };
    rec.onend = () => { $("#mic").classList.remove("rec"); rec = null; };
    rec.start();
  };
  /* ----- pesan suara: pemutar di gelembung + perekam ----- */
  const pollDraw = {};
  function pollEl(id) {
    const wrap = mk("div", null, "pollb");
    const draw = (p) => {
      wrap.replaceChildren(mk("b", p.q, "pq"));
      p.options.forEach((o, i) => {
        const b = mk("button", null, "po" + (p.mine === i ? " me" : "")), pct = p.total ? Math.round((o.n / p.total) * 100) : 0, bar = mk("i"); bar.style.width = pct + "%";
        b.type = "button"; b.append(bar, mk("span", o.t, "pot"), mk("small", o.n + " (" + pct + "%)", "pon"));
        b.onclick = async () => { try { const r = await api("/polls/" + id + "/vote", { method: "POST", body: JSON.stringify({ option: i }) }); pollDraw[id].forEach((f) => f(r.poll)); } catch (e) { toast(e.message); } };
        wrap.append(b);
      });
      wrap.append(mk("small", p.total + " suara", "pot2"));
    };
    (pollDraw[id] = pollDraw[id] || []).push(draw);
    wrap.append(mk("small", "Memuat polling...", "hint"));
    api("/polls/" + id).then((r) => draw(r.poll)).catch(() => wrap.replaceChildren(mk("div", "Polling tidak tersedia", "mph")));
    return wrap;
  }
  async function createPoll(chat) {
    const f = await dialog({ title: "Buat polling", fields: [{ name: "q", label: "Pertanyaan", max: 200, required: true }, { name: "o1", label: "Pilihan 1", max: 80, required: true }, { name: "o2", label: "Pilihan 2", max: 80, required: true }, { name: "o3", label: "Pilihan 3 (opsional)", max: 80 }, { name: "o4", label: "Pilihan 4 (opsional)", max: 80 }, { name: "o5", label: "Pilihan 5 (opsional)", max: 80 }], ok: "Kirim" });
    if (!f) return;
    try {
      const m = await api("/polls", { method: "POST", body: JSON.stringify({ to: chat, question: f.q, options: [f.o1, f.o2, f.o3, f.o4, f.o5].filter(Boolean) }) });
      st.last[chat] = m.body; st.lastT[chat] = m.t; if (st.cur === chat) addMsg(m); render();
    } catch (e) { toast(e.message); }
  }
  let curAud = null;
  function voiceEl(m, vn) {
    const wrap = mk("div", null, "vnb"), btn = mk("button", null, "vn-play"), bar = mk("div", null, "vn-bar"), fill = mk("i"), tt = mk("small", "0:00", "vn-t");
    btn.type = "button"; btn.setAttribute("aria-label", "Putar pesan suara"); btn.append(ic("play")); bar.append(fill); wrap.append(btn, bar, tt);
    let a = null, dur = 0;
    const setT = (s) => { tt.textContent = fmtDur(Math.max(0, Math.round(s))); };
    const icon = (playing) => { btn.replaceChildren(ic(playing ? "pause" : "play")); btn.setAttribute("aria-label", playing ? "Jeda" : "Putar pesan suara"); };
    const total = () => (a && isFinite(a.duration) && a.duration > 0 ? a.duration : dur);
    const ready = (meta) => {
      if (!meta || meta.missing || !meta.url) { wrap.replaceChildren(mk("div", "Pesan suara tidak tersedia", "mph")); return; }
      dur = meta.dur || 0; setT(dur);
      btn.onclick = () => {
        if (!a) {
          a = new Audio(meta.url); a.preload = "auto";
          a.ontimeupdate = () => { const d = total(); fill.style.width = d ? Math.min(100, (a.currentTime / d) * 100) + "%" : "0"; setT(a.currentTime); };
          a.onplay = () => icon(true); a.onpause = () => icon(false);
          a.onended = () => { fill.style.width = "0"; setT(dur); icon(false); };
          a.onerror = () => { icon(false); toast("Tidak bisa memutar pesan suara"); };
        }
        if (a.paused) { if (curAud && curAud !== a) curAud.pause(); curAud = a; a.play().catch(() => toast("Tidak bisa memutar pesan suara")); }
        else a.pause();
      };
      bar.onclick = (e) => { const d = total(); if (!a || !d) return; const r = bar.getBoundingClientRect(); a.currentTime = d * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    };
    if (m.local) ready(m.local); else needMeta(vn.id, ready);
    return wrap;
  }
  let vrec = null;
  const cancelVoice = () => { if (vrec) vrec.cancel(); };
  async function startVoice() {
    if (!st.cur || vrec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast("Browser ini belum mendukung rekam suara.");
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast("Izin mikrofon ditolak."); }
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const maxSec = /mp4/.test(mime) ? 45 : 90;  // mp4 (Safari) lebih boros ukuran, jadi dibatasi lebih pendek
    let mr; try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 }); }
    catch { stream.getTracks().forEach((t) => t.stop()); return toast("Rekam suara tidak bisa dimulai di browser ini."); }
    const chunks = [], to = st.cur, t0 = Date.now(), form = $("#form");
    const bar = mk("div", null, "recbar"), tmr = mk("b", "0:00"), no = mk("button", null, "hb"), go = mk("button", null, "cb go");
    no.type = go.type = "button"; no.setAttribute("aria-label", "Batalkan rekaman"); go.setAttribute("aria-label", "Kirim pesan suara");
    no.append(ic("trash")); go.append(ic("send"));
    bar.append(no, mk("i", null, "rdot"), tmr, mk("span", "Merekam... maks " + maxSec + " dtk", "rhint"), go);
    form.classList.add("vrec"); form.before(bar);
    let sendIt = false;
    const secs = () => Math.round((Date.now() - t0) / 1000);
    const iv = setInterval(() => { tmr.textContent = fmtDur(secs()); if (secs() >= maxSec) { sendIt = true; stop(); } }, 250);
    const stop = () => { if (mr.state !== "inactive") mr.stop(); };
    vrec = { cancel: () => { sendIt = false; stop(); } };
    no.onclick = vrec.cancel; go.onclick = () => { sendIt = true; stop(); };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      clearInterval(iv); stream.getTracks().forEach((t) => t.stop()); bar.remove(); form.classList.remove("vrec"); vrec = null;
      if (!sendIt) return;
      const dur = Math.max(1, Math.min(maxSec, secs()));
      if (secs() < 1) return toast("Rekaman terlalu pendek.");
      const blob = new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" }), url = URL.createObjectURL(blob);
      const el = addMsg({ sender: me.player_id, to, kind: "text", body: "[vn:" + "0".repeat(24) + "]", local: { kind: "audio", url, dur }, t: new Date().toISOString(), pending: true });
      try {
        const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("Gagal membaca rekaman")); fr.readAsDataURL(blob); });
        if (data.length > 690000) throw new Error("rekaman terlalu besar, coba lebih pendek");
        const { id } = await api("/voice", { method: "POST", body: JSON.stringify({ data, dur }) });
        const m = await send(to, "text", "[vn:" + id + "]");
        st.last[to] = m.body; st.lastT[to] = m.t; el.dataset.t = m.t; el.dataset.id = m.id; if (el._m) { el._m.id = m.id; el._m.body = m.body; }
        el.querySelector("time").textContent = tm(m.t); el.querySelector(".tk").replaceWith(tick(m)); render();
      } catch (err) { el.querySelector(".tk").replaceWith(ic("x", "tk fail")); toast("Pesan suara gagal terkirim: " + err.message); }
    };
    mr.start();
  }
  $("#vnrec").onclick = startVoice;
  async function saveId(id) {
    try {
      await api("/contacts", { method: "POST", body: JSON.stringify({ player_id: id }) });
      await loadContacts();
      if (st.cur) { $("#rtitle").textContent = nameOf(st.cur); $("#savebtn").hidden = saved(st.cur); }
    } catch (e) { toast(e.message); }
  }
  $("#savebtn").onclick = () => saveId(st.cur);
  async function mkRoom(body) { try { await api("/rooms", { method: "POST", body: JSON.stringify(body) }); loadRooms(); } catch (e) { toast(e.message); } }
  $("#newgrp").onclick = async () => {
    const r = await dialog({ title: "Buat grup", fields: [
      { name: "name", label: "Nama grup", placeholder: "Contoh: Squad Mabar", max: 60, required: true },
      { name: "extra", label: "ID lain (opsional, pisah koma)", placeholder: "48210377, 63915204", inputmode: "numeric" }], contacts: st.contacts, ok: "Buat grup" });
    if (!r) return;
    const members = [...new Set([...r.members, ...r.extra.split(",").map((x) => x.trim()).filter(Boolean)])];
    mkRoom({ kind: "group", name: r.name, members });
  };
  const newChannel = async () => {
    const r = await dialog({ title: "Buat saluran", desc: "Hanya kamu yang bisa posting. Orang lain mengikuti dan membaca.", fields: [
      { name: "name", label: "Nama saluran", max: 60, required: true },
      { name: "about", label: "Deskripsi singkat (opsional)", max: 200 }], ok: "Buat saluran" });
    if (r) mkRoom({ kind: "channel", name: r.name, about: r.about });
  };
  $("#fab").onclick = () => ({
    home: async () => {
      const r = await dialog({ title: "Simpan ID teman", desc: "Masukkan ID angka temanmu. Setelah disimpan, dia tampil dengan namanya.", fields: [
        { name: "id", label: "ID teman", placeholder: "contoh 48210377", inputmode: "numeric", max: 12, required: true }], ok: "Simpan" });
      if (r) saveId(r.id);
    },
    upd: () => storyImg(),
  }[st.tab] || (() => {}))();
  $("#fabt").onclick = () => storyText();
  $("#hnew").onclick = () => newChannel();
  $("#hback").onclick = () => show(st.screen === "admin" ? "profile" : "upd");
  $("#explore-btn").onclick = () => show("explore");
  $("#xsearch").oninput = render;

  /* ----- story ----- */
  const postStory = (kind, body) => api("/stories", { method: "POST", body: JSON.stringify({ kind, body }) }).then(loadStories).catch((e) => toast(e.message));
  const storyText = async () => {
    const r = await dialog({ title: "Tulis story", desc: "Hilang otomatis setelah 24 jam.", fields: [{ name: "t", label: "Isi story", multiline: true, max: 300, required: true }], ok: "Posting" });
    if (r) postStory("text", r.t);
  };
  const storyImg = async () => {
    const f = await pickMedia();
    if (!(await checkMedia(f, true))) return;
    if (f.type.startsWith("video/")) { const o = await mediaComposer(f, false, true); if (o) sendMedia(null, o, true); return; }
    let photo; try { photo = await resize(f, 720, 0.85); } catch { return toast("Foto tidak bisa dibaca."); }
    const out = await storyComposer(photo);
    if (out) postStory("img", out);
  };

  /* ----- penyusun story foto: caption + stiker ----- */
  const svgS = (inner) => "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 120 120" stroke="#111" stroke-width="6" stroke-linejoin="round" stroke-linecap="round">' + inner + "</svg>");
  const TX = (t, y, sz, fill, len) => '<text x="60" y="' + y + '" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="' + sz + '" text-anchor="middle" fill="' + fill + '" stroke="none" textLength="' + len + '" lengthAdjust="spacingAndGlyphs">' + t + "</text>";
  const BUILTIN = [
    ['Hati', '<path d="M60 104C20 74 10 48 28 32C42 20 56 28 60 40C64 28 78 20 92 32C110 48 100 74 60 104Z" fill="#FF4757"/><path d="M34 40c4-6 10-6 14-2" fill="none" stroke="#fff" stroke-width="5"/>'],
    ['Bintang', '<polygon points="60,10 74,44 110,46 82,68 92,104 60,84 28,104 38,68 10,46 46,44" fill="#FFD93D"/>'],
    ['Api', '<path d="M60 8C64 34 92 46 92 74C92 94 78 108 60 108C42 108 28 94 28 74C28 58 38 52 42 40C48 50 54 50 56 44C58 32 58 20 60 8Z" fill="#FF8A1F"/><path d="M60 62C66 74 76 78 76 90C76 99 69 104 60 104C51 104 44 99 44 90C44 80 56 74 60 62Z" fill="#FFD93D" stroke-width="4"/>'],
    ['Petir', '<polygon points="70,8 24,68 54,68 44,112 96,46 66,46" fill="#FFD93D"/>'],
    ['Mahkota', '<path d="M16 92L12 38L40 60L60 22L80 60L108 38L104 92Z" fill="#FFD93D"/><circle cx="60" cy="74" r="6" fill="#FF4757" stroke-width="4"/>'],
    ['Keren', '<circle cx="60" cy="60" r="48" fill="#FFD93D"/><rect x="22" y="44" width="34" height="22" rx="6" fill="#111"/><rect x="64" y="44" width="34" height="22" rx="6" fill="#111"/><path d="M38 82q22 18 44 0" fill="none"/>'],
    ['Sedih', '<circle cx="60" cy="60" r="48" fill="#7CC6FF"/><circle cx="42" cy="52" r="5" fill="#111"/><circle cx="78" cy="52" r="5" fill="#111"/><path d="M40 90q20-18 40 0" fill="none"/><path d="M84 62q8 12 0 20q-8-8 0-20Z" fill="#fff" stroke-width="4"/>'],
    ['Oke', '<circle cx="60" cy="60" r="48" fill="#2ED573"/><path d="M34 62l18 18 34-38" fill="none" stroke="#111" stroke-width="20"/><path d="M34 62l18 18 34-38" fill="none" stroke="#fff" stroke-width="10"/>'],
    ['WKWK', '<path d="M14 24Q14 12 26 12H94Q106 12 106 24V68Q106 80 94 80H62L40 106L44 80H26Q14 80 14 68Z" fill="#fff"/>' + TX("WKWK", 58, 26, "#FF4757", 76)],
    ['MANTAP', '<rect x="6" y="36" width="108" height="48" rx="8" fill="#FFD93D"/>' + TX("MANTAP", 70, 24, "#111", 92)],
    ['GAS', '<polygon points="60,6 72,26 96,18 92,42 114,54 92,66 98,92 72,86 60,110 48,86 22,92 28,66 6,54 28,42 24,18 48,26" fill="#FF4757"/>' + TX("GAS!", 68, 28, "#fff", 56)],
    ['NOVA', '<rect x="8" y="34" width="104" height="52" rx="10" fill="#111"/>' + TX("NOVA", 70, 30, "#FFD93D", 80)],
    ['SIAP', '<rect x="6" y="36" width="108" height="48" rx="8" fill="#fff"/>' + TX("SIAP", 70, 28, "#111", 72)],
    ['KUY', '<rect x="14" y="34" width="92" height="52" rx="26" fill="#FF8AD8"/>' + TX("KUY", 70, 28, "#111", 52)],
    ['Kilau', '<path d="M60 8Q64 52 112 60Q64 68 60 112Q56 68 8 60Q56 52 60 8Z" fill="#7CF2FF"/>'],
  ].map(([name, inner]) => ({ name, src: svgS(inner) }));
  const SK = "nova_stickers";
  const mySt = () => { try { return JSON.parse(localStorage.getItem(SK) || "[]"); } catch { return []; } };
  const saveMySt = (a) => { try { localStorage.setItem(SK, JSON.stringify(a.slice(0, 30))); return true; } catch { toast("Penyimpanan penuh. Hapus stiker lama dulu."); return false; } };
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const pickFile = () => new Promise((res) => { const f = $("#pick"); f.value = ""; f.onchange = () => f.files[0] && res(f.files[0]); f.click(); });
  const exportJpg = (c, lim) => {
    let q = 0.85, out = c.toDataURL("image/jpeg", q);
    while (out.length > lim && c.width > 200) {
      if (q > 0.4) q -= 0.1;
      else { const n = document.createElement("canvas"); n.width = Math.round(c.width * 0.85); n.height = Math.round(c.height * 0.85); n.getContext("2d").drawImage(c, 0, 0, n.width, n.height); c = n; q = 0.7; }
      out = c.toDataURL("image/jpeg", q);
    }
    return out;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  async function stickerMaker() {
    const file = await pickFile(), url = URL.createObjectURL(file); let im;
    try { im = await loadImg(url); } catch { URL.revokeObjectURL(url); toast("Gambar tidak bisa dibuka."); return null; }
    URL.revokeObjectURL(url);
    return new Promise((resolve) => {
      const prev = document.activeElement; let shape = "square", border = true, zoom = 1, ox = 0, oy = 0;
      const back = mk("div", null, "sc-back"), box = mk("div", null, "scmp");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Buat stiker");
      const bar = mk("div", null, "sc-bar"), no = mk("button", null, "hb"), go = mk("button", "Simpan", "btn");
      no.type = go.type = "button"; no.setAttribute("aria-label", "Batal"); no.append(ic("x")); bar.append(no, mk("b", "Buat stiker"), go);
      const wrap = mk("div", null, "sc-wrap"), cv = mk("canvas", null, "mk-cv"); cv.tabIndex = 0; cv.setAttribute("aria-label", "Pratinjau stiker. Geser untuk memosisikan foto."); wrap.append(cv);
      const ctl = mk("div", null, "mk-ctl");
      const zl = mk("label"), zr = mk("input"); zr.type = "range"; zr.min = 1; zr.max = 4; zr.step = 0.05; zr.value = 1; zl.append(mk("span", "Zoom (atau cubit layar)"), zr);
      const row = mk("div", null, "sc-tabs"), bsq = mk("button", "Kotak", "pill on"), bci = mk("button", "Bulat", "pill"), bbo = mk("button", "Garis putih", "pill on");
      [bsq, bci, bbo].forEach((b) => (b.type = "button")); bbo.setAttribute("aria-pressed", "true"); row.append(bsq, bci, bbo);
      const tl = mk("label"), tin = mk("input"), bl = mk("label"), bin = mk("input");
      tin.maxLength = bin.maxLength = 24; tin.autocomplete = bin.autocomplete = "off"; tin.placeholder = bin.placeholder = "Opsional";
      tl.append(mk("span", "Teks atas"), tin); bl.append(mk("span", "Teks bawah"), bin);
      ctl.append(zl, row, tl, bl); box.append(bar, wrap, ctl); back.append(box); document.body.append(back);

      const rr = (g, x, y, w, h, r) => { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
      const shp = (g, z, inset) => { g.beginPath(); if (shape === "circle") g.arc(z / 2, z / 2, z / 2 - inset, 0, Math.PI * 2); else rr(g, inset, inset, z - 2 * inset, z - 2 * inset, z * 0.14); };
      const limit = () => {
        const inner = 256 - 2 * (border ? 12 : 3), k = Math.max(inner / im.naturalWidth, inner / im.naturalHeight) * zoom;
        const mx = Math.max(0, (im.naturalWidth * k - inner) / 2), my = Math.max(0, (im.naturalHeight * k - inner) / 2);
        ox = clamp(ox, -mx, mx); oy = clamp(oy, -my, my);
      };
      const draw = (c, z) => {
        const k = z / 256, g = c.getContext("2d"); c.width = c.height = z; g.clearRect(0, 0, z, z);
        const ins = (border ? 12 : 3) * k, inner = z - 2 * ins;
        if (border) { shp(g, z, 3 * k); g.fillStyle = "#fff"; g.fill(); }
        g.save(); shp(g, z, ins); g.clip();
        const sc = Math.max(inner / im.naturalWidth, inner / im.naturalHeight) * zoom, w = im.naturalWidth * sc, h = im.naturalHeight * sc;
        g.drawImage(im, z / 2 - w / 2 + ox * k, z / 2 - h / 2 + oy * k, w, h); g.restore();
        const txt = (t, top) => {
          if (!t) return; t = t.toUpperCase(); let f = 38 * k; const F = () => (g.font = "900 " + f + 'px Impact,"Arial Black",Arial,sans-serif'); F();
          while (g.measureText(t).width > inner * 0.9 && f > 10) { f -= 2; F(); }
          g.textAlign = "center"; g.textBaseline = top ? "top" : "bottom"; g.lineJoin = "round"; g.lineWidth = Math.max(3, f / 5); g.strokeStyle = "#111"; g.fillStyle = "#fff";
          const y = top ? ins + 8 * k : z - ins - 8 * k; g.strokeText(t, z / 2, y); g.fillText(t, z / 2, y);
        };
        txt(tin.value.trim(), true); txt(bin.value.trim(), false);
      };
      const redraw = () => { limit(); draw(cv, 256); };
      const exportSt = () => {
        const c = document.createElement("canvas"); let z = 256, u = "";
        for (let i = 0; i < 3; i++) { draw(c, z); u = c.toDataURL("image/webp", 0.85); if (!u.startsWith("data:image/webp")) u = c.toDataURL("image/png"); if (u.length <= 100000) break; z = Math.round(z * 0.8); }
        return u;
      };
      redraw();
      const ptr = new Map(), dist = () => { if (ptr.size < 2) return 0; const [a, b] = [...ptr.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); }; let pd = 0;
      cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); ptr.set(e.pointerId, [e.clientX, e.clientY]); pd = dist(); };
      cv.onpointermove = (e) => {
        if (!ptr.has(e.pointerId)) return; const old = ptr.get(e.pointerId), f = 256 / cv.getBoundingClientRect().width; ptr.set(e.pointerId, [e.clientX, e.clientY]);
        if (ptr.size === 1) { ox += (e.clientX - old[0]) * f; oy += (e.clientY - old[1]) * f; }
        else { const d = dist(); if (pd) zoom = clamp(zoom * d / pd, 1, 4); pd = d; zr.value = zoom; }
        redraw();
      };
      cv.onpointerup = cv.onpointercancel = (e) => { ptr.delete(e.pointerId); pd = dist(); };
      cv.onkeydown = (e) => { const m = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key]; if (m) { e.preventDefault(); ox += m[0]; oy += m[1]; redraw(); } };
      zr.oninput = () => { zoom = +zr.value; redraw(); };
      tin.oninput = bin.oninput = redraw;
      const setShape = (v) => { shape = v; bsq.classList.toggle("on", v === "square"); bci.classList.toggle("on", v === "circle"); redraw(); };
      bsq.onclick = () => setShape("square"); bci.onclick = () => setShape("circle");
      bbo.onclick = () => { border = !border; bbo.classList.toggle("on", border); bbo.setAttribute("aria-pressed", String(border)); redraw(); };
      const done = (v) => { document.removeEventListener("keydown", onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        if (e.key === "Tab") {
          const f = [...box.querySelectorAll("button:not([disabled]),input,canvas")], a = f[0], z = f[f.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      no.onclick = () => done(null);
      go.onclick = () => { const u = exportSt(), a = mySt(); a.unshift(u); if (saveMySt(a)) { toast("Stiker disimpan"); done(u); } };
      cv.focus();
    });
  }

  /* ----- foto & video di chat dan status ----- */
  const pickMedia = () => new Promise((res) => { const f = $("#mpick"); f.value = ""; f.onchange = () => f.files[0] && res(f.files[0]); f.click(); });
  const mcache = {}, waiters = {}; let mq = new Set(), mt;
  function needMeta(id, cb) {  // ambil info media (url, keterangan, status) sekaligus untuk banyak pesan
    if (mcache[id]) return cb(mcache[id]);
    (waiters[id] = waiters[id] || []).push(cb); mq.add(id);
    clearTimeout(mt);
    mt = setTimeout(async () => {
      const ids = [...mq]; mq = new Set(); let r = {};
      try { r = (await api("/media/meta", { method: "POST", body: JSON.stringify({ ids }) })).media; } catch {}
      ids.forEach((i) => { mcache[i] = r[i] || { missing: true }; (waiters[i] || []).splice(0).forEach((f) => f(mcache[i])); });
    }, 40);
  }
  function probeVideo(file) {  // ukuran, durasi, dan gambar pembuka video (kalau browser bisa membacanya)
    if (file._p) return Promise.resolve(file._p);
    return new Promise((res) => {
      const v = document.createElement("video"), url = URL.createObjectURL(file), out = { w: 0, h: 0, dur: 0, poster: "", url };
      const fin = () => { file._p = out; res(out); };
      v.preload = "metadata"; v.muted = true; v.playsInline = true; v.src = url;
      v.onloadedmetadata = () => {
        out.w = v.videoWidth; out.h = v.videoHeight; out.dur = v.duration || 0;
        v.onseeked = () => { try { const k = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k); c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); out.poster = c.toDataURL("image/jpeg", 0.7); } catch {} fin(); };
        v.currentTime = Math.min(0.2, out.dur / 2);
      };
      v.onerror = fin; setTimeout(fin, 6000);
    });
  }
  async function checkMedia(file, story) {
    const isV = file.type.startsWith("video/");
    if (!isV && !file.type.startsWith("image/")) { toast("Pilih foto atau video."); return false; }
    if (isV) {
      const maxMb = 100;  // batas Cloudinary paket gratis per video; naikkan angka ini hanya kalau paket Cloudinary-mu naik
      if (!me.cld) { toast("Video butuh penyimpanan Cloudinary. Minta owner mengisinya di Vercel."); return false; }
      if (file.size > maxMb * 1048576) { toast("Video terlalu besar (" + Math.round(file.size / 1048576) + " MB, maks " + maxMb + " MB). Potong atau kompres dulu."); return false; }
      const p = await probeVideo(file), max = story ? 60 : 180;
      if (p.dur > max) { toast("Video terlalu panjang (maks " + (story ? "60 detik" : "3 menit") + ")."); return false; }
    }
    return true;
  }
  async function shrinkImg(file) {
    const url = URL.createObjectURL(file);
    try {
      const im = await loadImg(url), k = Math.min(1, 1280 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      const dataUrl = exportJpg(c, 280000), fin = await loadImg(dataUrl);
      return { dataUrl, blob: await (await fetch(dataUrl)).blob(), w: fin.naturalWidth, h: fin.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  }
  function xhrUpload(up, file, onp) {  // unggah langsung ke Cloudinary dengan indikator kemajuan
    return new Promise((res, rej) => {
      const fd = new FormData(); Object.entries(up.fields).forEach(([k, v]) => fd.append(k, v)); fd.append("file", file);
      const x = new XMLHttpRequest(); x.open("POST", up.url);
      x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded / e.total);
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status >= 200 && x.status < 300 ? res(j) : rej(new Error((j.error && j.error.message) || "Unggah gagal")); };
      x.onerror = () => rej(new Error("Koneksi putus saat mengunggah")); x.send(fd);
    });
  }
  function mediaBox(m, md) {
    const wrap = mk("div", null, "mbox"), cap = mk("p", null, "mcap"); cap.hidden = true;
    const draw = (meta) => {
      wrap.replaceChildren(); cap.hidden = true;
      if (!meta || meta.missing) { wrap.append(mk("div", (md.kind === "video" ? "Video" : "Foto") + " tidak tersedia", "mph")); return; }
      if (meta.once) {
        const what = meta.kind === "video" ? "Video" : "Foto", can = !meta.mine && meta.state === "new", b = mk("button", null, "once"); b.type = "button"; b.disabled = !can;
        b.append(ic("once"), mk("span", what + " 1x lihat · " + (meta.mine ? (meta.pending ? "mengirim..." : meta.state === "new" ? "belum dibuka" : "sudah dibuka") : can ? "ketuk untuk membuka" : "sudah dibuka")));
        b.onclick = () => openOnce(md.id, meta, draw); wrap.append(b); return;
      }
      if (!meta.url) { wrap.append(mk("div", "Media sudah dihapus", "mph")); return; }
      const t = mk("button", null, "mth"), im = mk("img"); t.type = "button"; t.setAttribute("aria-label", meta.kind === "video" ? "Putar video" : "Buka foto");
      im.src = meta.thumb || meta.url; im.alt = meta.kind === "video" ? "Video" : "Foto"; im.loading = "lazy"; t.append(im);
      if (meta.kind === "video") { t.append(ic("play", "pl")); if (meta.dur) t.append(mk("small", fmtDur(meta.dur), "dur")); }
      if (meta.pending) { const pr = mk("div", null, "mprog"); pr.append(mk("i")); t.append(pr); }
      t.onclick = () => viewMedia(meta);
      wrap.append(t); if (meta.caption) { cap.textContent = meta.caption; cap.hidden = false; }
    };
    if (m.local) draw(m.local); else { wrap.append(mk("div", "Memuat...", "mph")); needMeta(md.id, draw); }
    return [wrap, cap];
  }
  function viewMedia(meta, opts = {}) {
    const prev = document.activeElement, back = mk("div", null, "mv"), bar = mk("div", null, "mv-bar"), x = mk("button", null, "hb"), body = mk("div", null, "mv-body");
    x.type = "button"; x.setAttribute("aria-label", "Tutup"); x.append(ic("x")); bar.append(x, mk("b", opts.title || ""));
    let el;
    if (meta.kind === "video") { el = mk("video"); el.src = meta.url; el.controls = true; el.autoplay = true; el.playsInline = true; el.setAttribute("playsinline", ""); }
    else { el = mk("img"); el.src = meta.url; el.alt = "Foto"; }
    body.append(el); if (meta.caption) body.append(mk("p", meta.caption, "mv-cap"));
    back.append(bar, body); document.body.append(back);
    const close = () => { document.removeEventListener("keydown", onKey, true); if (el.pause) el.pause(); back.remove(); if (prev && prev.focus) prev.focus(); if (opts.onClose) opts.onClose(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true); x.onclick = close; x.focus();
  }
  async function openOnce(id, meta, redraw) {
    const after = () => { mcache[id] = { ...meta, state: "opened" }; redraw(mcache[id]); };
    try {
      const r = await api("/media/" + id + "/open", { method: "POST" });
      viewMedia({ kind: r.kind, url: r.url || r.data, caption: r.caption }, { title: "Sekali lihat", onClose: () => { api("/media/" + id + "/done", { method: "POST" }).catch(() => {}); after(); } });
    } catch (e) { toast(e.message); if (/Sudah/.test(e.message)) after(); }
  }
  function mediaComposer(file, canOnce, story) {
    return new Promise((resolve) => {
      const prev = document.activeElement, isV = file.type.startsWith("video/"), url = URL.createObjectURL(file); let once = false;
      const back = mk("div", null, "sc-back"), box = mk("div", null, "scmp");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", story ? "Status" : "Kirim media");
      const bar = mk("div", null, "sc-bar"), no = mk("button", null, "hb"), go = mk("button", story ? "Posting" : "Kirim", "btn");
      no.type = go.type = "button"; no.setAttribute("aria-label", "Batal"); no.append(ic("x"));
      bar.append(no, mk("b", story ? "Status " + (isV ? "video" : "foto") : isV ? "Kirim video" : "Kirim foto"), go);
      const wrap = mk("div", null, "sc-wrap"), pv = mk(isV ? "video" : "img", null, "mc-prev"); pv.src = url;
      if (isV) { pv.controls = true; pv.muted = true; pv.playsInline = true; pv.setAttribute("playsinline", ""); } else pv.alt = "Pratinjau";
      wrap.append(pv);
      const ctl = mk("div", null, "mk-ctl"), cl = mk("label"), ci = mk("input"); ci.maxLength = 200; ci.placeholder = "Tambah keterangan..."; ci.autocomplete = "off";
      cl.append(mk("span", "Keterangan (opsional)"), ci); ctl.append(cl);
      if (canOnce) {
        const ob = mk("button", "1x lihat: mati", "pill"), hint = mk("p", "Penerima hanya bisa membukanya sekali, lalu hilang.", "mc-hint"); ob.type = "button"; ob.setAttribute("aria-pressed", "false"); hint.hidden = true;
        ob.onclick = () => { once = !once; ob.classList.toggle("on", once); ob.setAttribute("aria-pressed", String(once)); ob.textContent = "1x lihat: " + (once ? "nyala" : "mati"); hint.hidden = !once; };
        ctl.append(ob, hint);
      }
      box.append(bar, wrap, ctl); back.append(box); document.body.append(back);
      const done = (v) => { document.removeEventListener("keydown", onKey, true); URL.revokeObjectURL(url); back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        if (e.key === "Tab") {
          const f = [...box.querySelectorAll("button:not([disabled]),input,video")], a = f[0], z = f[f.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      no.onclick = () => done(null); go.onclick = () => done({ file, caption: ci.value.trim(), once });
      ci.focus();
    });
  }
  async function sendMedia(to, { file, caption, once }, story) {
    const isV = file.type.startsWith("video/"), tag = (isV ? "v" : "i") + (once ? "o" : "");
    let el = null, w = 0, h = 0, dur = 0, blob = file, dataUrl = "", thumb = "", lurl = "";
    const prog = (f) => { const i = el && el.querySelector(".mprog i"); if (i) i.style.width = Math.round(f * 100) + "%"; else if (story) toast("Mengunggah status " + Math.round(f * 100) + "%"); };
    try {
      if (isV) { const p = await probeVideo(file); w = p.w; h = p.h; dur = Math.round(p.dur || 0); thumb = p.poster; lurl = p.url; }
      else { const r = await shrinkImg(file); blob = r.blob; dataUrl = r.dataUrl; w = r.w; h = r.h; thumb = lurl = r.dataUrl; }
      if (!story) el = addMsg({ sender: me.player_id, to, kind: "text", body: "[med:" + tag + ":" + "0".repeat(24) + "]", t: new Date().toISOString(), pending: true,
        local: { kind: isV ? "video" : "image", thumb, url: lurl, caption, once, mine: true, state: "new", pending: true, dur } });
      else toast("Mengunggah status...");
      const n = await api("/media/new", { method: "POST", body: JSON.stringify({ kind: isV ? "video" : "image", once, caption }) });
      if (n.provider === "cld") {
        const j = await xhrUpload(n.upload, blob, prog);
        await api("/media/" + n.id + "/ready", { method: "POST", body: JSON.stringify({ ext: j.format, w: j.width || w, h: j.height || h, dur: Math.round(j.duration || dur) }) });
      } else await api("/media/" + n.id + "/data", { method: "POST", body: JSON.stringify({ data: dataUrl, w, h }) });
      const body = "[med:" + tag + ":" + n.id + "]";
      if (story) { await api("/stories", { method: "POST", body: JSON.stringify({ kind: "vid", body }) }); await loadStories(); toast("Status diposting"); return; }
      const m = await send(to, "text", body);
      st.last[to] = m.body; st.lastT[to] = m.t; el.dataset.t = m.t; el.dataset.id = m.id; if (el._m) el._m.id = m.id;
      el.querySelector("time").textContent = tm(m.t); el.querySelector(".tk").replaceWith(tick(m));
      const pr = el.querySelector(".mprog"); if (pr) pr.remove();
      const oc = el.querySelector(".once span"); if (oc) oc.textContent = (isV ? "Video" : "Foto") + " 1x lihat · belum dibuka";
      render();
    } catch (err) {
      if (el) { const t = el.querySelector(".tk"); if (t) t.replaceWith(ic("x", "tk fail")); const pr = el.querySelector(".mprog"); if (pr) pr.remove(); }
      toast("Gagal mengirim: " + err.message);
    }
  }

  function storyComposer(photo) {
    return new Promise((resolve) => {
      const prev = document.activeElement, items = []; let sel = null, tab = "builtin";
      const back = mk("div", null, "sc-back"), box = mk("div", null, "scmp");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Story foto");
      const bar = mk("div", null, "sc-bar"), no = mk("button", null, "hb"), go = mk("button", "Posting", "btn");
      no.type = "button"; no.setAttribute("aria-label", "Batal"); no.append(ic("x")); go.type = "button";
      bar.append(no, mk("b", "Story foto"), go);
      const wrap = mk("div", null, "sc-wrap"), stage = mk("div", null, "sc-stage"), img = mk("img"), cap = mk("div", null, "sc-cap");
      img.src = photo; img.alt = "Foto story"; img.draggable = false; cap.hidden = true;
      stage.append(img, cap); wrap.append(stage);
      const tools = mk("div", null, "sc-tools"), bm = mk("button", "−", "pill"), bp = mk("button", "+", "pill"), bd = mk("button", "Hapus", "pill"), bs = mk("button", "Stiker", "pill on");
      [bm, bp, bd, bs].forEach((b) => (b.type = "button"));
      bm.setAttribute("aria-label", "Kecilkan stiker"); bp.setAttribute("aria-label", "Besarkan stiker"); bd.setAttribute("aria-label", "Hapus stiker terpilih");
      const sp = mk("span", null, "sp"); tools.append(bm, bp, bd, sp, bs);
      const input = mk("input"); input.placeholder = "Tulis caption..."; input.maxLength = 120; input.autocomplete = "off"; input.setAttribute("aria-label", "Caption");
      const capRow = mk("div", null, "sc-capin"); capRow.append(input);
      const tray = mk("div", null, "sc-tray"), tabs = mk("div", null, "sc-tabs"), t1 = mk("button", "Bawaan", "pill on"), t2 = mk("button", "Stiker saya", "pill"), grid = mk("div", null, "sc-grid");
      t1.type = t2.type = "button"; tabs.append(t1, t2); tray.append(tabs, grid);
      box.append(bar, wrap, tools, capRow, tray); back.append(box); document.body.append(back);

      const fit = () => (cap.style.fontSize = stage.clientWidth * 0.055 + "px");
      const ro = window.ResizeObserver ? new ResizeObserver(fit) : null; if (ro) ro.observe(stage); img.onload = fit;
      const place = (it) => { it.el.style.left = it.x * 100 + "%"; it.el.style.top = it.y * 100 + "%"; it.el.style.width = it.w * 100 + "%"; };
      const select = (it) => { sel = it; items.forEach((x) => x.el.classList.toggle("sel", x === it)); bm.disabled = bp.disabled = bd.disabled = !it; };
      const remove = (it) => { it.el.remove(); items.splice(items.indexOf(it), 1); select(null); };
      function add(src) {
        const n = items.length, el = mk("img", null, "stk"), it = { src, x: 0.3 + (n % 5) * 0.1, y: 0.35 + (n % 4) * 0.1, w: 0.3, el };
        el.src = src; el.alt = "Stiker"; el.draggable = false; el.tabIndex = 0;
        let drag = false;
        el.onpointerdown = (e) => { e.preventDefault(); select(it); drag = true; el.setPointerCapture(e.pointerId); };
        el.onpointermove = (e) => { if (!drag) return; const r = stage.getBoundingClientRect(); it.x = clamp((e.clientX - r.left) / r.width, 0, 1); it.y = clamp((e.clientY - r.top) / r.height, 0, 1); place(it); };
        el.onpointerup = el.onpointercancel = () => (drag = false);
        el.onfocus = () => select(it);
        el.onkeydown = (e) => {
          const st = 0.02, m = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
          if (m) { e.preventDefault(); it.x = clamp(it.x + m[0], 0, 1); it.y = clamp(it.y + m[1], 0, 1); place(it); }
          else if (e.key === "+" || e.key === "=") { it.w = clamp(it.w + 0.05, 0.08, 0.9); place(it); }
          else if (e.key === "-") { it.w = clamp(it.w - 0.05, 0.08, 0.9); place(it); }
          else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(it); }
        };
        items.push(it); stage.append(el); place(it); select(it);
      }
      bm.onclick = () => { if (sel) { sel.w = clamp(sel.w - 0.05, 0.08, 0.9); place(sel); } };
      bp.onclick = () => { if (sel) { sel.w = clamp(sel.w + 0.05, 0.08, 0.9); place(sel); } };
      bd.onclick = () => sel && remove(sel);
      stage.addEventListener("pointerdown", (e) => { if (e.target === img) select(null); });
      select(null);

      function renderTray() {
        grid.replaceChildren();
        t1.classList.toggle("on", tab === "builtin"); t2.classList.toggle("on", tab === "mine");
        if (tab === "mine") {
          const addb = mk("button", null, "cell addn"); addb.type = "button"; addb.setAttribute("aria-label", "Tambah stiker dari gambarmu"); addb.append(ic("plus"), mk("span", "Buat"));
          addb.onclick = async () => { if (await stickerMaker()) renderTray(); };
          grid.append(addb);
        }
        const list = tab === "builtin" ? BUILTIN : mySt().map((src, i) => ({ name: "Stiker saya " + (i + 1), src, mine: i }));
        list.forEach((s) => {
          const cell = mk("div", null, "cell"), b = mk("button"); b.type = "button"; b.setAttribute("aria-label", "Tambah stiker " + s.name);
          const im = mk("img"); im.src = s.src; im.alt = ""; b.append(im); b.onclick = () => add(s.src); cell.append(b);
          if (s.mine !== undefined) { const x = mk("button", "×", "rm"); x.type = "button"; x.setAttribute("aria-label", "Hapus " + s.name); x.onclick = () => { const a = mySt(); a.splice(s.mine, 1); saveMySt(a); renderTray(); }; cell.append(x); }
          grid.append(cell);
        });
        if (tab === "mine" && !mySt().length) grid.append(mk("p", "Belum ada stiker. Tap Tambah untuk membuat stiker dari fotomu.", "hint"));
      }
      t1.onclick = () => { tab = "builtin"; renderTray(); };
      t2.onclick = () => { tab = "mine"; renderTray(); };
      bs.onclick = () => { tray.hidden = !tray.hidden; bs.classList.toggle("on", !tray.hidden); };
      renderTray();

      input.oninput = () => { const v = input.value.trim(); cap.textContent = v; cap.hidden = !v; fit(); };
      async function flatten() {
        const base = await loadImg(photo), W = base.naturalWidth, H = base.naturalHeight;
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const g = c.getContext("2d"); g.drawImage(base, 0, 0);
        for (const it of items) { const im = await loadImg(it.src), w = it.w * W, h = (w * im.naturalHeight) / im.naturalWidth; g.drawImage(im, it.x * W - w / 2, it.y * H - h / 2, w, h); }
        const text = input.value.trim();
        if (text) {
          const f = Math.round(W * 0.055), lh = f * 1.3, lines = []; let cur = "";
          g.font = "700 " + f + 'px "Space Grotesk", Arial, sans-serif';
          text.split(/\s+/).forEach((w) => { const t = cur ? cur + " " + w : w; if (g.measureText(t).width > W * 0.92 && cur) { lines.push(cur); cur = w; } else cur = t; });
          if (cur) lines.push(cur);
          const bh = lines.length * lh + f * 0.8;
          g.fillStyle = "rgba(17,17,17,.75)"; g.fillRect(0, H - bh, W, bh);
          g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
          lines.forEach((l, i) => g.fillText(l, W / 2, H - bh + f * 0.4 + lh * (i + 0.5)));
        }
        return exportJpg(c, 190000);
      }
      const done = (v) => { document.removeEventListener("keydown", onKey, true); if (ro) ro.disconnect(); back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        if (e.key === "Tab") {
          const f = [...box.querySelectorAll("button:not([disabled]),input,img.stk")].filter((x) => !x.closest("[hidden]")), a = f[0], z = f[f.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      no.onclick = () => done(null);
      go.onclick = async () => { go.disabled = true; go.textContent = "Memproses..."; try { done(await flatten()); } catch { go.disabled = false; go.textContent = "Posting"; toast("Gagal memproses gambar."); } };
      input.focus();
    });
  }
  function viewStories(p) {
    const list = st.stories.filter((s) => s.owner === p);
    if (!list.length) return;
    let i = 0;
    const draw = () => {
      const s = list[i], b = $("#svbody"); b.replaceChildren();
      if (s.kind === "vid") {
        const vm = medOf(s.body); b.style.background = "#000"; b.append(mk("p", "Memuat...", "mph"));
        if (vm) needMeta(vm.id, (meta) => {
          if (list[i] !== s) return;
          b.replaceChildren(); if (!meta.url) { b.append(mk("p", "Video tidak tersedia")); return; }
          const v = mk("video"); v.src = meta.url; v.autoplay = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.onended = () => b.onclick(); b.append(v);
          if (meta.caption) b.append(mk("p", meta.caption, "mv-cap"));
          v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
        });
      }
      else if (s.kind === "img") { const im = mk("img"); im.src = s.body; b.append(im); b.style.background = "#000"; }
      else { b.append(mk("p", s.body)); b.style.background = "hsl(" + hue(s.body) + ",85%,78%)"; }
      $("#svwho").textContent = nameOf(p) + " · " + fmt(s.t) + " (" + (i + 1) + "/" + list.length + ")";
    };
    $("#sv").hidden = false; draw();
    $("#svbody").onclick = () => (++i >= list.length ? ($("#sv").hidden = true) : draw());
  }
  $("#svclose").onclick = () => ($("#sv").hidden = true);

  /* ----- profil ----- */
  async function saveProfile(patch) { try { me = (await api("/profile", { method: "POST", body: JSON.stringify(patch) })).user; render(); } catch (e) { toast(e.message); } }
  $("#pphoto").onclick = async () => saveProfile({ avatar: await pick(160, 0.75, 140000) });
  $("#pcov").onclick = async () => saveProfile({ cover: await pick(720, 0.6, 190000) });
  $("#swpub").onclick = () => saveProfile({ public: me.public === false });
  const pickVis = async (title, key) => {
    const r = await dialog({ title, desc: "Orang yang tidak diizinkan tidak akan melihatnya.", ok: null, actions: Object.entries(VIS).map(([k, l]) => ({ key: k, label: (me[key] === k ? "✓ " : "") + l })) });
    if (r) saveProfile({ [key]: r.action });
  };
  $("#storybtn").onclick = () => pickVis("Siapa yang bisa melihat story-ku", "story_vis");
  $("#seenbtn").onclick = () => pickVis("Terakhir dilihat dan status online", "seen_vis");
  $("#pedit").onclick = () => $("#pst").click();
  $("#pavb").onclick = () => $("#pphoto").click();
  $("#pdel").onclick = () => saveProfile({ avatar: "" });
  $("#pst").onclick = async () => {
    const r = await dialog({ title: "Ubah profil", fields: [{ name: "n", label: "Nama", value: me.full_name || "", max: 60, required: true }, { name: "s", label: "Status kamu", value: me.status || "", max: 80, placeholder: "Contoh: sibuk" }], ok: "Simpan" });
    if (r) saveProfile({ full_name: r.n, status: r.s });
  };

  /* ----- WebRTC native: STUN Google, signaling lewat /api/send + /api/poll ----- */
  let ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  api("/ice").then((r) => r.iceServers && (ICE = { iceServers: r.iceServers })).catch(() => {});
  let pc, stream, peer, pend = [], offer, video = true, facing = "user", sdpSent = false, t0 = 0, tmr, conT, ringT, ringCtx;
  const sig = (type, data) => send(peer, "sig", JSON.stringify({ type, data })).catch(() => {});
  const fmtT = (n) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  function showPeer(p, label) {
    $("#cav").replaceChildren(av(nameOf(p), imgOf(p))); $("#cname").textContent = $("#ctopn").textContent = nameOf(p);
    $("#cstat").textContent = label; $("#ctime").textContent = "";
  }
  function started() {  // dipanggil saat koneksi benar-benar tersambung
    if (t0) return;
    t0 = Date.now(); clearTimeout(conT); stopRing(); $("#call").classList.add("on");
    const upd = () => { const t = fmtT(Math.floor((Date.now() - t0) / 1000)); $("#cstat").textContent = t; $("#ctime").textContent = t; };
    upd(); tmr = setInterval(upd, 1000);
  }
  function startRing() {
    try { navigator.vibrate && navigator.vibrate([500, 300, 500]); } catch {}
    try {
      ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)(); ringCtx.resume();
      const beep = () => { const o = ringCtx.createOscillator(), g = ringCtx.createGain(); o.frequency.value = 440; g.gain.value = 0.08; o.connect(g); g.connect(ringCtx.destination); o.start(); o.stop(ringCtx.currentTime + 0.4); };
      const cycle = () => { beep(); setTimeout(beep, 600); try { navigator.vibrate && navigator.vibrate([500, 300, 500]); } catch {} };
      cycle(); ringT = setInterval(cycle, 3000);
    } catch {}
  }
  function stopRing() { clearInterval(ringT); ringT = null; try { navigator.vibrate && navigator.vibrate(0); } catch {} }
  const gathered = (p) => new Promise((res) => {  // tunggu kandidat jaringan terkumpul (maks 3 dtk) supaya sambungan lebih cepat dan andal
    if (!p || p.iceGatheringState === "complete") return res();
    const t = setTimeout(done, 3000);
    function chk() { if (p.iceGatheringState === "complete") done(); }
    function done() { clearTimeout(t); p.removeEventListener("icegatheringstatechange", chk); res(); }
    p.addEventListener("icegatheringstatechange", chk);
  });
  async function media() {
    $("#mute").classList.remove("off"); $("#cam").classList.remove("off");
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: video && { facingMode: facing } });
    $("#local").srcObject = stream; $("#local").play().catch(() => {});
    $("#local").hidden = $("#cam").hidden = $("#flip").hidden = !video;
    $("#call").classList.toggle("vid", video); $("#call").classList.remove("live", "on");
  }
  const R = $("#remote"), A = $("#raudio");
  const live = () => { if (video && R.videoWidth) $("#call").classList.add("live"); };
  R.addEventListener("playing", live); R.addEventListener("resize", live);
  $("#unmute").onclick = () => { A.play().catch(() => {}); R.play().catch(() => {}); $("#unmute").hidden = true; };
  function mkpc() {
    sdpSent = false;
    const p = (pc = new RTCPeerConnection(ICE));
    stream.getTracks().forEach((t) => p.addTrack(t, stream));
    p.ontrack = (e) => {
      const s = e.streams[0] || new MediaStream([e.track]);
      if (A.srcObject !== s) { A.srcObject = s; R.srcObject = s; R.muted = true; }  // suara lewat <audio>, gambar lewat <video>
      A.play().catch(() => { $("#unmute").hidden = false; });
      R.play().catch(() => {});
    };
    p.onicecandidate = (e) => e.candidate && sdpSent && sig("ice", e.candidate);
    p.onconnectionstatechange = () => {
      if (pc !== p) return;
      if (p.connectionState === "connected") started();
      else if (p.connectionState === "disconnected") $("#cstat").textContent = "Koneksi tidak stabil...";
      else if (p.connectionState === "failed") hang(true, "Panggilan gagal tersambung. Jaringan kalian mungkin memblokir panggilan langsung (butuh server TURN).");
    };
    conT = setTimeout(() => { if (pc === p && !t0) hang(true, "Tidak bisa tersambung. Coba lagi sebentar lagi."); }, 35000);
  }
  function hang(notify, msg) {
    if (notify && peer) sig("end");
    stopRing(); clearInterval(tmr); clearTimeout(conT); tmr = conT = null; t0 = 0;
    if (pc) { pc.onconnectionstatechange = null; pc.close(); }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    pc = stream = peer = offer = null; pend = [];
    A.srcObject = R.srcObject = $("#local").srcObject = null; $("#unmute").hidden = true;
    $("#call").hidden = true; $("#incoming").hidden = true; $("#call").classList.remove("live", "on");
    if (msg) toast(msg);
  }
  async function call(v) {
    if (peer || !st.cur || isRoom(st.cur)) return;
    peer = st.cur; video = v; t0 = 0; $("#call").hidden = false; showPeer(peer, "Memanggil...");
    try { await media(); } catch { return hang(false, "Izin kamera/mikrofon ditolak"); }
    if (!peer) return hang(false);
    mkpc();
    const p = pc;
    try {
      await p.setLocalDescription(await p.createOffer()); await gathered(p);
      if (pc !== p) return;
      sdpSent = true; await send(peer, "sig", JSON.stringify({ type: "offer", data: { sdp: { type: p.localDescription.type, sdp: p.localDescription.sdp }, video: v } }));
    } catch (e) { hang(false, (e && e.message) || "Tidak bisa memulai panggilan"); }
  }
  $("#vbtn").onclick = () => call(true);
  $("#abtn").onclick = () => call(false);
  async function signal(from, { type, data }) {
    const bub = (id) => [...document.querySelectorAll("#msgs .bub")].find((d) => d._m && d._m.id === Number(id));
    if (type === "react") { const d = bub(data && data.id); if (d) setReaction(d, from, REACTS.includes(data.emoji) ? data.emoji : ""); return; }
    if (type === "edit") { const d = bub(data && data.id); if (d && d._m.sender === from && typeof data.body === "string") markEdited(d, data.body.slice(0, 4000)); loadChats(); return; }
    if (type === "pollv") { (pollDraw[data && data.id] || []).length && api("/polls/" + data.id).then((r) => pollDraw[data.id].forEach((f) => f(r.poll))).catch(() => {}); return; }
    if (type === "pin") { if (st.cur && (st.cur === from || isRoom(st.cur))) loadPin(); return; }
    if (type === "typing") { st.typing[from] = Date.now(); if (st.cur === from) { roomSub(); setTimeout(roomSub, 4200); } return; }
    if (type === "del") {  // lawan bicara menghapus pesannya
      const id = Number(data && data.id);
      document.querySelectorAll("#msgs .bub").forEach((d) => {
        if (d._m && d._m.id === id && d._m.sender === from && d._m.body !== DEL) markDeleted(d);
        else if (d._m && d._m.reply && d._m.reply.id === id) { const q = d.querySelector(".quote"); if (q) q.replaceWith(quoteEl({ id, gone: true })); d._m.reply = { id, gone: true }; }
      });
      loadChats();
      return;
    }
    if (type === "ice") { if (peer && from === peer) { (pc && pc.remoteDescription) ? pc.addIceCandidate(data).catch(() => {}) : pend.push(data); } return; }
    if (type === "offer") {
      if (peer) return send(from, "sig", JSON.stringify({ type: "reject" }));
      peer = from; offer = data; video = !!data.video; t0 = 0; pend = [];
      $("#iav").replaceChildren(av(nameOf(from), imgOf(from))); $("#inwho").textContent = nameOf(from);
      $("#inkind").textContent = video ? "Panggilan video masuk" : "Panggilan suara masuk";
      $("#incoming").hidden = false; startRing(); return;
    }
    if (from !== peer) return;
    if (type === "answer") {
      await pc.setRemoteDescription(data);
      pend.forEach((c) => pc.addIceCandidate(c).catch(() => {})); pend = [];
      if (!t0) $("#cstat").textContent = "Menyambung...";
    } else hang(false, type === "reject" ? "Panggilan ditolak" : type === "end" ? (t0 ? "Panggilan berakhir" : "Panggilan dibatalkan") : null);
  }
  $("#accept").onclick = async () => {
    stopRing(); $("#incoming").hidden = true; $("#call").hidden = false; showPeer(peer, "Menyambung...");
    try { await media(); } catch { sig("reject"); return hang(false, "Izin kamera/mikrofon ditolak"); }
    if (!peer) return hang(false);
    mkpc();
    const p = pc;
    try {
      await p.setRemoteDescription(offer.sdp);
      pend.forEach((c) => pc.addIceCandidate(c).catch(() => {})); pend = [];
      await p.setLocalDescription(await p.createAnswer()); await gathered(p);
      if (pc !== p) return;
      sdpSent = true; sig("answer", { type: p.localDescription.type, sdp: p.localDescription.sdp });
    } catch { hang(true, "Tidak bisa menyambung panggilan"); }
  };
  $("#reject").onclick = () => { stopRing(); sig("reject"); hang(false); };
  $("#end").onclick = () => hang(true);
  const toggle = (sel, kind) => ($(sel).onclick = (e) => {
    const t = stream && stream.getTracks().find((x) => x.kind === kind);
    if (!t) return;
    t.enabled = !t.enabled; e.currentTarget.classList.toggle("off", !t.enabled);
  });
  toggle("#mute", "audio");
  toggle("#cam", "video");
  $("#flip").onclick = async () => {
    try {
      facing = facing === "user" ? "environment" : "user";
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      const nt = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } })).getVideoTracks()[0];
      stream.addTrack(nt);
      pc.getSenders().find((s) => s.track && s.track.kind === "video").replaceTrack(nt);
      $("#local").srcObject = stream;
    } catch { toast("Tidak bisa ganti kamera"); }
  };
  const L = $("#local"); let dx = 0, dy = 0, drag = false;
  L.onpointerdown = (e) => { drag = true; dx = e.clientX - L.offsetLeft; dy = e.clientY - L.offsetTop; L.setPointerCapture(e.pointerId); };
  L.onpointermove = (e) => { if (drag) { L.style.left = e.clientX - dx + "px"; L.style.top = e.clientY - dy + "px"; L.style.right = "auto"; } };
  L.onpointerup = () => (drag = false);

  /* ----- kunci aplikasi (sidik jari / PIN HP lewat WebAuthn, hanya kunci layar lokal) ----- */
  const LK = "nova_lock", b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const lockLabel = () => ($("#lockbtn small").textContent = localStorage.getItem(LK) ? "Aktif: sidik jari atau PIN HP" : "Mati. Tap untuk mengaktifkan");
  async function unlock() {
    try {
      await navigator.credentials.get({ publicKey: { challenge: rnd(32), allowCredentials: [{ type: "public-key", id: unb64(localStorage.getItem(LK)) }], userVerification: "required", timeout: 60000 } });
      $("#lock").hidden = true; $("#lockerr").textContent = "";
    } catch { $("#lockerr").textContent = "Verifikasi gagal. Coba lagi."; }
  }
  $("#unlock").onclick = unlock;
  $("#lockout").onclick = () => {
    localStorage.removeItem(LK);
    localStorage.removeItem("nova_token");
    location.href = "login.html";
  };
  $("#lockbtn").onclick = async () => {
    if (localStorage.getItem(LK)) { localStorage.removeItem(LK); return lockLabel(); }
    try {
      const c = await navigator.credentials.create({ publicKey: { challenge: rnd(32), rp: { name: "NOVA WAWA" }, user: { id: rnd(16), name: me.player_id, displayName: me.full_name }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" }, timeout: 60000 } });
      localStorage.setItem(LK, b64(c.rawId)); lockLabel();
    } catch { toast("Perangkat atau browser ini tidak mendukung kunci sidik jari/PIN."); }
  };
  lockLabel();
  if (localStorage.getItem(LK)) { $("#lock").hidden = false; unlock(); }
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (localStorage.getItem(LK) && Date.now() - hiddenAt > 30000) { $("#lock").hidden = false; unlock(); }
  });

  /* ----- polling pesan + sinyal ----- */
  await Promise.all([loadContacts(), loadRooms(), loadStories(), loadChats(), loadPresence(), loadBlocks(), loadMutes(), loadChatPins()]);
  show("home");
  /* ----- keamanan akun: ganti password, blokir ----- */
  async function changePassword() {
    const r = await dialog({ title: "Ubah password", desc: "Minimal 8 karakter dan jangan memuat namamu. Perangkat lain perlu masuk ulang setelah ini.", fields: [
      { name: "old", label: "Password lama", type: "password", auto: "current-password", required: true },
      { name: "n1", label: "Password baru", type: "password", auto: "new-password", required: true },
      { name: "n2", label: "Ulangi password baru", type: "password", auto: "new-password", required: true }], ok: "Ganti password" });
    if (!r) return;
    if (r.n1 !== r.n2) { toast("Password baru dan ulangannya tidak sama."); return changePassword(); }
    try {
      const d = await api("/password", { method: "POST", body: JSON.stringify({ old: r.old, new: r.n1 }) });
      localStorage.setItem("nova_token", d.token); localStorage.setItem("nova_weakpw", "0"); toast("Password diganti");
    } catch (e) { toast(e.message); }
  }
  $("#pwbtn").onclick = changePassword;
  async function security() {
    let d;
    try { d = await api("/sessions"); } catch (e) { toast(e.message); return; }
    const when = (s) => { try { return new Date(s).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } };
    const live = d.sessions.filter((s) => !s.revoked);
    const actions = [{ key: "tfa", label: d.tfa ? "Matikan verifikasi 2 langkah" : "Aktifkan verifikasi 2 langkah", danger: !d.tfa }];
    live.forEach((s) => { if (!s.current) actions.push({ key: "rv:" + s.sid, label: "Keluarkan: " + s.device + " · " + s.ip + " · " + when(s.last) }); });
    if (live.some((s) => !s.current)) actions.push({ key: "all", label: "Keluar dari semua perangkat lain", danger: true });
    const desc = "Verifikasi 2 langkah: " + (d.tfa ? "aktif" : "mati") + ". Perangkat ini: " + ((live.find((s) => s.current) || {}).device || "saat ini") + ". Perangkat masuk: " + live.length + ".";
    const r = await dialog({ title: "Keamanan akun", desc, actions, ok: "Tutup", cancel: " " });
    if (!r || !r.action) return;
    try {
      if (r.action.startsWith("rv:")) { await api("/sessions/" + encodeURIComponent(r.action.slice(3)) + "/revoke", { method: "POST" }); toast("Perangkat dikeluarkan"); return security(); }
      if (r.action === "all") { const x = await api("/sessions/revoke-all", { method: "POST" }); if (x.token) localStorage.setItem("nova_token", x.token); toast("Perangkat lain sudah keluar"); return security(); }
      if (r.action === "tfa" && !d.tfa) {
        const s = await api("/2fa/setup", { method: "POST" });
        await qrOverlay("Verifikasi 2 langkah", s.uri, { hint: "Pindai dengan Google Authenticator atau Authy, lalu tutup layar ini dan masukkan kodenya.", copy: s.secret, copyLabel: "Salin kunci", copyDone: "Kunci disalin" });
        const c = await dialog({ title: "Masukkan kode", desc: "Masukkan 6 angka dari aplikasi autentikator. Simpan kuncinya baik-baik, tidak ada kode cadangan.", fields: [{ name: "code", label: "Kode 6 angka", inputmode: "numeric", auto: "one-time-code", required: true, max: 6 }], ok: "Aktifkan" });
        if (!c) return;
        await api("/2fa/enable", { method: "POST", body: JSON.stringify({ code: c.code }) }); toast("Verifikasi 2 langkah aktif"); return security();
      }
      if (r.action === "tfa" && d.tfa) {
        const c = await dialog({ title: "Matikan 2 langkah", fields: [{ name: "password", label: "Password", type: "password", auto: "current-password", required: true }, { name: "code", label: "Kode 6 angka", inputmode: "numeric", auto: "one-time-code", required: true, max: 6 }], ok: "Matikan" });
        if (!c) return;
        await api("/2fa/disable", { method: "POST", body: JSON.stringify({ password: c.password, code: c.code }) }); toast("Verifikasi 2 langkah mati"); return security();
      }
    } catch (e) { toast(e.message); }
  }
  $("#secbtn").onclick = security;
  $("#legalbtn").onclick = () => window.open("terms.html", "_blank", "noopener");
  /* ----- tema tampilan: 5 pilihan siap pakai + custom (tersimpan per perangkat) ----- */
  const THEMES = [
    { id: "violet", name: "Ungu Nova", c1: "#8b5cf6", c2: "#22d3ee", bg: "#0a0a12" },
    { id: "teal", name: "Midnight Teal", c1: "#10b981", c2: "#2dd4bf", bg: "#071414" },
    { id: "ember", name: "Sunset Ember", c1: "#f97316", c2: "#fb7185", bg: "#140b08" },
    { id: "rose", name: "Rose Noir", c1: "#ec4899", c2: "#c084fc", bg: "#120a14" },
    { id: "light", name: "Arctic Light", c1: "#3b82f6", c2: "#0891b2", bg: "#f3f5fb" },
  ];
  function hex2hsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0); else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; }
    return [h * 360, s * 100, l * 100];
  }
  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map((x) => Math.round(255 * x).toString(16).padStart(2, "0")).join("");
  }
  const deriveAcc2 = (hex) => { try { const [h, s, l] = hex2hsl(hex); return hsl2hex((h + 150) % 360, Math.min(s, 85), Math.min(Math.max(l, 45), 68)); } catch { return "#22d3ee"; } };
  function applyTheme(id, acc, acc2) {
    if (id === "violet") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", id);
    if (id === "custom") {
      document.documentElement.style.setProperty("--c-acc", acc); document.documentElement.style.setProperty("--c-acc2", acc2);
      localStorage.setItem("nova_theme_acc", acc); localStorage.setItem("nova_theme_acc2", acc2);
    } else {
      document.documentElement.style.removeProperty("--c-acc"); document.documentElement.style.removeProperty("--c-acc2");
      localStorage.removeItem("nova_theme_acc"); localStorage.removeItem("nova_theme_acc2");
    }
    localStorage.setItem("nova_theme", id === "violet" ? "" : id);
    $("#thmsub").textContent = id === "custom" ? "Custom" : (THEMES.find((x) => x.id === id) || {}).name || "Ungu Nova";
  }
  function openThemePicker() {
    const cur = localStorage.getItem("nova_theme") || "violet";
    const back = mk("div", null, "dlg-back"), box = mk("div", null, "dlg");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "thm-t");
    const h = mk("h2", "Pilih tema"); h.id = "thm-t"; box.append(h);
    box.append(mk("p", "Ubah tampilan NOVA WAWA sesuai selera. Tersimpan di perangkat ini.", "dlg-d"));
    const grid = mk("div", null, "theme-grid");
    const markSel = (btn) => grid.querySelectorAll(".theme-sw").forEach((x) => x.classList.toggle("sel", x === btn));
    THEMES.forEach((t) => {
      const b = mk("button", null, "theme-sw" + (cur === t.id ? " sel" : "")); b.type = "button";
      const dot = mk("div", null, "tsw-dot"); dot.style.background = t.bg;
      const i1 = document.createElement("i"), i2 = document.createElement("i"); i1.style.background = t.c1; i2.style.background = t.c2;
      dot.append(i1, i2); b.append(dot, mk("span", t.name));
      b.onclick = () => { applyTheme(t.id); markSel(b); };
      grid.append(b);
    });
    const cb = mk("button", null, "theme-sw" + (cur === "custom" ? " sel" : "")); cb.type = "button";
    const cdot = mk("div", "+", "tsw-dot tsw-cus");
    cb.append(cdot, mk("span", "Custom"));
    cb.onclick = () => {
      const inp = document.createElement("input"); inp.type = "color"; inp.value = localStorage.getItem("nova_theme_acc") || "#8b5cf6";
      inp.style.cssText = "position:fixed;opacity:0;pointer-events:none;left:-99px"; document.body.append(inp);
      inp.addEventListener("input", () => { applyTheme("custom", inp.value, deriveAcc2(inp.value)); markSel(cb); });
      inp.addEventListener("change", () => inp.remove());
      inp.click();
    };
    grid.append(cb);
    box.append(grid);
    const row = mk("div", null, "dlg-b"), ok = mk("button", "Selesai", "btn"); ok.type = "button";
    row.append(ok); box.append(row);
    back.append(box); document.body.append(back);
    const done = () => { document.removeEventListener("keydown", onKey, true); back.remove(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(); } };
    document.addEventListener("keydown", onKey, true);
    ok.onclick = done;
    back.addEventListener("pointerdown", (e) => { if (e.target === back) done(); });
    ok.focus();
  }
  $("#thmbtn").onclick = openThemePicker;
  (() => { const id = localStorage.getItem("nova_theme") || "violet"; $("#thmsub").textContent = id === "custom" ? "Custom" : (THEMES.find((x) => x.id === id) || {}).name || "Ungu Nova"; })();
  $("#verifybtn").onclick = async () => { try { await api("/email/resend", { method: "POST" }); toast("Tautan verifikasi dikirim. Cek kotak masuk dan folder spam."); } catch (e) { toast(e.message); } };
  $("#delbtn").onclick = async () => {
    const r = await dialog({ title: "Hapus akun?", desc: "Akun, pesan, kontak, story, foto dan video, serta grup dan saluran milikmu dihapus permanen. Tidak bisa dibatalkan.", fields: [{ name: "pw", label: "Masukkan password untuk konfirmasi", type: "password", auto: "current-password", required: true }], ok: "Hapus permanen" });
    if (!r) return;
    try { await api("/account/delete", { method: "POST", body: JSON.stringify({ password: r.pw }) }); localStorage.clear(); location.href = "index.html"; } catch (e) { toast(e.message); }
  };
  /* notifikasi push */
  const u8 = (b) => Uint8Array.from(atob(b.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  const swReg = "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);
  const pushOk = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  async function pushState() {
    if (!pushOk()) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    const reg = await swReg; if (!reg) return "unsupported";
    return (await reg.pushManager.getSubscription()) ? "on" : "off";
  }
  async function refreshPush() {
    const t = { on: "Aktif di perangkat ini. Tap untuk mematikan.", off: "Mati. Tap untuk mengaktifkan.", denied: "Diblokir di pengaturan browser.", unsupported: "Browser ini belum mendukung." };
    $("#pushsub").textContent = t[await pushState()];
  }
  $("#pushbtn").onclick = async () => {
    const s0 = await pushState();
    if (s0 === "unsupported") return toast("Browser ini belum mendukung notifikasi. Di iPhone, tambahkan aplikasi ke layar utama dulu.");
    if (s0 === "denied") return toast("Notifikasi diblokir. Aktifkan lewat pengaturan situs di browser.");
    const reg = await swReg;
    try {
      if (s0 === "on") {
        const sub = await reg.pushManager.getSubscription();
        await api("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); toast("Notifikasi dimatikan");
      } else {
        if ((await Notification.requestPermission()) !== "granted") return toast("Izin notifikasi tidak diberikan.");
        const { key } = await api("/push/key");
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(key) }), j = sub.toJSON();
        await api("/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
        await api("/push/test", { method: "POST" }).catch(() => {}); toast("Notifikasi aktif");
      }
    } catch (e) { toast(e.message || "Gagal mengatur notifikasi."); }
    refreshPush();
  };
  swReg.then(async (reg) => {  // pastikan perangkat ini tercatat untuk akun yang sedang masuk
    if (!reg || !pushOk() || Notification.permission !== "granted") return;
    const sub = await reg.pushManager.getSubscription(); if (!sub) return;
    const j = sub.toJSON(); api("/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) }).catch(() => {});
  });
  const joinFromHash = () => { let c = null; try { c = localStorage.getItem("nova_join"); localStorage.removeItem("nova_join"); } catch {} if (c) { history.replaceState(null, "", location.pathname); joinInvite(c); return true; } return false; };
  const openFromHash = () => { if (joinFromHash()) return; const m = /^#chat=(.+)$/.exec(location.hash); if (m) { history.replaceState(null, "", location.pathname); open(decodeURIComponent(m[1])); } };
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { const m = /#chat=(.+)$/.exec((e.data && e.data.url) || ""); if (e.data && e.data.type === "open" && m) open(decodeURIComponent(m[1])); });
  setTimeout(openFromHash, 700);
  st.blocked = new Set();
  async function loadBlocks() { try { st.blocked = new Set((await api("/blocks")).blocks.map((b) => b.player_id)); } catch {} }
  /* ----- pesan disematkan, chat disematkan ----- */
  async function loadPin() {
    document.querySelectorAll(".pinbar").forEach((x) => x.remove()); st.pin = null;
    const cur = st.cur; if (!cur || cur === OFFICIAL) return;
    try {
      const { pin } = await api("/pins?chat=" + encodeURIComponent(cur)); if (cur !== st.cur || !pin) return;
      st.pin = pin;
      const bar = mk("div", null, "pinbar"), t = mk("button", null, "pint"), x = mk("button", null, "hb");
      t.type = x.type = "button"; t.append(ic("pin"), mk("span", [whoName(pin.sender) + ": " + lastText(pin.body)].join("")));
      t.onclick = () => jumpTo(pin.id); x.setAttribute("aria-label", "Lepas sematan"); x.append(ic("x")); x.onclick = () => pinMsg({ id: pin.id });
      bar.append(t, x); $("#msgs").before(bar);
    } catch {}
  }
  async function pinMsg(m) {
    const unpin = st.pin && st.pin.id === m.id;
    try { await api("/pins", { method: "POST", body: JSON.stringify({ chat: st.cur, message_id: unpin ? null : m.id }) }); await loadPin(); toast(unpin ? "Sematan dilepas" : "Pesan disematkan"); } catch (e) { toast(e.message); }
  }
  async function loadChatPins() { try { st.cpins = new Set((await api("/chatpins")).pins); } catch {} }
  async function toggleChatPin(chat) {
    const on = !st.cpins.has(chat);
    try { await api("/chatpins", { method: "POST", body: JSON.stringify({ chat, value: on }) }); on ? st.cpins.add(chat) : st.cpins.delete(chat); toast(on ? "Chat disematkan" : "Sematan chat dilepas"); render(); } catch (e) { toast(e.message); }
  }
  /* ----- bisukan, cari pesan, media & tautan, tautan undangan ----- */
  st.mutes = new Set();
  async function loadMutes() { try { st.mutes = new Set((await api("/mutes")).mutes); } catch {} }
  async function toggleMute(chat) {
    const on = !st.mutes.has(chat);
    try { await api("/mutes", { method: "POST", body: JSON.stringify({ chat, value: on }) }); on ? st.mutes.add(chat) : st.mutes.delete(chat); toast(on ? "Notifikasi dibisukan" : "Notifikasi diaktifkan"); } catch (e) { toast(e.message); }
  }
  const toolActs = (chat) => [{ key: "pinchat", label: st.cpins.has(chat) ? "Lepas sematan chat" : "Sematkan chat di atas" }, { key: "mute", label: st.mutes.has(chat) ? "Aktifkan notifikasi" : "Bisukan notifikasi" }, { key: "search", label: "Cari pesan" }, { key: "media", label: "Media dan tautan" }, ...(!$("#form").hidden ? [{ key: "poll", label: "Buat polling" }] : [])];
  function chatSearch() {
    document.querySelectorAll(".msearch").forEach((x) => x.remove());
    const bar = mk("div", null, "msearch"), inp = mk("input"), cnt = mk("small"), x = mk("button", null, "hb");
    inp.type = "search"; inp.placeholder = "Cari di chat ini..."; inp.setAttribute("aria-label", "Cari pesan");
    x.type = "button"; x.setAttribute("aria-label", "Tutup pencarian"); x.append(ic("x"));
    bar.append(inp, cnt, x); $("#msgs").before(bar); inp.focus();
    const run = () => {
      const q = inp.value.trim().toLowerCase(); let n = 0;
      document.querySelectorAll("#msgs .bub").forEach((d) => {
        const b = d._m && d._m.body, hit = !q || (b && !medOf(b) && !stkId(b) && !vnOf(b) && b !== DEL && b.toLowerCase().includes(q));
        d.hidden = !hit; if (q && hit) n++;
      });
      cnt.textContent = q ? n + " ditemukan" : "";
    };
    inp.oninput = run;
    x.onclick = () => { inp.value = ""; run(); bar.remove(); };
  }
  function mediaPanel() {
    const items = [], links = [], wrap = mk("div", null, "mpanel");
    document.querySelectorAll("#msgs .bub").forEach((d) => {
      const m = d._m; if (!m || !m.body) return;
      const md = medOf(m.body); if (md && !md.once) items.push(md);
      (m.body.match(/https?:\/\/[^\s<>"']+/g) || []).forEach((u) => links.push(u.slice(0, 300)));
    });
    const grid = mk("div", null, "mgrid");
    items.forEach((md) => needMeta(md.id, (meta) => {
      if (!meta || !meta.url) return;
      const b = mk("button"), im = mk("img"); b.type = "button"; im.src = meta.thumb || meta.url; im.alt = md.kind === "video" ? "Video" : "Foto"; im.loading = "lazy"; b.append(im);
      b.onclick = () => viewMedia(meta); grid.append(b);
    }));
    wrap.append(mk("small", items.length || links.length ? "Dari 200 pesan terakhir" : "Belum ada media atau tautan di pesan yang termuat.", "hint"), grid);
    if (links.length) { const ul = mk("div", null, "llist"); [...new Set(links)].forEach((u) => { const a = mk("a", u); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; ul.append(a); }); wrap.append(mk("b", "Tautan"), ul); }
    return wrap;
  }
  function mediaList() {
    const prev = document.activeElement, back = mk("div", null, "mv"), bar = mk("div", null, "mv-bar"), x = mk("button", null, "hb"), body = mk("div", null, "mv-body mlist");
    x.type = "button"; x.setAttribute("aria-label", "Tutup"); x.append(ic("x")); bar.append(x, mk("b", "Media dan tautan")); body.append(mediaPanel());
    back.append(bar, body); document.body.append(back);
    const close = () => { document.removeEventListener("keydown", onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".mv ~ .mv")) { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true); x.onclick = close; x.focus();
  }
  async function toolAction(key, chat) {
    if (key === "pinchat") await toggleChatPin(chat); else if (key === "mute") await toggleMute(chat); else if (key === "search") chatSearch(); else if (key === "media") mediaList(); else if (key === "poll") await createPoll(chat); else return false;
    return true;
  }
  async function inviteMenu(r, reset) {
    try {
      const { url } = await api("/rooms/" + r.id + "/invite", { method: "POST", body: JSON.stringify({ reset: !!reset }) });
      const a = await dialog({ title: "Tautan undangan", desc: url + "\nSiapa pun yang punya tautan ini bisa bergabung.", ok: null, actions: [{ key: "copy", label: "Salin tautan" }, { key: "share", label: "Bagikan" }, { key: "qr", label: "Tampilkan kode QR" }, { key: "reset", label: "Buat tautan baru (yang lama mati)", danger: true }] });
      if (!a) return;
      if (a.action === "copy") navigator.clipboard.writeText(url).then(() => toast("Tautan disalin"), () => toast("Tidak bisa menyalin"));
      else if (a.action === "share") { if (navigator.share) navigator.share({ title: r.name, url }).catch(() => {}); else navigator.clipboard.writeText(url).then(() => toast("Tautan disalin")); }
      else if (a.action === "qr") qrOverlay("Kode QR undangan", url);
      else if (a.action === "reset") inviteMenu(r, true);
    } catch (e) { toast(e.message); }
  }
  async function joinInvite(code) {
    try {
      const info = await api("/invite/" + encodeURIComponent(code));
      if (info.joined) { await loadRooms(); return open("R-" + info.id); }
      const ok = await dialog({ title: (info.kind === "group" ? "Gabung grup " : "Ikuti saluran ") + info.name + "?", desc: info.count + " anggota" + (info.about ? "\n" + info.about : ""), ok: info.kind === "group" ? "Gabung" : "Ikuti" });
      if (!ok) return;
      const r = await api("/invite/" + encodeURIComponent(code) + "/join", { method: "POST" });
      await loadRooms(); open("R-" + r.id);
    } catch (e) { toast(e.message); }
  }
  async function editRoom(r, patch, okMsg) {
    try {
      await api("/rooms/" + r.id + "/edit", { method: "POST", body: JSON.stringify(patch) });
      await loadRooms(); const nr = roomOf("R-" + r.id);
      if (nr && st.cur === "R-" + r.id) { $("#rtitle").textContent = nr.name; $("#rav").replaceChildren(chAv(nr.kind, nr.avatar, nr.name)); loadChats(); }
      toast(okMsg || "Disimpan");
    } catch (e) { toast(e.message); }
  }
  async function showMembers(r) {
    try {
      const members = (await api("/rooms/" + r.id + "/members")).members;
      const isOwn = r.owner === me.player_id, canKick = r.kind === "group" && (isOwn || r.admin);
      const nm = (m) => m.full_name + (m.room_owner ? " (pemilik)" : m.room_admin ? " (admin)" : "") + (m.player_id === me.player_id ? " (kamu)" : "");
      if (!canKick) return dialog({ title: "Anggota (" + members.length + ")", desc: members.map(nm).join("\n"), ok: null });
      const others = members.filter((m) => m.player_id !== me.player_id && !m.room_owner && (isOwn || !m.room_admin));
      const pk = await dialog({ title: "Anggota (" + members.length + ")", desc: others.length ? members.map(nm).join("\n") + "\n\nPilih anggota untuk dikeluarkan" + (isOwn ? " atau dijadikan admin." : ".") : "Belum ada anggota lain yang bisa dikelola.", ok: null,
        actions: others.flatMap((m) => [{ key: m.player_id, label: "Keluarkan: " + m.full_name }].concat(isOwn ? [{ key: "adm:" + m.player_id, label: (m.room_admin ? "Cabut admin: " : "Jadikan admin: ") + m.full_name }] : [])) });
      if (!pk) return;
      if (pk.action.startsWith("adm:")) {
        const t = others.find((m) => m.player_id === pk.action.slice(4)); if (!t) return;
        await api("/rooms/" + r.id + "/admin", { method: "POST", body: JSON.stringify({ player_id: t.player_id, value: !t.room_admin }) });
        toast(t.full_name + (t.room_admin ? " bukan admin lagi" : " sekarang admin")); if (st.cur === "R-" + r.id) { $("#msgs").replaceChildren(); (await api("/history?peer=" + encodeURIComponent(st.cur))).messages.forEach(addMsg); }
        return;
      }
      const who = others.find((m) => m.player_id === pk.action); if (!who) return;
      if (!(await dialog({ title: "Keluarkan " + who.full_name + "?", desc: "Dia tidak bisa lagi membaca atau mengirim pesan di grup ini. Anggota lain melihat pemberitahuannya.", ok: "Keluarkan" }))) return;
      await api("/rooms/" + r.id + "/kick", { method: "POST", body: JSON.stringify({ player_id: who.player_id }) });
      toast(who.full_name + " dikeluarkan"); loadRooms();
      if (st.cur === "R-" + r.id) { $("#msgs").replaceChildren(); (await api("/history?peer=" + encodeURIComponent(st.cur))).messages.forEach(addMsg); }
    } catch (e) { toast(e.message); }
  }
  /* ----- halaman info grup / saluran (tab Anggota, Media, Pengaturan) ----- */
  async function addMembers(r) {
    try {
      const cur = new Set((await api("/rooms/" + r.id + "/members")).members.map((m) => m.player_id));
      const f = await dialog({ title: "Tambah anggota", fields: [{ name: "extra", label: "ID lain (opsional, pisah koma)", placeholder: "48210377, 63915204", inputmode: "numeric" }],
        contacts: st.contacts.filter((c) => !cur.has(c.player_id)), ok: "Tambah" });
      if (!f) return false;
      const members = [...new Set([...f.members, ...f.extra.split(",").map((x) => x.trim()).filter(Boolean)])];
      if (!members.length) { toast("Pilih minimal satu orang."); return false; }
      const res = await api("/rooms/" + r.id + "/add", { method: "POST", body: JSON.stringify({ members }) });
      toast(res.added + " anggota ditambahkan"); await loadRooms();
      if (st.cur === "R-" + r.id) { $("#msgs").replaceChildren(); (await api("/history?peer=" + encodeURIComponent(st.cur))).messages.forEach(addMsg); }
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  async function leaveRoom(r) {
    const grp = r.kind === "group", jenis = grp ? "grup" : "saluran", mineOwner = r.owner === me.player_id;
    const warn = grp && mineOwner ? "Kamu pemilik grup ini. Anggota paling lama akan jadi pemilik baru, dan kalau tidak ada anggota lain, grup dihapus." : "Kamu tidak akan menerima pesan dari " + jenis + " ini lagi.";
    if (!(await dialog({ title: (grp ? "Keluar dari " : "Berhenti mengikuti ") + r.name + "?", desc: warn, ok: grp ? "Keluar" : "Berhenti" }))) return false;
    try { await api("/rooms/" + r.id + "/leave", { method: "POST" }); st.cur = null; show(st.tab); loadRooms(); toast(grp ? "Kamu keluar dari grup" : "Tidak lagi mengikuti"); return true; } catch (e) { toast(e.message); return false; }
  }
  function qrOverlay(title, url, opt = {}) {
    return new Promise((resolve) => {
    const q = window.NovaQR(url), px = 8, quiet = 4, size = (q.n + quiet * 2) * px, c = document.createElement("canvas");
    c.width = c.height = size; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, size, size); g.fillStyle = "#000";
    for (let y = 0; y < q.n; y++) for (let x = 0; x < q.n; x++) if (q.dark(y, x)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    const img = mk("img", null, "qrimg"); img.src = c.toDataURL("image/png"); img.alt = "Kode QR undangan";
    const prev = document.activeElement, back = mk("div", null, "mv"), bar = mk("div", null, "mv-bar"), x = mk("button", null, "hb"), body = mk("div", null, "mv-body"), cp = mk("button", opt.copyLabel || "Salin tautan", "btn");
    x.type = cp.type = "button"; x.setAttribute("aria-label", "Tutup"); x.append(ic("x")); bar.append(x, mk("b", title));
    cp.onclick = () => navigator.clipboard.writeText(opt.copy || url).then(() => toast(opt.copyDone || "Tautan disalin"), () => toast("Tidak bisa menyalin"));
    body.append(img, mk("small", opt.hint || "Pindai dengan kamera untuk bergabung", "hint"), cp); back.append(bar, body); document.body.append(back);
    const close = () => { document.removeEventListener("keydown", onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); resolve(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true); x.onclick = close; x.focus();
    });
  }
  async function roomInfo(r) {
    const grp = r.kind === "group", jenis = grp ? "grup" : "saluran", chat = "R-" + r.id, own = r.owner === me.player_id, canEdit = own || (grp && r.admin);
    const back = mk("div", null, "mv rinfo"), bar = mk("div", null, "mv-bar"), x = mk("button", null, "hb"), body = mk("div", null, "rbody");
    x.type = "button"; x.setAttribute("aria-label", "Tutup"); x.append(ic("back")); bar.append(x, mk("b", "Info " + jenis));
    const prev = document.activeElement;
    const close = () => { document.removeEventListener("keydown", onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".rinfo ~ .mv")) { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true); x.onclick = close;
    const hero = mk("div", null, "rhero"); const h2 = mk("h2", r.name); if (r.bdg) h2.append(ic("seal", "seal " + r.bdg), mk("i", RB[r.bdg], "own"));
    hero.append(chAv(r.kind, r.avatar, r.name), h2, mk("small", jenis[0].toUpperCase() + jenis.slice(1) + " · " + r.count + (grp ? " anggota" : " pengikut")));
    if (r.about) hero.append(mk("p", r.about, "rabout"));
    const qa = mk("div", null, "rqa"), qbtn = (icon, label, fn) => { const b = mk("button", null, "qa"); b.type = "button"; b.append(ic(icon), mk("span", label)); b.onclick = fn; qa.append(b); return b; };
    qbtn("search", "Cari", () => { close(); chatSearch(); });
    const mb = qbtn("mic", st.mutes.has(chat) ? "Aktifkan" : "Bisukan", async () => { await toggleMute(chat); mb.lastChild.textContent = st.mutes.has(chat) ? "Aktifkan" : "Bisukan"; });
    if (canEdit) qbtn("userplus", grp ? "Undang" : "Bagikan", () => inviteMenu(r));
    if (grp && canEdit) qbtn("plus", "Tambah", async () => { if (await addMembers(r)) { r = roomOf(chat) || r; hero.querySelector("small").textContent = "Grup · " + r.count + " anggota"; tabs.members(); } });
    const tabBar = mk("div", null, "rtabs"), pane = mk("div", null, "rpane"), tabs = {}, defs = [["members", "Anggota"], ["media", "Media"], ["set", "Pengaturan"]];
    const setTab = (k) => { [...tabBar.children].forEach((b) => { const on = b.dataset.k === k; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }); pane.replaceChildren(); tabs[k](); };
    defs.forEach(([k, label]) => { const b = mk("button", label); b.type = "button"; b.dataset.k = k; b.setAttribute("role", "tab"); b.onclick = () => setTab(k); tabBar.append(b); });
    tabs.members = async () => {
      pane.replaceChildren(mk("small", "Memuat...", "hint"));
      try {
        const members = (await api("/rooms/" + r.id + "/members")).members, list = mk("div", null, "mlist2");
        members.forEach((m) => {
          const row = mk("button", null, "mrow"); row.type = "button"; row.append(av(m.full_name, m.avatar));
          const t = mk("span"); t.append(mk("b", m.full_name + (m.player_id === me.player_id ? " (kamu)" : ""))); if (m.online || m.player_id === me.player_id) t.append(mk("small", "online", "onl")); row.append(t);
          if (m.room_owner) row.append(mk("i", "Pemilik", "own")); else if (m.room_admin) row.append(mk("i", "Admin", "own"));
          const can = grp && canEdit && !m.room_owner && m.player_id !== me.player_id && (own || !m.room_admin);
          if (can) row.onclick = async () => {
            const acts = [{ key: "kick", label: "Keluarkan", danger: true }]; if (own) acts.unshift({ key: "adm", label: m.room_admin ? "Cabut admin" : "Jadikan admin" });
            const a = await dialog({ title: m.full_name, desc: "ID " + m.player_id, ok: null, actions: acts }); if (!a) return;
            try {
              if (a.action === "adm") await api("/rooms/" + r.id + "/admin", { method: "POST", body: JSON.stringify({ player_id: m.player_id, value: !m.room_admin }) });
              else { if (!(await dialog({ title: "Keluarkan " + m.full_name + "?", desc: "Dia tidak bisa lagi membaca atau mengirim pesan di grup ini.", ok: "Keluarkan" }))) return; await api("/rooms/" + r.id + "/kick", { method: "POST", body: JSON.stringify({ player_id: m.player_id }) }); }
              await loadRooms(); r = roomOf(chat) || r; hero.querySelector("small").textContent = "Grup · " + r.count + " anggota"; tabs.members();
              if (st.cur === chat) { $("#msgs").replaceChildren(); (await api("/history?peer=" + encodeURIComponent(st.cur))).messages.forEach(addMsg); }
            } catch (e) { toast(e.message); }
          }; else row.disabled = true;
          list.append(row);
        });
        const n = members.filter((m) => m.online || m.player_id === me.player_id).length; if (grp) hero.querySelector("small").textContent = "Grup · " + r.count + " anggota · " + n + " online";
        pane.replaceChildren(list);
      } catch (e) { pane.replaceChildren(mk("small", e.message, "hint")); }
    };
    tabs.media = () => pane.replaceChildren(mediaPanel());
    tabs.set = () => {
      const col = mk("div", null, "rset"), add = (label, fn, danger) => { const b = mk("button", label, danger ? "danger" : ""); b.type = "button"; b.onclick = fn; col.append(b); };
      if (canEdit) {
        add("Ganti nama dan deskripsi", async () => { const f = await dialog({ title: "Ubah " + jenis, fields: [{ name: "name", label: "Nama " + jenis, value: r.name, max: 60, required: true }, { name: "about", label: "Deskripsi (opsional)", value: r.about || "", max: 200 }], ok: "Simpan" }); if (f) { await editRoom(r, { name: f.name, about: f.about }); close(); roomInfo(roomOf(chat) || r); } });
        add("Ganti foto " + jenis, async () => { const img = await pick(160, 0.75, 55000); await editRoom(r, { avatar: img }, "Foto diperbarui"); close(); roomInfo(roomOf(chat) || r); });
        if (r.avatar) add("Hapus foto " + jenis, async () => { await editRoom(r, { avatar: "" }, "Foto dihapus"); close(); roomInfo(roomOf(chat) || r); });
        add("Tautan undangan", () => inviteMenu(r));
        if (grp) {
          const SL = { 0: "Mati", 10: "10 detik", 30: "30 detik", 60: "1 menit", 300: "5 menit" };
          add("Mode lambat: " + (SL[r.slow || 0] || "Mati"), async () => {
            const a = await dialog({ title: "Mode lambat", desc: "Anggota biasa hanya bisa kirim satu pesan per selang waktu. Admin dan pemilik tidak dibatasi.", ok: null, actions: Object.entries(SL).map(([k, l]) => ({ key: k, label: ((r.slow || 0) === Number(k) ? "✓ " : "") + l })) });
            if (!a) return; try { await api("/rooms/" + r.id + "/settings", { method: "POST", body: JSON.stringify({ slow: Number(a.action) }) }); await loadRooms(); toast("Disimpan"); close(); roomInfo(roomOf(chat) || r); } catch (e) { toast(e.message); }
          });
          add("Pesan sambutan" + (r.welcome ? " (aktif)" : ""), async () => {
            const f = await dialog({ title: "Pesan sambutan", desc: "Dikirim otomatis saat ada anggota baru. Kosongkan untuk mematikan.", fields: [{ name: "w", label: "Isi pesan", value: r.welcome || "", multiline: true, max: 300 }], ok: "Simpan" });
            if (f) try { await api("/rooms/" + r.id + "/settings", { method: "POST", body: JSON.stringify({ welcome: f.w }) }); await loadRooms(); toast("Disimpan"); close(); roomInfo(roomOf(chat) || r); } catch (e) { toast(e.message); }
          });
        }
        add("Log aktivitas admin", async () => {
          try {
            const { log } = await api("/rooms/" + r.id + "/log"), AC = { tambah: "menambah", keluarkan: "mengeluarkan", jadi_admin: "menjadikan admin", cabut_admin: "mencabut admin", ganti_nama: "mengganti nama jadi", mode_lambat: "mode lambat (detik)", sambutan: "mengubah pesan sambutan" };
            await dialog({ title: "Log aktivitas admin", desc: log.length ? log.map((x) => short(x.t) + " · " + x.actor + " " + (AC[x.action] || x.action) + (x.detail ? " " + x.detail : "")).join("\n") : "Belum ada catatan.", ok: null });
          } catch (e) { toast(e.message); }
        });
      }
      add(st.mutes.has(chat) ? "Aktifkan notifikasi" : "Bisukan notifikasi", async () => { await toggleMute(chat); tabs.set(); mb.lastChild.textContent = st.mutes.has(chat) ? "Aktifkan" : "Bisukan"; });
      if (grp || !own) add(grp ? "Keluar dari grup" : "Berhenti mengikuti", async () => { if (await leaveRoom(r)) close(); }, true);
      pane.replaceChildren(col);
    };
    body.append(hero, qa, tabBar, pane); back.append(bar, body); document.body.append(back); x.focus();
    setTab("members");
  }
  const roomMenu = roomInfo;
  $("#morebtn").onclick = async () => {
    const p = st.cur; if (p && isRoom(p)) { const r = roomOf(p); if (r) roomMenu(r); return; }
    if (!p || p === OFFICIAL) return;
    const was = st.blocked.has(p);
    const r = await dialog({ title: nameOf(p), desc: "ID " + p, ok: null, actions: [...toolActs(p), { key: "blk", label: was ? "Buka blokir" : "Blokir pengguna", danger: !was }, { key: "rep", label: "Laporkan pengguna" }] });
    if (!r) return;
    if (await toolAction(r.action, p)) return;
    if (r.action === "rep") return reportUser(p);
    if (!was && !(await dialog({ title: "Blokir " + nameOf(p) + "?", desc: "Pesan dan panggilan darinya tidak akan sampai ke kamu, dan dia tidak diberi tahu.", ok: "Blokir" }))) return;
    try { await api("/blocks/" + p, { method: "POST", body: JSON.stringify({ value: !was }) }); await loadBlocks(); toast(was ? "Blokir dibuka" : "Pengguna diblokir"); } catch (e) { toast(e.message); }
  };
  const REASON = { spam: "Spam", pelecehan: "Pelecehan atau ancaman", penipuan: "Penipuan", tidak_pantas: "Konten tidak pantas", lainnya: "Lainnya" };
  async function reportUser(p) {
    const why = await dialog({ title: "Laporkan " + nameOf(p), desc: "Pilih alasan. Laporan ditinjau owner, dan orang ini tidak diberi tahu.", ok: null, actions: Object.entries(REASON).map(([k, l]) => ({ key: k, label: l })) });
    if (!why) return;
    const d = await dialog({ title: REASON[why.action], desc: "Tambahkan keterangan singkat (opsional).", fields: [{ name: "detail", label: "Keterangan", multiline: true, max: 300 }], ok: "Kirim laporan" });
    if (!d) return;
    try { await api("/reports", { method: "POST", body: JSON.stringify({ target: p, reason: why.action, detail: d.detail }) }); toast("Laporan terkirim. Terima kasih."); } catch (e) { toast(e.message); }
  }
  $("#blkbtn").onclick = async () => {
    try {
      const r = await api("/blocks");
      if (!r.blocks.length) return toast("Belum ada pengguna yang diblokir.");
      const pk = await dialog({ title: "Pengguna diblokir", desc: "Pilih untuk membuka blokir.", ok: null, actions: r.blocks.map((b) => ({ key: b.player_id, label: "Buka blokir: " + b.full_name })) });
      if (pk) { await api("/blocks/" + pk.action, { method: "POST", body: JSON.stringify({ value: false }) }); await loadBlocks(); toast("Blokir dibuka"); }
    } catch (e) { toast(e.message); }
  };
  const askPw = async (n = 0) => {  // ajakan ganti password: pilihan pemilik akun, tidak dipaksa, tidak mengganggu saat sedang sibuk
    const weak = localStorage.getItem("nova_weakpw") === "1", last = +localStorage.getItem("nova_pwask") || 0;
    if (weak ? Date.now() - last < 7 * 864e5 : last) return;
    const busy = !$("#room").hidden || document.querySelector(".dlg-back,.sc-back,.mv,.lock:not([hidden]),#sv:not([hidden]),#call:not([hidden]),#incoming:not([hidden])");
    if (busy) { if (n < 30) setTimeout(() => askPw(n + 1), 6000); return; }
    localStorage.setItem("nova_pwask", String(Date.now()));
    const r = await dialog({ title: weak ? "Password-mu masih pendek" : "Perkuat keamanan akunmu",
      desc: weak ? "Password akunmu kurang dari 8 karakter sehingga mudah ditebak. Mau ganti sekarang? Ini pilihanmu, kamu juga bisa menggantinya nanti di Profil." : "Kamu bisa mengganti password kapan saja di Profil. Mau ganti sekarang untuk keamanan lebih lanjut?",
      ok: null, cancel: "Nanti saja", actions: [{ key: "go", label: "Ganti password sekarang" }] });
    if (r && r.action === "go") changePassword();
  };
  setTimeout(askPw, 2500);

  /* ----- panel owner ----- */
  const ago = (t) => { if (!t) return "belum pernah"; const d = (Date.now() - Date.parse(t)) / 1000; if (d < 90) return "baru saja"; if (d < 3600) return Math.round(d / 60) + " mnt lalu"; if (d < 86400) return Math.round(d / 3600) + " jam lalu"; return Math.round(d / 86400) + " hari lalu"; };
  const dshort = (t) => (t ? new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "-");
  const adm = { stats: null };
  const AUDIT = { block: "memblokir", unblock: "membuka blokir", verify_on: "memberi centang biru", verify_off: "mencabut centang biru", delete_user: "menghapus akun", delete_room: "menghapus grup/saluran",
    banner: "mengubah banner", announce: "mengirim pengumuman", rbadge_blue: "memberi centang biru ke grup/saluran", rbadge_yellow: "memberi centang emas ke grup/saluran", rbadge_off: "mencabut centang grup/saluran", maint_on: "menyalakan mode perawatan", maint_off: "mematikan mode perawatan", warn: "memberi peringatan", mute_on: "membisukan", mute_off: "membuka bisu", report_selesai: "menyelesaikan laporan", report_diabaikan: "mengabaikan laporan", mod_on: "menjadikan moderator", mod_off: "mencabut moderator", cc_on: "memberi gelar Co-Chief", cc_off: "mencabut gelar Co-Chief",
    badge_red_on: "memberi centang merah", badge_red_off: "mencabut centang merah", badge_gray_on: "memberi centang abu-abu", badge_gray_off: "mencabut centang abu-abu", badge_yellow_on: "memberi centang kuning", badge_yellow_off: "mencabut centang kuning" };
  const BADGES = [["red", "merah"], ["gray", "abu-abu"], ["yellow", "kuning"]];
  const emptyLi = (t) => { const li = mk("li", t, "hint"); return li; };
  async function loadAdmin() {
    try {
      const q = $("#ausearch").value.trim();
      const own = !!me.is_owner;
      document.querySelectorAll("#admin [data-own]").forEach((e) => (e.hidden = !own));
      $("#aintro").textContent = own ? "Kamu masuk sebagai owner. Semua tindakan di sini dicek ulang oleh server dan dicatat." : "Kamu masuk sebagai moderator. Kamu bisa menangani laporan dan memblokir pengguna. Tindakanmu dicatat.";
      const [s, u, rp, r, sc, lg] = await Promise.all([api("/admin/stats"), api("/admin/users?q=" + encodeURIComponent(q)), api("/admin/reports"),
        api("/admin/rooms?q=" + encodeURIComponent($("#arsearch").value.trim())), own ? api("/admin/security") : { items: [] }, own ? api("/admin/audit") : { log: [] }]);
      adm.stats = s;
      $("#amstate").textContent = s.maint ? "Mode perawatan AKTIF: " + s.maint : "Mode perawatan mati. Pengguna biasa bisa memakai aplikasi.";
      api("/admin/activity").then((a) => {
        const bars = (el, arr, n, step) => {
          const map = new Map(arr.map((x) => [Math.floor(new Date(x.t).getTime() / step), x.n])), end = Math.floor(Date.now() / step), vals = [];
          for (let i = n - 1; i >= 0; i--) vals.push(map.get(end - i) || 0);
          const mx = Math.max(1, ...vals); el.replaceChildren(...vals.map((v) => { const b = mk("i"); b.style.height = Math.max(3, (v / mx) * 100) + "%"; b.title = String(v); return b; }));
        };
        bars($("#achart"), a.hours, 24, 3600000); bars($("#achart2"), a.days, 7, 86400000);
      }).catch(() => {});
      if (own) loadHealth();
      $("#aaudit").replaceChildren(...(lg.log.length ? lg.log.map((x) => row(null, x.actor_name + " · " + (AUDIT[x.action] || x.action), (x.detail ? x.detail + " · " : "") + (x.target ? x.target + " · " : "") + ago(x.t), () => {})) : [emptyLi("Belum ada catatan.")]));
      $("#areports").replaceChildren(...(rp.reports.length ? rp.reports.map((x) => row(null, x.target_name + " · " + (REASON[x.reason] || x.reason),
        x.reporter_name + " melapor · " + ago(x.t) + (x.count > 1 ? " · " + x.count + " laporan" : "") + (x.detail ? " · " + x.detail : ""), () => reportActions(x), { badge: x.blocked ? "BLOKIR" : "" })) : [emptyLi("Tidak ada laporan baru.")]));
      $("#asec").replaceChildren(...sc.items.map((x) => { const li = mk("li", null, "sitem " + (x.ok ? "ok" : "bad")); li.append(mk("b", (x.ok ? "✓ " : "✗ ") + x.name), mk("small", x.note)); return li; }));
      $("#astats").replaceChildren(...[["users", "Pengguna"], ["online", "Online"], ["new24", "Baru 24 jam"], ["msgs24", "Pesan 24 jam"], ["groups", "Grup"], ["channels", "Saluran"]].map(([k, l]) => { const c = mk("div", null, "astat"); c.append(mk("b", String(s[k])), mk("small", l)); return c; }));
      $("#ausers").replaceChildren(...(u.users.length ? u.users.map((x) => row(null, x.full_name, x.player_id + " · daftar " + dshort(x.created_at) + " · " + (x.online ? "online" : ago(x.last_seen)),
        () => userActions(x), { vb: x.badge, tag: x.owner ? "OWNER" : x.mod ? "MOD" : x.cc ? "CC" : "", badge: x.banned ? "BLOKIR" : "", online: x.online })) : [emptyLi("Tidak ada pengguna yang cocok.")]));
      $("#arooms").replaceChildren(...(r.rooms.length ? r.rooms.map((x) => row(null, x.name, (x.kind === "group" ? "Grup" : "Saluran") + " · " + x.count + " anggota · oleh " + x.owner, () => roomActions(x), { vb: x.bdg, tag: RB[x.bdg] || "", avEl: chAv(x.kind) })) : [emptyLi($("#arsearch").value.trim() ? "Tidak ada yang cocok." : "Belum ada grup atau saluran.")]));
    } catch (e) { toast(e.message); }
  }
  async function loadHealth() {
    try {
      const h = await api("/admin/health"), up = h.up > 3600 ? Math.floor(h.up / 3600) + " jam" : Math.ceil(h.up / 60) + " menit";
      const items = [["Database", h.ping < 400 ? "ok" : "bad", "respons " + h.ping + " ms"], ["Ukuran database", h.dbmb != null && h.dbmb < 400 ? "ok" : "bad", h.dbmb != null ? h.dbmb + " MB (batas gratis Neon 512 MB)" : "tidak terbaca"],
        ["Pesan suara", "ok", (h.vnmb != null ? h.vnmb + " MB" : "?") + " tersimpan"], ["Isi database", "ok", h.users + " akun, " + h.msgs + " pesan, " + h.media + " media"], ["Server aktif", "ok", up + " sejak mulai"]];
      $("#ahealth").replaceChildren(...items.map(([n, ok, note]) => { const li = mk("li", null, "sitem " + ok); li.append(mk("b", (ok === "ok" ? "✓ " : "✗ ") + n), mk("small", note)); return li; }));
    } catch (e) { toast(e.message); }
  }
  $("#ahrefresh").onclick = loadHealth;
  async function setMaint(on) {
    if (on && !(await dialog({ title: "Aktifkan mode perawatan?", desc: "Semua pengguna biasa langsung tidak bisa memakai aplikasi sampai kamu mematikannya. Staf tetap bisa masuk.", ok: "Aktifkan" }))) return;
    try { await api("/admin/maint", { method: "POST", body: JSON.stringify({ on, text: $("#amtext").value.trim() }) }); toast(on ? "Mode perawatan aktif" : "Mode perawatan mati"); loadAdmin(); } catch (e) { toast(e.message); }
  }
  $("#amon").onclick = () => setMaint(true); $("#amoff").onclick = () => setMaint(false);
  async function userActions(x) {
    const r = await dialog({ title: x.full_name, desc: "ID " + x.player_id + (x.banned ? " · sedang diblokir" : ""), ok: null, actions: [
      ...(me.is_owner ? [{ key: "verify", label: x.verified ? "Cabut centang biru" : "Beri centang biru" },
        ...BADGES.map(([c, l]) => ({ key: "badge_" + c, label: (x[c] ? "Cabut centang " : "Beri centang ") + l }))] : []),
      ...(x.owner || (!me.is_owner && x.mod) ? [] : [{ key: "warn", label: "Beri peringatan" + (x.warns ? " (sudah " + x.warns + ")" : "") }, { key: "mute", label: x.muted ? "Buka bisu" : "Bisukan" }]),
      ...(x.owner || (!me.is_owner && x.mod) ? [] : [{ key: "block", label: x.banned ? "Buka blokir" : "Blokir akun" }]),
      ...(me.is_owner && !x.owner ? [{ key: "mod", label: x.mod ? "Cabut peran moderator" : "Jadikan moderator" }, { key: "cc", label: x.cc ? "Cabut gelar Co-Chief" : "Jadikan Co-Chief" }, { key: "delete", label: "Hapus akun", danger: true }] : [])] });
    if (!r) return;
    try {
      if (r.action === "verify") await api("/admin/users/" + x.player_id + "/verify", { method: "POST", body: JSON.stringify({ value: !x.verified }) });
      else if (r.action.startsWith("badge_")) {
        const c = r.action.slice(6);
        await api("/admin/users/" + x.player_id + "/badge", { method: "POST", body: JSON.stringify({ color: c, value: !x[c] }) });
      }
      else if (r.action === "warn") {
        const w = await dialog({ title: "Peringatan untuk " + x.full_name, desc: "Dikirim ke chatnya sebagai pesan dari NOVA WAWA. Setiap 3 peringatan, dia otomatis dibisukan 24 jam.", fields: [{ name: "text", label: "Alasan", multiline: true, max: 300, required: true }], ok: "Kirim peringatan" });
        if (!w) return;
        await api("/admin/users/" + x.player_id + "/warn", { method: "POST", body: JSON.stringify({ text: w.text }) });
      }
      else if (r.action === "mute") {
        let mins = 0;
        if (!x.muted) {
          const m = await dialog({ title: "Bisukan " + x.full_name, desc: "Dia tidak bisa mengirim pesan, suara, atau polling. Masih bisa membaca.", ok: null, actions: [{ key: "15", label: "15 menit" }, { key: "60", label: "1 jam" }, { key: "1440", label: "1 hari" }, { key: "10080", label: "7 hari" }] });
          if (!m) return; mins = +m.action;
        }
        await api("/admin/users/" + x.player_id + "/mute", { method: "POST", body: JSON.stringify({ minutes: mins }) });
      }
      else if (r.action === "mod") {
        if (!x.mod && !(await dialog({ title: "Jadikan " + x.full_name + " moderator?", desc: "Moderator bisa menangani laporan dan memblokir pengguna. Dia tidak bisa menghapus akun, mengirim pengumuman, atau mengubah pengaturan. Semua tindakannya dicatat." + (x.cc ? " Ini akan mencabut gelar Co-Chief-nya." : ""), ok: "Jadikan moderator" }))) return;
        await api("/admin/users/" + x.player_id + "/role", { method: "POST", body: JSON.stringify({ value: !x.mod }) });
      }
      else if (r.action === "cc") {
        if (!x.cc && !(await dialog({ title: "Jadikan " + x.full_name + " Co-Chief?", desc: "Co-Chief cuma gelar/titel — tidak menambah kewenangan apa pun." + (x.mod ? " Ini akan mencabut peran moderator-nya." : ""), ok: "Jadikan Co-Chief" }))) return;
        await api("/admin/users/" + x.player_id + "/cc", { method: "POST", body: JSON.stringify({ value: !x.cc }) });
      }
      else if (r.action === "block") {
        if (!x.banned && !(await dialog({ title: "Blokir " + x.full_name + "?", desc: "Dia langsung tidak bisa masuk atau memakai aplikasi sampai blokirnya dibuka.", ok: "Blokir" }))) return;
        await api("/admin/users/" + x.player_id + "/block", { method: "POST", body: JSON.stringify({ value: !x.banned }) });
      } else if (r.action === "delete") {
        if (!(await dialog({ title: "Hapus akun " + x.full_name + "?", desc: "Akun, semua pesan, kontak, story, serta grup dan saluran miliknya dihapus permanen. Tidak bisa dibatalkan.", ok: "Hapus permanen" }))) return;
        await api("/admin/users/" + x.player_id, { method: "DELETE" });
      }
      toast("Berhasil"); loadAdmin();
    } catch (e) { toast(e.message); }
  }
  async function reportActions(x) {
    const r = await dialog({ title: "Laporan: " + x.target_name, desc: (REASON[x.reason] || x.reason) + " · dari " + x.reporter_name + (x.detail ? "\n" + x.detail : "") + "\nTotal laporan atas akun ini: " + x.count, ok: null, actions: [
      ...(x.blocked ? [] : [{ key: "block", label: "Blokir " + x.target_name, danger: true }]), { key: "selesai", label: "Tandai selesai" }, { key: "diabaikan", label: "Abaikan laporan" }] });
    if (!r) return;
    try {
      if (r.action === "block") await api("/admin/users/" + x.target + "/block", { method: "POST", body: JSON.stringify({ value: true }) });
      else await api("/admin/reports/" + x.id, { method: "POST", body: JSON.stringify({ status: r.action }) });
      toast("Berhasil"); loadAdmin();
    } catch (e) { toast(e.message); }
  }
  async function roomActions(x) {
    const jenis = x.kind === "group" ? "grup" : "saluran";
    const r = await dialog({ title: x.name, desc: jenis + " · " + x.count + " anggota", ok: null, actions: [{ key: "blue", label: x.bdg === "blue" ? "Centang biru (aktif)" : "Beri centang biru (resmi)" }, { key: "yellow", label: x.bdg === "yellow" ? "Centang emas (aktif)" : "Beri centang emas (pilihan)" },
      ...(x.bdg ? [{ key: "off", label: "Cabut centang" }] : []), ...(me.is_owner ? [{ key: "delete", label: "Hapus " + jenis, danger: true }] : [])] });
    if (!r) return;
    if (r.action !== "delete") { try { await api("/admin/rooms/" + x.id + "/badge", { method: "POST", body: JSON.stringify({ color: r.action === "off" ? "" : r.action }) }); toast("Berhasil"); loadAdmin(); loadRooms(); } catch (e) { toast(e.message); } return; }
    if (!(await dialog({ title: "Hapus " + x.name + "?", desc: "Semua pesan di dalamnya ikut terhapus permanen.", ok: "Hapus permanen" }))) return;
    try { await api("/admin/rooms/" + x.id, { method: "DELETE" }); toast("Dihapus"); loadAdmin(); loadRooms(); } catch (e) { toast(e.message); }
  }
  $("#abset").onclick = async () => {
    try {
      const r = await api("/admin/banner", { method: "POST", body: JSON.stringify({ text: $("#abanner").value.trim() }) });
      me.announce = r.announce; $("#annt").textContent = $("#annt2").textContent = r.announce; $("#abanner").value = r.announce; toast("Banner diperbarui");
    } catch (e) { toast(e.message); }
  };
  $("#abreset").onclick = () => { $("#abanner").value = ""; $("#abset").click(); };
  $("#acastgo").onclick = async () => {
    const text = $("#acast").value.trim();
    if (!text) return toast("Tulis isi pengumuman dulu.");
    if (!(await dialog({ title: "Kirim ke " + (adm.stats ? adm.stats.users : "semua") + " pengguna?", desc: "Pesan ini muncul di chat setiap pengguna sebagai pesan dari NOVA WAWA (akun resmi).", ok: "Kirim" }))) return;
    try { const r = await api("/admin/announce", { method: "POST", body: JSON.stringify({ text }) }); $("#acast").value = ""; toast("Terkirim ke " + r.sent + " pengguna"); } catch (e) { toast(e.message); }
  };
  let adT; $("#ausearch").oninput = $("#arsearch").oninput = () => { clearTimeout(adT); adT = setTimeout(loadAdmin, 350); };
  $("#admbtn").onclick = () => show("admin");

  let last = (await api("/poll")).last, t1 = Date.now(), t2 = Date.now();
  let pollT = null, polling = false;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !polling) { clearTimeout(pollT); pollTick(); } });
  async function pollTick() {
    if (document.hidden) { pollT = setTimeout(pollTick, 20000); return; }
    polling = true;  // tab disembunyikan: berhenti polling supaya database & server bisa istirahat (pesan yang terlewat diambil saat tab dibuka lagi)
    let wait = 50;
    const started = Date.now();
    try {
      const r = await api("/poll?after=" + last + "&wait=1", { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
      last = r.last;
      r.events.forEach((m) => {
        if (m.kind === "sig") return signal(m.sender, JSON.parse(m.body));
        const key = isRoom(m.to) ? m.to : m.sender;
        if (isRoom(key) && !roomOf(key)) loadRooms();
        if (st.cur === key && !$("#room").hidden) addMsg(m);
        else { st.last[key] = m.body; st.lastT[key] = m.t; st.unread[key] = (st.unread[key] || 0) + 1; }
        render();
      });
      if (!r.events.length && Date.now() - started < 1500) wait = 1200;  // server lama tanpa long-poll: jangan membanjiri
      const now = Date.now();
      if (now - t1 > 60000) { t1 = now; loadStories(); loadContacts(); loadChats(); }
      if (now - t2 > 15000) { t2 = now; loadPresence(); }
    } catch (e) { wait = 2500; }
    polling = false;
    pollT = setTimeout(pollTick, wait);
  }
  pollTick();
}

function splash() {
  try { if (sessionStorage.getItem("nova_splash")) return; sessionStorage.setItem("nova_splash", "1"); } catch {}
  const d = document.createElement("div"), im = document.createElement("img"), t = document.createElement("b");
  d.className = "splash"; im.src = "logo.png"; im.alt = ""; im.onerror = () => im.remove(); t.textContent = "NOVA WAWA";
  d.append(im, t); document.body.append(d);
  setTimeout(() => d.classList.add("out"), 1100); setTimeout(() => d.remove(), 1500);
}

function startGridCanvas() {
  const cv = $("#grid-bg"); if (!cv) return;
  const ctx = cv.getContext("2d");
  let W, H, raf;
  function resize() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
  resize(); window.addEventListener("resize", resize);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const speed = reduced ? 0 : t * 0.3;
    const vp = H * 0.58;  // titik lenyap perspektif
    const cols = 10, rows = 14;
    ctx.strokeStyle = "rgba(120,60,220,0.22)"; ctx.lineWidth = 1;
    // garis horizontal (menjauh ke atas)
    for (let r = 0; r <= rows; r++) {
      const prog = (r / rows + speed * 0.004) % 1;
      const y = vp + (H - vp) * Math.pow(prog, 1.6);
      const xSpread = W * 0.5 * prog;
      ctx.beginPath(); ctx.moveTo(W / 2 - xSpread, y); ctx.lineTo(W / 2 + xSpread, y); ctx.stroke();
    }
    // garis vertikal
    for (let c = 0; c <= cols; c++) {
      const xRatio = c / cols;
      const xBottom = W * xRatio;
      const xTop = W / 2 + (xRatio - 0.5) * W * 0.02;
      ctx.beginPath(); ctx.moveTo(xTop, vp); ctx.lineTo(xBottom, H); ctx.stroke();
    }
    if (!reduced) { t++; raf = requestAnimationFrame(draw); }
  }
  draw();
  return () => cancelAnimationFrame(raf);
}

function spotlightLoop(el, text) {
  if (!el) return;
  el.setAttribute("aria-label", text);
  el.innerHTML = "";
  const words = text.split(" ");
  const spans = [];
  words.forEach((w, i) => {
    if (i > 0) el.append(document.createTextNode(" "));
    const s = document.createElement("span");
    s.className = "tw-word";
    s.textContent = w;
    el.append(s);
    spans.push(s);
  });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { spans.forEach((s) => s.classList.add("tw-active")); return; }
  // bingkai sudut (viewfinder) yang berpindah dari kata ke kata
  const frame = document.createElement("div");
  frame.className = "tw-frame";
  frame.innerHTML = '<i class="tw-c tw-tl"></i><i class="tw-c tw-tr"></i><i class="tw-c tw-bl"></i><i class="tw-c tw-br"></i>';
  el.append(frame);
  let i = -1, timer = null;
  const place = (s) => {
    const er = el.getBoundingClientRect(), sr = s.getBoundingClientRect();
    frame.style.left = (sr.left - er.left - 8) + "px";
    frame.style.top = (sr.top - er.top - 5) + "px";
    frame.style.width = (sr.width + 16) + "px";
    frame.style.height = (sr.height + 10) + "px";
  };
  const tick = () => {
    i = (i + 1) % spans.length;
    spans.forEach((s, idx) => s.classList.toggle("tw-active", idx === i));
    place(spans[i]);
  };
  const start = () => { if (timer) return; tick(); frame.classList.add("on"); timer = setInterval(tick, 650); };
  const stop = () => { clearInterval(timer); timer = null; };
  start();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") stop(); else start(); });
  window.addEventListener("resize", () => { if (i >= 0) place(spans[i]); });
}

function initLanding() {
  startGridCanvas();
  if (getToken()) { const e = $("#enter"); if (e) { e.href = "dashboard.html"; e.textContent = "BUKA APLIKASI"; } }
  spotlightLoop(document.querySelector(".ltitle"), "SELAMAT DATANG DI WEBSITE NOVA WAWA");
}

function initAbout() {
  startGridCanvas();
}

document.querySelectorAll("img.logo").forEach((i) => i.addEventListener("error", () => (i.style.display = "none")));
function initForgot() {
  const f = $("#f-form"), msg = $("#msg");
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const b = f.querySelector("button"); b.disabled = true; msg.className = "msg"; msg.textContent = "";
    try {
      await api("/forgot", { method: "POST", body: JSON.stringify({ email: f.email.value }) });
      msg.className = "msg okmsg"; msg.textContent = "Kalau emailmu terdaftar, tautan untuk membuat password baru sudah dikirim. Cek kotak masuk dan folder spam.";
    } catch (err) { msg.textContent = err.message; }
    b.disabled = false;
  });
}
function initReset() {
  const t = new URLSearchParams(location.search).get("t") || "", f = $("#r-form"), msg = $("#msg");
  if (!t) { msg.textContent = "Tautan tidak lengkap. Minta tautan baru."; f.hidden = true; return; }
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); msg.className = "msg"; msg.textContent = "";
    if (f.p1.value !== f.p2.value) { msg.textContent = "Password baru dan ulangannya tidak sama."; return; }
    const b = f.querySelector("button"); b.disabled = true;
    try {
      await api("/reset", { method: "POST", body: JSON.stringify({ token: t, password: f.p1.value }) });
      localStorage.removeItem("nova_token"); msg.className = "msg okmsg"; msg.textContent = "Password berhasil diganti. Silakan masuk dengan password baru."; f.hidden = true; $("#toLogin").hidden = false;
    } catch (err) { msg.textContent = err.message; b.disabled = false; }
  });
}
async function initVerify() {
  const t = new URLSearchParams(location.search).get("t") || "", msg = $("#msg");
  try { await api("/email/verify", { method: "POST", body: JSON.stringify({ token: t }) }); msg.className = "msg okmsg"; msg.textContent = "Email berhasil diverifikasi. Terima kasih!"; }
  catch (err) { msg.className = "msg"; msg.textContent = err.message; }
}

const page = document.body.dataset.page;
if (page === "dashboard") splash();
if (page === "landing") initLanding();
if (page === "about") initAbout();
if (page === "login") initLogin();
if (page === "forgot") initForgot();
if (page === "reset") initReset();
if (page === "verify") initVerify();
if (page === "dashboard") initDashboard();
