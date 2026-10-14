import os, re, json, time, base64, hashlib, secrets, string
from datetime import datetime, timedelta
from functools import wraps
import bcrypt
from dotenv import load_dotenv
load_dotenv()
from flask import Flask, request, jsonify, send_from_directory, Response
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from database import Session, User, Contact, Message, Profile, ProfileExt, Sticker, AppSetting, UserFlag, Media, Story, Room, RoomMember, Call, init_db

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
ser = URLSafeTimedSerializer(os.getenv("SECRET_KEY", "dev-secret-change-me"))
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
PUBLIC_FILES = {"index.html", "login.html", "dashboard.html", "style.css", "script.js", "logo.png", "login.mp4", "intro.mp4"}


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


_cache = {"t": 0.0, "banned": set(), "vfy": {}, "first": None, "announce": ""}


def flags(db):
    """Daftar blokir, centang manual, dan banner. Disimpan di memori ~15 detik supaya tidak membebani database."""
    if time.time() - _cache["t"] > 15:
        try:
            rows = db.query(UserFlag).all()
            a = db.get(AppSetting, "announce")
            _cache.update(t=time.time(), banned={r.player_id for r in rows if r.banned},
                          vfy={r.player_id: r.verified for r in rows if r.verified is not None},
                          announce=(a.value if a and a.value else ""))
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


def is_verified(u):
    v = _cache["vfy"].get(u.player_id)
    if v is not None:
        return v
    return u.player_id == OFFICIAL or is_owner(u) or u.id == _cache["first"] or u.player_id in VERIFIED


def authed(f):
    @wraps(f)
    def w(*a, **k):
        with Session() as db:
            try:
                u = db.get(User, ser.loads(request.headers.get("Authorization", "")[7:], max_age=7 * 86400))
            except (BadSignature, SignatureExpired):
                u = None
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


EMPTY = {"avatar": "", "status": "", "cover": "", "public": True, "show_seen": True, "last_seen": None}


def prof(db, ids):
    out = {i: dict(EMPTY) for i in ids}
    for p in db.query(Profile).filter(Profile.player_id.in_(ids)):
        out[p.player_id].update(avatar=p.avatar or "", status=p.status or "")
    for e in db.query(ProfileExt).filter(ProfileExt.player_id.in_(ids)):
        out[e.player_id].update(cover=e.cover or "", public=e.public is not False,
                                show_seen=e.show_seen is not False, last_seen=e.last_seen)
    return out


def pub(u, pr, mine=False):
    d = pr.get(u.player_id, EMPTY)
    o = {**u.public(), "verified": is_verified(u), "owner": is_owner(u)}
    if mine:
        o.update(avatar=d["avatar"], status=d["status"], cover=d["cover"], public=d["public"],
                 show_seen=d["show_seen"], announce=_cache["announce"] or ANNOUNCE, is_owner=is_owner(u), official=OFFICIAL, cld=bool(cld_conf()))
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
    if not name or "@" not in email or len(pw) < 6 or not 1900 <= year <= time.gmtime().tm_year:
        return jsonify(error="Data tidak valid. Password minimal 6 karakter."), 400
    hashed = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
    with Session() as db:
        if db.query(User.id).filter_by(email=email).first():
            return jsonify(error="Email sudah terdaftar."), 409
        for _ in range(5):
            u = User(player_id=new_pid(db), full_name=name, birth_year=year, email=email, password_hash=hashed)
            db.add(u)
            try:
                db.commit()
                return jsonify(token=ser.dumps(u.id), user=u.public()), 201
            except IntegrityError:
                db.rollback()
        return jsonify(error="Gagal membuat akun, coba lagi."), 500


@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    with Session() as db:
        u = db.query(User).filter_by(email=(d.get("email") or "").strip().lower()).first()
        if not u or u.player_id == OFFICIAL or not bcrypt.checkpw((d.get("password") or "").encode(), u.password_hash.encode()):
            return jsonify(error="Email atau password salah."), 401
        if u.player_id == OFFICIAL:
            return jsonify(error="Email atau password salah."), 401
        if u.player_id in flags(db)["banned"]:
            return jsonify(error="Akunmu diblokir oleh admin.", banned=True), 403
        return jsonify(token=ser.dumps(u.id), user=u.public())


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
    pid = ((request.get_json(silent=True) or {}).get("player_id") or "").strip().upper()
    t = db.query(User).filter_by(player_id=pid).first()
    if not t:
        return jsonify(error="ID tidak ditemukan."), 404
    if t.id == u.id:
        return jsonify(error="Itu ID kamu sendiri."), 400
    if not db.query(Contact.id).filter_by(owner=u.player_id, contact_pid=pid).first():
        db.add(Contact(owner=u.player_id, contact_pid=pid))
        db.commit()
    return jsonify(contact=t.public())


