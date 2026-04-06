import hashlib
import os
import secrets
from pathlib import Path
from datetime import datetime
from typing import Annotated, Literal
from uuid import uuid4

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from openai import OpenAI
from pydantic import BaseModel, EmailStr, Field

app = FastAPI(title="Nora Backend")

# =========================
# OpenAI client (single instance)
# =========================
openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# In-memory storage for MVP
# =========================
reminders: list[dict] = []
users: list[dict] = []
sessions: dict[str, str] = {}  # token -> user_id
connections: list[dict] = []   # caregiver_id + elder_id pairs

security = HTTPBearer(auto_error=False)
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


# =========================
# Utility helpers
# =========================
def hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, 120_000
    ).hex()


def new_salt() -> str:
    return secrets.token_hex(16)


def generate_connection_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))


def find_user_by_id(user_id: str) -> dict | None:
    for u in users:
        if u["id"] == user_id:
            return u
    return None


def find_user_by_email(email: str) -> dict | None:
    e = email.strip().lower()
    for u in users:
        if u["email"] == e:
            return u
    return None


def find_elder_by_connection_code(code: str) -> dict | None:
    c = code.strip().upper()
    for u in users:
        if u["role"] == "elder" and u.get("connection_code") == c:
            return u
    return None


def connection_exists(caregiver_id: str, elder_id: str) -> bool:
    for row in connections:
        if row["caregiver_id"] == caregiver_id and row["elder_id"] == elder_id:
            return True
    return False


def is_caregiver_linked_to_elder(caregiver_id: str, elder_id: str) -> bool:
    for row in connections:
        if row["caregiver_id"] == caregiver_id and row["elder_id"] == elder_id:
            return True
    return False


def user_public(u: dict) -> dict:
    out = {
        "id": u["id"],
        "email": u["email"],
        "role": u["role"],
        "displayName": u["display_name"],
    }
    if u["role"] == "elder":
        out["connectionCode"] = u.get("connection_code")
    return out


def can_access_owner(current_user: dict, owner_user_id: str) -> bool:
    if current_user["id"] == owner_user_id:
        return True
    if current_user["role"] == "caregiver" and is_caregiver_linked_to_elder(
        current_user["id"], owner_user_id
    ):
        return True
    return False


def assert_can_access_owner(current_user: dict, owner_user_id: str) -> None:
    if not can_access_owner(current_user, owner_user_id):
        raise HTTPException(status_code=403, detail="You do not have access to this user")


def assert_can_mutate_reminder(current_user: dict, reminder: dict) -> None:
    owner_user_id = reminder["ownerUserId"]
    if not can_access_owner(current_user, owner_user_id):
        raise HTTPException(status_code=403, detail="You do not have access to this reminder")


async def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> dict:
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_id = sessions.get(creds.credentials)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = find_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


# =========================
# Auth models
# =========================
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


# =========================
# Reminder models
# =========================
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


# =========================
# Chat models
# =========================
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    ownerUserId: str | None = None


class ChatResponse(BaseModel):
    reply: str


# =========================
# Reminder helpers
# =========================
def find_reminder_index(reminder_id: str) -> int:
    for i, reminder in enumerate(reminders):
        if reminder["id"] == reminder_id:
            return i
    return -1


def same_owner_same_datetime_exists(
    owner_user_id: str,
    due_datetime: datetime,
    exclude_reminder_id: str | None = None,
) -> bool:
    for reminder in reminders:
        if exclude_reminder_id and reminder["id"] == exclude_reminder_id:
            continue
        if (
            reminder["ownerUserId"] == owner_user_id
            and reminder["dueDateTime"] == due_datetime
        ):
            return True
    return False


# =========================
# Routes
# =========================
@app.get("/")
def root():
    return {"message": "Nora backend is running"}


# =========================
# Auth routes
# =========================
@app.post("/auth/register", response_model=TokenResponse)
def register(body: UserRegister):
    if find_user_by_email(body.email):
        raise HTTPException(status_code=400, detail="Email already registered")

    salt = new_salt()
    uid = str(uuid4())

    user = {
        "id": uid,
        "email": body.email.strip().lower(),
        "password_hash": hash_password(body.password, salt),
        "salt": salt,
        "role": body.role,
        "display_name": body.display_name.strip(),
        "connection_code": generate_connection_code() if body.role == "elder" else None,
    }
    users.append(user)

    token = secrets.token_urlsafe(32)
    sessions[token] = uid

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": user_public(user),
    }


