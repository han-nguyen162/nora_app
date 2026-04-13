const API_BASE = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

const TOKEN_KEY = "nora_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function parseErrorDetail(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((e) => e.msg ?? JSON.stringify(e)).join(", ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return "Request failed";
}

export async function api(path, options = {}) {
  const headers = { ...options.headers };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = parseErrorDetail(data.detail) || res.statusText;
      throw new Error(msg);
    }

    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Request timed out. Backend may not be running.");
    }
    if (err instanceof TypeError) {
      throw new Error("Cannot connect to backend. Check FastAPI server and URL.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function register({ email, password, role, displayName }) {
  return api("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      role,
      display_name: displayName,
    }),
  });
}

export async function login({ email, password }) {
  return api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function logout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    setToken(null);
  }
}

export async function fetchMe() {
  return api("/auth/me");
}

export async function refreshConnectionCode() {
  return api("/elder/connection-code/refresh", { method: "POST" });
}

export async function linkWithCode(code) {
  return api("/connections/link", {
    method: "POST",
    body: JSON.stringify({ code: code.trim() }),
  });
}

export async function fetchLinkedElders() {
  return api("/connections/elders");
}

export async function fetchLinkedCaregivers() {
  return api("/connections/caregivers");
}

export async function fetchUserReminders(userId) {
  return api(`/users/${encodeURIComponent(userId)}/reminders`);
}

export async function createReminder(body) {
  return api("/reminders", {
    method: "POST",
    body: JSON.stringify({
      ownerUserId: body.ownerUserId,
      createdByUserId: body.createdByUserId,
      title: body.title,
      description: body.description ?? null,
      category: body.category,
      dueDateTime: body.dueDateTime,
      repeatType: null,
      voiceCreated: false,
      isCritical: false,
      escalationEnabled: false,
    }),
  });
}

export async function updateReminder(reminderId, body) {
  return api(`/reminders/${encodeURIComponent(reminderId)}`, {
    method: "PUT",
    body: JSON.stringify({
      title: body.title,
      description: body.description ?? null,
      category: body.category,
      dueDateTime: body.dueDateTime,
    }),
  });
}

export async function deleteReminder(reminderId) {
  return api(`/reminders/${encodeURIComponent(reminderId)}`, {
    method: "DELETE",
  });
}

export async function triggerEmergency({ source, phrase }) {
  return api("/emergency/trigger", {
    method: "POST",
    body: JSON.stringify({
      source,
      phrase: phrase ?? null,
    }),
  });
}

export async function fetchEmergencyAlerts() {
  return api("/emergency/alerts");
}

export async function acknowledgeEmergencyAlert(alertId) {
  return api(`/emergency/alerts/${encodeURIComponent(alertId)}/ack`, {
    method: "PATCH",
  });
}