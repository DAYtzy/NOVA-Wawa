# NOVA WAWA

Aplikasi chat bergaya WhatsApp: chat pribadi, grup, saluran, story foto/video/teks, stiker buatan sendiri,
telepon dan video call, notifikasi push, serta panel owner. Frontend HTML/CSS/JS biasa, backend Flask,
database PostgreSQL (Neon), dan di-host di Vercel.

## Struktur
| File | Isi |
|---|---|
| `app.py` | Semua rute API (Flask) |
| `database.py` | Tabel database (SQLAlchemy) |
| `security.py` | Header keamanan (CSP), aturan password, validasi gambar, enkripsi pesan |
| `mailer.py` | Pengiriman email (Resend atau SMTP) |
| `push.py` | Notifikasi push (VAPID + enkripsi RFC 8291) |
| `index.html` `login.html` `dashboard.html` | Halaman utama |
| `forgot.html` `reset.html` `verify.html` | Lupa password dan verifikasi email |
| `terms.html` `privacy.html` | Syarat dan Kebijakan Privasi (draf, sesuaikan sendiri) |
| `script.js` `style.css` | Logika dan tampilan |
| `sw.js` `manifest.json` `icon-*.png` | PWA dan notifikasi push |
| `vercel.json` | Konfigurasi Vercel (server di Singapura) |

## Variabel lingkungan (Vercel: Settings, Environment Variables)
| Nama | Wajib? | Fungsi |
|---|---|---|
| `SECRET_KEY` | **Ya** (min. 16 karakter) | Menandatangani sesi login. Tanpa ini API menolak jalan |
| `DATABASE_URL` | **Ya** | Alamat database Neon |
| `OWNER_IDS` | Disarankan | ID angka owner, pisahkan koma. Kosong = akun pertama yang mendaftar |
| `DATA_KEY` | Disarankan (min. 24 karakter) | Mengenkripsi isi pesan di database. **Jangan hilang atau berganti** |
| `CLOUDINARY_CLOUD_NAME` `CLOUDINARY_API_KEY` `CLOUDINARY_API_SECRET` | Untuk video | Penyimpanan video dan foto |
| `METERED_DOMAIN` `METERED_API_KEY` | Untuk telepon andal | Server TURN supaya telepon antar jaringan seluler tidak gagal |
| `RESEND_API_KEY` + `MAIL_FROM` **atau** `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | Untuk lupa password dan verifikasi email | Pengirim email. Gmail bisa dipakai lewat sandi aplikasi |
| `PUBLIC_URL` | Opsional | Alamat situs untuk tautan di email (mis. `https://nova-wawa.vercel.app`) |
| `VAPID_SUBJECT` | Opsional | Kontak untuk layanan push (mis. `mailto:kamu@email.com`) |

Kartu **Keamanan** di Panel Owner menunjukkan pengaturan mana yang sudah aktif.

## Daftar periksa setelah deploy
1. Isi `SECRET_KEY`, `DATABASE_URL`, `OWNER_IDS`, dan `DATA_KEY`, lalu Redeploy.
2. Pasang pemantau gratis (UptimeRobot): monitor HTTP ke `https://DOMAINMU/api/health` tiap 5 menit.
3. Neon: buka konsol Neon, lihat **Restore / Backup** dan catat berapa lama riwayat yang disimpan paket gratismu.
4. Daftarkan akun pertamamu, buka Profil, dan pastikan tombol Panel Owner muncul.
5. Baca `terms.html` dan `privacy.html`, sesuaikan, dan tambahkan kontak resmi.

## Menjalankan di komputer
```
pip install -r requirements.txt
python app.py
```
Tanpa `DATABASE_URL`, aplikasi memakai SQLite lokal (`nova.db`).

## Batasan yang perlu diketahui
- Pesan **tidak** terenkripsi ujung ke ujung. Enkripsi di database hanya melindungi dari kebocoran database saja.
- Pesan baru diambil dengan long polling (bukan WebSocket) karena Vercel tidak mendukung WebSocket.
- Telepon masuk berdering hanya jika aplikasi terbuka; selain itu pengguna menerima notifikasi push (jika diaktifkan).
