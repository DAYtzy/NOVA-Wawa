import os
from sqlalchemy import create_engine, Column, Integer, String, DateTime, func
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


def init_db():
    Base.metadata.create_all(engine)