@app.post("/auth/login", response_model=TokenResponse)
def login(body: UserLogin):
    user = find_user_by_email(body.email)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if hash_password(body.password, user["salt"]) != user["password_hash"]:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = secrets.token_urlsafe(32)
    sessions[token] = user["id"]

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": user_public(user),
    }


@app.post("/auth/logout")
def logout(user: Annotated[dict, Depends(get_current_user)]):
    to_drop = [t for t, uid in sessions.items() if uid == user["id"]]
    for t in to_drop:
        del sessions[t]
    return {"ok": True}


@app.get("/auth/me")
def auth_me(user: Annotated[dict, Depends(get_current_user)]):
    return user_public(user)


@app.post("/elder/connection-code/refresh")
def refresh_connection_code(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "elder":
        raise HTTPException(status_code=403, detail="Only elder accounts have a connection code")

    user["connection_code"] = generate_connection_code()
    return {"connectionCode": user["connection_code"]}


# =========================
# Connection routes
# =========================
@app.get("/connections/caregivers")
def list_my_caregivers(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "elder":
        raise HTTPException(status_code=403, detail="Only elder accounts can list caregivers")

    out = []
    for row in connections:
        if row["elder_id"] == user["id"]:
            c = find_user_by_id(row["caregiver_id"])
            if c:
                out.append(
                    {
                        "id": c["id"],
                        "displayName": c["display_name"],
                        "email": c["email"],
                        "linkedAt": row["created_at"],
                    }
                )
    return out


@app.get("/connections/elders")
def list_my_elders(user: Annotated[dict, Depends(get_current_user)]):
    if user["role"] != "caregiver":
        raise HTTPException(status_code=403, detail="Only caregiver accounts can list linked elders")

    out = []
    for row in connections:
        if row["caregiver_id"] == user["id"]:
            e = find_user_by_id(row["elder_id"])
            if e:
                out.append(
                    {
                        "id": e["id"],
                        "displayName": e["display_name"],
                        "email": e["email"],
                        "linkedAt": row["created_at"],
                    }
                )
    return out


@app.post("/connections/link")
def link_caregiver_to_elder(
    body: LinkByCodeBody,
    user: Annotated[dict, Depends(get_current_user)],
):
    if user["role"] != "caregiver":
        raise HTTPException(
            status_code=403,
            detail="Sign in as Son / Daughter (caregiver) to link with an elder",
        )

    elder = find_elder_by_connection_code(body.code)
    if not elder:
        raise HTTPException(status_code=404, detail="No elder matches that code")

    if elder["id"] == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot link to your own account")

    if connection_exists(user["id"], elder["id"]):
        return {
            "ok": True,
            "alreadyLinked": True,
            "elder": {
                "id": elder["id"],
                "displayName": elder["display_name"],
                "email": elder["email"],
            },
        }

    now = datetime.now()
    connections.append(
        {
            "caregiver_id": user["id"],
            "elder_id": elder["id"],
            "created_at": now,
        }
    )

    return {
        "ok": True,
        "alreadyLinked": False,
        "elder": {
            "id": elder["id"],
            "displayName": elder["display_name"],
            "email": elder["email"],
        },
    }


# =========================
# Reminder routes
# =========================
@app.post("/reminders", response_model=Reminder)
def create_reminder(
    reminder: ReminderCreate,
    user: Annotated[dict, Depends(get_current_user)],
):
    if reminder.createdByUserId != user["id"]:
        raise HTTPException(status_code=403, detail="createdByUserId must match the signed-in user")

    assert_can_access_owner(user, reminder.ownerUserId)

    now = datetime.now()

    if reminder.dueDateTime <= now:
        raise HTTPException(status_code=400, detail="Reminder dueDateTime must be in the future")

    if same_owner_same_datetime_exists(reminder.ownerUserId, reminder.dueDateTime):
        raise HTTPException(
            status_code=400,
            detail="This user already has another event at the same date and time",
        )

    new_reminder = {
        "id": str(uuid4()),
        "ownerUserId": reminder.ownerUserId,
        "createdByUserId": reminder.createdByUserId,
        "title": reminder.title.strip(),
        "description": reminder.description.strip() if reminder.description else None,
        "category": reminder.category.strip(),
        "dueDateTime": reminder.dueDateTime,
        "repeatType": reminder.repeatType,
        "voiceCreated": reminder.voiceCreated,
        "isCritical": reminder.isCritical,
        "escalationEnabled": reminder.escalationEnabled,
        "status": "pending",
        "completedAt": None,
        "followUpCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }

    reminders.append(new_reminder)
    return new_reminder


@app.get("/reminders", response_model=list[Reminder])
def get_reminders(user: Annotated[dict, Depends(get_current_user)]):
    visible = [
        reminder for reminder in reminders
        if can_access_owner(user, reminder["ownerUserId"])
    ]
    visible.sort(key=lambda r: r["dueDateTime"])
    return visible


@app.get("/reminders/upcoming", response_model=list[Reminder])
def get_upcoming_reminders(user: Annotated[dict, Depends(get_current_user)]):
    now = datetime.now()
    upcoming = [
        reminder
        for reminder in reminders
        if can_access_owner(user, reminder["ownerUserId"])
        and reminder["dueDateTime"] >= now
        and reminder["status"] != "completed"
    ]
    upcoming.sort(key=lambda r: r["dueDateTime"])
    return upcoming


@app.get("/reminders/pending", response_model=list[Reminder])
def get_pending_reminders(user: Annotated[dict, Depends(get_current_user)]):
    pending = [
        reminder
        for reminder in reminders
        if can_access_owner(user, reminder["ownerUserId"])
        and reminder["status"] == "pending"
    ]
    pending.sort(key=lambda r: r["dueDateTime"])
    return pending


@app.get("/reminders/completed", response_model=list[Reminder])
def get_completed_reminders(user: Annotated[dict, Depends(get_current_user)]):
    completed = [
        reminder
        for reminder in reminders
        if can_access_owner(user, reminder["ownerUserId"])
        and reminder["status"] == "completed"
    ]
    completed.sort(key=lambda r: r["dueDateTime"])
    return completed


@app.get("/reminders/{reminder_id}", response_model=Reminder)
def get_reminder_detail(
    reminder_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    index = find_reminder_index(reminder_id)
    if index == -1:
        raise HTTPException(status_code=404, detail="Reminder not found")

    reminder = reminders[index]
    assert_can_mutate_reminder(user, reminder)
    return reminder


@app.put("/reminders/{reminder_id}", response_model=Reminder)
def update_reminder(
    reminder_id: str,
    body: ReminderUpdate,
    user: Annotated[dict, Depends(get_current_user)],
):
    index = find_reminder_index(reminder_id)
    if index == -1:
        raise HTTPException(status_code=404, detail="Reminder not found")

    reminder = reminders[index]
    assert_can_mutate_reminder(user, reminder)

    if body.dueDateTime <= datetime.now():
        raise HTTPException(status_code=400, detail="Reminder dueDateTime must be in the future")

    if same_owner_same_datetime_exists(
        reminder["ownerUserId"],
        body.dueDateTime,
        exclude_reminder_id=reminder_id,
    ):
        raise HTTPException(
            status_code=400,
            detail="This user already has another event at the same date and time",
        )

    reminder["title"] = body.title.strip()
    reminder["description"] = body.description.strip() if body.description else None
    reminder["category"] = body.category.strip()
    reminder["dueDateTime"] = body.dueDateTime
    reminder["updatedAt"] = datetime.now()

    return reminder


@app.delete("/reminders/{reminder_id}")
def delete_reminder(
    reminder_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    index = find_reminder_index(reminder_id)
    if index == -1:
        raise HTTPException(status_code=404, detail="Reminder not found")

    reminder = reminders[index]
    assert_can_mutate_reminder(user, reminder)

    deleted = reminders.pop(index)
    return {"ok": True, "deletedId": deleted["id"]}


@app.patch("/reminders/{reminder_id}/complete", response_model=Reminder)
def complete_reminder(
    reminder_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    index = find_reminder_index(reminder_id)
    if index == -1:
        raise HTTPException(status_code=404, detail="Reminder not found")

    reminder = reminders[index]
    assert_can_mutate_reminder(user, reminder)

    reminder["status"] = "completed"
    reminder["completedAt"] = datetime.now()
    reminder["updatedAt"] = datetime.now()

    return reminder


@app.get("/users/{user_id}/reminders", response_model=list[Reminder])
def get_user_reminders(
    user_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    assert_can_access_owner(user, user_id)

    user_reminders = [
        reminder for reminder in reminders
        if reminder["ownerUserId"] == user_id
    ]
    user_reminders.sort(key=lambda r: r["dueDateTime"])
    return user_reminders


@app.get("/users/{user_id}/reminders/overdue", response_model=list[Reminder])
def get_overdue_reminders(
    user_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    assert_can_access_owner(user, user_id)

    overdue = [
        reminder for reminder in reminders
        if reminder["ownerUserId"] == user_id and reminder["status"] == "overdue"
    ]
    overdue.sort(key=lambda r: r["dueDateTime"])
    return overdue


@app.get("/users/{user_id}/reminders/critical", response_model=list[Reminder])
def get_critical_reminders(
    user_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    assert_can_access_owner(user, user_id)

    critical = [
        reminder for reminder in reminders
        if reminder["ownerUserId"] == user_id and reminder["isCritical"] is True
    ]
    critical.sort(key=lambda r: r["dueDateTime"])
    return critical


@app.get("/users/{user_id}/reminders/completed", response_model=list[Reminder])
def get_user_completed_reminders(
    user_id: str,
    user: Annotated[dict, Depends(get_current_user)],
):
    assert_can_access_owner(user, user_id)

    completed = [
        reminder for reminder in reminders
        if reminder["ownerUserId"] == user_id and reminder["status"] == "completed"
    ]
    completed.sort(key=lambda r: r["dueDateTime"])
    return completed


@app.post("/reminders/check-overdue")
def check_overdue_reminders(user: Annotated[dict, Depends(get_current_user)]):
    now = datetime.now()
    updated_reminders = []

    for reminder in reminders:
        if can_access_owner(user, reminder["ownerUserId"]):
            if reminder["status"] == "pending" and reminder["dueDateTime"] < now:
                reminder["status"] = "overdue"
                reminder["followUpCount"] += 1
                reminder["updatedAt"] = now
                updated_reminders.append(reminder)

    return {
        "message": "Overdue reminder check completed",
        "count": len(updated_reminders),
        "updatedReminders": updated_reminders,
    }


# =========================
# Chat route
# =========================
@app.post("/chat", response_model=ChatResponse)
def chat_with_nora(
    body: ChatRequest,
    user: Annotated[dict, Depends(get_current_user)],
):
    target_owner_id = body.ownerUserId or user["id"]
    assert_can_access_owner(user, target_owner_id)

    target_user = find_user_by_id(target_owner_id)
    target_name = target_user["display_name"] if target_user else "the user"

    if not os.environ.get("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY is not set on the backend",
        )

    upcoming = [
        r for r in reminders
        if r["ownerUserId"] == target_owner_id and r["status"] != "completed"
    ]
    upcoming.sort(key=lambda r: r["dueDateTime"])
    upcoming_preview = [
        {
            "title": r["title"],
            "category": r["category"],
            "dueDateTime": r["dueDateTime"].isoformat(),
            "status": r["status"],
        }
        for r in upcoming[:8]
    ]

    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Nora, a warm, simple, voice-friendly assistant for older adults and caregivers. "
                        "Keep answers short, calm, practical, and easy to understand. "
                        "If the user asks about reminders or schedule, use the reminder context provided. "
                        "Do not invent appointments that are not in context."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Current signed-in role: {user['role']}\n"
                        f"Target person name: {target_name}\n"
                        f"Upcoming reminder context: {upcoming_preview}\n\n"
                        f"User message: {body.message}"
                    ),
                },
            ],
        )
        return {"reply": response.choices[0].message.content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI chat failed: {str(e)}")