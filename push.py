"""Web Push (RFC 8030/8291/8292) tanpa pustaka tambahan selain `cryptography`: kunci VAPID, enkripsi isi, dan pengiriman."""
import json, os, time, base64, struct, urllib.request, urllib.error
from urllib.parse import urlparse
try:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    READY = True
except Exception:  # pustaka belum ada: notifikasi push dinonaktifkan, aplikasi tetap jalan
    READY = False

HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com")
SUFFIX = (".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def host_ok(url):
    """Hanya layanan push resmi yang boleh dihubungi (mencegah server dipakai menyerang alamat lain)."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    h = (u.hostname or "").lower()
    return u.scheme == "https" and len(url) < 700 and (h in HOSTS or h.endswith(SUFFIX))


def new_vapid():
    k = ec.generate_private_key(ec.SECP256R1())
    priv = b64u(k.private_numbers().private_value.to_bytes(32, "big"))
    pub = b64u(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    return priv, pub


def _key(priv_b64):
    return ec.derive_private_key(int.from_bytes(b64d(priv_b64), "big"), ec.SECP256R1())


def vapid_header(endpoint, priv, pub, subject, now=None):
    u = urlparse(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    body = b64u(json.dumps({"aud": "%s://%s" % (u.scheme, u.netloc), "exp": int(now or time.time()) + 12 * 3600, "sub": subject}, separators=(",", ":")).encode())
    r, s = decode_dss_signature(_key(priv).sign((head + "." + body).encode(), ec.ECDSA(hashes.SHA256())))
    return "vapid t=%s.%s.%s, k=%s" % (head, body, b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big")), pub)


def encrypt(plaintext, ua_pub_b64, auth_b64, as_priv=None, salt=None):
    """aes128gcm (RFC 8291). as_priv/salt hanya untuk pengujian dengan contoh dari RFC."""
    ua_pub, auth = b64d(ua_pub_b64), b64d(auth_b64)
    as_key = _key(as_priv) if as_priv else ec.generate_private_key(ec.SECP256R1())
    as_pub = as_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    secret = as_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    salt = salt or os.urandom(16)
    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + ua_pub + as_pub).derive(secret)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    return salt + struct.pack(">IB", 4096, len(as_pub)) + as_pub + AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)


def send_push(sub, payload, priv, pub, subject, timeout=4):
    """'ok', 'gone' (langganan sudah tidak berlaku, hapus saja), atau 'fail'."""
    if not READY or not host_ok(sub["endpoint"]):
        return "fail"
    try:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()[:3000]
        req = urllib.request.Request(sub["endpoint"], data=encrypt(data, sub["p256dh"], sub["auth"]), method="POST", headers={
            "Authorization": vapid_header(sub["endpoint"], priv, pub, subject), "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream", "TTL": "86400", "Urgency": "high"})
        urllib.request.urlopen(req, timeout=timeout).read()
        return "ok"
    except urllib.error.HTTPError as e:
        return "gone" if e.code in (404, 410) else "fail"
    except Exception as e:
        print("push gagal:", e)
        return "fail"
