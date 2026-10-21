const $ = (s) => document.querySelector(s);
const getToken = () => localStorage.getItem("nova_token");

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
    if (res.status === 403 && data.banned) {  // akun diblokir owner: keluar dan tampilkan alasannya di halaman masuk
      localStorage.removeItem("nova_token"); try { sessionStorage.setItem("nova_notice", data.error); } catch {}
      if (!/login/.test(location.pathname)) location.href = "login.html";
    }
    throw new Error(data.error || "Terjadi kesalahan");
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
  const lastText = (b) => { const k = medOf(b); return k ? (k.kind === "video" ? "Video" : "Foto") + (k.once ? " 1x lihat" : "") : stkId(b) ? "Stiker" : b; };
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
  const hasStory = (p) => st.stories.some((s) => s.owner === p);
  const send = (to, kind, body, reply) => api("/send", { method: "POST", body: JSON.stringify(reply ? { to, kind, body, reply } : { to, kind, body }) });
  const chAv = (k, img, nm) => { const g = safeImg(img); if (g) return av(nm || "?", g); const e = mk("div", null, "av ico " + k); e.append(ic(k === "group" ? "users" : "channel")); return e; };
  const row = (img, name, sub, onclick, o = {}) => {
    const li = mk("li", null, "item"), box = mk("div", null, "txt"), w = mk("div", null, "avw");
    const nb = mk("b", name);
    if (o.verified) nb.append(ic("seal"));
    if (o.tag) nb.append(mk("i", o.tag, "own"));
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
    st.screen = id; if (id !== "room" && id !== "explore" && id !== "admin") st.tab = id;
    SCREENS.forEach((s) => ($("#" + s).hidden = s !== id));
    if (TITLES[id]) {
      $("#htitle").textContent = TITLES[id]; $("#top").classList.toggle("c", id !== "home");
      $("#clock").hidden = id !== "home"; $("#hback").hidden = !["explore", "admin"].includes(id); $("#hnew").hidden = id !== "upd";
    }
    $("#fab").hidden = !["home", "upd"].includes(id); $("#fabt").hidden = id !== "upd";
    $(".nav").hidden = id === "room" || id === "explore";
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.s === (id === "explore" ? "upd" : id === "admin" ? "profile" : id)));
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
    const E = st.contacts.map((c) => ({ p: c.player_id, n: c.full_name, i: c.avatar, k: "dm", v: c.verified, tag: c.owner ? "OWNER" : c.mod ? "MOD" : "" }));
    st.rooms.filter((r) => r.kind === "group" || r.joined).forEach((r) => E.push({ p: "R-" + r.id, n: r.name, k: r.kind, i: r.avatar }));
    Object.keys(st.last).forEach((k) => { if (!isRoom(k) && !saved(k) && k !== me.player_id) E.push({ p: k, n: nameOf(k), i: imgOf(k), k: "dm", v: k === OFFICIAL, tag: k === OFFICIAL ? "RESMI" : "" }); });
    const F = E.filter((e) => (st.filter === "all" || e.k === st.filter) && (e.n + e.p).toLowerCase().includes(q))
      .sort((a, b) => (Date.parse(st.lastT[b.p]) || 0) - (Date.parse(st.lastT[a.p]) || 0));
    $("#empty-list").hidden = F.length > 0;
    $("#empty-list").textContent = E.length ? "Tidak ada chat yang cocok." : "Belum ada chat. Tap + lalu masukkan ID temanmu untuk menyimpannya.";
    $("#list").replaceChildren(...F.map((e) => row(e.i, e.n, lastText(st.last[e.p]) || (e.k === "dm" ? e.p : e.k === "group" ? "Grup" : "Saluran"), () => open(e.p),
      { time: st.lastT[e.p] ? short(st.lastT[e.p]) : "", badge: st.unread[e.p] || "", verified: e.v, tag: e.tag, avEl: e.k === "dm" ? null : chAv(e.k, e.i, e.n), online: e.k === "dm" && !!(st.seen[e.p] && st.seen[e.p].online) })));

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
      { avEl: chAv("channel", r.avatar, r.name), badge: r.owner === me.player_id ? "ADMIN" : st.unread["R-" + r.id] || "", icon: r.joined ? null : ic("plus", "pbtn") });
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
    $("#pver").toggleAttribute("hidden", !me.verified); $("#pown").hidden = !(me.owner || me.mod); $("#pown").textContent = me.owner ? "OWNER" : "MOD"; $("#admbtn").hidden = !me.is_staff; $("#admtitle").textContent = me.is_owner ? "Panel Owner" : "Panel Moderator"; $("#admsub").textContent = me.is_owner ? "Kelola pengguna, banner, laporan, dan pengumuman" : "Tangani laporan dan blokir pengguna"; $("#pvb").toggleAttribute("hidden", !me.verified); $("#copysub").textContent = me.player_id;
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
    el.textContent = s ? (s.online ? "online" : "terakhir dilihat " + fmt(s.seen)) : st.cur;
  }
  /* ----- balas pesan: kutipan di gelembung, bar balasan, menu tekan-lama, geser ke kanan ----- */
  st.replyTo = null;
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
  async function bubbleMenu(d) {
    const m = d._m; if (!m || menuBusy) return;
    menuBusy = true;
    try {
      const plain = !stkId(m.body) && !medOf(m.body), acts = [];
      if (!$("#form").hidden) acts.push({ key: "reply", label: "Balas" });
      if (plain) acts.push({ key: "copy", label: "Salin teks" });
      if (!acts.length) return;
      const a = await dialog({ title: m.sender === me.player_id ? "Pesanmu" : nameOf(m.sender), desc: lastText(m.body).slice(0, 120), ok: null, actions: acts });
      if (!a) return;
      if (a.action === "reply") setReply(m);
      else if (a.action === "copy") navigator.clipboard.writeText(m.body).then(() => toast("Teks disalin"), () => toast("Tidak bisa menyalin teks"));
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
    const r = roomOf(st.cur || ""), sid = stkId(m.body), md = medOf(m.body), d = mk("div", null, "bub " + (mine ? "out" : "in") + (sid ? " sticker" : "") + (md ? " media" : "")), box = mk("div"), mt = mk("div", null, "mt");
    if (!mine && r && r.kind === "group") box.append(mk("small", nameOf(m.sender), "who"));
    if (m.reply) box.append(quoteEl(m.reply));
    if (sid) { const im = mk("img", null, "smsg"); im.src = m.local || "/api/stickers/" + sid; im.alt = "Stiker"; box.append(im); }
    else if (md) box.append(...mediaBox(m, md));
    else box.append(mk("span", m.body));
    mt.append(mk("time", tm(m.t)));
    if (mine) { d.dataset.to = m.to; d.dataset.t = m.t; mt.append(tick(m)); }
    d.append(box, mt);
    d._m = m; if (m.id) d.dataset.id = m.id; bubbleGestures(d);
    $("#msgs").append(d); $("#msgs").scrollTop = 1e9;
    return d;
  }
  async function open(p) {
    clearReply(); st.cur = p; st.unread[p] = 0;
    const r = roomOf(p);
    $("#rtitle").textContent = nameOf(p);
    const ct = contact(p); if (ct && ct.owner) $("#rtitle").append(mk("i", "OWNER", "own")); if (p === OFFICIAL) $("#rtitle").append(mk("i", "RESMI", "own"));
    $("#rav").replaceChildren(r ? chAv(r.kind, r.avatar, r.name) : av(nameOf(p), imgOf(p)));
    $("#rid").className = ""; $("#rid").textContent = r ? (r.kind === "group" ? "Grup" : "Saluran · " + r.count + " pengikut") : p;
    roomSub(); $("#tray").hidden = true;
    $("#savebtn").hidden = !!r || saved(p) || p === OFFICIAL; $("#morebtn").hidden = p === OFFICIAL; $("#vbtn").hidden = $("#abtn").hidden = !!r || p === OFFICIAL;
    $("#form").hidden = (!!r && r.kind === "channel" && r.owner !== me.player_id) || p === OFFICIAL;
    $("#msgs").replaceChildren(); show("room");
    (await api("/history?peer=" + encodeURIComponent(p))).messages.forEach(addMsg);
    render();
  }
  $("#back").onclick = () => { st.cur = null; show(st.tab); };
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
  const upd = () => { const has = $("#text").value.trim().length > 0; $("#sendb").hidden = !has; $("#mic").hidden = has; };
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
    const r = await dialog({ title: "Ubah status", fields: [{ name: "s", label: "Status kamu", value: me.status || "", max: 80, placeholder: "Contoh: sibuk" }], ok: "Simpan" });
    if (r) saveProfile({ status: r.s });
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
  await Promise.all([loadContacts(), loadRooms(), loadStories(), loadChats(), loadPresence(), loadBlocks()]);
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
  $("#legalbtn").onclick = () => window.open("terms.html", "_blank", "noopener");
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
  const openFromHash = () => { const m = /^#chat=(.+)$/.exec(location.hash); if (m) { history.replaceState(null, "", location.pathname); open(decodeURIComponent(m[1])); } };
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { const m = /#chat=(.+)$/.exec((e.data && e.data.url) || ""); if (e.data && e.data.type === "open" && m) open(decodeURIComponent(m[1])); });
  setTimeout(openFromHash, 700);
  st.blocked = new Set();
  async function loadBlocks() { try { st.blocked = new Set((await api("/blocks")).blocks.map((b) => b.player_id)); } catch {} }
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
      const canKick = r.kind === "group" && r.owner === me.player_id;
      const nm = (m) => m.full_name + (m.room_owner ? " (pemilik)" : "") + (m.player_id === me.player_id ? " (kamu)" : "");
      if (!canKick) return dialog({ title: "Anggota (" + members.length + ")", desc: members.map(nm).join("\n"), ok: null });
      const others = members.filter((m) => m.player_id !== me.player_id);
      const pk = await dialog({ title: "Anggota (" + members.length + ")", desc: others.length ? "Pilih anggota untuk mengeluarkannya dari grup." : "Belum ada anggota lain di grup ini.", ok: null,
        actions: others.map((m) => ({ key: m.player_id, label: "Keluarkan: " + m.full_name })) });
      if (!pk) return;
      const who = others.find((m) => m.player_id === pk.action); if (!who) return;
      if (!(await dialog({ title: "Keluarkan " + who.full_name + "?", desc: "Dia tidak bisa lagi membaca atau mengirim pesan di grup ini. Anggota lain melihat pemberitahuannya.", ok: "Keluarkan" }))) return;
      await api("/rooms/" + r.id + "/kick", { method: "POST", body: JSON.stringify({ player_id: who.player_id }) });
      toast(who.full_name + " dikeluarkan"); loadRooms();
      if (st.cur === "R-" + r.id) { $("#msgs").replaceChildren(); (await api("/history?peer=" + encodeURIComponent(st.cur))).messages.forEach(addMsg); }
    } catch (e) { toast(e.message); }
  }
  async function roomMenu(r) {
    const grp = r.kind === "group", jenis = grp ? "grup" : "saluran", mineOwner = r.owner === me.player_id;
    const acts = [{ key: "members", label: "Lihat anggota" }];
    if (mineOwner) acts.push({ key: "edit", label: "Ganti nama dan deskripsi" }, { key: "photo", label: "Ganti foto " + jenis });
    if (mineOwner && r.avatar) acts.push({ key: "rmphoto", label: "Hapus foto " + jenis });
    if (grp || !mineOwner) acts.push({ key: "leave", label: grp ? "Keluar dari grup" : "Berhenti mengikuti", danger: true });
    const a = await dialog({ title: r.name, desc: jenis + " · " + r.count + " anggota" + (r.about ? "\n" + r.about : ""), ok: null, actions: acts });
    if (!a) return;
    if (a.action === "members") return showMembers(r);
    if (a.action === "edit") {
      const f = await dialog({ title: "Ubah " + jenis, fields: [{ name: "name", label: "Nama " + jenis, value: r.name, max: 60, required: true }, { name: "about", label: "Deskripsi (opsional)", value: r.about || "", max: 200 }], ok: "Simpan" });
      if (f) editRoom(r, { name: f.name, about: f.about });
    } else if (a.action === "photo") {
      const img = await pick(160, 0.75, 55000); editRoom(r, { avatar: img }, "Foto diperbarui");
    } else if (a.action === "rmphoto") editRoom(r, { avatar: "" }, "Foto dihapus");
    else if (a.action === "leave") {
      const warn = grp && mineOwner ? "Kamu pemilik grup ini. Anggota paling lama akan jadi pemilik baru, dan kalau tidak ada anggota lain, grup dihapus." : "Kamu tidak akan menerima pesan dari " + jenis + " ini lagi.";
      if (!(await dialog({ title: (grp ? "Keluar dari " : "Berhenti mengikuti ") + r.name + "?", desc: warn, ok: grp ? "Keluar" : "Berhenti" }))) return;
      try { await api("/rooms/" + r.id + "/leave", { method: "POST" }); st.cur = null; show(st.tab); loadRooms(); toast(grp ? "Kamu keluar dari grup" : "Tidak lagi mengikuti"); } catch (e) { toast(e.message); }
    }
  }
  $("#morebtn").onclick = async () => {
    const p = st.cur; if (p && isRoom(p)) { const r = roomOf(p); if (r) roomMenu(r); return; }
    if (!p || p === OFFICIAL) return;
    const was = st.blocked.has(p);
    const r = await dialog({ title: nameOf(p), desc: "ID " + p, ok: null, actions: [{ key: "blk", label: was ? "Buka blokir" : "Blokir pengguna", danger: !was }, { key: "rep", label: "Laporkan pengguna" }] });
    if (!r) return;
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
    banner: "mengubah banner", announce: "mengirim pengumuman", report_selesai: "menyelesaikan laporan", report_diabaikan: "mengabaikan laporan", mod_on: "menjadikan moderator", mod_off: "mencabut moderator" };
  const emptyLi = (t) => { const li = mk("li", t, "hint"); return li; };
  async function loadAdmin() {
    try {
      const q = $("#ausearch").value.trim();
      const own = !!me.is_owner;
      document.querySelectorAll("#admin [data-own]").forEach((e) => (e.hidden = !own));
      $("#aintro").textContent = own ? "Kamu masuk sebagai owner. Semua tindakan di sini dicek ulang oleh server dan dicatat." : "Kamu masuk sebagai moderator. Kamu bisa menangani laporan dan memblokir pengguna. Tindakanmu dicatat.";
      const [s, u, rp, r, sc, lg] = await Promise.all([api("/admin/stats"), api("/admin/users?q=" + encodeURIComponent(q)), api("/admin/reports"),
        own ? api("/admin/rooms") : { rooms: [] }, own ? api("/admin/security") : { items: [] }, own ? api("/admin/audit") : { log: [] }]);
      adm.stats = s;
      $("#aaudit").replaceChildren(...(lg.log.length ? lg.log.map((x) => row(null, x.actor_name + " · " + (AUDIT[x.action] || x.action), (x.detail ? x.detail + " · " : "") + (x.target ? x.target + " · " : "") + ago(x.t), () => {})) : [emptyLi("Belum ada catatan.")]));
      $("#areports").replaceChildren(...(rp.reports.length ? rp.reports.map((x) => row(null, x.target_name + " · " + (REASON[x.reason] || x.reason),
        x.reporter_name + " melapor · " + ago(x.t) + (x.count > 1 ? " · " + x.count + " laporan" : "") + (x.detail ? " · " + x.detail : ""), () => reportActions(x), { badge: x.blocked ? "BLOKIR" : "" })) : [emptyLi("Tidak ada laporan baru.")]));
      $("#asec").replaceChildren(...sc.items.map((x) => { const li = mk("li", null, "sitem " + (x.ok ? "ok" : "bad")); li.append(mk("b", (x.ok ? "✓ " : "✗ ") + x.name), mk("small", x.note)); return li; }));
      $("#astats").replaceChildren(...[["users", "Pengguna"], ["online", "Online"], ["new24", "Baru 24 jam"], ["msgs24", "Pesan 24 jam"], ["groups", "Grup"], ["channels", "Saluran"]].map(([k, l]) => { const c = mk("div", null, "astat"); c.append(mk("b", String(s[k])), mk("small", l)); return c; }));
      $("#ausers").replaceChildren(...(u.users.length ? u.users.map((x) => row(null, x.full_name, x.player_id + " · daftar " + dshort(x.created_at) + " · " + (x.online ? "online" : ago(x.last_seen)),
        () => userActions(x), { verified: x.verified, tag: x.owner ? "OWNER" : x.mod ? "MOD" : "", badge: x.banned ? "BLOKIR" : "", online: x.online })) : [emptyLi("Tidak ada pengguna yang cocok.")]));
      $("#arooms").replaceChildren(...(r.rooms.length ? r.rooms.map((x) => row(null, x.name, (x.kind === "group" ? "Grup" : "Saluran") + " · " + x.count + " anggota · oleh " + x.owner, () => roomActions(x), { avEl: chAv(x.kind) })) : [emptyLi("Belum ada grup atau saluran.")]));
    } catch (e) { toast(e.message); }
  }
  async function userActions(x) {
    const r = await dialog({ title: x.full_name, desc: "ID " + x.player_id + (x.banned ? " · sedang diblokir" : ""), ok: null, actions: [
      ...(me.is_owner ? [{ key: "verify", label: x.verified ? "Cabut centang biru" : "Beri centang biru" }] : []),
      ...(x.owner || (!me.is_owner && x.mod) ? [] : [{ key: "block", label: x.banned ? "Buka blokir" : "Blokir akun" }]),
      ...(me.is_owner && !x.owner ? [{ key: "mod", label: x.mod ? "Cabut peran moderator" : "Jadikan moderator" }, { key: "delete", label: "Hapus akun", danger: true }] : [])] });
    if (!r) return;
    try {
      if (r.action === "verify") await api("/admin/users/" + x.player_id + "/verify", { method: "POST", body: JSON.stringify({ value: !x.verified }) });
      else if (r.action === "mod") {
        if (!x.mod && !(await dialog({ title: "Jadikan " + x.full_name + " moderator?", desc: "Moderator bisa menangani laporan dan memblokir pengguna. Dia tidak bisa menghapus akun, mengirim pengumuman, atau mengubah pengaturan. Semua tindakannya dicatat.", ok: "Jadikan moderator" }))) return;
        await api("/admin/users/" + x.player_id + "/role", { method: "POST", body: JSON.stringify({ value: !x.mod }) });
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
    const r = await dialog({ title: x.name, desc: jenis + " · " + x.count + " anggota", ok: null, actions: [{ key: "delete", label: "Hapus " + jenis, danger: true }] });
    if (!r) return;
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
  let adT; $("#ausearch").oninput = () => { clearTimeout(adT); adT = setTimeout(loadAdmin, 350); };
  $("#admbtn").onclick = () => show("admin");

  let last = (await api("/poll")).last, t1 = Date.now(), t2 = Date.now();
  (async function tick() {
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
    setTimeout(tick, wait);
  })();
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

function wordRevealEffect(el, text) {
  if (!el) return;
  el.setAttribute("aria-label", text);
  el.innerHTML = "";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { el.textContent = text; return; }
  const words = text.split(" ");
  const spans = [];
  // render semua kata sekaligus tapi dim, lalu spotlight satu per satu
  words.forEach((w, i) => {
    if (i > 0) { const sp = document.createElement("span"); sp.textContent = " "; sp.className = "tw-sp"; el.append(sp); }
    const s = document.createElement("span");
    s.className = "tw-word tw-dim";
    s.textContent = w;
    el.append(s);
    spans.push(s);
  });
  // highlight tiap kata bergantian, lalu setelah selesai semua terang permanen
  let i = 0;
  const step = () => {
    if (i > 0) spans[i-1].className = "tw-word tw-done";
    if (i < spans.length) {
      spans[i].className = "tw-word tw-active";
      i++;
      setTimeout(step, 320);
    } else {
      spans.forEach(s => s.className = "tw-word tw-done");
    }
  };
  setTimeout(step, 200);
}

function initLanding() {
  startGridCanvas();
  if (getToken()) { const e = $("#enter"); if (e) { e.href = "dashboard.html"; e.textContent = "BUKA APLIKASI"; } }
  wordRevealEffect(document.querySelector(".ltitle"), "SELAMAT DATANG DI WEBSITE NOVA WAWA");
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
