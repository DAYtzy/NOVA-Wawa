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


class BadgeFlag(Base):  # centang warna lain (selain biru di UserFlag): merah & abu-abu manual oleh owner, kuning otomatis saat daftar (tabel baru biar gak perlu ALTER tabel lama)
    __tablename__ = "badge_flags"
    player_id = Column(String(12), primary_key=True)
    red = Column(Boolean, nullable=True)     # True = diberi owner, selain itu dianggap tidak ada
    gray = Column(Boolean, nullable=True)    # True = diberi owner, selain itu dianggap tidak ada
    yellow = Column(Boolean, nullable=True)  # override manual owner: True = paksa ada, False = paksa dicabut, None = otomatis (akun yang daftar dalam YELLOW_DAYS hari terakhir)


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


class StaffRole(Base):  # peran staf selain owner. role: "mod" = moderator (boleh tangani laporan dan blokir, tidak boleh hapus akun)
    __tablename__ = "staff_roles"
    player_id = Column(String(12), primary_key=True)
    role = Column(String(10), nullable=False, default="mod")
    by = Column(String(12), default="")
    created_at = Column(DateTime, server_default=func.now())


class AuditLog(Base):  # catatan tindakan owner dan moderator
    __tablename__ = "audit_log"
    id = Column(Integer, primary_key=True)
    actor = Column(String(12), nullable=False, index=True)
    action = Column(String(24), nullable=False)
    target = Column(String(40), default="")
    detail = Column(String(200), default="")
    created_at = Column(DateTime, server_default=func.now(), index=True)


class RoomExt(Base):  # tabel baru (bukan ALTER) untuk foto grup/saluran
    __tablename__ = "room_ext"
    room_id = Column(Integer, primary_key=True)
    avatar = Column(Text, default="")


class MsgReply(Base):  # pesan ini membalas pesan lain (tabel baru, bukan ALTER; kutipan dibuat server dari pesan aslinya)
    __tablename__ = "msg_reply"
    message_id = Column(Integer, primary_key=True)
    reply_to = Column(Integer, nullable=False, index=True)


class RoomAdmin(Base):  # admin tambahan di grup (selain pemilik); tabel baru, bukan ALTER
    __tablename__ = "room_admins"
    room_id = Column(Integer, primary_key=True)
    player_id = Column(String(12), primary_key=True)


class ChatMute(Base):  # chat yang dibisukan (notifikasi push tidak dikirim); chat = ID teman atau "R-<id>"
    __tablename__ = "chat_mutes"
    player_id = Column(String(12), primary_key=True)
    chat = Column(String(14), primary_key=True)


class RoomInvite(Base):  # tautan undangan grup/saluran
    __tablename__ = "room_invites"
    room_id = Column(Integer, primary_key=True)
    code = Column(String(16), unique=True, nullable=False, index=True)


class MsgReaction(Base):  # reaksi emoji di pesan: satu reaksi per orang per pesan
    __tablename__ = "msg_reactions"
    message_id = Column(Integer, primary_key=True)
    player_id = Column(String(12), primary_key=True)
    emoji = Column(String(16), nullable=False)


class MsgEdit(Base):  # penanda pesan sudah diedit (tabel baru, bukan ALTER)
    __tablename__ = "msg_edits"
    message_id = Column(Integer, primary_key=True)
    at = Column(DateTime)


class MsgPin(Base):  # pesan yang disematkan di sebuah chat; chat = "R-<id>" atau "<idA>:<idB>" (urut)
    __tablename__ = "msg_pins"
    chat = Column(String(30), primary_key=True)
    message_id = Column(Integer, nullable=False)
    by = Column(String(12), default="")


class ChatPin(Base):  # chat yang disematkan di atas daftar chat milik seseorang
    __tablename__ = "chat_pins"
    player_id = Column(String(12), primary_key=True)
    chat = Column(String(14), primary_key=True)


class RoomSetting(Base):  # pengaturan grup: mode lambat (detik) dan pesan sambutan
    __tablename__ = "room_settings"
    room_id = Column(Integer, primary_key=True)
    slow = Column(Integer, default=0)
    welcome = Column(String(300), default="")


class RoomLog(Base):  # catatan tindakan admin di grup
    __tablename__ = "room_logs"
    id = Column(Integer, primary_key=True)
    room_id = Column(Integer, nullable=False, index=True)
    actor = Column(String(12), nullable=False)
    action = Column(String(24), nullable=False)
    detail = Column(String(200), default="")
    created_at = Column(DateTime, server_default=func.now())


class Poll(Base):  # polling; pesannya berisi "[poll:<id>]"
    __tablename__ = "polls"
    id = Column(Integer, primary_key=True)
    sender = Column(String(12), nullable=False)
    to_id = Column(String(12), nullable=False)
    question = Column(String(200), nullable=False)
    options = Column(Text, nullable=False)  # JSON daftar teks pilihan
    created_at = Column(DateTime, server_default=func.now())


class PollVote(Base):
    __tablename__ = "poll_votes"
    poll_id = Column(Integer, primary_key=True)
    player_id = Column(String(12), primary_key=True)
    option = Column(Integer, nullable=False)


class LoginSession(Base):  # satu baris per login (perangkat); token membawa id-nya sehingga bisa dicabut satu per satu
    __tablename__ = "login_sessions"
    sid = Column(String(16), primary_key=True)
    player_id = Column(String(12), nullable=False, index=True)
    device = Column(String(80), default="")
    uahash = Column(String(16), default="")
    ip = Column(String(45), default="")
    created_at = Column(DateTime, server_default=func.now())
    last_seen = Column(DateTime, nullable=True)
    revoked = Column(Boolean, default=False)


class LogoutAll(Base):  # semua token yang diterbitkan sebelum waktu ini tidak berlaku lagi
    __tablename__ = "logout_all"
    player_id = Column(String(12), primary_key=True)
    at = Column(DateTime)


class TotpKey(Base):  # autentikasi dua langkah (TOTP)
    __tablename__ = "totp_keys"
    player_id = Column(String(12), primary_key=True)
    secret = Column(String(40), nullable=False)
    enabled = Column(Boolean, default=False)
