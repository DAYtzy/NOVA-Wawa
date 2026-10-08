# NOVA WAWA

Chat + telpon + video call tanpa aplikasi/web pihak ketiga (WebRTC native browser).
Tetap jalan di **Vercel + Neon** (tidak perlu Render).

## Cara kerja
- **Save ID**: tombol `+` (kanan bawah) atau "SIMPAN ID" di chat. Teman yang ID-nya disimpan muncul di baris atas dan daftar chat dengan namanya. Pengirim yang belum disimpan tampil sebagai ID.
- **Real-time**: polling ~1,5 detik (Vercel tidak mendukung WebSocket). Sinyal panggilan WebRTC juga lewat polling, jadi telpon tersambung dalam beberapa detik.
- **Telpon / video**: tombol TELPON dan VIDEO di dalam chat. Video lawan layar penuh, video sendiri bisa digeser.

## Lokal
```bash
pip install -r requirements.txt
cp .env.example .env
python app.py        # http://localhost:5000
```

## Deploy
Upload semua file ke GitHub (replace). Vercel otomatis deploy. `SECRET_KEY` dan `DATABASE_URL` tetap sama. Tabel `contacts` dan `messages` dibuat otomatis, atau jalankan SQL:
```sql
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY, owner VARCHAR(12) NOT NULL, contact_pid VARCHAR(12) NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY, sender VARCHAR(12) NOT NULL, to_id VARCHAR(12) NOT NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'text', body TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
```

## Batasan
- Hanya STUN Google, tanpa TURN: panggilan bisa gagal di jaringan seluler/NAT ketat.
- Pesan tidak instan (jeda 1-2 detik) dan tanpa notifikasi saat web ditutup.

## Fitur v3
Story (teks/foto, 24 jam), grup, saluran (hanya pemilik yang posting), riwayat panggilan, foto profil + status, kunci aplikasi (sidik jari/PIN HP lewat WebAuthn, hanya kunci layar lokal). Tabel baru (`profiles`, `stories`, `rooms`, `room_members`, `calls`) dibuat otomatis; tabel `users` tidak diubah.
