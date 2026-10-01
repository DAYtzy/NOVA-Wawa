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

/* ---------- Dashboard ---------- */
async function initDashboard() {
  if (!getToken()) return logout();
  let me;
  try { me = (await api("/me")).user; } catch { return logout(); }
  $("#name").textContent = me.full_name;
  $("#pid").textContent = me.player_id;
  $("#logout").addEventListener("click", logout);
  $("#vc").addEventListener("click", () =>
    window.open("https://meet.jit.si/NOVA-ROOM-" + encodeURIComponent(me.player_id), "_blank", "noopener")
  );

  const render = (users) => {
    const tbody = $("#rows");
    tbody.replaceChildren(...users.map((u) => {
      const tr = document.createElement("tr");
      if (u.player_id === me.player_id) tr.className = "me";
      [u.full_name, u.player_id, u.birth_year].forEach((v) => {
        const td = document.createElement("td");
        td.textContent = v; tr.appendChild(td);
      });
      return tr;
    }));
    $("#count").textContent = users.length;
  };

  // SSE: server mengirim event 'user_update'; EventSource otomatis reconnect.
  const es = new EventSource("/api/stream?token=" + encodeURIComponent(getToken()));
  es.addEventListener("user_update", (e) => render(JSON.parse(e.data)));
  es.onopen = () => ($("#live").textContent = "Live: daftar diperbarui otomatis");
  es.onerror = () => ($("#live").textContent = "Menyambung ulang...");
}

const page = document.body.dataset.page;
if (page === "login") initLogin();
if (page === "dashboard") initDashboard();
