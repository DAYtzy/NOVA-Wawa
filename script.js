const $ = (s) => document.querySelector(s);
const getToken = () => localStorage.getItem("nova_token");

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (getToken()) headers.Authorization = "Bearer " + getToken();
  const res = await fetch("/api" + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Terjadi kesalahan");
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
  const lv = $("#lv");
  if (lv) { if (matchMedia("(prefers-reduced-motion: reduce)").matches) lv.pause(); else lv.play().catch(() => {}); }
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
  const av = (n, img) => { const e = mk("div", img ? "" : (n[0] || "?").toUpperCase(), "av"); e.style.background = img ? "url(" + img + ") center/cover" : "hsl(" + hue(n) + ",85%,78%)"; return e; };
  const toast = (msg) => {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = mk("div", msg, "toast"); t.setAttribute("role", "status"); document.body.append(t);
    setTimeout(() => t.remove(), 3600);
  };
  /* Kotak dialog bergaya NOVA, pengganti prompt() bawaan browser. Hasil: objek isian, atau null kalau dibatalkan. */
  function dialog({ title, desc, fields = [], contacts = null, ok = "Simpan" }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const back = mk("div", null, "dlg-back"), box = mk("div", null, "dlg"), form = mk("form");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "dlg-t");
      const h = mk("h2", title); h.id = "dlg-t"; form.append(h);
      if (desc) form.append(mk("p", desc, "dlg-d"));
      const els = {};
      fields.forEach((f) => {
        const lab = mk("label"), inp = mk(f.multiline ? "textarea" : "input");
        inp.value = f.value || ""; inp.placeholder = f.placeholder || ""; inp.autocomplete = "off";
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
      const row = mk("div", null, "dlg-b"), no = mk("button", "Batal", "btn ghost"), yes = mk("button", ok, "btn");
      no.type = "button"; yes.type = "submit"; row.append(no, yes); form.append(row);
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
          out[f.name] = els[f.name].value.trim();
          if (f.required && !out[f.name]) { err.textContent = f.label + " wajib diisi."; els[f.name].focus(); return; }
        }
        out.members = checks.filter((c) => c.checked).map((c) => c.value);
        done(out);
      };
      const first = form.querySelector("input,textarea"); if (first) first.focus();
    });
  }
  const isRoom = (p) => p.startsWith("R-");
  const roomOf = (p) => st.rooms.find((r) => "R-" + r.id === p);
  const contact = (p) => st.contacts.find((c) => c.player_id === p);
  const saved = (p) => !!contact(p);
  const nameOf = (p) => (p === me.player_id ? me.full_name : isRoom(p) ? (roomOf(p) || { name: "Grup" }).name : (contact(p) || { full_name: p }).full_name);
  const imgOf = (p) => (p === me.player_id ? me.avatar : (contact(p) || {}).avatar);
  const fmt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const NS = "http://www.w3.org/2000/svg";
  const ic = (n, cls) => { const s = document.createElementNS(NS, "svg"), u = document.createElementNS(NS, "use"); s.setAttribute("class", "ic" + (cls ? " " + cls : "")); u.setAttribute("href", "#i-" + n); s.append(u); return s; };
  const tm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const short = (t) => (new Date(t).toDateString() === new Date().toDateString() ? tm(t) : new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }));
  const hasStory = (p) => st.stories.some((s) => s.owner === p);
  const send = (to, kind, body) => api("/send", { method: "POST", body: JSON.stringify({ to, kind, body }) });
  const chAv = (k) => { const e = mk("div", null, "av ico " + k); e.append(ic(k === "group" ? "users" : "channel")); return e; };
  const row = (img, name, sub, onclick, o = {}) => {
    const li = mk("li", null, "item"), box = mk("div", null, "txt"), w = mk("div", null, "avw");
    const nb = mk("b", name);
    if (o.verified) nb.append(ic("seal"));
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

  const SCREENS = ["home", "upd", "calls", "profile", "room", "explore"];
  const loaders = { upd: () => { loadStories(); loadRooms(); }, calls: loadCalls, explore: loadRooms };
  const TITLES = { home: "NOVA WAWA", upd: "Pembaruan", calls: "Panggilan", profile: "Profil", explore: "Cari Saluran" };
  function show(id) {
    if (id !== "room" && id !== "explore") st.tab = id;
    SCREENS.forEach((s) => ($("#" + s).hidden = s !== id));
    if (TITLES[id]) {
      $("#htitle").textContent = TITLES[id]; $("#top").classList.toggle("c", id !== "home");
      $("#clock").hidden = id !== "home"; $("#hback").hidden = id !== "explore"; $("#hnew").hidden = id !== "upd";
    }
    $("#fab").hidden = !["home", "upd"].includes(id); $("#fabt").hidden = id !== "upd";
    $(".nav").hidden = id === "room" || id === "explore";
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.s === (id === "explore" ? "upd" : id)));
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
    const E = st.contacts.map((c) => ({ p: c.player_id, n: c.full_name, i: c.avatar, k: "dm", v: c.verified }));
    st.rooms.filter((r) => r.kind === "group" || r.joined).forEach((r) => E.push({ p: "R-" + r.id, n: r.name, k: r.kind }));
    Object.keys(st.last).forEach((k) => { if (!isRoom(k) && !saved(k) && k !== me.player_id) E.push({ p: k, n: k, k: "dm" }); });
    const F = E.filter((e) => (st.filter === "all" || e.k === st.filter) && (e.n + e.p).toLowerCase().includes(q))
      .sort((a, b) => (Date.parse(st.lastT[b.p]) || 0) - (Date.parse(st.lastT[a.p]) || 0));
    $("#empty-list").hidden = F.length > 0;
    $("#empty-list").textContent = E.length ? "Tidak ada chat yang cocok." : "Belum ada chat. Tap + lalu masukkan ID temanmu untuk menyimpannya.";
    $("#list").replaceChildren(...F.map((e) => row(e.i, e.n, st.last[e.p] || (e.k === "dm" ? e.p : e.k === "group" ? "Grup" : "Saluran"), () => open(e.p),
      { time: st.lastT[e.p] ? short(st.lastT[e.p]) : "", badge: st.unread[e.p] || "", verified: e.v, avEl: e.k === "dm" ? null : chAv(e.k), online: e.k === "dm" && !!(st.seen[e.p] && st.seen[e.p].online) })));

    /* Pembaruan: kartu status */
    const card = (o, label, onclick) => {
      const l = st.stories.filter((s) => s.owner === o), s = l[l.length - 1], b = mk("button", null, "sc");
      if (!s) b.classList.add("empty");
      else if (s.kind === "img") b.style.backgroundImage = 'url("' + s.body + '")';
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
      { avEl: chAv("channel"), badge: r.owner === me.player_id ? "ADMIN" : st.unread["R-" + r.id] || "", icon: r.joined ? null : ic("plus", "pbtn") });
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
    $("#pcover").style.backgroundImage = me.cover ? 'url("' + me.cover + '")' : "";
    $("#pver").toggleAttribute("hidden", !me.verified); $("#pvb").toggleAttribute("hidden", !me.verified); $("#copysub").textContent = me.player_id;
    $("#swpub").setAttribute("aria-checked", String(me.public !== false)); $("#swseen").setAttribute("aria-checked", String(me.show_seen !== false));
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
  async function loadPresence() { try { st.seen = (await api("/presence")).presence; refreshTicks(); roomSub(); render(); } catch {} }
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
    const s = st.seen[st.cur], el = $("#rid");
    el.className = s && s.online ? "on" : "";
    el.textContent = s ? (s.online ? "online" : "terakhir dilihat " + fmt(s.seen)) : st.cur;
  }
  function addMsg(m) {
    const mine = m.sender === me.player_id, key = isRoom(m.to) || mine ? m.to : m.sender;
    st.last[key] = m.body; st.lastT[key] = m.t;
    const r = roomOf(st.cur || ""), d = mk("div", null, "bub " + (mine ? "out" : "in")), box = mk("div"), mt = mk("div", null, "mt");
    if (!mine && r && r.kind === "group") box.append(mk("small", nameOf(m.sender), "who"));
    box.append(mk("span", m.body));
    mt.append(mk("time", tm(m.t)));
    if (mine) { d.dataset.to = m.to; d.dataset.t = m.t; mt.append(tick(m)); }
    d.append(box, mt);
    $("#msgs").append(d); $("#msgs").scrollTop = 1e9;
    return d;
  }
  async function open(p) {
    st.cur = p; st.unread[p] = 0;
    const r = roomOf(p);
    $("#rtitle").textContent = nameOf(p);
    $("#rav").replaceChildren(av(nameOf(p), imgOf(p)));
    $("#rid").className = ""; $("#rid").textContent = r ? (r.kind === "group" ? "Grup" : "Saluran · " + r.count + " pengikut") : p;
    roomSub(); $("#tray").hidden = true;
    $("#savebtn").hidden = !!r || saved(p); $("#vbtn").hidden = $("#abtn").hidden = !!r;
    $("#form").hidden = !!r && r.kind === "channel" && r.owner !== me.player_id;
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
    const to = st.cur, el = addMsg({ sender: me.player_id, to, kind: "text", body: v, t: new Date().toISOString(), pending: true });
    try {
      const m = await send(to, "text", v);
      st.last[to] = m.body; st.lastT[to] = m.t; el.dataset.t = m.t;
      el.querySelector("time").textContent = tm(m.t); el.querySelector(".tk").replaceWith(tick(m)); render();
    } catch (err) { el.querySelector(".tk").replaceWith(ic("x", "tk fail")); toast("Pesan gagal terkirim: " + err.message); }
  };
  const upd = () => { const has = $("#text").value.trim().length > 0; $("#sendb").hidden = !has; $("#mic").hidden = has; };
  $("#text").oninput = upd;
  ["😀", "😂", "😍", "😭", "😎", "🙏", "👍", "🔥", "🎉", "❤️", "😅", "🤔"].forEach((em) => {
    const b = mk("button", em); b.type = "button"; b.setAttribute("aria-label", "Emoji " + em);
    b.onclick = () => { $("#text").value += em; upd(); $("#text").focus(); };
    $("#tray").append(b);
  });
  $("#plus").onclick = () => ($("#tray").hidden = !$("#tray").hidden);
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
  $("#hback").onclick = () => show("upd");
  $("#explore-btn").onclick = () => show("explore");
  $("#xsearch").oninput = render;

  /* ----- story ----- */
  const postStory = (kind, body) => api("/stories", { method: "POST", body: JSON.stringify({ kind, body }) }).then(loadStories).catch((e) => toast(e.message));
  const storyText = async () => {
    const r = await dialog({ title: "Tulis story", desc: "Hilang otomatis setelah 24 jam.", fields: [{ name: "t", label: "Isi story", multiline: true, max: 300, required: true }], ok: "Posting" });
    if (r) postStory("text", r.t);
  };
  const storyImg = async () => postStory("img", await pick(640, 0.65, 190000));
  function viewStories(p) {
    const list = st.stories.filter((s) => s.owner === p);
    if (!list.length) return;
    let i = 0;
    const draw = () => {
      const s = list[i], b = $("#svbody"); b.replaceChildren();
      if (s.kind === "img") { const im = mk("img"); im.src = s.body; b.append(im); b.style.background = "#000"; }
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
  $("#swseen").onclick = () => saveProfile({ show_seen: me.show_seen === false });
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
      sdpSent = true; sig("offer", { sdp: { type: p.localDescription.type, sdp: p.localDescription.sdp }, video: v });
    } catch { hang(false, "Tidak bisa memulai panggilan"); }
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
  await Promise.all([loadContacts(), loadRooms(), loadStories(), loadChats(), loadPresence()]);
  show("home");
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

function initLanding() {
  const panel = $("#panel"), v = $("#bg");
  if (v) { if (matchMedia("(prefers-reduced-motion: reduce)").matches) v.pause(); else v.play().catch(() => {}); }
  if (getToken()) { const e = $("#enter"); e.href = "dashboard.html"; e.textContent = "BUKA APLIKASI"; }
  let on = false, last = 0, lx = 0, ly = 0;
  const reveal = (x, y) => {
    if (on) return; on = true;
    if (x != null) { const r = document.createElement("div"); r.className = "ripple"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.append(r); setTimeout(() => r.remove(), 800); }
    document.body.classList.add("show");
    panel.removeAttribute("inert"); panel.setAttribute("aria-hidden", "false");
  };
  document.addEventListener("pointerup", (e) => {
    if (on) return;
    if (e.timeStamp - last < 350 && Math.hypot(e.clientX - lx, e.clientY - ly) < 60) reveal(e.clientX, e.clientY);
    last = e.timeStamp; lx = e.clientX; ly = e.clientY;
  });
  $("#hint").onclick = (e) => { if (e.detail === 0) reveal(); };  // tombol ini untuk pengguna keyboard / pembaca layar
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === document.body) reveal(); });
}

const page = document.body.dataset.page;
if (page === "dashboard") splash();
if (page === "landing") initLanding();
if (page === "login") initLogin();
if (page === "dashboard") initDashboard();
