# NOVA PROJECT

Letakkan file **logo.png** kamu di folder yang sama dengan `index.html`.

## 1. Jalankan lokal
```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # isi SECRET_KEY
python app.py
```
Buka http://localhost:5000 (frontend + API dilayani Flask). Tabel dibuat otomatis.
Tes real-time: buka 2 browser, login di satu, daftar akun baru di yang lain.

## 2. Push ke GitHub
```bash
git init
git add .
git commit -m "NOVA PROJECT"
git branch -M main
git remote add origin https://github.com/USERNAME/nova-project.git
git push -u origin main
```

## 3. Database production (Neon atau Supabase)
Buat project, salin connection string PostgreSQL. Tabel dibuat otomatis oleh
`init_db()`, atau jalankan SQL ini manual:
```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  player_id VARCHAR(12) UNIQUE NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  birth_year INTEGER NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_player_id ON users(player_id);
```

## 4. Deploy ke Vercel
1. vercel.com > Add New > Project > import repo GitHub.
2. Environment Variables: `SECRET_KEY` dan `DATABASE_URL` (PostgreSQL).
3. Deploy. Selesai.

## Catatan penting
- **WebSocket tidak didukung Vercel serverless.** Karena itu real-time memakai
  **SSE** (event `user_update`). Klien otomatis menyambung ulang tiap ~8 detik,
  jadi daftar tetap update tanpa refresh. Untuk WebSocket asli, host backend di
  Render/Railway/Fly.io.
- SQLite tidak persisten di Vercel: wajib PostgreSQL di production.
- Token login disimpan di localStorage (berlaku 7 hari).
