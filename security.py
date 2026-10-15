"""Fungsi keamanan murni (tanpa database) supaya bisa diuji sendiri: header, pembatas laju, aturan password,
validasi gambar data-URL, dan enkripsi isi pesan di database."""
import os, re, time, base64, hashlib

try:
    from cryptography.fernet import Fernet, InvalidToken
except Exception:  # pustaka belum terpasang: enkripsi dinonaktifkan, aplikasi tetap jalan
    Fernet = None
    InvalidToken = Exception

# ---------- header keamanan ----------
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://res.cloudinary.com; "
       "media-src 'self' blob: data: https://res.cloudinary.com; connect-src 'self' data: blob: https://api.cloudinary.com; "
       "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
BASE_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}


def apply_headers(resp, path=""):
    for k, v in BASE_HEADERS.items():
        resp.headers.setdefault(k, v)
    if path.startswith("/api/") and "Cache-Control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"  # jawaban API (pesan, profil) tidak boleh disimpan cache
    return resp


# ---------- pembatas laju (di memori, per instance) ----------
class Limiter:
    def __init__(self):
        self.h = {}

    def hit(self, key, limit, secs):
        """True kalau masih boleh, False kalau sudah melewati batas dalam `secs` detik terakhir."""
        now = time.time()
        q = [t for t in self.h.get(key, []) if now - t < secs]
        ok = len(q) < limit
        if ok:
            q.append(now)
        self.h[key] = q
        if len(self.h) > 5000:  # bersihkan sesekali
            self.h = {k: v for k, v in self.h.items() if v and now - v[-1] < 3600}
        return ok


# ---------- aturan password ----------
COMMON = {"12345678", "123456789", "1234567890", "password", "password1", "password123", "qwerty123", "qwertyuiop",
          "11111111", "00000000", "abc12345", "iloveyou", "admin123", "letmein1", "87654321", "asdfghjkl", "kontol123"}


def pw_problem(pw, name="", email=""):
    """Pesan masalah (Indonesia) kalau password terlalu lemah, atau None kalau boleh."""
    if len(pw) < 8:
        return "Password minimal 8 karakter."
    if len(pw.encode()) > 72:
        return "Password maksimal 72 karakter."
    low = pw.lower()
    if low in COMMON or len(set(low)) <= 2:
        return "Password terlalu mudah ditebak. Pakai kombinasi yang lebih unik."
    if any(len(x) >= 4 and x in low for x in re.split(r"\s+", name.strip().lower())):
        return "Password jangan memuat namamu."
    if email and low == email.strip().lower():
        return "Password jangan sama dengan email."
    return None


# ---------- validasi gambar data-URL (mencegah suntikan ke CSS/atribut) ----------
IMG_RE = re.compile(r"^data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$")


def safe_data_url(s, maxlen):
    return isinstance(s, str) and len(s) <= maxlen and bool(IMG_RE.match(s))


# ---------- enkripsi isi pesan di database ----------
class Box:
    PREFIX = "enc1:"

    def __init__(self, secret):
        self.f = None
        if secret and Fernet:
            self.f = Fernet(base64.urlsafe_b64encode(hashlib.sha256(("nova.v1|" + secret).encode()).digest()))

    @property
    def on(self):
        return self.f is not None

    def enc(self, text):
        return self.PREFIX + self.f.encrypt(text.encode()).decode() if self.f and text else text

    def dec(self, text):
        if not isinstance(text, str) or not text.startswith(self.PREFIX):
            return text  # pesan lama (belum terenkripsi) tetap terbaca
        if not self.f:
            return "[pesan terenkripsi: kunci belum diisi]"
        try:
            return self.f.decrypt(text[len(self.PREFIX):].encode()).decode()
        except (InvalidToken, ValueError):
            return "[pesan tidak bisa dibaca: kunci berbeda]"


_secret = os.getenv("DATA_KEY", "").strip()
BOX = Box(_secret if len(_secret) >= 24 else "")


def enc(text):
    return BOX.enc(text)


def dec(text):
    return BOX.dec(text)


def crypto_status():
    if not _secret:
        return "mati: DATA_KEY belum diisi"
    if len(_secret) < 24:
        return "mati: DATA_KEY terlalu pendek (minimal 24 karakter)"
    if not Fernet:
        return "mati: pustaka cryptography belum terpasang"
    return "aktif"
