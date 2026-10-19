import os, re, json, time, base64, hashlib, secrets, string, threading
from datetime import datetime, timedelta
from functools import wraps
import bcrypt
from dotenv import load_dotenv
load_dotenv()
from flask import Flask, request, jsonify, send_from_directory, Response
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
import mailer, push
from security import apply_headers, pw_problem, enc, dec, crypto_status, safe_data_url
from database import Session, User, Contact, Message, Profile, ProfileExt, Sticker, AppSetting, UserFlag, Media, Block, RateHit, PwChange, EmailOk, PrivPref, Report, PushSub, Story, Room, RoomMember, Call, StaffRole, AuditLog, RoomExt, init_db

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)


@app.before_request
def guard_secret():
    if ON_VERCEL and not SECRET_OK and request.path.startswith("/api/"):
        return jsonify(error="Server belum aman: SECRET_KEY belum diisi di Vercel (minimal 16 karakter).", config=True), 503


@app.after_request
def sec_headers(r):
    return apply_headers(r, request.path)
SECRET = os.getenv("SECRET_KEY", "").strip()
SECRET_OK = len(SECRET) >= 16
ON_VERCEL = bool(os.getenv("VERCEL"))
ser = URLSafeTimedSerializer(SECRET if SECRET_OK else "dev-secret-change-me")  # kunci cadangan HANYA untuk komputer lokal
init_db()

STK_RE = re.compile(r"^\[stk:([0-9a-f]{24})\]$")
STK_DATA = re.compile(r"^data:image/(png|webp);base64,[A-Za-z0-9+/=]+$")
OFFICIAL = "NOVA"  # akun resmi pengirim pengumuman (tidak bisa login)
OWNER_IDS = {x.strip().upper() for x in os.getenv("OWNER_IDS", "").split(",") if x.strip()}  # kosong = akun pertama yang mendaftar
MED_RE = re.compile(r"^\[med:(i|v)(o?):([0-9a-f]{24})\]$")
IMG_DATA = re.compile(r"^data:image/jpeg;base64,[A-Za-z0-9+/=]+$")
EXT_OK = {"mp4", "mov", "webm", "m4v", "3gp", "mkv", "jpg", "jpeg", "png", "webp"}
ONLINE_SEC = 25
VERIFIED = {x.strip().upper() for x in os.getenv("VERIFIED_IDS", "").split(",") if x.strip()}  # ID yang dapat centang biru
ANNOUNCE = os.getenv("ANNOUNCEMENT", "Selamat datang di NOVA WAWA. Simpan ID temanmu lalu mulai chat, telpon, atau video call.")
PUBLIC_FILES = {"index.html", "login.html", "dashboard.html", "forgot.html", "reset.html", "verify.html", "terms.html", "privacy.html",
                "style.css", "script.js", "sw.js", "manifest.json", "icon-192.png", "icon-512.png", "logo.png", "login.mp4", "intro.mp4"}


def new_pid(db):
    while True:  # ID angka acak 8 digit (tanpa awalan 0), diulang sampai belum dipakai
        pid = str(secrets.randbelow(90_000_000) + 10_000_000)
        if not db.query(User.id).filter_by(player_id=pid).first():
            return pid


ID_COLS = [(User, "player_id"), (Contact, "owner"), (Contact, "contact_pid"), (Message, "sender"), (Message, "to_id"),
           (Profile, "player_id"), (ProfileExt, "player_id"), (Story, "owner"), (Room, "owner"),
           (RoomMember, "player_id"), (Call, "caller"), (Call, "callee"), (Media, "owner")]


def migrate_ids():
    """Sekali jalan: ganti ID lama NOVA-XXXXXX jadi angka, di semua tabel (kontak, pesan, grup, dll)."""
    try:
        with Session() as db:
            for o in [u.player_id for u in db.query(User).filter(User.player_id.like("NOVA-%"))]:
                n = new_pid(db)
                for M, col in ID_COLS:
                    c = getattr(M, col)
                    db.query(M).filter(c == o).update({c: n}, synchronize_session=False)
            db.commit()
    except Exception as e:  # jangan sampai aplikasi gagal start karena migrasi
        print("migrate_ids gagal:", e)


migrate_ids()


_cache = {"t": 0.0, "banned": set(), "vfy": {}, "first": None, "announce": "", "pwchg": set(), "mods": set()}


def flags(db):
    """Daftar blokir, centang manual, dan banner. Disimpan di memori ~15 detik supaya tidak membebani database."""
    if time.time() - _cache["t"] > 15:
        try:
            rows = db.query(UserFlag).all()
            a = db.get(AppSetting, "announce")
            _cache.update(t=time.time(), banned={r.player_id for r in rows if r.banned},
                          vfy={r.player_id: r.verified for r in rows if r.verified is not None},
                          announce=(a.value if a and a.value else ""), pwchg={r.player_id for r in db.query(PwChange)},
                          mods={r.player_id for r in db.query(StaffRole).filter(StaffRole.role == "mod")})
            if _cache["first"] is None:
                _cache["first"] = db.query(func.min(User.id)).filter(User.player_id != OFFICIAL).scalar()
        except Exception as e:
            db.rollback()
            print("flags gagal:", e)
    return _cache


def is_owner(u):
    if OWNER_IDS:
        return u.player_id in OWNER_IDS
    return _cache["first"] is not None and u.id == _cache["first"]


def is_mod(u):
    return u.player_id in _cache["mods"] and not is_owner(u)


def is_staff(u):
    return is_owner(u) or is_mod(u)


def is_verified(u):
    v = _cache["vfy"].get(u.player_id)
    if v is not None:
        return v
    return u.player_id == OFFICIAL or is_owner(u) or u.id == _cache["first"] or u.player_id in VERIFIED


def client_ip():
    return (request.headers.get("x-real-ip") or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or request.remote_addr or "?")[:45]


def too_many(db, key, limit, secs):
    since = datetime.utcnow() - timedelta(seconds=secs)
    return (db.query(func.count(RateHit.id)).filter(RateHit.key == key, RateHit.ts > since).scalar() or 0) >= limit


def note_hit(db, key):
    db.add(RateHit(key=key[:120], ts=datetime.utcnow()))
    db.commit()
    if secrets.randbelow(40) == 0:  # sesekali buang catatan lama
        db.query(RateHit).filter(RateHit.ts < datetime.utcnow() - timedelta(days=1)).delete(synchronize_session=False)
        db.commit()


def rl(db, key, limit, secs):
    """Pembatas laju berbasis database (berlaku lintas instance). True = boleh, False = sudah melewati batas."""
    if too_many(db, key, limit, secs):
        return False
    note_hit(db, key)
    return True


def tokver(u):
    return hashlib.sha256(u.password_hash.encode()).hexdigest()[:10]


def make_token(u):
    return ser.dumps([u.id, tokver(u)])  # berubah kalau password diganti, jadi sesi lama otomatis tidak berlaku


def load_user(db):
    try:
        v = ser.loads(request.headers.get("Authorization", "")[7:], max_age=7 * 86400)
        if isinstance(v, list) and len(v) == 2:
            u = db.get(User, v[0])
            return u if u and tokver(u) == v[1] else None
        u = db.get(User, v)  # token lama (hanya id): sah selama password belum pernah diganti lewat fitur baru
        return None if u and u.player_id in flags(db)["pwchg"] else u
    except (BadSignature, SignatureExpired, TypeError, ValueError):
        return None


def authed(f):
    @wraps(f)
    def w(*a, **k):
        with Session() as db:
            u = load_user(db)
            if not u:
                return jsonify(error="Unauthorized"), 401
            if u.player_id in flags(db)["banned"]:
                return jsonify(error="Akunmu diblokir oleh admin.", banned=True), 403
            return f(db, u, *a, **k)
    return w


def owner_only(f):
    @authed
    @wraps(f)
    def w(db, u, *a, **k):
        if not is_owner(u):
            return jsonify(error="Khusus owner."), 403
        return f(db, u, *a, **k)
    return w


def staff_only(f):
    """Owner atau moderator."""
    @authed
    @wraps(f)
    def w(db, u, *a, **k):
        if not is_staff(u):
            return jsonify(error="Khusus staf."), 403
        return f(db, u, *a, **k)
    return w


AUDIT_KEEP_DAYS = 180


def audit(db, u, action, target="", detail=""):
    """Catat tindakan staf. Gagal mencatat tidak boleh menggagalkan tindakannya."""
    try:
        db.add(AuditLog(actor=u.player_id, action=action[:24], target=str(target)[:40], detail=clean(detail, 200)))
        db.commit()
        if secrets.randbelow(50) == 0:  # sesekali buang catatan lama
            db.query(AuditLog).filter(AuditLog.created_at < datetime.utcnow() - timedelta(days=AUDIT_KEEP_DAYS)).delete(synchronize_session=False)
            db.commit()
    except Exception as e:
        db.rollback()
        print("audit gagal:", e)


