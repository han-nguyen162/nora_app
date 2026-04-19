import hashlib
import json
import os
import re
import secrets
import sqlite3
import urllib.request
import urllib.error
from calendar import monthrange
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import uuid4

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field

app = FastAPI(title="Nora Backend")

# ─────────────────────────────────────────
# Amazon Nova — Bedrock bearer token auth
# ─────────────────────────────────────────
def _nova_invoke(model_id: str, system: str, user_text: str, max_tokens: int = 1024) -> str:
    bearer = os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "")
    region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
    url = f"https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke"
    payload = json.dumps({
        "messages": [{"role": "user", "content": [{"text": user_text}]}],
        "system": [{"text": system}],
        "inferenceConfig": {"max_new_tokens": max_tokens, "temperature": 0.7},
    }).encode()
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req) as r:
        result = json.loads(r.read())
    return result["output"]["message"]["content"][0]["text"]

_task_prep_cache: dict[str, str] = {}

# ─────────────────────────────────────────
# SQLite — persistent storage
# ─────────────────────────────────────────
DB_PATH = BASE_DIR.parent / "nora.db"

def _init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id              TEXT PRIMARY KEY,
                email           TEXT UNIQUE NOT NULL,
                password_hash   TEXT NOT NULL,
                salt            TEXT NOT NULL,
                role            TEXT NOT NULL,
                display_name    TEXT NOT NULL,
                connection_code TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token   TEXT PRIMARY KEY,
                user_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS connections (
                caregiver_id TEXT NOT NULL,
                elder_id     TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                PRIMARY KEY (caregiver_id, elder_id)
            );
            CREATE TABLE IF NOT EXISTS reminders (
                id                  TEXT PRIMARY KEY,
                owner_user_id       TEXT NOT NULL,
                created_by_user_id  TEXT NOT NULL,
                title               TEXT NOT NULL,
                description         TEXT,
                category            TEXT NOT NULL,
                due_datetime        TEXT NOT NULL,
                repeat_type         TEXT,
                voice_created       INTEGER NOT NULL DEFAULT 0,
                is_critical         INTEGER NOT NULL DEFAULT 0,
                escalation_enabled  INTEGER NOT NULL DEFAULT 0,
                status              TEXT NOT NULL DEFAULT 'pending',
                completed_at        TEXT,
                follow_up_count     INTEGER NOT NULL DEFAULT 0,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS emergency_alerts (
                id                  TEXT PRIMARY KEY,
                elder_id            TEXT NOT NULL,
                elder_display_name  TEXT NOT NULL,
                created_at          TEXT NOT NULL,
                source              TEXT NOT NULL,
                phrase              TEXT,
                acknowledged        INTEGER NOT NULL DEFAULT 0,
                acknowledged_at     TEXT
            );
        """)

_init_db()

@contextmanager
def _db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

# ─────────────────────────────────────────
# Row converters
# ─────────────────────────────────────────
def _user_row(row) -> dict:
    return dict(row)

def _reminder_row(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "ownerUserId": d["owner_user_id"],
        "createdByUserId": d["created_by_user_id"],
        "title": d["title"],
        "description": d["description"],
        "category": d["category"],
        "dueDateTime": datetime.fromisoformat(d["due_datetime"]),
        "repeatType": d["repeat_type"],
        "voiceCreated": bool(d["voice_created"]),
        "isCritical": bool(d["is_critical"]),
        "escalationEnabled": bool(d["escalation_enabled"]),
        "status": d["status"],
        "completedAt": datetime.fromisoformat(d["completed_at"]) if d["completed_at"] else None,
        "followUpCount": d["follow_up_count"],
        "createdAt": datetime.fromisoformat(d["created_at"]),
        "updatedAt": datetime.fromisoformat(d["updated_at"]),
    }

def _alert_to_json(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "elderId": d["elder_id"],
        "elderDisplayName": d["elder_display_name"],
        "createdAt": d["created_at"],
        "source": d["source"],
        "phrase": d["phrase"],
        "acknowledged": bool(d["acknowledged"]),
    }

# ─────────────────────────────────────────
# CORS
# ─────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────
# Security + utility helpers
# ─────────────────────────────────────────
security = HTTPBearer(auto_error=False)
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

def hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000).hex()

def new_salt() -> str:
    return secrets.token_hex(16)

def generate_connection_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))

def find_user_by_id(user_id: str) -> dict | None:
    with _db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _user_row(row) if row else None

def find_user_by_email(email: str) -> dict | None:
    with _db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()
        return _user_row(row) if row else None

def find_elder_by_connection_code(code: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE role = 'elder' AND connection_code = ?",
            (code.strip().upper(),),
        ).fetchone()
        return _user_row(row) if row else None

def is_caregiver_linked_to_elder(caregiver_id: str, elder_id: str) -> bool:
    with _db() as conn:
        row = conn.execute(
            "SELECT 1 FROM connections WHERE caregiver_id = ? AND elder_id = ?",
            (caregiver_id, elder_id),
        ).fetchone()
        return row is not None

def linked_caregiver_ids_for_elder(elder_id: str) -> list[str]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT caregiver_id FROM connections WHERE elder_id = ?", (elder_id,)
        ).fetchall()
        return [r["caregiver_id"] for r in rows]

def linked_elder_ids_for_caregiver(caregiver_id: str) -> list[str]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT elder_id FROM connections WHERE caregiver_id = ?", (caregiver_id,)
        ).fetchall()
        return [r["elder_id"] for r in rows]

def user_public(u: dict) -> dict:
    out = {"id": u["id"], "email": u["email"], "role": u["role"], "displayName": u["display_name"]}
    if u["role"] == "elder":
        out["connectionCode"] = u.get("connection_code")
    return out

def can_access_owner(current_user: dict, owner_user_id: str) -> bool:
    if current_user["id"] == owner_user_id:
        return True
    if current_user["role"] == "caregiver":
        return is_caregiver_linked_to_elder(current_user["id"], owner_user_id)
    return False

def assert_can_access_owner(current_user: dict, owner_user_id: str) -> None:
    if not can_access_owner(current_user, owner_user_id):
        raise HTTPException(status_code=403, detail="You do not have access to this user")

def assert_can_mutate_reminder(current_user: dict, reminder: dict) -> None:
    if not can_access_owner(current_user, reminder["ownerUserId"]):
        raise HTTPException(status_code=403, detail="You do not have access to this reminder")

async def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> dict:
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    with _db() as conn:
        row = conn.execute(
            "SELECT user_id FROM sessions WHERE token = ?", (creds.credentials,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = find_user_by_id(row["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

# ─────────────────────────────────────────
# Recurrence helpers
# ─────────────────────────────────────────
def _next_due_datetime(due: datetime, repeat_type: str) -> datetime | None:
    if repeat_type == "daily":
        return due + timedelta(days=1)
    if repeat_type == "weekly":
        return due + timedelta(weeks=1)
    if repeat_type == "monthly":
        m = due.month % 12 + 1
        y = due.year + (due.month // 12)
        day = min(due.day, monthrange(y, m)[1])
        return due.replace(year=y, month=m, day=day)
    return None

def _spawn_next_occurrence(conn: sqlite3.Connection, reminder: dict, now: datetime) -> None:
    next_due = _next_due_datetime(reminder["dueDateTime"], reminder["repeatType"])
    if next_due is None:
        return
    existing = conn.execute(
        "SELECT 1 FROM reminders WHERE owner_user_id = ? AND due_datetime = ? AND status != 'completed'",
        (reminder["ownerUserId"], next_due.isoformat()),
    ).fetchone()
    if existing:
        return
    conn.execute(
        """INSERT INTO reminders (
            id, owner_user_id, created_by_user_id, title, description, category,
            due_datetime, repeat_type, voice_created, is_critical, escalation_enabled,
            status, completed_at, follow_up_count, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            str(uuid4()),
            reminder["ownerUserId"], reminder["createdByUserId"],
            reminder["title"], reminder["description"], reminder["category"],
            next_due.isoformat(), reminder["repeatType"],
            int(reminder["voiceCreated"]), int(reminder["isCritical"]),
            int(reminder["escalationEnabled"]),
            "pending", None, 0, now.isoformat(), now.isoformat(),
        ),
    )