@app.post("/api/send")
@authed
def send(db, u):
    d = request.get_json(silent=True) or {}
    kind = "sig" if d.get("kind") == "sig" else "text"
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
    m = Message(sender=u.player_id, to_id=to, kind=kind, body=body)
    db.add(m)
    db.commit()
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
        u = "/api/media/%s/file" % m.id
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
    with Session() as db:
        m = db.get(Media, mid)
        data = m.data if m and m.provider == "db" and not m.once and not m.gone else ""
    if not data:
        return "", 404
    r = Response(base64.b64decode(data.split(",", 1)[1]), mimetype="image/jpeg")
    r.headers["Cache-Control"] = "public, max-age=31536000, immutable"
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
    db.query(Room).filter(Room.id == rid).delete(synchronize_session=False)


def purge_user(db, pid):
    for r in db.query(Room).filter_by(owner=pid).all():
        purge_room(db, r.id)
    for M, col in ID_COLS:
        c = getattr(M, col)
        db.query(M).filter(c == pid).delete(synchronize_session=False)
    db.query(UserFlag).filter(UserFlag.player_id == pid).delete(synchronize_session=False)
    # User sudah terhapus lewat ID_COLS (User.player_id)


def target_user(db, u, pid, allow_self=False):
    """Pengguna yang boleh dikenai tindakan owner (bukan akun resmi / owner / diri sendiri)."""
    t = db.query(User).filter_by(player_id=pid).first()
    if not t or t.player_id == OFFICIAL:
        return None, (jsonify(error="Pengguna tidak ditemukan."), 404)
    if not allow_self and (is_owner(t) or t.id == u.id):
        return None, (jsonify(error="Akun owner tidak bisa dikenai tindakan ini."), 400)
    return t, None


def iso(dt):
    return dt.isoformat() + "Z" if dt else None


@app.get("/api/admin/stats")
@owner_only
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
@owner_only
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
                    "owner": is_owner(x), "banned": x.player_id in _cache["banned"]})
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
    set_flag(db, t.player_id, verified=bool((request.get_json(silent=True) or {}).get("value")))
    return jsonify(ok=True)


@app.post("/api/admin/users/<pid>/block")
@owner_only
def adm_block(db, u, pid):
    t, err = target_user(db, u, pid)
    if err:
        return err
    set_flag(db, t.player_id, banned=bool((request.get_json(silent=True) or {}).get("value")))
    return jsonify(ok=True)


@app.delete("/api/admin/users/<pid>")
@owner_only
def adm_delete_user(db, u, pid):
    t, err = target_user(db, u, pid)
    if err:
        return err
    purge_user(db, t.player_id)
    db.commit()
    _cache["t"] = 0.0
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
    if not db.get(Room, rid):
        return jsonify(error="Tidak ditemukan."), 404
    purge_room(db, rid)
    db.commit()
    return jsonify(ok=True)


@app.post("/api/admin/banner")
@owner_only
def adm_banner(db, u):
    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()[:300]
    s_ = db.get(AppSetting, "announce") or AppSetting(key="announce")
    s_.value = text
    db.add(s_)
    db.commit()
    _cache["announce"] = text
    return jsonify(announce=text or ANNOUNCE)


