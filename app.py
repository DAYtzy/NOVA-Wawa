import os, time, json, secrets, string
import bcrypt
from dotenv import load_dotenv
load_dotenv()
from flask import Flask, request, jsonify, Response, send_from_directory
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from database import Session, User, init_db

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
ser = URLSafeTimedSerializer(os.getenv("SECRET_KEY", "dev-secret-change-me"))
init_db()
ALPHABET = string.ascii_uppercase + string.digits
PUBLIC_FILES = {"index.html", "login.html", "dashboard.html",
                "style.css", "script.js", "logo.png"}


def gen_player_id(db):
    """Loop sampai dapat ID NOVA-XXXXXX yang belum dipakai."""
    while True:
        pid = "NOVA-" + "".join(secrets.choice(ALPHABET) for _ in range(6))
        if not db.query(User.id).filter_by(player_id=pid).first():
            return pid


def current_user(db):
    h = request.headers.get("Authorization", "")
    token = h[7:] if h.startswith("Bearer ") else request.args.get("token", "")
    try:
        uid = ser.loads(token, max_age=7 * 86400)
    except (BadSignature, SignatureExpired):
        return None
    return db.get(User, uid)


def users_list(db):
    rows = db.query(User).order_by(User.id.desc()).all()
    return [u.public() for u in rows]


@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    name = (d.get("full_name") or "").strip()
    email = (d.get("email") or "").strip().lower()
    pw = d.get("password") or ""
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
        for _ in range(5):  # retry jika terjadi tabrakan ID/email (race condition)
            u = User(player_id=gen_player_id(db), full_name=name, birth_year=year,
                     email=email, password_hash=hashed)
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
    email = (d.get("email") or "").strip().lower()
    pw = (d.get("password") or "").encode()
    with Session() as db:
        u = db.query(User).filter_by(email=email).first()
        if not u or not bcrypt.checkpw(pw, u.password_hash.encode()):
            return jsonify(error="Email atau password salah."), 401
        return jsonify(token=ser.dumps(u.id), user=u.public())


@app.get("/api/me")
def me():
    with Session() as db:
        u = current_user(db)
        return (jsonify(user=u.public()) if u else (jsonify(error="Unauthorized"), 401))


@app.get("/api/users")
def users():
    with Session() as db:
        if not current_user(db):
            return jsonify(error="Unauthorized"), 401
        return jsonify(users=users_list(db))


@app.get("/api/stream")
def stream():
    """SSE: kirim event 'user_update' saat ada user baru. Koneksi pendek + auto-reconnect
    (kompatibel dengan Vercel serverless)."""
    with Session() as db:
        if not current_user(db):
            return jsonify(error="Unauthorized"), 401

    def gen():
        last, end = None, time.time() + float(os.getenv("STREAM_SECONDS", "8"))
        yield "retry: 500\n\n"
        while time.time() < end:
            with Session() as db:
                sig = (db.query(func.count(User.id)).scalar(), db.query(func.max(User.id)).scalar())
                if sig != last:
                    last = sig
                    yield f"event: user_update\ndata: {json.dumps(users_list(db))}\n\n"
            time.sleep(1.5)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


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