# ─────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────
class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    role: Literal["elder", "caregiver"]
    display_name: str = Field(min_length=1, max_length=80)

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict

class LinkByCodeBody(BaseModel):
    code: str = Field(min_length=4, max_length=16)

class ReminderCreate(BaseModel):
    ownerUserId: str
    createdByUserId: str
    title: str
    description: str | None = None
    category: str
    dueDateTime: datetime
    repeatType: str | None = None
    voiceCreated: bool = False
    isCritical: bool = False
    escalationEnabled: bool = False

class ReminderUpdate(BaseModel):
    title: str
    description: str | None = None
    category: str
    dueDateTime: datetime
    repeatType: str | None = None

class Reminder(BaseModel):
    id: str
    ownerUserId: str
    createdByUserId: str
    title: str
    description: str | None = None
    category: str
    dueDateTime: datetime
    repeatType: str | None = None
    voiceCreated: bool = False
    isCritical: bool = False
    escalationEnabled: bool = False
    status: str
    completedAt: datetime | None = None
    followUpCount: int
    createdAt: datetime
    updatedAt: datetime

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    ownerUserId: str | None = None

class ChatResponse(BaseModel):
    reply: str
    intent: dict | None = None

class TaskPreparationRequest(BaseModel):
    reminder_id: str

