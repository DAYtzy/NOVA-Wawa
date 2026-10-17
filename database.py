import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, func
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import NullPool
from security import dec  # isi pesan dienkripsi di database kalau DATA_KEY diisi

url = os.getenv("DATABASE_URL", "sqlite:///nova.db")
if url.startswith("postgres://"):
    url = url.replace("postgres://", "postgresql://", 1)
if url.startswith("postgresql://"):
    url = url.replace("postgresql://", "postgresql+psycopg2://", 1)  # paksa driver psycopg2

if url.startswith("postgresql"):
    engine = create_engine(url, poolclass=NullPool, pool_pre_ping=True)  # aman untuk serverless
else:
    engine = create_engine(url, connect_args={"check_same_thread": False})

Session = sessionmaker(bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    player_id = Column(String(12), unique=True, nullable=False, index=True)
    full_name = Column(String(100), nullable=False)
    birth_year = Column(Integer, nullable=False)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    def public(self):
        return {"player_id": self.player_id, "full_name": self.full_name,
                "birth_year": self.birth_year}


class Contact(Base):  # "Save ID": teman yang disimpan pemilik
    __tablename__ = "contacts"
    id = Column(Integer, primary_key=True)
    owner = Column(String(12), nullable=False, index=True)
    contact_pid = Column(String(12), nullable=False)


class Message(Base):  # kind: 'text' = pesan, 'sig' = signaling panggilan WebRTC
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True)
    sender = Column(String(12), nullable=False, index=True)
    to_id = Column(String(12), nullable=False, index=True)
    kind = Column(String(8), nullable=False, default="text")
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    def public(self):
        return {"id": self.id, "sender": self.sender, "to": self.to_id, "kind": self.kind,
                "body": dec(self.body), "t": self.created_at.isoformat() + "Z"}


def init_db():
    Base.metadata.create_all(engine)


from sqlalchemy import Boolean


class Profile(Base):
    __tablename__ = "profiles"
    player_id = Column(String(12), primary_key=True)
    avatar = Column(Text, default="")
    status = Column(String(80), default="")


class Story(Base):
    __tablename__ = "stories"
    id = Column(Integer, primary_key=True)
    owner = Column(String(12), nullable=False, index=True)
    kind = Column(String(8), nullable=False)  # text | img
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class Room(Base):  # grup atau saluran; pesannya disimpan di messages dengan to_id = 'R-<id>'
    __tablename__ = "rooms"
    id = Column(Integer, primary_key=True)
    kind = Column(String(8), nullable=False)  # group | channel
    name = Column(String(60), nullable=False)
    about = Column(String(200), default="")
    owner = Column(String(12), nullable=False)


class RoomMember(Base):
    __tablename__ = "room_members"
    id = Column(Integer, primary_key=True)
    room_id = Column(Integer, nullable=False, index=True)
    player_id = Column(String(12), nullable=False, index=True)


class Call(Base):
    __tablename__ = "calls"
    id = Column(Integer, primary_key=True)
    caller = Column(String(12), nullable=False, index=True)
    callee = Column(String(12), nullable=False, index=True)
    video = Column(Boolean, default=False)
    status = Column(String(10), default="missed")  # missed | answered | rejected
    created_at = Column(DateTime, server_default=func.now())


class ProfileExt(Base):  # tabel baru (bukan ALTER) supaya database Neon yang sudah ada tidak perlu migrasi
    __tablename__ = "profile_ext"
    player_id = Column(String(12), primary_key=True)
    cover = Column(Text, default="")
    public = Column(Boolean, default=True)      # Profil Publik
    show_seen = Column(Boolean, default=True)   # Terakhir Dilihat
    last_seen = Column(DateTime, nullable=True)


class Sticker(Base):  # stiker disimpan sekali (id = hash isi), pesan hanya membawa "[stk:id]"
    __tablename__ = "stickers"
    id = Column(String(24), primary_key=True)
    data = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class AppSetting(Base):  # pengaturan yang diubah owner dari aplikasi (mis. teks banner)
    __tablename__ = "app_settings"
    key = Column(String(40), primary_key=True)
    value = Column(Text, default="")


class UserFlag(Base):  # centang biru manual dan status blokir, diatur owner
    __tablename__ = "user_flags"
    player_id = Column(String(12), primary_key=True)
    verified = Column(Boolean, nullable=True)  # None = aturan bawaan, True = beri centang, False = cabut
    banned = Column(Boolean, default=False)


class Media(Base):  # foto/video di chat & status. File di Cloudinary (provider "cld") atau, khusus foto kecil, di database ("db")
    __tablename__ = "media"
    id = Column(String(24), primary_key=True)
    owner = Column(String(12), nullable=False, index=True)
    kind = Column(String(5), nullable=False)       # image | video
    provider = Column(String(3), nullable=False)   # cld | db
    ref = Column(String(120), default="")          # public_id di Cloudinary
    ext = Column(String(5), default="")
    data = Column(Text, default="")                # isi foto (data URL) untuk provider db
    w = Column(Integer, default=0)
    h = Column(Integer, default=0)
    dur = Column(Integer, default=0)
    caption = Column(String(200), default="")
    once = Column(Boolean, default=False)          # sekali lihat
    to_id = Column(String(12), default="")         # penerima (untuk sekali lihat)
    ready = Column(Boolean, default=False)
    sent = Column(Boolean, default=False)
    gone = Column(Boolean, default=False)
    viewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())


class Block(Base):  # pengguna memblokir pengguna lain
    __tablename__ = "blocks"
    owner = Column(String(12), primary_key=True)
    target = Column(String(12), primary_key=True)


class RateHit(Base):  # catatan percobaan (login gagal, daftar) untuk membatasi serangan tebak-tebakan
    __tablename__ = "rate_hits"
    id = Column(Integer, primary_key=True)
    key = Column(String(120), nullable=False, index=True)
    ts = Column(DateTime, nullable=False, index=True)


class PwChange(Base):  # akun yang pernah ganti password: sesi lama (token lama) tidak berlaku lagi
    __tablename__ = "pw_changes"
    player_id = Column(String(12), primary_key=True)
    at = Column(DateTime)


class EmailOk(Base):  # email yang sudah diverifikasi lewat tautan
    __tablename__ = "email_ok"
    player_id = Column(String(12), primary_key=True)
    at = Column(DateTime)


class PrivPref(Base):  # siapa yang boleh melihat story dan terakhir dilihat: all | mutual | none
    __tablename__ = "priv_pref"
    player_id = Column(String(12), primary_key=True)
    story_vis = Column(String(8), default="all")
    seen_vis = Column(String(8), default="all")


class Report(Base):  # laporan pengguna
    __tablename__ = "reports"
    id = Column(Integer, primary_key=True)
    reporter = Column(String(12), nullable=False, index=True)
    target = Column(String(12), nullable=False, index=True)
    reason = Column(String(20), nullable=False)
    detail = Column(String(300), default="")
    status = Column(String(10), default="baru")
    created_at = Column(DateTime, server_default=func.now())


class PushSub(Base):  # perangkat yang mengaktifkan notifikasi
    __tablename__ = "push_subs"
    id = Column(Integer, primary_key=True)
    player_id = Column(String(12), nullable=False, index=True)
    endpoint = Column(Text, nullable=False, unique=True)
    p256dh = Column(String(120), nullable=False)
    auth = Column(String(40), nullable=False)
    created_at = Column(DateTime, server_default=func.now())