def ensure_official():
    try:
        with Session() as db:
            if not db.query(User.id).filter_by(player_id=OFFICIAL).first():
                db.add(User(player_id=OFFICIAL, full_name="NOVA WAWA", birth_year=2024, email="official@nova.invalid",
                            password_hash=bcrypt.hashpw(secrets.token_hex(24).encode(), bcrypt.gensalt()).decode()))
                db.commit()
    except Exception as e:  # jangan sampai aplikasi gagal start
        print("ensure_official gagal:", e)


ensure_official()


EMPTY = {"avatar": "", "status": "", "cover": "", "public": True, "show_seen": True, "last_seen": None, "story_vis": "all", "seen_vis": "all", "email_ok": False}


def vis_ok(vis, owner, viewer, mutual):
    """Apakah `viewer` (yang menyimpan ID `owner`) boleh melihat. mutual = pemilik juga menyimpan viewer."""
    return vis == "all" or (vis == "mutual" and (owner, viewer) in mutual)


def prof(db, ids):
    out = {i: dict(EMPTY) for i in ids}
    for p in db.query(Profile).filter(Profile.player_id.in_(ids)):
        out[p.player_id].update(avatar=p.avatar or "", status=p.status or "")
    for e in db.query(ProfileExt).filter(ProfileExt.player_id.in_(ids)):
        out[e.player_id].update(cover=e.cover or "", public=e.public is not False,
                                show_seen=e.show_seen is not False, last_seen=e.last_seen)
    for x in db.query(EmailOk).filter(EmailOk.player_id.in_(ids)):
        out[x.player_id]["email_ok"] = True
    pp = {x.player_id: x for x in db.query(PrivPref).filter(PrivPref.player_id.in_(ids))}
    for i, d in out.items():
        x = pp.get(i)
        d["story_vis"] = (x.story_vis if x and x.story_vis in ("all", "mutual", "none") else "all")
        d["seen_vis"] = (x.seen_vis if x and x.seen_vis in ("all", "mutual", "none") else ("all" if d["show_seen"] else "none"))
    return out


def pub(u, pr, mine=False):
    d = pr.get(u.player_id, EMPTY)
    o = {**u.public(), "verified": is_verified(u), "owner": is_owner(u), "mod": is_mod(u)}
    if not mine:
        o.pop("birth_year", None)  # tahun lahir hanya terlihat oleh pemilik akun
    if mine:
        o.update(avatar=d["avatar"], status=d["status"], cover=d["cover"], public=d["public"],
                 show_seen=d["show_seen"], story_vis=d["story_vis"], seen_vis=d["seen_vis"], mail=mailer.mail_ready(), email_verified=d["email_ok"], announce=_cache["announce"] or ANNOUNCE, is_owner=is_owner(u), is_staff=is_staff(u), official=OFFICIAL, cld=bool(cld_conf()))
    elif d["public"]:  # profil privat: foto & status disembunyikan dari orang lain
        o.update(avatar=d["avatar"], status=d["status"])
    else:
        o.update(avatar="", status="")
    return o


def touch(db, pid):
    now = datetime.utcnow()
    e = db.get(ProfileExt, pid)
    if not e:
        e = ProfileExt(player_id=pid, public=True, show_seen=True)
        db.add(e)
    if not e.last_seen or (now - e.last_seen).total_seconds() > 15:
        e.last_seen = now
        db.commit()


def log_call(db, me_id, to, body):
    try:
        s = json.loads(body)
        t = s.get("type")
    except ValueError:
        return
    if t == "offer":
        db.add(Call(caller=me_id, callee=to, video=bool((s.get("data") or {}).get("video")), status="missed"))
    elif t in ("answer", "reject"):
        c = db.query(Call).filter_by(caller=to, callee=me_id, status="missed").order_by(Call.id.desc()).first()
        if c:
            c.status = "answered" if t == "answer" else "rejected"


@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    name, email, pw = (d.get("full_name") or "").strip(), (d.get("email") or "").strip().lower(), d.get("password") or ""
    try:
        year = int(d.get("birth_year"))
    except (TypeError, ValueError):
        year = 0
    if not name or "@" not in email or len(email) > 120 or len(name) > 60 or not 1900 <= year <= time.gmtime().tm_year:
        return jsonify(error="Data tidak valid."), 400
    if not d.get("agree"):
        return jsonify(error="Setujui Syarat dan Kebijakan Privasi dulu."), 400
    bad = pw_problem(pw, name, email)
    if bad:
        return jsonify(error=bad), 400
    hashed = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
    ip = client_ip()
    with Session() as db:
        if too_many(db, "R:" + ip, 6, 3600):
            return jsonify(error="Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti."), 429
        note_hit(db, "R:" + ip)
        if db.query(User.id).filter_by(email=email).first():
            return jsonify(error="Email sudah terdaftar."), 409
        for _ in range(5):
            u = User(player_id=new_pid(db), full_name=name, birth_year=year, email=email, password_hash=hashed)
            db.add(u)
            try:
                db.commit()
                sent = send_verify(u)
                return jsonify(token=make_token(u), user=u.public(), verify_sent=sent), 201
            except IntegrityError:
                db.rollback()
        return jsonify(error="Gagal membuat akun, coba lagi."), 500


@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    email, pw, ip = (d.get("email") or "").strip().lower()[:120], d.get("password") or "", client_ip()
    with Session() as db:
        if too_many(db, "L:ip:" + ip, 40, 900) or too_many(db, "L:em:" + email, 8, 900):
            return jsonify(error="Terlalu banyak percobaan masuk. Tunggu sekitar 15 menit lalu coba lagi."), 429
        u = db.query(User).filter_by(email=email).first()
        ok = False
        if u and u.player_id != OFFICIAL:
            try:
                ok = bcrypt.checkpw(pw.encode()[:72], u.password_hash.encode())
            except ValueError:
                ok = False
        if not ok:
            note_hit(db, "L:ip:" + ip)
            note_hit(db, "L:em:" + email)
            return jsonify(error="Email atau password salah."), 401
        if u.player_id in flags(db)["banned"]:
            return jsonify(error="Akunmu diblokir oleh admin.", banned=True), 403
        return jsonify(token=make_token(u), user=u.public(), weak=len(pw) < 8)


@app.post("/api/password")
@authed
def change_password(db, u):
    d = request.get_json(silent=True) or {}
    old, new = d.get("old") or "", d.get("new") or ""
    if too_many(db, "P:" + u.player_id, 6, 3600):
        return jsonify(error="Terlalu banyak percobaan. Coba lagi nanti."), 429
    try:
        ok = bcrypt.checkpw(old.encode()[:72], u.password_hash.encode())
    except ValueError:
        ok = False
    if not ok:
        note_hit(db, "P:" + u.player_id)
        return jsonify(error="Password lama salah."), 400
    bad = pw_problem(new, u.full_name, u.email)
    if bad:
        return jsonify(error=bad), 400
    if new == old:
        return jsonify(error="Password baru harus berbeda dari yang lama."), 400
    u.password_hash = bcrypt.hashpw(new.encode(), bcrypt.gensalt()).decode()
    ch = db.get(PwChange, u.player_id) or PwChange(player_id=u.player_id)
    ch.at = datetime.utcnow()
    db.add(ch)
    db.commit()
    _cache["t"] = 0.0
    return jsonify(ok=True, token=make_token(u))


@app.get("/api/me")
@authed
def me(db, u):
    return jsonify(user=pub(u, prof(db, [u.player_id]), True))


@app.get("/api/contacts")
@authed
def contacts(db, u):
    ids = [c.contact_pid for c in db.query(Contact).filter_by(owner=u.player_id).order_by(Contact.id.desc())]
    pr = prof(db, ids)
    us = {x.player_id: pub(x, pr) for x in db.query(User).filter(User.player_id.in_(ids))}
    return jsonify(contacts=[us[i] for i in ids if i in us])


@app.post("/api/contacts")
@authed
def add_contact(db, u):
    if not rl(db, "add:" + u.player_id, 30, 600):
        return jsonify(error="Terlalu banyak pencarian ID. Tunggu sebentar."), 429
    pid = ((request.get_json(silent=True) or {}).get("player_id") or "").strip().upper()
    t = db.query(User).filter_by(player_id=pid).first()
    if not t:
        return jsonify(error="ID tidak ditemukan."), 404
    if t.id == u.id:
        return jsonify(error="Itu ID kamu sendiri."), 400
    if not db.query(Contact.id).filter_by(owner=u.player_id, contact_pid=pid).first():
        db.add(Contact(owner=u.player_id, contact_pid=pid))
        db.commit()
    return jsonify(contact=pub(t, prof(db, [t.player_id])))


