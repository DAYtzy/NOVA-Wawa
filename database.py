import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, func
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.pool import NullPool

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
                "body": self.body, "t": self.created_at.isoformat() + "Z"}


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