class TaskPreparationResponse(BaseModel):
    content: str

class EmergencyDetectRequest(BaseModel):
    phrase: str

class EmergencyDetectResponse(BaseModel):
    is_emergency: bool
    confidence: float
    details: str | None

class EmergencyTriggerBody(BaseModel):
    source: Literal["button", "voice"]
    phrase: str | None = Field(None, max_length=500)

# ─────────────────────────────────────────
# Reminder query helper
# ─────────────────────────────────────────
def _ph(lst) -> str:
    return ",".join("?" * len(lst))

def _accessible_owner_ids(user: dict) -> list[str]:
    if user["role"] == "elder":
        return [user["id"]]
    # Caregiver sees their own events + linked elder's events
    return [user["id"]] + linked_elder_ids_for_caregiver(user["id"])

def _fetch_reminders(user: dict, extra_where: str = "", extra_params: list | None = None) -> list[dict]:
    owner_ids = _accessible_owner_ids(user)
    if not owner_ids:
        return []
    params = owner_ids + (extra_params or [])
    with _db() as conn:
        rows = conn.execute(
            f"SELECT * FROM reminders WHERE owner_user_id IN ({_ph(owner_ids)}) {extra_where} ORDER BY due_datetime",
            params,
        ).fetchall()
    return [_reminder_row(r) for r in rows]

# ─────────────────────────────────────────
# Routes — root
# ─────────────────────────────────────────
@app.get("/")
def root():
    return {"message": "Nora backend is running"}

