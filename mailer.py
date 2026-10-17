"""Kirim email: Resend (HTTPS) kalau RESEND_API_KEY diisi, atau SMTP biasa (mis. Gmail dengan sandi aplikasi)."""
import os, json, ssl, smtplib, urllib.request
from email.message import EmailMessage


def mail_ready():
    return bool(os.getenv("RESEND_API_KEY", "").strip() or (os.getenv("SMTP_HOST", "").strip() and os.getenv("MAIL_FROM", "").strip()))


def send_mail(to, subject, text):
    """True kalau berhasil dikirim."""
    frm, key = os.getenv("MAIL_FROM", "NOVA WAWA <onboarding@resend.dev>").strip(), os.getenv("RESEND_API_KEY", "").strip()
    try:
        if key:
            req = urllib.request.Request("https://api.resend.com/emails", method="POST", headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
                                         data=json.dumps({"from": frm, "to": [to], "subject": subject, "text": text}).encode())
            urllib.request.urlopen(req, timeout=8).read()
            return True
        host = os.getenv("SMTP_HOST", "").strip()
        if not host:
            return False
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = frm, to, subject
        msg.set_content(text)
        port, user, pw, ctx = int(os.getenv("SMTP_PORT", "587")), os.getenv("SMTP_USER", "").strip(), os.getenv("SMTP_PASS", ""), ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=10, context=ctx) as s:
                if user:
                    s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=10) as s:
                s.starttls(context=ctx)
                if user:
                    s.login(user, pw)
                s.send_message(msg)
        return True
    except Exception as e:
        print("kirim email gagal:", e)
        return False