@app.post("/api/admin/announce")
@owner_only
def adm_announce(db, u):
    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()[:500]
    if not text:
        return jsonify(error="Isi pengumuman kosong."), 400
    pids = [p for (p,) in db.query(User.player_id).filter(User.player_id != OFFICIAL) if p not in _cache["banned"]]
    db.add_all([Message(sender=OFFICIAL, to_id=p, kind="text", body=text) for p in pids])
    db.commit()
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
    rows = db.query(Message).filter(Message.kind == "text", cond).order_by(Message.id.desc()).limit(200).all()
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
    while True:
        tags = ["R-%d" % m.room_id for m in db.query(RoomMember).filter_by(player_id=u.player_id)]
        rows = (db.query(Message).filter(Message.id > after, or_(
                (Message.to_id == u.player_id) & or_(Message.kind == "text", Message.created_at > cut),
                Message.to_id.in_(tags) & (Message.sender != u.player_id)))
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
        p.avatar = a if a.startswith("data:image/") and len(a) < 150000 else ""
    if "status" in d:
        p.status = (d["status"] or "")[:80]
    if "cover" in d:
        c = d["cover"] or ""
        e.cover = c if c.startswith("data:image/") and len(c) < 200000 else ""
    if "public" in d:
        e.public = bool(d["public"])
    if "show_seen" in d:
        e.show_seen = bool(d["show_seen"])
    db.commit()
    return jsonify(user=pub(u, prof(db, [u.player_id]), True))


@app.get("/api/presence")
@authed
def presence(db, u):
    """Status online / terakhir dilihat teman yang tersimpan (hanya yang mengizinkan)."""
    ids = [c.contact_pid for c in db.query(Contact).filter_by(owner=u.player_id)]
    now, out = datetime.utcnow(), {}
    for pid, d in prof(db, ids).items():
        if d["show_seen"] and d["last_seen"]:
            out[pid] = {"online": (now - d["last_seen"]).total_seconds() < ONLINE_SEC,
                        "seen": d["last_seen"].isoformat() + "Z"}
    return jsonify(presence=out, announce=_cache["announce"] or ANNOUNCE)


@app.get("/api/chats")
@authed
def chats(db, u):
    """Pesan terakhir tiap percakapan, untuk daftar chat."""
    me_id = u.player_id
    tags = ["R-%d" % m.room_id for m in db.query(RoomMember).filter_by(player_id=me_id)]
    rows = (db.query(Message).filter(Message.kind == "text", or_(
            Message.sender == me_id, Message.to_id == me_id, Message.to_id.in_(tags)))
            .order_by(Message.id.desc()).limit(400).all())
    seen, out = set(), []
    for m in rows:
        key = m.to_id if (m.to_id.startswith("R-") or m.sender == me_id) else m.sender
        if key in seen:
            continue
        seen.add(key)
        out.append({"key": key, "body": m.body[:120], "t": m.created_at.isoformat() + "Z", "mine": m.sender == me_id})
    return jsonify(chats=out)


@app.get("/api/stories")
@authed
def stories_get(db, u):
    ids = [u.player_id] + [c.contact_pid for c in db.query(Contact).filter_by(owner=u.player_id)]
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
            (kind == "img" and (not body.startswith("data:image/") or len(body) > 200000)):
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
    return jsonify(rooms=[{"id": r.id, "kind": r.kind, "name": r.name, "about": r.about, "owner": r.owner,
                           "count": cnt.get(r.id, 0), "joined": r.id in mine}
                          for r in db.query(Room).order_by(Room.id.desc()) if r.kind == "channel" or r.id in mine])


@app.post("/api/rooms")
@authed
def rooms_post(db, u):
    d = request.get_json(silent=True) or {}
    kind, name = ("channel" if d.get("kind") == "channel" else "group"), (d.get("name") or "").strip()[:60]
    if not name:
        return jsonify(error="Nama wajib diisi."), 400
    r = Room(kind=kind, name=name, about=(d.get("about") or "")[:200], owner=u.player_id)
    db.add(r)
    db.flush()
    ids = {u.player_id}
    if kind == "group":
        ids |= {x for x in (d.get("members") or []) if db.query(User.id).filter_by(player_id=x).first()}
    for p in ids:
        db.add(RoomMember(room_id=r.id, player_id=p))
    db.commit()
    return jsonify(id=r.id), 201


@app.post("/api/rooms/<int:rid>/join")
@authed
def rooms_join(db, u, rid):
    r = db.get(Room, rid)
    if not r or r.kind != "channel":
        return jsonify(error="Saluran tidak ditemukan."), 404
    if not db.query(RoomMember.id).filter_by(room_id=rid, player_id=u.player_id).first():
        db.add(RoomMember(room_id=rid, player_id=u.player_id))
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
        return send_from_directory(BASE, f)
    return "Not found", 404


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