# ─────────────────────────────────────────
# Auth
# ─────────────────────────────────────────
@app.post("/auth/register", response_model=TokenResponse)
def register(body: UserRegister):
    if find_user_by_email(body.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    salt = new_salt()
    uid = str(uuid4())
    conn_code = generate_connection_code() if body.role == "elder" else None
    token = secrets.token_urlsafe(32)
    with _db() as conn:
        conn.execute(
            "INSERT INTO users (id,email,password_hash,salt,role,display_name,connection_code) VALUES (?,?,?,?,?,?,?)",
            (uid, body.email.strip().lower(), hash_password(body.password, salt),
             salt, body.role, body.display_name.strip(), conn_code),
        )
        conn.execute("INSERT INTO sessions (token,user_id) VALUES (?,?)", (token, uid))
    return {"access_token": token, "token_type": "bearer", "user": user_public(find_user_by_id(uid))}

@app.post("/auth/login", response_model=TokenResponse)
def login(body: UserLogin):
    user = find_user_by_email(body.email)
    if not user or hash_password(body.password, user["salt"]) != user["password_hash"]:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = secrets.token_urlsafe(32)
    with _db() as conn:
        conn.execute("INSERT INTO sessions (token,user_id) VALUES (?,?)", (token, user["id"]))
    return {"access_token": token, "token_type": "bearer", "user": user_public(user)}

@app.post("/auth/logout")
def logout(user: Annotated[dict, Depends(get_current_user)]):
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
    return {"ok": True}

@app.get("/auth/me")
def auth_me(user: Annotated[dict, Depends(get_current_user)]):
    return user_public(user)

@app.post("/elder/connection-code/refresh")
def refresh_connection_code(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "elder":
        raise HTTPException(status_code=403, detail="Only elder accounts have a connection code")
    new_code = generate_connection_code()
    with _db() as conn:
        conn.execute("UPDATE users SET connection_code = ? WHERE id = ?", (new_code, user["id"]))
    return {"connectionCode": new_code}

# ─────────────────────────────────────────
# Connections
# ─────────────────────────────────────────
@app.get("/connections/caregivers")
def list_my_caregivers(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "elder":
        raise HTTPException(status_code=403, detail="Only elder accounts can list caregivers")
    with _db() as conn:
        rows = conn.execute(
            "SELECT u.id,u.display_name,u.email,c.created_at FROM connections c JOIN users u ON c.caregiver_id=u.id WHERE c.elder_id=?",
            (user["id"],),
        ).fetchall()
    return [{"id": r["id"], "displayName": r["display_name"], "email": r["email"], "linkedAt": r["created_at"]} for r in rows]

@app.get("/connections/elders")
def list_my_elders(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "caregiver":
        raise HTTPException(status_code=403, detail="Only caregiver accounts can list linked elders")
    with _db() as conn:
        rows = conn.execute(
            "SELECT u.id,u.display_name,u.email,c.created_at FROM connections c JOIN users u ON c.elder_id=u.id WHERE c.caregiver_id=?",
            (user["id"],),
        ).fetchall()
    return [{"id": r["id"], "displayName": r["display_name"], "email": r["email"], "linkedAt": r["created_at"]} for r in rows]

@app.post("/connections/link")
def link_caregiver_to_elder(body: LinkByCodeBody, user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "caregiver":
        raise HTTPException(status_code=403, detail="Sign in as Son / Daughter (caregiver) to link with an elder")
    elder = find_elder_by_connection_code(body.code)
    if not elder:
        raise HTTPException(status_code=404, detail="No elder matches that code")
    if elder["id"] == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot link to your own account")
    if is_caregiver_linked_to_elder(user["id"], elder["id"]):
        return {"ok": True, "alreadyLinked": True,
                "elder": {"id": elder["id"], "displayName": elder["display_name"], "email": elder["email"]}}
    with _db() as conn:
        conn.execute(
            "INSERT INTO connections (caregiver_id,elder_id,created_at) VALUES (?,?,?)",
            (user["id"], elder["id"], datetime.now(timezone.utc).isoformat()),
        )
    return {"ok": True, "alreadyLinked": False,
            "elder": {"id": elder["id"], "displayName": elder["display_name"], "email": elder["email"]}}

# ─────────────────────────────────────────
# Reminders
# ─────────────────────────────────────────
@app.post("/reminders", response_model=Reminder)
def create_reminder(reminder: ReminderCreate, user: Annotated[dict, Depends(get_current_user)]):
    if reminder.createdByUserId != user["id"]:
        raise HTTPException(status_code=403, detail="createdByUserId must match the signed-in user")
    assert_can_access_owner(user, reminder.ownerUserId)
    now = datetime.now(timezone.utc)
    if reminder.dueDateTime <= now:
        raise HTTPException(status_code=400, detail="Reminder dueDateTime must be in the future")
    rid = str(uuid4())
    with _db() as conn:
        dup = conn.execute(
            "SELECT 1 FROM reminders WHERE owner_user_id=? AND due_datetime=?",
            (reminder.ownerUserId, reminder.dueDateTime.isoformat()),
        ).fetchone()
        if dup:
            raise HTTPException(status_code=400, detail="This user already has another event at the same date and time")
        conn.execute(
            """INSERT INTO reminders (id,owner_user_id,created_by_user_id,title,description,category,
               due_datetime,repeat_type,voice_created,is_critical,escalation_enabled,
               status,completed_at,follow_up_count,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rid, reminder.ownerUserId, reminder.createdByUserId,
             reminder.title.strip(), reminder.description.strip() if reminder.description else None,
             reminder.category.strip(), reminder.dueDateTime.isoformat(), reminder.repeatType,
             int(reminder.voiceCreated), int(reminder.isCritical), int(reminder.escalationEnabled),
             "pending", None, 0, now.isoformat(), now.isoformat()),
        )
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (rid,)).fetchone()
    return _reminder_row(row)

@app.get("/reminders", response_model=list[Reminder])
def get_reminders(user: Annotated[dict, Depends(get_current_user)]):
    return _fetch_reminders(user)

@app.get("/reminders/upcoming", response_model=list[Reminder])
def get_upcoming_reminders(user: Annotated[dict, Depends(get_current_user)]):
    now = datetime.now(timezone.utc).isoformat()
    return _fetch_reminders(user, "AND due_datetime >= ? AND status != 'completed'", [now])

@app.get("/reminders/pending", response_model=list[Reminder])
def get_pending_reminders(user: Annotated[dict, Depends(get_current_user)]):
    return _fetch_reminders(user, "AND status = 'pending'")

@app.get("/reminders/completed", response_model=list[Reminder])
def get_completed_reminders(user: Annotated[dict, Depends(get_current_user)]):
    return _fetch_reminders(user, "AND status = 'completed'")

@app.get("/reminders/{reminder_id}", response_model=Reminder)
def get_reminder_detail(reminder_id: str, user: Annotated[dict, Depends(get_current_user)]):
    with _db() as conn:
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Reminder not found")
    r = _reminder_row(row)
    assert_can_mutate_reminder(user, r)
    return r

@app.put("/reminders/{reminder_id}", response_model=Reminder)
def update_reminder(reminder_id: str, body: ReminderUpdate, user: Annotated[dict, Depends(get_current_user)]):
    with _db() as conn:
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Reminder not found")
        r = _reminder_row(row)
        assert_can_mutate_reminder(user, r)
        if body.dueDateTime <= datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Reminder dueDateTime must be in the future")
        dup = conn.execute(
            "SELECT 1 FROM reminders WHERE owner_user_id=? AND due_datetime=? AND id!=?",
            (r["ownerUserId"], body.dueDateTime.isoformat(), reminder_id),
        ).fetchone()
        if dup:
            raise HTTPException(status_code=400, detail="This user already has another event at the same date and time")
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE reminders SET title=?,description=?,category=?,due_datetime=?,repeat_type=?,updated_at=? WHERE id=?",
            (body.title.strip(), body.description.strip() if body.description else None,
             body.category.strip(), body.dueDateTime.isoformat(), body.repeatType, now, reminder_id),
        )
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
    return _reminder_row(row)

@app.delete("/reminders/{reminder_id}")
def delete_reminder(reminder_id: str, user: Annotated[dict, Depends(get_current_user)]):
    with _db() as conn:
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Reminder not found")
        assert_can_mutate_reminder(user, _reminder_row(row))
        conn.execute("DELETE FROM reminders WHERE id=?", (reminder_id,))
    return {"ok": True, "deletedId": reminder_id}

@app.patch("/reminders/{reminder_id}/complete", response_model=Reminder)
def complete_reminder(reminder_id: str, user: Annotated[dict, Depends(get_current_user)]):
    with _db() as conn:
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Reminder not found")
        r = _reminder_row(row)
        assert_can_mutate_reminder(user, r)
        now = datetime.now(timezone.utc)
        conn.execute(
            "UPDATE reminders SET status='completed',completed_at=?,updated_at=? WHERE id=?",
            (now.isoformat(), now.isoformat(), reminder_id),
        )
        if r["repeatType"]:
            _spawn_next_occurrence(conn, r, now)
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
    return _reminder_row(row)

@app.get("/users/{user_id}/reminders", response_model=list[Reminder])
def get_user_reminders(user_id: str, user: Annotated[dict, Depends(get_current_user)]):
    assert_can_access_owner(user, user_id)
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE owner_user_id=? ORDER BY due_datetime", (user_id,)
        ).fetchall()
    return [_reminder_row(r) for r in rows]

@app.get("/users/{user_id}/reminders/overdue", response_model=list[Reminder])
def get_overdue_reminders(user_id: str, user: Annotated[dict, Depends(get_current_user)]):
    assert_can_access_owner(user, user_id)
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE owner_user_id=? AND status='overdue' ORDER BY due_datetime", (user_id,)
        ).fetchall()
    return [_reminder_row(r) for r in rows]

@app.get("/users/{user_id}/reminders/critical", response_model=list[Reminder])
def get_critical_reminders(user_id: str, user: Annotated[dict, Depends(get_current_user)]):
    assert_can_access_owner(user, user_id)
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE owner_user_id=? AND is_critical=1 ORDER BY due_datetime", (user_id,)
        ).fetchall()
    return [_reminder_row(r) for r in rows]

@app.get("/users/{user_id}/reminders/completed", response_model=list[Reminder])
def get_user_completed_reminders(user_id: str, user: Annotated[dict, Depends(get_current_user)]):
    assert_can_access_owner(user, user_id)
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM reminders WHERE owner_user_id=? AND status='completed' ORDER BY due_datetime", (user_id,)
        ).fetchall()
    return [_reminder_row(r) for r in rows]

@app.post("/reminders/check-overdue")
def check_overdue_reminders(user: Annotated[dict, Depends(get_current_user)]):
    owner_ids = _accessible_owner_ids(user)
    if not owner_ids:
        return {"message": "No reminders to check", "count": 0, "updatedReminders": []}
    now = datetime.now(timezone.utc)
    updated = []
    with _db() as conn:
        rows = conn.execute(
            f"SELECT * FROM reminders WHERE owner_user_id IN ({_ph(owner_ids)}) AND status='pending' AND due_datetime < ?",
            owner_ids + [now.isoformat()],
        ).fetchall()
        for row in rows:
            r = _reminder_row(row)
            conn.execute(
                "UPDATE reminders SET status='overdue',follow_up_count=follow_up_count+1,updated_at=? WHERE id=?",
                (now.isoformat(), r["id"]),
            )
            if r["repeatType"]:
                _spawn_next_occurrence(conn, r, now)
            updated.append(r["id"])
    return {"message": "Overdue check completed", "count": len(updated), "updatedReminders": updated}

# ─────────────────────────────────────────
# Emergency
# ─────────────────────────────────────────
@app.post("/emergency/trigger")
def emergency_trigger(body: EmergencyTriggerBody, user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "elder":
        raise HTTPException(status_code=403, detail="Only the elder account can send an emergency alert")
    caregiver_ids = linked_caregiver_ids_for_elder(user["id"])
    if not caregiver_ids:
        raise HTTPException(status_code=400, detail="No family member is linked yet. Share your connection code first.")
    aid = str(uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        conn.execute(
            "INSERT INTO emergency_alerts (id,elder_id,elder_display_name,created_at,source,phrase,acknowledged,acknowledged_at) VALUES (?,?,?,?,?,?,?,?)",
            (aid, user["id"], user["display_name"], now, body.source,
             body.phrase.strip() if body.phrase else None, 0, None),
        )
    return {"ok": True, "alertId": aid, "notifiedCaregivers": len(caregiver_ids)}

@app.get("/emergency/alerts")
def emergency_alerts_list(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "caregiver":
        raise HTTPException(status_code=403, detail="Only family (caregiver) accounts can view emergency alerts")
    elder_ids = linked_elder_ids_for_caregiver(user["id"])
    if not elder_ids:
        return {"alerts": []}
    with _db() as conn:
        rows = conn.execute(
            f"SELECT * FROM emergency_alerts WHERE elder_id IN ({_ph(elder_ids)}) ORDER BY acknowledged, created_at DESC",
            elder_ids,
        ).fetchall()
    return {"alerts": [_alert_to_json(r) for r in rows]}

@app.patch("/emergency/alerts/{alert_id}/ack")
def emergency_acknowledge(alert_id: str, user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "caregiver":
        raise HTTPException(status_code=403, detail="Only family (caregiver) accounts can acknowledge alerts")
    elder_ids = linked_elder_ids_for_caregiver(user["id"])
    with _db() as conn:
        row = conn.execute("SELECT * FROM emergency_alerts WHERE id=?", (alert_id,)).fetchone()
        if not row or row["elder_id"] not in elder_ids:
            raise HTTPException(status_code=404, detail="Alert not found")
        conn.execute(
            "UPDATE emergency_alerts SET acknowledged=1,acknowledged_at=? WHERE id=?",
            (datetime.now(timezone.utc).isoformat(), alert_id),
        )
    return {"ok": True}

# ─────────────────────────────────────────
# Nova AI routes
# ─────────────────────────────────────────
def _require_aws():
    if not os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        raise HTTPException(status_code=500, detail="AWS_BEARER_TOKEN_BEDROCK is not set on the backend")

def _strip_fences(text: str) -> str:
    return re.sub(r"^```[a-z]*\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)

@app.post("/chat", response_model=ChatResponse)
def chat_with_nora(body: ChatRequest, user: Annotated[dict, Depends(get_current_user)]):
    _require_aws()
    target_owner_id = body.ownerUserId or user["id"]
    assert_can_access_owner(user, target_owner_id)
    target_user = find_user_by_id(target_owner_id)
    target_name = target_user["display_name"] if target_user else "the user"
    with _db() as conn:
        rows = conn.execute(
            "SELECT title,category,due_datetime,status FROM reminders WHERE owner_user_id=? AND status!='completed' ORDER BY due_datetime LIMIT 8",
            (target_owner_id,),
        ).fetchall()
    upcoming = [{"title": r["title"], "category": r["category"], "dueDateTime": r["due_datetime"], "status": r["status"]} for r in rows]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    system = (
        "You are Nora, a warm, calm, voice-friendly assistant for older adults and caregivers. "
        "Keep replies short and easy to understand. "
        "ALWAYS respond with a valid JSON object with two keys:\n"
        '  "reply": your conversational response (string)\n'
        '  "intent": null, OR {"type":"create_reminder","title":"...","dueDateTime":"YYYY-MM-DDTHH:MM:SS","category":"medical|personal|social|other"}\n'
        "Only set intent when the user clearly wants to create a new reminder. "
        f"Use ISO 8601 for dueDateTime. Today is {today}. "
        "Do not invent appointments not in context. Do not include markdown or extra text outside the JSON."
    )
    user_text = (
        f"Signed-in role: {user['role']}\nTarget person: {target_name}\n"
        f"Upcoming reminders: {json.dumps(upcoming)}\n\nUser message: {body.message}"
    )
    try:
        raw = _nova_invoke("amazon.nova-lite-v1:0", system, user_text, max_tokens=512)
        try:
            parsed = json.loads(_strip_fences(raw))
            return {"reply": parsed.get("reply", raw), "intent": parsed.get("intent")}
        except json.JSONDecodeError:
            return {"reply": raw, "intent": None}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nova chat failed: {str(e)}")

@app.post("/prepare-task", response_model=TaskPreparationResponse)
def prepare_task(body: TaskPreparationRequest, user: Annotated[dict, Depends(get_current_user)]):
    _require_aws()
    with _db() as conn:
        row = conn.execute("SELECT * FROM reminders WHERE id=?", (body.reminder_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Reminder not found")
    r = _reminder_row(row)
    assert_can_mutate_reminder(user, r)
    cache_key = f"{r['category']}::{r['title'].lower().strip()}"
    if cache_key in _task_prep_cache:
        return {"content": _task_prep_cache[cache_key]}
    system = (
        "You are a helpful assistant for older adults. "
        "Given a reminder/appointment, provide a concise friendly guide: "
        "1) What documents/items to bring, 2) Key steps to expect, "
        "3) Whether in-person attendance is required, 4) Helpful tips. "
        "Under 200 words, simple language, short bullet points."
    )
    user_text = (
        f"Appointment: {r['title']}\nCategory: {r['category']}\n"
        f"Description: {r.get('description') or 'None'}\n\nProvide a preparation guide."
    )
    try:
        content = _nova_invoke("amazon.nova-lite-v1:0", system, user_text, max_tokens=400)
        _task_prep_cache[cache_key] = content
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nova task preparation failed: {str(e)}")

@app.post("/emergency/detect", response_model=EmergencyDetectResponse)
def emergency_detect(body: EmergencyDetectRequest, user: Annotated[dict, Depends(get_current_user)]):
    _require_aws()
    system = (
        "You are a safety detection system. Analyze the phrase for medical emergency or distress. "
        'Respond ONLY with JSON: {"is_emergency": true/false, "confidence": 0.0-1.0, "details": "reason or null"}'
    )
    try:
        raw = _nova_invoke("amazon.nova-micro-v1:0", system, f'Phrase: "{body.phrase}"', max_tokens=128)
        try:
            parsed = json.loads(_strip_fences(raw))
            return {"is_emergency": bool(parsed.get("is_emergency", False)),
                    "confidence": float(parsed.get("confidence", 0.0)),
                    "details": parsed.get("details")}
        except (json.JSONDecodeError, ValueError):
            return {"is_emergency": False, "confidence": 0.0, "details": None}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nova emergency detection failed: {str(e)}")
