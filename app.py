import os, json, time, secrets, string
from datetime import datetime, timedelta
from functools import wraps
import bcrypt
from dotenv import load_dotenv
load_dotenv()
from flask import Flask, request, jsonify, send_from_directory
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from database import Session, User, Contact, Message, Profile, ProfileExt, Story, Room, RoomMember, Call, init_db

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
ser = URLSafeTimedSerializer(os.getenv("SECRET_KEY", "dev-secret-change-me"))
init_db()

ONLINE_SEC = 25
VERIFIED = {x.strip().upper() for x in os.getenv("VERIFIED_IDS", "").split(",") if x.strip()}  # ID yang dapat centang biru
ANNOUNCE = os.getenv("ANNOUNCEMENT", "Selamat datang di NOVA WAWA. Simpan ID temanmu lalu mulai chat, telpon, atau video call.")
PUBLIC_FILES = {"index.html", "login.html", "dashboard.html", "style.css", "script.js", "logo.png"}


def new_pid(db):
    while True:  # ID angka acak 8 digit (tanpa awalan 0), diulang sampai belum dipakai
        pid = str(secrets.randbelow(90_000_000) + 10_000_000)
        if not db.query(User.id).filter_by(player_id=pid).first():
            return pid


ID_COLS = [(User, "player_id"), (Contact, "owner"), (Contact, "contact_pid"), (Message, "sender"), (Message, "to_id"),
           (Profile, "player_id"), (ProfileExt, "player_id"), (Story, "owner"), (Room, "owner"),
           (RoomMember, "player_id"), (Call, "caller"), (Call, "callee")]


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
            return f(db, u, *a, **k)
    return w


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
    o = {**u.public(), "verified": u.id == 1 or u.player_id in VERIFIED}
    if mine:
        o.update(avatar=d["avatar"], status=d["status"], cover=d["cover"], public=d["public"],
                 show_seen=d["show_seen"], announce=ANNOUNCE)
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
        if not u or not bcrypt.checkpw((d.get("password") or "").encode(), u.password_hash.encode()):
            return jsonify(error="Email atau password salah."), 401
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
    m = Message(sender=u.player_id, to_id=to, kind=kind, body=body)
    db.add(m)
    db.commit()
    return jsonify(m.public())


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
    """Short polling: pesan + sinyal panggilan baru. Tanpa ?after= hanya mengembalikan id terakhir."""
    touch(db, u.player_id)
    after = request.args.get("after", type=int)
    if after is None:
        return jsonify(events=[], last=db.query(func.max(Message.id)).scalar() or 0)
    cut = datetime.utcnow() - timedelta(seconds=90)
    tags = ["R-%d" % m.room_id for m in db.query(RoomMember).filter_by(player_id=u.player_id)]
    rows = (db.query(Message).filter(Message.id > after, or_(
            (Message.to_id == u.player_id) & or_(Message.kind == "text", Message.created_at > cut),
            Message.to_id.in_(tags) & (Message.sender != u.player_id)))
            .order_by(Message.id).limit(100).all())
    return jsonify(events=[m.public() for m in rows], last=rows[-1].id if rows else after)


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
    return jsonify(presence=out)


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
    kind, body = ("img" if d.get("kind") == "img" else "text"), d.get("body") or ""
    if not body or (kind == "text" and len(body) > 300) or \
            (kind == "img" and (not body.startswith("data:image/") or len(body) > 200000)):
        return jsonify(error="Story tidak valid atau terlalu besar."), 400
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