@app.post("/api/send")
@authed
def send(db, u):
    d = request.get_json(silent=True) or {}
    kind = "sig" if d.get("kind") == "sig" else "text"
    if not rl(db, "send:" + u.player_id, 400 if kind == "sig" else 60, 60):
        return jsonify(error="Terlalu cepat. Pelan-pelan ya."), 429
    body, to = (d.get("body") or "")[:20000 if kind == "sig" else 4000], d.get("to") or ""
    if kind == "text":
        body = body.strip()
        if body.startswith("[stk:"):
            mm = STK_RE.match(body)
            if not mm or not db.get(Sticker, mm.group(1)):
                return jsonify(error="Stiker tidak ditemukan."), 400
    med = None
    if kind == "text" and body.startswith("[med:"):
        mm = MED_RE.match(body)
        med = mm and db.get(Media, mm.group(3))
        if not med or med.owner != u.player_id or not med.ready or med.sent or med.gone \
                or (mm.group(1) == "v") != (med.kind == "video") or bool(mm.group(2)) != bool(med.once):
            return jsonify(error="Foto/video tidak valid."), 400
        if med.once and to.startswith("R-"):
            return jsonify(error="Sekali lihat hanya untuk chat pribadi."), 400
    if kind == "sig":
        try:
            sig_type = (json.loads(body) or {}).get("type")
        except (ValueError, AttributeError):
            sig_type = None
        if sig_type == "offer":
            if to == OFFICIAL or to.startswith("R-"):
                return jsonify(error="Panggilan hanya ke pengguna."), 400
            if not db.query(Contact.id).filter_by(owner=to, contact_pid=u.player_id).first():
                return jsonify(error="Hanya kontak yang bisa menelepon. Minta dia menyimpan ID-mu dulu."), 403
            if not rl(db, "call:" + u.player_id, 12, 600):
                return jsonify(error="Terlalu sering menelepon. Tunggu sebentar."), 429
    if kind == "text" and to == OFFICIAL:
        return jsonify(error="Akun resmi hanya mengirim pengumuman."), 400
    if kind == "text" and to.startswith("R-") and to[2:].isdigit():
        r = db.get(Room, int(to[2:]))
        ok = r and db.query(RoomMember.id).filter_by(room_id=r.id, player_id=u.player_id).first() \
            and (r.kind == "group" or r.owner == u.player_id)  # saluran: hanya pemilik yang boleh posting
    else:
        ok = db.query(User.id).filter_by(player_id=to).first()
    if not body or not ok:
        return jsonify(error="Pesan tidak valid."), 400
    if kind == "sig":
        log_call(db, u.player_id, to, body)
    if med:
        med.sent = True
        med.to_id = to
    m = Message(sender=u.player_id, to_id=to, kind=kind, body=enc(body) if kind == "text" else body)
    db.add(m)
    db.commit()
    try:
        notify(db, u, to, kind, body)
    except Exception as e:  # notifikasi tidak boleh menggagalkan pengiriman pesan
        print("notify gagal:", e)
    return jsonify(m.public())


