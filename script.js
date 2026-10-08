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
  const st = { contacts: [], rooms: [], stories: [], calls: [], cur: null, unread: {}, last: {}, tab: "home" };
  const mk = (tag, txt, cls) => { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
  const hue = (n) => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  const av = (n, img) => { const e = mk("div", img ? "" : (n[0] || "?").toUpperCase(), "av"); e.style.background = img ? "url(" + img + ") center/cover" : "hsl(" + hue(n) + ",85%,78%)"; return e; };
  const isRoom = (p) => p.startsWith("R-");
  const roomOf = (p) => st.rooms.find((r) => "R-" + r.id === p);
  const contact = (p) => st.contacts.find((c) => c.player_id === p);
  const saved = (p) => !!contact(p);
  const nameOf = (p) => (p === me.player_id ? me.full_name : isRoom(p) ? (roomOf(p) || { name: "Grup" }).name : (contact(p) || { full_name: p }).full_name);
  const imgOf = (p) => (p === me.player_id ? me.avatar : (contact(p) || {}).avatar);
  const fmt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const hasStory = (p) => st.stories.some((s) => s.owner === p);
  const send = (to, kind, body) => api("/send", { method: "POST", body: JSON.stringify({ to, kind, body }) });
  const row = (img, name, sub, onclick, badge) => {
    const li = mk("li", null, "item"), box = mk("div");
    box.append(mk("b", name), mk("small", sub));
    li.append(av(name, img), box);
    if (badge) li.append(mk("i", badge, "dot"));
    li.onclick = onclick;
    return li;
  };
  const resize = (file, max, q) => new Promise((res) => {
    const im = new Image();
    im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = im.width * k; c.height = im.height * k; c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", q)); };
    im.src = URL.createObjectURL(file);
  });
  const pick = (max, q) => new Promise((res) => { const f = $("#pick"); f.value = ""; f.onchange = () => f.files[0] && resize(f.files[0], max, q).then(res); f.click(); });

  const SCREENS = ["home", "story", "chan", "calls", "profile", "room"];
  const loaders = { story: loadStories, calls: loadCalls, chan: loadRooms };
  function show(id) {
    if (id !== "room") st.tab = id;
    SCREENS.forEach((s) => ($("#" + s).hidden = s !== id));
    $("#fab").hidden = !["home", "story", "chan"].includes(id); $(".nav").hidden = id === "room";
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.s === id));
    if (loaders[id]) loaders[id]();
    render();
  }
  function render() {
    const q = $("#search").value.trim().toLowerCase();
    const mine = mk("button", null, "story plus");
    mine.append(av(me.full_name, me.avatar), mk("span", "Story saya"));
    mine.onclick = () => (hasStory(me.player_id) ? viewStories(me.player_id) : $("#stxt").click());
    $("#stories").replaceChildren(mine, ...st.contacts.map((c) => {
      const b = mk("button", null, "story" + (hasStory(c.player_id) ? " ring" : ""));
      b.append(av(c.full_name, c.avatar), mk("span", c.full_name));
      b.onclick = () => (hasStory(c.player_id) ? viewStories(c.player_id) : open(c.player_id));
      return b;
    }));
    const E = st.contacts.map((c) => [c.player_id, c.full_name, c.avatar]);
    st.rooms.filter((r) => r.kind === "group").forEach((r) => E.push(["R-" + r.id, r.name]));
    Object.keys(st.last).forEach((k) => { if (!isRoom(k) && !saved(k)) E.push([k, k]); });
    $("#empty-list").hidden = E.length > 0;
    $("#list").replaceChildren(...E.filter(([p, n]) => (n + p).toLowerCase().includes(q)).map(([p, n, i]) => row(i, n, st.last[p] || (isRoom(p) ? "Grup" : p), () => open(p), st.unread[p])));
    const owners = [...new Set(st.stories.map((s) => s.owner))].sort((a, b) => (b === me.player_id) - (a === me.player_id));
    $("#slist").replaceChildren(...owners.map((o) => { const l = st.stories.filter((s) => s.owner === o); return row(imgOf(o), o === me.player_id ? "Story saya" : nameOf(o), l.length + " pembaruan · " + fmt(l[l.length - 1].t), () => viewStories(o)); }));
    $("#clist").replaceChildren(...st.rooms.filter((r) => r.kind === "channel").map((r) => row(null, r.name, r.count + " pengikut · " + (st.last["R-" + r.id] || r.about || "-"), () => (r.joined ? open("R-" + r.id) : confirm("Ikuti saluran " + r.name + "?") && joinCh(r.id)), st.unread["R-" + r.id] || (r.joined ? "" : "IKUTI"))));
    const ST = { answered: "Terjawab", missed: "Tidak terjawab", rejected: "Ditolak" };
    $("#calllist").replaceChildren(...st.calls.map((c) => row(imgOf(c.peer), nameOf(c.peer), (c.out ? "Keluar" : "Masuk") + " · " + (c.video ? "Video" : "Suara") + " · " + ST[c.status] + " · " + fmt(c.t), () => open(c.peer))));
    $("#pav").replaceChildren(av(me.full_name, me.avatar));
    $("#pname").textContent = me.full_name; $("#pstat").textContent = me.status || "Belum ada status";
    $("#pid").textContent = me.player_id; $("#pyear").textContent = "Lahir " + me.birth_year;
  }
  async function loadContacts() { st.contacts = (await api("/contacts")).contacts; render(); }
  async function loadStories() { try { st.stories = (await api("/stories")).stories; render(); } catch {} }
  async function loadCalls() { try { st.calls = (await api("/calls")).calls; render(); } catch {} }
  async function loadRooms() { try { st.rooms = (await api("/rooms")).rooms; render(); } catch {} }
  const joinCh = (id) => api("/rooms/" + id + "/join", { method: "POST" }).then(loadRooms);
  $("#search").oninput = render;
  document.querySelectorAll(".nav button").forEach((b) => (b.onclick = () => show(b.dataset.s)));
  $("#logout").onclick = logout;
  $("#copy").onclick = () => navigator.clipboard.writeText(me.player_id).then(() => ($("#copy").textContent = "TERSALIN"));

  function addMsg(m) {
    const mine = m.sender === me.player_id;
    st.last[isRoom(m.to) || mine ? m.to : m.sender] = m.body;
    const r = roomOf(st.cur || ""), d = mk("div", null, "bub " + (mine ? "out" : "in")), box = mk("div");
    if (!mine && r && r.kind === "group") box.append(mk("small", nameOf(m.sender), "who"));
    box.append(mk("span", m.body));
    d.append(box, mk("time", new Date(m.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
    $("#msgs").append(d); $("#msgs").scrollTop = 1e9;
  }
  async function open(p) {
    st.cur = p; st.unread[p] = 0;
    const r = roomOf(p);
    $("#rtitle").textContent = nameOf(p);
    $("#rid").textContent = r ? (r.kind === "group" ? "Grup" : "Saluran · " + r.count + " pengikut") : p;
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
    $("#text").value = "";
    try { addMsg(await send(st.cur, "text", v)); } catch (err) { alert(err.message); }
  };
  async function saveId(id) {
    try {
      await api("/contacts", { method: "POST", body: JSON.stringify({ player_id: id }) });
      await loadContacts();
      if (st.cur) { $("#rtitle").textContent = nameOf(st.cur); $("#savebtn").hidden = saved(st.cur); }
    } catch (e) { alert(e.message); }
  }
  $("#savebtn").onclick = () => saveId(st.cur);
  async function mkRoom(body) { try { await api("/rooms", { method: "POST", body: JSON.stringify(body) }); loadRooms(); } catch (e) { alert(e.message); } }
  $("#newgrp").onclick = () => {
    const name = prompt("Nama grup"); if (!name) return;
    const members = (prompt("ID anggota dipisah koma\nContoh: NOVA-AAA111,NOVA-BBB222") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    mkRoom({ kind: "group", name, members });
  };
  const newChannel = () => { const name = prompt("Nama saluran"); if (name) mkRoom({ kind: "channel", name, about: prompt("Deskripsi singkat") || "" }); };
  $("#fab").onclick = () => ({
    home: () => { const id = (prompt("Masukkan ID teman (contoh NOVA-AB12CD)") || "").trim(); if (id) saveId(id); },
    story: () => $("#stxt").click(), chan: newChannel,
  }[st.tab] || (() => {}))();

  /* ----- story ----- */
  const postStory = (kind, body) => api("/stories", { method: "POST", body: JSON.stringify({ kind, body }) }).then(loadStories).catch((e) => alert(e.message));
  $("#stxt").onclick = () => { const t = (prompt("Tulis story (maks 300 huruf)") || "").trim(); if (t) postStory("text", t); };
  $("#simg").onclick = async () => postStory("img", await pick(640, 0.65));
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
  async function saveProfile(patch) { try { me = (await api("/profile", { method: "POST", body: JSON.stringify(patch) })).user; render(); } catch (e) { alert(e.message); } }
  $("#pphoto").onclick = async () => saveProfile({ avatar: await pick(160, 0.75) });
  $("#pdel").onclick = () => saveProfile({ avatar: "" });
  $("#pst").onclick = () => { const t = prompt("Status kamu", me.status || ""); if (t !== null) saveProfile({ status: t.trim() }); };

  /* ----- WebRTC native: STUN Google, signaling lewat /api/send + /api/poll ----- */
  const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  let pc, stream, peer, pend = [], offer, video = true, facing = "user";
  const sig = (type, data) => send(peer, "sig", JSON.stringify({ type, data })).catch(() => {});
  async function media() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video && { facingMode: facing } });
    $("#local").srcObject = stream;
    $("#local").hidden = $("#cam").hidden = $("#flip").hidden = !video;
  }
  function mkpc() {
    pc = new RTCPeerConnection(ICE);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (e) => ($("#remote").srcObject = e.streams[0]);
    pc.onicecandidate = (e) => e.candidate && sig("ice", e.candidate);
    pc.onconnectionstatechange = () => { if (pc && pc.connectionState === "failed") hang(true, "Koneksi gagal (jaringan memblokir P2P)"); };
  }
  function hang(notify, msg) {
    if (notify && peer) sig("end");
    if (pc) pc.close();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    pc = stream = peer = offer = null; pend = [];
    $("#call").hidden = true; $("#incoming").hidden = true;
    if (msg) alert(msg);
  }
  async function call(v) {
    if (peer || !st.cur) return;
    peer = st.cur; video = v; $("#call").hidden = false; $("#cinfo").textContent = "Memanggil " + nameOf(peer) + "...";
    try { await media(); } catch { return hang(false, "Izin kamera/mikrofon ditolak"); }
    mkpc();
    const o = await pc.createOffer(); await pc.setLocalDescription(o);
    sig("offer", { sdp: { type: o.type, sdp: o.sdp }, video: v });
  }
  $("#vbtn").onclick = () => call(true);
  $("#abtn").onclick = () => call(false);
  async function signal(from, { type, data }) {
    if (type === "ice" && (!peer || from === peer)) { (pc && pc.remoteDescription) ? pc.addIceCandidate(data) : pend.push(data); return; }
    if (type === "offer") {
      if (peer) return send(from, "sig", JSON.stringify({ type: "reject" }));
      peer = from; offer = data; video = !!data.video;
      $("#inwho").textContent = nameOf(from) + (video ? " video call..." : " menelpon...");
      $("#incoming").hidden = false; return;
    }
    if (from !== peer) return;
    if (type === "answer") {
      await pc.setRemoteDescription(data);
      pend.forEach((c) => pc.addIceCandidate(c)); pend = [];
      $("#cinfo").textContent = "Terhubung";
    } else hang(false, type === "reject" ? "Panggilan ditolak" : null);
  }
  $("#accept").onclick = async () => {
    $("#incoming").hidden = true; $("#call").hidden = false; $("#cinfo").textContent = "Menyambung...";
    try { await media(); } catch { sig("reject"); return hang(false, "Izin kamera/mikrofon ditolak"); }
    mkpc();
    await pc.setRemoteDescription(offer.sdp);
    pend.forEach((c) => pc.addIceCandidate(c)); pend = [];
    const a = await pc.createAnswer(); await pc.setLocalDescription(a);
    sig("answer", { type: a.type, sdp: a.sdp }); $("#cinfo").textContent = "Terhubung";
  };
  $("#reject").onclick = () => { sig("reject"); hang(false); };
  $("#end").onclick = () => hang(true);
  const toggle = (sel, kind, on, off) => ($(sel).onclick = (e) => {
    const t = stream.getTracks().find((x) => x.kind === kind);
    t.enabled = !t.enabled; e.target.textContent = t.enabled ? on : off;
  });
  toggle("#mute", "audio", "MUTE", "UNMUTE");
  toggle("#cam", "video", "KAMERA OFF", "KAMERA ON");
  $("#flip").onclick = async () => {
    try {
      facing = facing === "user" ? "environment" : "user";
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      const nt = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } })).getVideoTracks()[0];
      stream.addTrack(nt);
      pc.getSenders().find((s) => s.track && s.track.kind === "video").replaceTrack(nt);
      $("#local").srcObject = stream;
    } catch { alert("Tidak bisa ganti kamera"); }
  };
  const L = $("#local"); let dx = 0, dy = 0, drag = false;
  L.onpointerdown = (e) => { drag = true; dx = e.clientX - L.offsetLeft; dy = e.clientY - L.offsetTop; L.setPointerCapture(e.pointerId); };
  L.onpointermove = (e) => { if (drag) { L.style.left = e.clientX - dx + "px"; L.style.top = e.clientY - dy + "px"; L.style.right = "auto"; } };
  L.onpointerup = () => (drag = false);

  /* ----- kunci aplikasi (sidik jari / PIN HP lewat WebAuthn, hanya kunci layar lokal) ----- */
  const LK = "nova_lock", b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const lockLabel = () => ($("#lockbtn").textContent = "KUNCI: " + (localStorage.getItem(LK) ? "ON" : "OFF"));
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
    } catch { alert("Perangkat atau browser ini tidak mendukung kunci sidik jari/PIN."); }
  };
  lockLabel();
  if (localStorage.getItem(LK)) { $("#lock").hidden = false; unlock(); }
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (localStorage.getItem(LK) && Date.now() - hiddenAt > 30000) { $("#lock").hidden = false; unlock(); }
  });

  /* ----- polling pesan + sinyal ----- */
  await Promise.all([loadContacts(), loadRooms(), loadStories()]);
  show("home");
  let last = (await api("/poll")).last, n = 0;
  (async function tick() {
    try {
      const r = await api("/poll?after=" + last); last = r.last;
      r.events.forEach((m) => {
        if (m.kind === "sig") return signal(m.sender, JSON.parse(m.body));
        const key = isRoom(m.to) ? m.to : m.sender;
        if (isRoom(key) && !roomOf(key)) loadRooms();
        if (st.cur === key && !$("#room").hidden) addMsg(m);
        else { st.last[key] = m.body; st.unread[key] = (st.unread[key] || 0) + 1; }
        render();
      });
      if (++n % 40 === 0) { loadStories(); loadContacts(); }
    } catch (e) {}
    setTimeout(tick, peer ? 700 : 1500);
  })();
}

const page = document.body.dataset.page;
if (page === "login") initLogin();
if (page === "dashboard") initDashboard();