def cld_conf():
    """(cloud_name, api_key, api_secret) dari env, atau None kalau Cloudinary belum diisi."""
    name, key, sec = (os.getenv(k, "").strip() for k in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"))
    url = os.getenv("CLOUDINARY_URL", "").strip()
    if url and not (name and key and sec):
        mm = re.match(r"^cloudinary://([^:]+):([^@]+)@(.+)$", url)
        if mm:
            key, sec, name = mm.groups()
    return (name, key, sec) if name and key and sec else None


def cld_sign(params, secret):
    return hashlib.sha1(("&".join("%s=%s" % (k, params[k]) for k in sorted(params)) + secret).encode()).hexdigest()


def cld_destroy(m):
    cfg = cld_conf()
    if m.provider != "cld" or not cfg:
        return
    try:
        import urllib.parse, urllib.request
        params = {"invalidate": "true", "public_id": m.ref, "timestamp": str(int(time.time()))}
        data = urllib.parse.urlencode({**params, "api_key": cfg[1], "signature": cld_sign(params, cfg[2])}).encode()
        urllib.request.urlopen("https://api.cloudinary.com/v1_1/%s/%s/destroy" % (cfg[0], "video" if m.kind == "video" else "image"), data=data, timeout=6).read()
    except Exception as e:
        print("hapus media gagal:", e)


def media_urls(m, cfg):
    """(url, thumb). Alamat dibuat di server dari public_id, bukan dari kiriman klien."""
    if m.provider == "db":
        u = "/api/media/%s/file?s=%s" % (m.id, ser.dumps(m.id, salt="media"))  # berlaku 6 jam
        return u, u
    base = "https://res.cloudinary.com/%s/%s/upload" % (cfg[0] if cfg else "", "video" if m.kind == "video" else "image")
    if m.kind == "image":
        u = "%s/%s.%s" % (base, m.ref, m.ext or "jpg")
        return u, u
    native = m.ext in ("mp4", "webm")
    url = "%s/%s%s.%s" % (base, "" if native else "f_mp4,vc_h264/", m.ref, m.ext if native else "mp4")
    return url, "%s/so_0,w_480,c_limit,f_jpg/%s.jpg" % (base, m.ref)


def n0(x):
    try:
        return max(0, min(int(float(x)), 100000))
    except (TypeError, ValueError):
        return 0


def sweep_once(db):
    """Foto/video sekali lihat yang sudah dibuka lebih dari 10 menit lalu dihapus dari penyimpanan."""
    cut = datetime.utcnow() - timedelta(minutes=10)
    for m in db.query(Media).filter(Media.once.is_(True), Media.gone.is_(False), Media.viewed_at.isnot(None), Media.viewed_at < cut).limit(5).all():
        cld_destroy(m)
        m.data, m.gone = "", True
    db.commit()


@app.post("/api/media/new")
@authed
def media_new(db, u):
    if not rl(db, "med:" + u.player_id, 20, 600):
        return jsonify(error="Terlalu banyak unggahan. Tunggu sebentar."), 429
    d = request.get_json(silent=True) or {}
    kind, cfg = ("video" if d.get("kind") == "video" else "image"), cld_conf()
    if kind == "video" and not cfg:
        return jsonify(error="Video butuh penyimpanan Cloudinary. Minta owner mengisi kuncinya di Vercel."), 400
    mid = secrets.token_hex(12)
    m = Media(id=mid, owner=u.player_id, kind=kind, provider="cld" if cfg else "db", ref=("nova/" + mid) if cfg else "",
              caption=(d.get("caption") or "").strip()[:200], once=bool(d.get("once")))
    db.add(m)
    db.commit()
    out = {"id": mid, "provider": m.provider}
    if cfg:
        params = {"public_id": m.ref, "timestamp": str(int(time.time()))}
        out["upload"] = {"url": "https://api.cloudinary.com/v1_1/%s/%s/upload" % (cfg[0], kind),
                         "fields": {**params, "api_key": cfg[1], "signature": cld_sign(params, cfg[2])}}
    return jsonify(out)


@app.post("/api/media/<mid>/ready")
@authed
def media_ready(db, u, mid):
    m = db.get(Media, mid)
    if not m or m.owner != u.player_id or m.provider != "cld" or m.ready:
        return jsonify(error="Media tidak ditemukan."), 404
    d = request.get_json(silent=True) or {}
    ext = str(d.get("ext") or "").lower()
    m.ext = ext if ext in EXT_OK else ("mp4" if m.kind == "video" else "jpg")
    m.w, m.h, m.dur, m.ready = n0(d.get("w")), n0(d.get("h")), n0(d.get("dur")), True
    db.commit()
    return jsonify(ok=True)


@app.post("/api/media/<mid>/data")
@authed
def media_data(db, u, mid):
    m = db.get(Media, mid)
    d = request.get_json(silent=True) or {}
    data = d.get("data") or ""
    if not m or m.owner != u.player_id or m.provider != "db" or m.kind != "image" or m.ready:
        return jsonify(error="Media tidak ditemukan."), 404
    if len(data) > 300000 or not IMG_DATA.match(data):
        return jsonify(error="Foto terlalu besar."), 400
    m.data, m.w, m.h, m.ready = data, n0(d.get("w")), n0(d.get("h")), True
    db.commit()
    return jsonify(ok=True)


@app.get("/api/media/<mid>/file")
def media_file(mid):
    if not re.fullmatch(r"[0-9a-f]{24}", mid):
        return "", 404
    try:
        if ser.loads(request.args.get("s", ""), salt="media", max_age=21600) != mid:
            return "", 403
    except (BadSignature, SignatureExpired):
        return "", 403
    with Session() as db:
        m = db.get(Media, mid)
        data = m.data if m and m.provider == "db" and not m.once and not m.gone else ""
    if not data:
        return "", 404
    r = Response(base64.b64decode(data.split(",", 1)[1]), mimetype="image/jpeg")
    r.headers["Cache-Control"] = "private, max-age=3600"
    return r


@app.post("/api/media/meta")
@authed
def media_meta(db, u):
    raw = (request.get_json(silent=True) or {}).get("ids") or []
    ids = [i for i in raw[:40] if isinstance(i, str) and re.fullmatch(r"[0-9a-f]{24}", i)]
    sweep_once(db)
    cfg, out = cld_conf(), {}
    for m in db.query(Media).filter(Media.id.in_(ids)):
        if not m.ready:
            continue
        o = {"kind": m.kind, "once": bool(m.once), "caption": m.caption or "", "w": m.w, "h": m.h, "dur": m.dur, "mine": m.owner == u.player_id}
        if m.once:
            o["state"] = "gone" if m.gone else ("opened" if m.viewed_at else "new")
        elif not m.gone:
            o["url"], o["thumb"] = media_urls(m, cfg)
        out[m.id] = o
    return jsonify(media=out)


@app.post("/api/media/<mid>/open")
@authed
def media_open(db, u, mid):
    m = db.get(Media, mid)
    if not m or not m.once or not m.ready:
        return jsonify(error="Media tidak ditemukan."), 404
    if m.owner == u.player_id or m.to_id != u.player_id:
        return jsonify(error="Tidak bisa dibuka."), 403
    # pembaruan bersyarat: hanya satu permintaan yang berhasil menandai "sudah dibuka"
    n = db.query(Media).filter(Media.id == mid, Media.viewed_at.is_(None), Media.gone.is_(False)).update({"viewed_at": datetime.utcnow()}, synchronize_session=False)
    db.commit()
    if not n:
        return jsonify(error="Sudah dibuka dan tidak bisa dilihat lagi."), 410
    if m.provider == "db":
        return jsonify(kind=m.kind, data=m.data, caption=m.caption or "")
    return jsonify(kind=m.kind, url=media_urls(m, cld_conf())[0], caption=m.caption or "")


@app.post("/api/media/<mid>/done")
@authed
def media_done(db, u, mid):
    m = db.get(Media, mid)
    if m and m.once and m.to_id == u.player_id and m.viewed_at and not m.gone:
        cld_destroy(m)
        m.data, m.gone = "", True
        db.commit()
    return jsonify(ok=True)


@app.post("/api/stickers")
@authed
def sticker_up(db, u):
    if not rl(db, "stk:" + u.player_id, 40, 600):
        return jsonify(error="Terlalu banyak unggahan stiker. Tunggu sebentar."), 429
    d = (request.get_json(silent=True) or {}).get("data") or ""
    if len(d) > 120000 or not STK_DATA.match(d):
        return jsonify(error="Stiker tidak valid atau terlalu besar."), 400
    sid = hashlib.sha256(d.encode()).hexdigest()[:24]
    if not db.get(Sticker, sid):
        db.add(Sticker(id=sid, data=d))
        db.commit()
    return jsonify(id=sid)


def purge_room(db, rid):
    db.query(Message).filter(Message.to_id == "R-%d" % rid).delete(synchronize_session=False)
    db.query(RoomMember).filter(RoomMember.room_id == rid).delete(synchronize_session=False)
    db.query(RoomExt).filter(RoomExt.room_id == rid).delete(synchronize_session=False)
    db.query(Room).filter(Room.id == rid).delete(synchronize_session=False)


def purge_user(db, pid):
    for m in db.query(Media).filter(Media.owner == pid, Media.provider == "cld").limit(15).all():
        cld_destroy(m)  # hapus juga berkas di Cloudinary (maks 15 sekali jalan)
    for r in db.query(Room).filter_by(owner=pid).all():
        purge_room(db, r.id)
    for M, col in ID_COLS:
        c = getattr(M, col)
        db.query(M).filter(c == pid).delete(synchronize_session=False)
    for M, col in ((UserFlag, "player_id"), (EmailOk, "player_id"), (PrivPref, "player_id"), (PushSub, "player_id"), (PwChange, "player_id"),
                   (Block, "owner"), (Block, "target"), (Report, "reporter"), (StaffRole, "player_id")):
        c = getattr(M, col)
        db.query(M).filter(c == pid).delete(synchronize_session=False)
    # User sudah terhapus lewat ID_COLS (User.player_id)


def target_user(db, u, pid, allow_self=False):
    """Pengguna yang boleh dikenai tindakan owner (bukan akun resmi / owner / diri sendiri)."""
    t = db.query(User).filter_by(player_id=pid).first()
    if not t or t.player_id == OFFICIAL:
        return None, (jsonify(error="Pengguna tidak ditemukan."), 404)
    if not allow_self and (is_owner(t) or t.id == u.id):
        return None, (jsonify(error="Akun owner tidak bisa dikenai tindakan ini."), 400)
    if is_mod(u) and is_mod(t):
        return None, (jsonify(error="Moderator tidak bisa menindak moderator lain."), 400)
    return t, None


def iso(dt):
    return dt.isoformat() + "Z" if dt else None


@app.get("/api/admin/stats")
@staff_only
def adm_stats(db, u):
    now = datetime.utcnow()
    day = now - timedelta(days=1)
    real = User.player_id != OFFICIAL
    return jsonify(
        users=db.query(func.count(User.id)).filter(real).scalar() or 0,
        new24=db.query(func.count(User.id)).filter(real, User.created_at > day).scalar() or 0,
        online=db.query(func.count(ProfileExt.player_id)).filter(ProfileExt.last_seen > now - timedelta(seconds=90)).scalar() or 0,
        msgs24=db.query(func.count(Message.id)).filter(Message.kind == "text", Message.created_at > day).scalar() or 0,
        groups=db.query(func.count(Room.id)).filter(Room.kind == "group").scalar() or 0,
        channels=db.query(func.count(Room.id)).filter(Room.kind == "channel").scalar() or 0,
        banned=len(_cache["banned"]))


@app.get("/api/admin/users")
@staff_only
def adm_users(db, u):
    q = (request.args.get("q") or "").strip().replace("%", "").replace("_", "")[:40]
    qs = db.query(User).filter(User.player_id != OFFICIAL)
    if q:
        qs = qs.filter(or_(User.full_name.ilike("%" + q + "%"), User.player_id.like(q + "%")))
    rows = qs.order_by(User.id.desc()).limit(60).all()
    ext = {e.player_id: e for e in db.query(ProfileExt).filter(ProfileExt.player_id.in_([x.player_id for x in rows]))}
    now, out = datetime.utcnow(), []
    for x in rows:
        ls = ext[x.player_id].last_seen if x.player_id in ext else None
        out.append({"player_id": x.player_id, "full_name": x.full_name, "created_at": iso(x.created_at), "last_seen": iso(ls),
                    "online": bool(ls and (now - ls).total_seconds() < 90), "verified": is_verified(x),
                    "owner": is_owner(x), "mod": is_mod(x), "banned": x.player_id in _cache["banned"]})
    return jsonify(users=out)


def set_flag(db, pid, **kw):
    f = db.get(UserFlag, pid) or UserFlag(player_id=pid, banned=False)
    for k, v in kw.items():
        setattr(f, k, v)
    db.add(f)
    db.commit()
    _cache["t"] = 0.0  # muat ulang cache pada permintaan berikutnya


@app.post("/api/admin/users/<pid>/verify")
@owner_only
def adm_verify(db, u, pid):
    t, err = target_user(db, u, pid, allow_self=True)
    if err:
        return err
    val = bool((request.get_json(silent=True) or {}).get("value"))
    set_flag(db, t.player_id, verified=val)
    audit(db, u, "verify_on" if val else "verify_off", t.player_id, t.full_name)
    return jsonify(ok=True)


@app.post("/api/admin/users/<pid>/block")
@staff_only
def adm_block(db, u, pid):
    t, err = target_user(db, u, pid)
    if err:
        return err
    val = bool((request.get_json(silent=True) or {}).get("value"))
    set_flag(db, t.player_id, banned=val)
    audit(db, u, "block" if val else "unblock", t.player_id, t.full_name)
    return jsonify(ok=True)


@app.post("/api/admin/users/<pid>/role")
@owner_only
def adm_role(db, u, pid):
    """Jadikan atau cabut peran moderator. Hanya owner."""
    t, err = target_user(db, u, pid)
    if err:
        return err
    on = bool((request.get_json(silent=True) or {}).get("value"))
    cur = db.get(StaffRole, t.player_id)
    if on and not cur:
        db.add(StaffRole(player_id=t.player_id, role="mod", by=u.player_id))
    elif not on and cur:
        db.delete(cur)
    db.commit()
    _cache["t"] = 0.0
    audit(db, u, "mod_on" if on else "mod_off", t.player_id, t.full_name)
    return jsonify(ok=True)


@app.get("/api/admin/audit")
@owner_only
def adm_audit(db, u):
    rows = db.query(AuditLog).order_by(AuditLog.id.desc()).limit(80).all()
    ids = list({r.actor for r in rows})
    names = {x.player_id: x.full_name for x in db.query(User).filter(User.player_id.in_(ids))} if ids else {}
    return jsonify(log=[{"id": r.id, "actor": r.actor, "actor_name": names.get(r.actor, r.actor), "action": r.action,
                         "target": r.target or "", "detail": r.detail or "", "t": iso(r.created_at)} for r in rows])


@app.delete("/api/admin/users/<pid>")
@owner_only
def adm_delete_user(db, u, pid):
    t, err = target_user(db, u, pid)
    if err:
        return err
    pid_, nm = t.player_id, t.full_name
    purge_user(db, pid_)
    db.commit()
    _cache["t"] = 0.0
    audit(db, u, "delete_user", pid_, nm)
    return jsonify(ok=True)


@app.get("/api/admin/rooms")
@owner_only
def adm_rooms(db, u):
    rooms = db.query(Room).order_by(Room.id.desc()).limit(100).all()
    cnt = {rid: n for rid, n in db.query(RoomMember.room_id, func.count(RoomMember.id)).group_by(RoomMember.room_id)}
    names = {x.player_id: x.full_name for x in db.query(User).filter(User.player_id.in_([r.owner for r in rooms]))}
    return jsonify(rooms=[{"id": r.id, "kind": r.kind, "name": r.name, "owner": names.get(r.owner, r.owner), "count": cnt.get(r.id, 0)} for r in rooms])


@app.delete("/api/admin/rooms/<int:rid>")
@owner_only
def adm_delete_room(db, u, rid):
    r = db.get(Room, rid)
    if not r:
        return jsonify(error="Tidak ditemukan."), 404
    nm = r.name
    purge_room(db, rid)
    db.commit()
    audit(db, u, "delete_room", "R-%d" % rid, nm)
    return jsonify(ok=True)


@app.get("/api/admin/security")
@owner_only
def adm_security(db, u):
    cs, cld = crypto_status(), cld_conf()
    turn = bool(os.getenv("METERED_API_KEY") or os.getenv("TURN_URL"))
    return jsonify(items=[
        {"name": "Kunci sesi (SECRET_KEY)", "ok": SECRET_OK, "note": "terisi" if SECRET_OK else "BELUM diisi atau terlalu pendek"},
        {"name": "Enkripsi pesan di database", "ok": cs == "aktif", "note": cs},
        {"name": "Penyimpanan video (Cloudinary)", "ok": bool(cld), "note": "terhubung" if cld else "belum diisi"},
        {"name": "Server TURN untuk panggilan", "ok": turn, "note": "terhubung" if turn else "belum diisi"},
        {"name": "Owner ditetapkan manual (OWNER_IDS)", "ok": bool(OWNER_IDS), "note": "ya" if OWNER_IDS else "belum, memakai akun pertama"}])


@app.post("/api/admin/banner")
@owner_only
def adm_banner(db, u):
    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()[:300]
    s_ = db.get(AppSetting, "announce") or AppSetting(key="announce")
    s_.value = text
    db.add(s_)
    db.commit()
    _cache["announce"] = text
    audit(db, u, "banner", "", text or "(reset)")
    return jsonify(announce=text or ANNOUNCE)


@app.post("/api/admin/announce")
@owner_only
def adm_announce(db, u):
    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()[:500]
    if not text:
        return jsonify(error="Isi pengumuman kosong."), 400
    pids = [p for (p,) in db.query(User.player_id).filter(User.player_id != OFFICIAL) if p not in _cache["banned"]]
    db.add_all([Message(sender=OFFICIAL, to_id=p, kind="text", body=enc(text)) for p in pids])
    db.commit()
    audit(db, u, "announce", "%d pengguna" % len(pids), text)
    return jsonify(sent=len(pids))


@app.get("/api/stickers/<sid>")
def sticker_get(sid):
    if not re.fullmatch(r"[0-9a-f]{24}", sid):
        return "", 404
    with Session() as db:
        st = db.get(Sticker, sid)
        data = st.data if st else None
    if not data:
        return "", 404
    head, b64 = data.split(",", 1)
    r = Response(base64.b64decode(b64), mimetype=head[5:head.index(";")])
    r.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return r


@app.get("/api/history")
@authed
def history(db, u):
    p, me_id = request.args.get("peer", ""), u.player_id
    if p.startswith("R-"):
        if not (p[2:].isdigit() and db.query(RoomMember.id).filter_by(room_id=int(p[2:]), player_id=me_id).first()):
            return jsonify(messages=[])
        cond = Message.to_id == p
    else:
        cond = or_((Message.sender == me_id) & (Message.to_id == p),
                   (Message.sender == p) & (Message.to_id == me_id))
    bl = blocked_list(db, me_id)
    blk = [~Message.sender.in_(bl)] if bl else []
    rows = db.query(Message).filter(Message.kind == "text", cond, *blk).order_by(Message.id.desc()).limit(200).all()
    return jsonify(messages=[m.public() for m in reversed(rows)])


@app.get("/api/poll")
@authed
def poll(db, u):
    """Long polling: kalau belum ada pesan baru, server menunggu (maks ~6 dtk) lalu menjawab begitu ada yang masuk.
    Tanpa ?after= hanya mengembalikan id terakhir."""
    touch(db, u.player_id)
    after = request.args.get("after", type=int)
    if after is None:
        return jsonify(events=[], last=db.query(func.max(Message.id)).scalar() or 0)
    deadline = time.time() + (6 if request.args.get("wait", type=int) else 0)
    cut = datetime.utcnow() - timedelta(seconds=90)
    bl = blocked_list(db, u.player_id)
    blk = [~Message.sender.in_(bl)] if bl else []  # pesan dari pengguna yang kamu blokir tidak diterima
    while True:
        tags = ["R-%d" % m.room_id for m in db.query(RoomMember).filter_by(player_id=u.player_id)]
        rows = (db.query(Message).filter(Message.id > after, or_(
                (Message.to_id == u.player_id) & or_(Message.kind == "text", Message.created_at > cut),
                Message.to_id.in_(tags) & (Message.sender != u.player_id)), *blk)
                .order_by(Message.id).limit(100).all())
        if rows or time.time() >= deadline:
            break
        db.rollback()  # lepas koneksi database selama menunggu
        time.sleep(0.4)
    return jsonify(events=[m.public() for m in rows], last=rows[-1].id if rows else after)


_ice = {"t": 0.0, "v": None}


@app.get("/api/ice")
@authed
def ice(db, u):
    """Daftar server STUN/TURN untuk panggilan. TURN (relay) diisi lewat env METERED_DOMAIN + METERED_API_KEY,
    atau TURN_URL + TURN_USER + TURN_PASS. Tanpa TURN, panggilan antar jaringan seluler sering gagal tersambung."""
    now = time.time()
    if _ice["v"] and now - _ice["t"] < 600:
        return jsonify(iceServers=_ice["v"], turn=any("turn" in str(x.get("urls")) for x in _ice["v"]))
    servers, dom, key = [{"urls": "stun:stun.l.google.com:19302"}], os.getenv("METERED_DOMAIN", "").strip(), os.getenv("METERED_API_KEY", "").strip()
    dom = dom.replace("https://", "").replace("http://", "").strip("/")
    if dom and key:
        try:
            import urllib.parse, urllib.request
            url = "https://%s/api/v1/turn/credentials?apiKey=%s" % (dom, urllib.parse.quote(key))
            with urllib.request.urlopen(url, timeout=4) as r:
                got = json.loads(r.read().decode())
            if isinstance(got, list) and got:
                servers = got
        except Exception as e:
            print("ambil TURN gagal:", e)
    elif os.getenv("TURN_URL"):
        servers.append({"urls": [x.strip() for x in os.getenv("TURN_URL").split(",")],
                        "username": os.getenv("TURN_USER", ""), "credential": os.getenv("TURN_PASS", "")})
    _ice.update(t=now, v=servers)
    return jsonify(iceServers=servers, turn=any("turn" in str(x.get("urls")) for x in servers))


@app.post("/api/profile")
@authed
def profile_post(db, u):
    d = request.get_json(silent=True) or {}
    p = db.get(Profile, u.player_id) or Profile(player_id=u.player_id)
    e = db.get(ProfileExt, u.player_id) or ProfileExt(player_id=u.player_id, public=True, show_seen=True)
    db.add(p)
    db.add(e)
    if "avatar" in d:
        a = d["avatar"] or ""
        p.avatar = a if safe_data_url(a, 150000) else ""
    if "status" in d:
        p.status = (d["status"] or "")[:80]
    if "cover" in d:
        c = d["cover"] or ""
        e.cover = c if safe_data_url(c, 200000) else ""
    if "public" in d:
        e.public = bool(d["public"])
    if "show_seen" in d:
        e.show_seen = bool(d["show_seen"])
    if d.get("story_vis") in ("all", "mutual", "none") or d.get("seen_vis") in ("all", "mutual", "none"):
        pr = db.get(PrivPref, u.player_id) or PrivPref(player_id=u.player_id, story_vis="all", seen_vis="all")
        db.add(pr)
        if d.get("story_vis") in ("all", "mutual", "none"):
            pr.story_vis = d["story_vis"]
        if d.get("seen_vis") in ("all", "mutual", "none"):
            pr.seen_vis = d["seen_vis"]
            e.show_seen = d["seen_vis"] != "none"
    db.commit()
    return jsonify(user=pub(u, prof(db, [u.player_id]), True))


def blocked_list(db, pid):
    return [b.target for b in db.query(Block).filter_by(owner=pid)]


def public_url():
    base = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
    if base:
        return base
    prod = os.getenv("VERCEL_PROJECT_PRODUCTION_URL", "").strip()
    return ("https://" + prod) if prod else request.host_url.rstrip("/")


def fire(fn, *a, wait=3.0):
    """Jalankan pekerjaan jaringan (email/push) di latar belakang, tunggu sebentar saja supaya respons tetap cepat."""
    t = threading.Thread(target=fn, args=a, daemon=True)
    t.start()
    t.join(wait)


def vtoken(u):
    return ser.dumps([u.id, hashlib.sha256(u.email.encode()).hexdigest()[:8]], salt="verify")


def send_verify(u):
    if not mailer.mail_ready():
        return False
    link = "%s/verify.html?t=%s" % (public_url(), vtoken(u))
    fire(mailer.send_mail, u.email, "Verifikasi email NOVA WAWA",
         "Halo %s,\n\nTap tautan ini untuk memverifikasi emailmu (berlaku 3 hari):\n%s\n\nKalau bukan kamu yang mendaftar, abaikan email ini.\n" % (u.full_name, link))
    return True


@app.post("/api/email/verify")
def email_verify():
    tok = (request.get_json(silent=True) or {}).get("token") or ""
    try:
        uid, h = ser.loads(tok, salt="verify", max_age=3 * 86400)
    except (BadSignature, SignatureExpired, TypeError, ValueError):
        return jsonify(error="Tautan tidak valid atau sudah kedaluwarsa."), 400
    with Session() as db:
        u = db.get(User, uid)
        if not u or hashlib.sha256(u.email.encode()).hexdigest()[:8] != h:
            return jsonify(error="Tautan tidak valid."), 400
        if not db.get(EmailOk, u.player_id):
            db.add(EmailOk(player_id=u.player_id, at=datetime.utcnow()))
            db.commit()
        return jsonify(ok=True)


@app.post("/api/email/resend")
@authed
def email_resend(db, u):
    if db.get(EmailOk, u.player_id):
        return jsonify(error="Emailmu sudah terverifikasi."), 400
    if not mailer.mail_ready():
        return jsonify(error="Pengiriman email belum diaktifkan oleh owner."), 503
    if not rl(db, "V:" + u.player_id, 3, 3600):
        return jsonify(error="Terlalu sering. Coba lagi nanti."), 429
    send_verify(u)
    return jsonify(ok=True)


@app.post("/api/forgot")
def forgot():
    email, ip = ((request.get_json(silent=True) or {}).get("email") or "").strip().lower()[:120], client_ip()
    if not mailer.mail_ready():
        return jsonify(error="Pemulihan lewat email belum diaktifkan. Hubungi owner NOVA WAWA."), 503
    with Session() as db:
        if too_many(db, "F:ip:" + ip, 6, 3600) or too_many(db, "F:em:" + email, 3, 3600):
            return jsonify(error="Terlalu banyak permintaan. Coba lagi nanti."), 429
        note_hit(db, "F:ip:" + ip)
        note_hit(db, "F:em:" + email)
        u = db.query(User).filter_by(email=email).first()
        if u and u.player_id != OFFICIAL and u.player_id not in flags(db)["banned"]:
            link = "%s/reset.html?t=%s" % (public_url(), ser.dumps([u.id, tokver(u)], salt="reset"))
            fire(mailer.send_mail, u.email, "Atur ulang password NOVA WAWA",
                 "Halo %s,\n\nTap tautan ini untuk membuat password baru (berlaku 1 jam, hanya sekali pakai):\n%s\n\nKalau bukan kamu yang meminta, abaikan email ini. Passwordmu tidak berubah.\n" % (u.full_name, link))
        return jsonify(ok=True)  # jawaban sama untuk email terdaftar maupun tidak (mencegah menebak email)


@app.post("/api/reset")
def reset_password():
    d, ip = request.get_json(silent=True) or {}, client_ip()
    with Session() as db:
        if not rl(db, "X:ip:" + ip, 15, 3600):
            return jsonify(error="Terlalu banyak percobaan. Coba lagi nanti."), 429
        try:
            uid, tv = ser.loads(d.get("token") or "", salt="reset", max_age=3600)
        except (BadSignature, SignatureExpired, TypeError, ValueError):
            return jsonify(error="Tautan tidak valid atau sudah kedaluwarsa. Minta tautan baru."), 400
        u = db.get(User, uid)
        if not u or tokver(u) != tv or u.player_id == OFFICIAL:
            return jsonify(error="Tautan sudah dipakai atau tidak valid. Minta tautan baru."), 400
        new = d.get("password") or ""
        bad = pw_problem(new, u.full_name, u.email)
        if bad:
            return jsonify(error=bad), 400
        u.password_hash = bcrypt.hashpw(new.encode(), bcrypt.gensalt()).decode()
        ch = db.get(PwChange, u.player_id) or PwChange(player_id=u.player_id)
        ch.at = datetime.utcnow()
        db.add(ch)
        if not db.get(EmailOk, u.player_id):  # tautan sampai ke emailnya, berarti email terbukti miliknya
            db.add(EmailOk(player_id=u.player_id, at=datetime.utcnow()))
        db.commit()
        _cache["t"] = 0.0
        return jsonify(ok=True)


def vapid(db):
    if not push.READY:
        return None
    if _cache.get("vapid"):
        return _cache["vapid"]
    row = db.get(AppSetting, "vapid")
    if row and row.value:
        k = json.loads(row.value)
    else:
        pr, pb = push.new_vapid()
        k = {"priv": pr, "pub": pb}
        db.add(AppSetting(key="vapid", value=json.dumps(k)))
        db.commit()
    _cache["vapid"] = k
    return k


def preview(body):
    if STK_RE.match(body or ""):
        return "Stiker"
    mm = MED_RE.match(body or "")
    if mm:
        return ("Video" if mm.group(1) == "v" else "Foto") + (" sekali lihat" if mm.group(2) else "")
    return (body or "")[:120]


def notify(db, u, to, kind, body):
    """Kirim notifikasi push ke penerima yang sedang tidak membuka aplikasi."""
    k = vapid(db)
    if not k:
        return
    if to.startswith("R-") and to[2:].isdigit():
        r = db.get(Room, int(to[2:]))
        if not r:
            return
        targets, title, url = [m.player_id for m in db.query(RoomMember).filter_by(room_id=r.id) if m.player_id != u.player_id], r.name, to
    else:
        targets, title, url = [to], u.full_name, u.player_id
    if kind == "sig":
        try:
            sg = json.loads(body)
        except ValueError:
            return
        if sg.get("type") != "offer":
            return
        text, tag = ("Panggilan video masuk" if (sg.get("data") or {}).get("video") else "Panggilan suara masuk"), "call"
    else:
        text, tag = preview(body), "chat-" + url
        if to.startswith("R-"):
            text = u.full_name + ": " + text
    if not targets:
        return
    blocked = {b.owner for b in db.query(Block).filter(Block.target == u.player_id, Block.owner.in_(targets))}
    cut = datetime.utcnow() - timedelta(seconds=20)
    active = {e.player_id for e in db.query(ProfileExt).filter(ProfileExt.player_id.in_(targets), ProfileExt.last_seen > cut)}
    targets = [t for t in targets if t not in blocked and t not in active]
    if not targets:
        return
    subs = [{"endpoint": x.endpoint, "p256dh": x.p256dh, "auth": x.auth} for x in db.query(PushSub).filter(PushSub.player_id.in_(targets)).limit(200)]
    if not subs:
        return
    payload = {"title": title[:60], "body": text, "url": "/dashboard.html#chat=" + url, "tag": tag}
    subject = os.getenv("VAPID_SUBJECT", "").strip() or public_url()
    dead, threads = [], []

    def work(sub):
        if push.send_push(sub, payload, k["priv"], k["pub"], subject) == "gone":
            dead.append(sub["endpoint"])
    for sub in subs:
        t = threading.Thread(target=work, args=(sub,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(2.5)
    if dead:
        db.query(PushSub).filter(PushSub.endpoint.in_(dead)).delete(synchronize_session=False)
        db.commit()


@app.get("/api/push/key")
@authed
def push_key(db, u):
    k = vapid(db)
    return (jsonify(key=k["pub"]) if k else (jsonify(error="Notifikasi belum didukung server."), 503))


@app.post("/api/push/subscribe")
@authed
def push_subscribe(db, u):
    d = request.get_json(silent=True) or {}
    ep, ks = d.get("endpoint") or "", d.get("keys") or {}
    p256, au = ks.get("p256dh") or "", ks.get("auth") or ""
    if not push.host_ok(ep) or not (80 <= len(p256) <= 100) or not (16 <= len(au) <= 40):
        return jsonify(error="Langganan notifikasi tidak valid."), 400
    row = db.query(PushSub).filter_by(endpoint=ep).first()
    if row:
        row.player_id, row.p256dh, row.auth = u.player_id, p256, au
    else:
        old = db.query(PushSub).filter_by(player_id=u.player_id).order_by(PushSub.id).all()
        for x in old[:max(0, len(old) - 4)]:  # simpan maksimal 5 perangkat
            db.delete(x)
        db.add(PushSub(player_id=u.player_id, endpoint=ep, p256dh=p256, auth=au))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/push/unsubscribe")
@authed
def push_unsubscribe(db, u):
    ep = (request.get_json(silent=True) or {}).get("endpoint") or ""
    db.query(PushSub).filter(PushSub.endpoint == ep, PushSub.player_id == u.player_id).delete(synchronize_session=False)
    db.commit()
    return jsonify(ok=True)


@app.post("/api/push/test")
@authed
def push_test(db, u):
    k = vapid(db)
    subs = [{"endpoint": x.endpoint, "p256dh": x.p256dh, "auth": x.auth} for x in db.query(PushSub).filter_by(player_id=u.player_id)]
    if not k or not subs:
        return jsonify(error="Notifikasi belum aktif di perangkat ini."), 400
    res = [push.send_push(s_, {"title": "NOVA WAWA", "body": "Notifikasi berhasil diaktifkan.", "url": "/dashboard.html", "tag": "test"}, k["priv"], k["pub"], public_url()) for s_ in subs]
    return jsonify(ok="ok" in res, results=res)


REASONS = {"spam", "pelecehan", "penipuan", "tidak_pantas", "lainnya"}


@app.post("/api/reports")
@authed
def report_post(db, u):
    d = request.get_json(silent=True) or {}
    target, reason = str(d.get("target") or "").strip().upper(), d.get("reason")
    if reason not in REASONS or target in (u.player_id, OFFICIAL) or not db.query(User.id).filter_by(player_id=target).first():
        return jsonify(error="Laporan tidak valid."), 400
    if not rl(db, "report:" + u.player_id, 10, 86400):
        return jsonify(error="Batas laporan harian tercapai."), 429
    db.add(Report(reporter=u.player_id, target=target, reason=reason, detail=clean(d.get("detail"), 300)))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/admin/reports")
@staff_only
def adm_reports(db, u):
    st = request.args.get("status") or "baru"
    rows = db.query(Report).filter(Report.status == st).order_by(Report.id.desc()).limit(60).all()
    ids = list({x for r in rows for x in (r.reporter, r.target)})
    names = {x.player_id: x.full_name for x in db.query(User).filter(User.player_id.in_(ids))} if ids else {}
    total = {t: n for t, n in db.query(Report.target, func.count(Report.id)).group_by(Report.target)} if rows else {}
    return jsonify(reports=[{"id": r.id, "reporter": r.reporter, "reporter_name": names.get(r.reporter, r.reporter), "target": r.target,
                             "target_name": names.get(r.target, r.target), "reason": r.reason, "detail": r.detail or "",
                             "t": iso(r.created_at), "count": total.get(r.target, 1), "blocked": r.target in _cache["banned"]} for r in rows])


@app.post("/api/admin/reports/<int:rid>")
@staff_only
def adm_report_set(db, u, rid):
    r = db.get(Report, rid)
    if not r:
        return jsonify(error="Tidak ditemukan."), 404
    r.status = "selesai" if (request.get_json(silent=True) or {}).get("status") == "selesai" else "diabaikan"
    db.commit()
    audit(db, u, "report_" + r.status, r.target, "laporan #%d (%s)" % (r.id, r.reason))
    return jsonify(ok=True)


@app.post("/api/account/delete")
@authed
def account_delete(db, u):
    if is_owner(u):
        return jsonify(error="Akun owner tidak bisa dihapus dari sini."), 400
    if too_many(db, "D:" + u.player_id, 5, 3600):
        return jsonify(error="Terlalu banyak percobaan. Coba lagi nanti."), 429
    try:
        ok = bcrypt.checkpw(((request.get_json(silent=True) or {}).get("password") or "").encode()[:72], u.password_hash.encode())
    except ValueError:
        ok = False
    if not ok:
        note_hit(db, "D:" + u.player_id)
        return jsonify(error="Password salah."), 400
    purge_user(db, u.player_id)
    db.commit()
    _cache["t"] = 0.0
    return jsonify(ok=True)


@app.get("/api/health")
def health():
    with Session() as db:
        db.query(func.count(User.id)).scalar()
    return jsonify(ok=True, t=int(time.time()))


@app.get("/api/blocks")
@authed
def blocks_get(db, u):
    ids = blocked_list(db, u.player_id)
    names = {x.player_id: x.full_name for x in db.query(User).filter(User.player_id.in_(ids))} if ids else {}
    return jsonify(blocks=[{"player_id": i, "full_name": names.get(i, i)} for i in ids])


@app.post("/api/blocks/<pid>")
@authed
def blocks_set(db, u, pid):
    pid = pid.strip().upper()
    if pid == OFFICIAL or pid == u.player_id or not db.query(User.id).filter_by(player_id=pid).first():
        return jsonify(error="Pengguna ini tidak bisa diblokir."), 400
    on, cur = bool((request.get_json(silent=True) or {}).get("value")), db.get(Block, (u.player_id, pid))
    if on and not cur:
        db.add(Block(owner=u.player_id, target=pid))
    elif not on and cur:
        db.delete(cur)
    db.commit()
    return jsonify(ok=True)


@app.get("/api/presence")
@authed
def presence(db, u):
    """Status online / terakhir dilihat teman yang tersimpan (hanya yang mengizinkan)."""
    ids = [c.contact_pid for c in db.query(Contact).filter_by(owner=u.player_id)]
    now, out = datetime.utcnow(), {}
    mu = {(c.owner, c.contact_pid) for c in db.query(Contact).filter(Contact.contact_pid == u.player_id, Contact.owner.in_(ids))} if ids else set()
    for pid, d in prof(db, ids).items():
        if d["last_seen"] and vis_ok(d["seen_vis"], pid, u.player_id, mu):
            out[pid] = {"online": (now - d["last_seen"]).total_seconds() < ONLINE_SEC,
                        "seen": d["last_seen"].isoformat() + "Z"}
    return jsonify(presence=out, announce=_cache["announce"] or ANNOUNCE)


@app.get("/api/chats")
@authed
def chats(db, u):
    """Pesan terakhir tiap percakapan, untuk daftar chat."""
    me_id = u.player_id
    tags = ["R-%d" % m.room_id for m in db.query(RoomMember).filter_by(player_id=me_id)]
    bl = blocked_list(db, me_id)
    blk = [~Message.sender.in_(bl)] if bl else []
    rows = (db.query(Message).filter(Message.kind == "text", or_(
            Message.sender == me_id, Message.to_id == me_id, Message.to_id.in_(tags)), *blk)
            .order_by(Message.id.desc()).limit(400).all())
    seen, out = set(), []
    for m in rows:
        key = m.to_id if (m.to_id.startswith("R-") or m.sender == me_id) else m.sender
        if key in seen:
            continue
        seen.add(key)
        out.append({"key": key, "body": dec(m.body)[:120], "t": m.created_at.isoformat() + "Z", "mine": m.sender == me_id})
    return jsonify(chats=out)


@app.get("/api/stories")
@authed
def stories_get(db, u):
    mine = [c.contact_pid for c in db.query(Contact).filter_by(owner=u.player_id)]
    pv, mu = prof(db, mine), {(c.owner, c.contact_pid) for c in db.query(Contact).filter(Contact.contact_pid == u.player_id, Contact.owner.in_(mine))} if mine else set()
    ids = [u.player_id] + [p for p in mine if vis_ok(pv[p]["story_vis"], p, u.player_id, mu)]
    cut = datetime.utcnow() - timedelta(hours=24)
    rows = db.query(Story).filter(Story.owner.in_(ids), Story.created_at > cut).order_by(Story.id).all()
    return jsonify(stories=[{"id": s.id, "owner": s.owner, "kind": s.kind, "body": s.body,
                             "t": s.created_at.isoformat() + "Z"} for s in rows])


@app.post("/api/stories")
@authed
def stories_post(db, u):
    d = request.get_json(silent=True) or {}
    kind, body = (d.get("kind") if d.get("kind") in ("img", "vid") else "text"), d.get("body") or ""
    if not body or (kind == "text" and len(body) > 300) or \
            (kind == "img" and not safe_data_url(body, 200000)):
        return jsonify(error="Story tidak valid atau terlalu besar."), 400
    if kind == "vid":
        mm = MED_RE.match(body)
        med = mm and db.get(Media, mm.group(3))
        if not med or med.owner != u.player_id or not med.ready or med.sent or med.kind != "video" or med.once:
            return jsonify(error="Video tidak valid."), 400
        med.sent = True
    db.add(Story(owner=u.player_id, kind=kind, body=body))
    db.commit()
    return jsonify(ok=True), 201


@app.get("/api/rooms")
@authed
def rooms_get(db, u):
    mine = {m.room_id for m in db.query(RoomMember).filter_by(player_id=u.player_id)}
    cnt = dict(db.query(RoomMember.room_id, func.count(RoomMember.id)).group_by(RoomMember.room_id).all())
    av_ = {x.room_id: x.avatar or "" for x in db.query(RoomExt)}
    return jsonify(rooms=[{"id": r.id, "kind": r.kind, "name": r.name, "about": r.about, "owner": r.owner,
                           "count": cnt.get(r.id, 0), "joined": r.id in mine, "avatar": av_.get(r.id, "")}
                          for r in db.query(Room).order_by(Room.id.desc()) if r.kind == "channel" or r.id in mine])


def clean(t, n):
    return re.sub(r"[\x00-\x1f\x7f]", "", (t or "")).strip()[:n]


@app.post("/api/rooms")
@authed
def rooms_post(db, u):
    d = request.get_json(silent=True) or {}
    kind, name = ("channel" if d.get("kind") == "channel" else "group"), clean(d.get("name"), 60)
    if not name:
        return jsonify(error="Nama wajib diisi."), 400
    if not rl(db, "room:" + u.player_id, 10, 3600):
        return jsonify(error="Terlalu banyak membuat grup/saluran. Coba lagi nanti."), 429
    if db.query(func.count(Room.id)).filter(Room.owner == u.player_id).scalar() >= 30:
        return jsonify(error="Batas 30 grup/saluran per akun tercapai."), 400
    raw = d.get("members") or []
    if not isinstance(raw, list) or len(raw) > 255:
        return jsonify(error="Anggota maksimal 255 orang."), 400
    r = Room(kind=kind, name=name, about=clean(d.get("about"), 200), owner=u.player_id)
    db.add(r)
    db.flush()
    ids = {u.player_id}
    if kind == "group":
        want = {str(x).strip().upper() for x in raw if isinstance(x, (str, int))}
        found = {x.player_id for x in db.query(User).filter(User.player_id.in_(list(want)))} if want else set()
        nope = {b.owner for b in db.query(Block).filter(Block.target == u.player_id, Block.owner.in_(list(found)))} if found else set()
        ids |= (found - nope - {OFFICIAL})  # yang memblokirmu tidak ikut ditambahkan
    for p in ids:
        db.add(RoomMember(room_id=r.id, player_id=p))
    db.commit()
    return jsonify(id=r.id), 201


@app.post("/api/rooms/<int:rid>/join")
@authed
def rooms_join(db, u, rid):
    if not rl(db, "join:" + u.player_id, 40, 3600):
        return jsonify(error="Terlalu banyak. Coba lagi nanti."), 429
    r = db.get(Room, rid)
    if not r or r.kind != "channel":
        return jsonify(error="Saluran tidak ditemukan."), 404
    if not db.query(RoomMember.id).filter_by(room_id=rid, player_id=u.player_id).first():
        db.add(RoomMember(room_id=rid, player_id=u.player_id))
        db.commit()
    return jsonify(ok=True)


def room_notice(db, rid, text):
    """Pesan sistem di dalam grup (dikirim oleh akun resmi)."""
    db.add(Message(sender=OFFICIAL, to_id="R-%d" % rid, kind="text", body=enc(text)))


def my_room(db, u, rid, need_owner=False):
    """(room, error). Pemanggil harus anggota; kalau need_owner, harus pemilik ruang."""
    r = db.get(Room, rid)
    if not r or not db.query(RoomMember.id).filter_by(room_id=rid, player_id=u.player_id).first():
        return None, (jsonify(error="Grup tidak ditemukan."), 404)
    if need_owner and r.owner != u.player_id:
        return None, (jsonify(error="Hanya pemilik yang bisa melakukan ini."), 403)
    return r, None


@app.get("/api/rooms/<int:rid>/members")
@authed
def room_members(db, u, rid):
    r, err = my_room(db, u, rid)
    if err:
        return err
    ids = [m.player_id for m in db.query(RoomMember).filter_by(room_id=rid).order_by(RoomMember.id).limit(300)]
    pr = prof(db, ids)
    users = {x.player_id: x for x in db.query(User).filter(User.player_id.in_(ids))}
    return jsonify(members=[{"player_id": i, "full_name": users[i].full_name, "avatar": pr[i]["avatar"] if pr[i]["public"] else "",
                             "room_owner": i == r.owner} for i in ids if i in users])


@app.post("/api/rooms/<int:rid>/leave")
@authed
def room_leave(db, u, rid):
    r, err = my_room(db, u, rid)
    if err:
        return err
    if r.kind == "channel" and r.owner == u.player_id:
        return jsonify(error="Pemilik saluran tidak bisa keluar. Hapus saluran lewat owner aplikasi, atau minta bantuan admin."), 400
    db.query(RoomMember).filter_by(room_id=rid, player_id=u.player_id).delete(synchronize_session=False)
    left = db.query(RoomMember).filter_by(room_id=rid).order_by(RoomMember.id).first()
    if r.kind == "group":
        if not left:
            purge_room(db, rid)  # tidak ada anggota tersisa
            db.commit()
            return jsonify(ok=True)
        if r.owner == u.player_id:  # pemilik keluar: anggota paling lama jadi pemilik baru
            r.owner = left.player_id
            nu = db.query(User).filter_by(player_id=left.player_id).first()
            room_notice(db, rid, "%s keluar dari grup. %s sekarang pemilik grup." % (u.full_name, nu.full_name if nu else left.player_id))
        else:
            room_notice(db, rid, "%s keluar dari grup." % u.full_name)
    db.commit()
    return jsonify(ok=True)


@app.post("/api/rooms/<int:rid>/kick")
@authed
def room_kick(db, u, rid):
    r, err = my_room(db, u, rid, need_owner=True)
    if err:
        return err
    if r.kind != "group":
        return jsonify(error="Hanya untuk grup."), 400
    if not rl(db, "kick:" + u.player_id, 30, 3600):
        return jsonify(error="Terlalu banyak. Coba lagi nanti."), 429
    pid = str((request.get_json(silent=True) or {}).get("player_id") or "").strip().upper()
    if pid == u.player_id:
        return jsonify(error="Gunakan Keluar dari grup untuk dirimu sendiri."), 400
    m = db.query(RoomMember).filter_by(room_id=rid, player_id=pid).first()
    if not m:
        return jsonify(error="Dia bukan anggota grup ini."), 404
    t = db.query(User).filter_by(player_id=pid).first()
    db.delete(m)
    room_notice(db, rid, "%s dikeluarkan dari grup." % (t.full_name if t else pid))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/rooms/<int:rid>/edit")
@authed
def room_edit(db, u, rid):
    r, err = my_room(db, u, rid, need_owner=True)
    if err:
        return err
    if not rl(db, "redit:" + u.player_id, 30, 3600):
        return jsonify(error="Terlalu banyak perubahan. Coba lagi nanti."), 429
    d = request.get_json(silent=True) or {}
    jenis = "grup" if r.kind == "group" else "saluran"
    if "name" in d:
        name = clean(d.get("name"), 60)
        if not name:
            return jsonify(error="Nama wajib diisi."), 400
        if name != r.name:
            r.name = name
            if r.kind == "group":
                room_notice(db, rid, "%s mengganti nama grup menjadi \"%s\"." % (u.full_name, name))
    if "about" in d:
        r.about = clean(d.get("about"), 200)
    if "avatar" in d:
        a = d.get("avatar") or ""
        if a and not safe_data_url(a, 60000):
            return jsonify(error="Foto %s tidak valid atau terlalu besar." % jenis), 400
        e = db.get(RoomExt, rid) or RoomExt(room_id=rid)
        e.avatar = a
        db.add(e)
        if r.kind == "group":
            room_notice(db, rid, "%s %s foto grup." % (u.full_name, "mengganti" if a else "menghapus"))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/calls")
@authed
def calls(db, u):
    me_id = u.player_id
    rows = db.query(Call).filter(or_(Call.caller == me_id, Call.callee == me_id)).order_by(Call.id.desc()).limit(50).all()
    return jsonify(calls=[{"peer": c.callee if c.caller == me_id else c.caller, "out": c.caller == me_id,
                           "video": bool(c.video), "status": c.status,
                           "t": c.created_at.isoformat() + "Z"} for c in rows])


@app.get("/")
def home():
    return send_from_directory(BASE, "index.html")


@app.get("/<path:f>")
def static_files(f):
    if f in PUBLIC_FILES:
        r = send_from_directory(BASE, f)
        if f == "sw.js":
            r.headers["Cache-Control"] = "no-cache"
            r.headers["Service-Worker-Allowed"] = "/"
        elif f == "manifest.json":
            r.mimetype = "application/manifest+json"
        return r
    return "Not found", 404


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
