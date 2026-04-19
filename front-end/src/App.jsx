import { useCallback, useEffect, useRef, useState } from "react";
import {
  acknowledgeEmergencyAlert,
  chatWithNora,
  createReminder,
  deleteReminder,
  detectEmergency,
  fetchEmergencyAlerts,
  fetchLinkedCaregivers,
  fetchLinkedElders,
  fetchMe,
  fetchReminders,
  fetchUserReminders,
  getToken,
  linkWithCode,
  login,
  logout,
  prepareTask,
  refreshConnectionCode,
  register,
  setToken,
  triggerEmergency,
  updateReminder,
} from "./api.js";

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function mapReminderFromApi(r) {
  const d = new Date(r.dueDateTime);
  const pad = (n) => String(n).padStart(2, "0");

  return {
    id: r.id,
    title: r.title,
    day: WEEK[d.getDay()] ?? "—",
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    type: r.category || "personal",
    repeatType: r.repeatType ?? null,
    description: r.description || "",
    dueDateTime: r.dueDateTime,
    dueLocal: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`,
  };
}

function defaultDueDatetimeLocal() {
  const d = new Date();
  d.setTime(d.getTime() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Voice phrases that trigger an emergency alert (elder account). */
const EMERGENCY_PHRASE_RE =
  /\b(emergency|help\s*me|i\s*'?ve\s*fallen|i\s*fell|i\s*'?m\s*hurt|heart\s*attack|can\s*'?t\s*breathe|cannot\s*breathe|choking|bleeding\s*badly|call\s*911|send\s*help|need\s*help\s*now)\b/i;

function transcriptLooksLikeEmergency(text) {
  return EMERGENCY_PHRASE_RE.test(text.trim());
}

function playEmergencyAlarm() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const beep = (freq, start, dur) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.value = 0.12;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(start);
      o.stop(start + dur);
    };
    beep(880, 0, 0.15);
    beep(660, 0.2, 0.15);
    beep(880, 0.4, 0.2);
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [screen, setScreen] = useState("login");
  const [authMode, setAuthMode] = useState("login");
  const [role, setRole] = useState("elder");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [connectCode, setConnectCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);

  const recognitionRef = useRef(null);
  const onVoiceTranscriptRef = useRef(null);
  const emergencySendingRef = useRef(false);
  const chatBusyRef = useRef(false);
  const initialEmergencyPollRef = useRef(true);
  const seenEmergencyIdsRef = useRef(new Set());
  const listeningActiveRef = useRef(false);
  const tryStartListeningRef = useRef(() => {});
  const voiceCooldownUntilRef = useRef(0);

  const [voiceError, setVoiceError] = useState("");
  const [speechAvailable, setSpeechAvailable] = useState(false);

  const [isListening, setIsListening] = useState(false);
  const [emergencyStatus, setEmergencyStatus] = useState("");
  const [emergencySending, setEmergencySending] = useState(false);
  const [emergencyAlerts, setEmergencyAlerts] = useState([]);
  const [ackBusyId, setAckBusyId] = useState(null);

  const [reminders, setReminders] = useState([]);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const [elders, setElders] = useState([]);
  const [caregivers, setCaregivers] = useState([]);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatPrefill, setChatPrefill] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!getToken()) {
        setBooting(false);
        return;
      }

      try {
        const me = await fetchMe();
        if (!cancelled) {
          setUser(me);
          setScreen("dashboard");
        }
      } catch {
        setToken(null);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const loadLinksAndReminders = useCallback(async (u, { silent = false } = {}) => {
    if (!u) return;

    if (!silent) setRemindersLoading(true);
    try {
      if (u.role === "caregiver") {
        const list = await fetchLinkedElders();
        setElders(list);
      } else {
        setCaregivers(await fetchLinkedCaregivers());
      }
      const raw = await fetchReminders();
      setReminders(raw.map(mapReminderFromApi));
    } catch {
      /* ignore background poll errors */
    } finally {
      if (!silent) setRemindersLoading(false);
    }
  }, []);

  tryStartListeningRef.current = () => {
    const r = recognitionRef.current;
    if (!r || !listeningActiveRef.current) return;
    try {
      r.start();
      setIsListening(true);
    } catch {
      /* InvalidStateError: already running */
    }
  };

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      return;
    }

    setSpeechAvailable(true);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let full = "";
      for (let i = 0; i < event.results.length; i++) {
        full += event.results[i][0].transcript;
      }
      full = full.trim();
      if (full) onVoiceTranscriptRef.current?.(full);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        return;
      }
      if (event.error === "not-allowed") {
        setVoiceError(
          "Microphone access is off. Allow the mic in your browser settings, or tap the screen once and try again.",
        );
        setIsListening(false);
        return;
      }
      setVoiceError(`Voice: ${event.error}`);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (!listeningActiveRef.current) return;
      setTimeout(() => tryStartListeningRef.current(), 200);
    };

    recognitionRef.current = recognition;
  }, []);

  useEffect(() => {
    if (!user || screen !== "dashboard") return;
    loadLinksAndReminders(user);
    const id = setInterval(() => loadLinksAndReminders(user, { silent: true }), 5000);
    return () => clearInterval(id);
  }, [user, screen, loadLinksAndReminders]);

  const handleEmergencyVoice = useCallback(async (phrase) => {
    if (!user || user.role !== "elder") return;
    if (emergencySendingRef.current) return;
    emergencySendingRef.current = true;
    setEmergencySending(true);
    setEmergencyStatus("");
    setVoiceError("");
    try {
      const r = await triggerEmergency({ source: "voice", phrase });
      setEmergencyStatus(
        `Emergency heard. Alert sent to ${r.notifiedCaregivers} linked contact(s).`,
      );
    } catch (e) {
      setEmergencyStatus(e.message ?? "Could not send alert.");
    } finally {
      emergencySendingRef.current = false;
      setEmergencySending(false);
    }
  }, [user]);

  const handleEmergencyButton = useCallback(async () => {
    if (!user || user.role !== "elder") return;
    setEmergencyStatus("");
    setVoiceError("");
    setEmergencySending(true);
    try {
      const r = await triggerEmergency({ source: "button", phrase: null });
      setEmergencyStatus(`Alert sent to ${r.notifiedCaregivers} linked contact(s).`);
    } catch (e) {
      setEmergencyStatus(e.message ?? "Could not send alert.");
    } finally {
      setEmergencySending(false);
    }
  }, [user]);

  const handleChat = useCallback(async (message) => {
    if (!message.trim() || chatBusyRef.current) return;
    const ownerUserId = user?.role === "elder" ? user.id : elders[0]?.id ?? user?.id;
    setChatMessages((prev) => [...prev, { role: "user", text: message }]);
    chatBusyRef.current = true;
    setChatBusy(true);
    try {
      const { reply, intent } = await chatWithNora({ message, ownerUserId });
      setChatMessages((prev) => [...prev, { role: "nora", text: reply, intent: intent ?? null }]);
    } catch {
      setChatMessages((prev) => [
        ...prev,
        { role: "nora", text: "Sorry, I couldn't reach the server. Please try again.", intent: null },
      ]);
    } finally {
      chatBusyRef.current = false;
      setChatBusy(false);
    }
  }, [user, elders]);

  const handleCreateFromIntent = useCallback(async (intent) => {
    let dueLocal = defaultDueDatetimeLocal();
    if (intent.dueDateTime) {
      const d = new Date(intent.dueDateTime);
      if (!Number.isNaN(d.getTime()) && d > new Date()) {
        const pad = (n) => String(n).padStart(2, "0");
        dueLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
    setChatPrefill({
      title: intent.title || "",
      category: (intent.category || "personal").toLowerCase(),
      description: "",
      dueLocal,
    });
    setChatOpen(false);
  }, []);

  const noraChatDebounceRef = useRef(null);
  const noraQuerySentRef = useRef("");

  useEffect(() => {
    onVoiceTranscriptRef.current = (transcript) => {
      if (user?.role !== "elder") return;

      // "Hey Nora" wake word — route transcript to chat
      const noraMatch = transcript.match(/\bhey[\s,]+nora[,\s]*(.*)/i);
      if (noraMatch) {
        const query = noraMatch[1].trim();
        setChatOpen(true);
        if (query.length > 4 && query !== noraQuerySentRef.current) {
          clearTimeout(noraChatDebounceRef.current);
          noraChatDebounceRef.current = setTimeout(() => {
            noraQuerySentRef.current = query;
            handleChat(query);
          }, 1200);
        }
        return;
      }

      // Fast client-side emergency check
      if (transcriptLooksLikeEmergency(transcript)) {
        if (Date.now() < voiceCooldownUntilRef.current) return;
        voiceCooldownUntilRef.current = Date.now() + 10000;
        void handleEmergencyVoice(transcript);
        return;
      }

      // Nova Micro fallback for complex distress phrases
      if (Date.now() < voiceCooldownUntilRef.current) return;
      detectEmergency(transcript)
        .then(({ is_emergency, confidence }) => {
          if (is_emergency && confidence >= 0.65) {
            voiceCooldownUntilRef.current = Date.now() + 10000;
            void handleEmergencyVoice(transcript);
          }
        })
        .catch(() => { /* ignore */ });
    };
  }, [user, handleEmergencyVoice, handleChat]);

  useEffect(() => {
    const active = user?.role === "elder" && screen === "dashboard";
    listeningActiveRef.current = active;
    if (!active) {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* noop */
      }
      setIsListening(false);
      return;
    }
    const t = setTimeout(() => tryStartListeningRef.current(), 400);
    return () => {
      clearTimeout(t);
      listeningActiveRef.current = false;
      try {
        recognitionRef.current?.stop();
      } catch {
        /* noop */
      }
    };
  }, [user, screen]);

  useEffect(() => {
    if (user?.role !== "elder" || screen !== "dashboard") return;
    const kick = () => tryStartListeningRef.current();
    document.addEventListener("pointerdown", kick, { passive: true, once: true });
    return () => document.removeEventListener("pointerdown", kick);
  }, [user, screen]);

  useEffect(() => {
    if (!user || user.role !== "caregiver" || screen !== "dashboard") return;

    const poll = async () => {
      try {
        const { alerts } = await fetchEmergencyAlerts();
        setEmergencyAlerts(alerts);

        if (initialEmergencyPollRef.current) {
          alerts.forEach((a) => seenEmergencyIdsRef.current.add(a.id));
          initialEmergencyPollRef.current = false;
          return;
        }

        const newAlerts = alerts.filter((a) => !seenEmergencyIdsRef.current.has(a.id));
        newAlerts.forEach((a) => seenEmergencyIdsRef.current.add(a.id));
        if (newAlerts.some((a) => !a.acknowledged)) {
          playEmergencyAlarm();
        }
      } catch {
        /* ignore */
      }
    };

    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [user, screen]);

  const handleAckEmergency = useCallback(async (alertId) => {
    setAckBusyId(alertId);
    try {
      await acknowledgeEmergencyAlert(alertId);
      setEmergencyAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a)),
      );
    } catch (e) {
      console.error(e);
    } finally {
      setAckBusyId(null);
    }
  }, []);

  const handleAuth = async () => {
    setAuthError("");
    setBusy(true);
  
    try {
      if (authMode === "register") {
        const data = await register({
          email,
          password,
          role,
          displayName: displayName.trim() || (role === "elder" ? "Elder" : "Family"),
        });
        setToken(data.access_token);
        setUser(data.user);
        setScreen("dashboard");
      } else {
        const data = await login({ email, password });
        setToken(data.access_token);
        setUser(data.user);
        setScreen("dashboard");
      }
    } catch (e) {
      console.error("Auth error:", e);
      setAuthError(e.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setScreen("login");
    setReminders([]);
    setElders([]);
    setCaregivers([]);
    setEmergencyAlerts([]);
    setEmergencyStatus("");
    initialEmergencyPollRef.current = true;
    seenEmergencyIdsRef.current = new Set();
  };

  const handleCaregiverLink = async () => {
    setLinkMsg("");
    try {
      const result = await linkWithCode(connectCode);
      setLinkMsg(
        result.alreadyLinked
          ? `Already linked with ${result.elder.displayName}.`
          : `Linked with ${result.elder.displayName}.`,
      );
      setConnectCode("");
      await loadLinksAndReminders(user);
    } catch (e) {
      setLinkMsg(e.message ?? "Could not link");
    }
  };

  const handleRefreshCode = async () => {
    setLinkMsg("");
    try {
      const { connectionCode } = await refreshConnectionCode();
      setUser((prev) => (prev ? { ...prev, connectionCode } : prev));
    } catch (e) {
      setLinkMsg(e.message ?? "Could not refresh code");
    }
  };

  const handleCopyCode = async () => {
    if (!user?.connectionCode) return;
    try {
      await navigator.clipboard.writeText(user.connectionCode);
      setLinkMsg("Code copied.");
    } catch {
      setLinkMsg("Copy manually if needed.");
    }
  };

  const handleCreateReminder = async ({ title, category, description, dueLocal, repeatType }) => {
    if (!user) return;

    // Caregivers create events on behalf of their linked elder; elders own their own
    const ownerId = user.role === "caregiver" ? (elders[0]?.id ?? user.id) : user.id;

    const due = new Date(dueLocal);
    if (Number.isNaN(due.getTime())) throw new Error("Invalid date or time.");
    if (due <= new Date()) throw new Error("Pick a date and time in the future.");

    await createReminder({
      ownerUserId: ownerId,
      createdByUserId: user.id,
      title: title.trim(),
      description: description?.trim() ? description.trim() : null,
      category,
      dueDateTime: due.toISOString(),
      repeatType: repeatType ?? null,
    });

    await loadLinksAndReminders(user);
  };

  const handleUpdateReminder = async (reminderId, { title, category, description, dueLocal, repeatType }) => {
    const due = new Date(dueLocal);
    if (Number.isNaN(due.getTime())) throw new Error("Invalid date or time.");
    if (due <= new Date()) throw new Error("Pick a date and time in the future.");

    await updateReminder(reminderId, {
      title: title.trim(),
      description: description?.trim() ? description.trim() : null,
      category,
      dueDateTime: due.toISOString(),
      repeatType: repeatType ?? null,
    });

    await loadLinksAndReminders(user);
  };

  const handleDeleteReminder = async (reminderId) => {
    await deleteReminder(reminderId);
    await loadLinksAndReminders(user);
  };

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-300 text-neutral-600">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-300 p-4 md:p-6">
      <div className="mx-auto w-full max-w-[390px] rounded-[3rem] bg-black p-[10px] shadow-2xl">
        <div className="relative h-[85vh] min-h-[680px] max-h-[844px] overflow-hidden rounded-[2.6rem] border border-black/10 bg-[#f7f5f1]">
          <div className="absolute left-1/2 top-2 z-20 h-7 w-40 -translate-x-1/2 rounded-full bg-black" />

          <div className="flex h-full min-h-0 flex-col">
            <Header />

            {screen === "login" ? (
              <LoginScreen
                authMode={authMode}
                setAuthMode={setAuthMode}
                setAuthError={setAuthError}
                role={role}
                setRole={setRole}
                email={email}
                setEmail={setEmail}
                password={password}
                setPassword={setPassword}
                displayName={displayName}
                setDisplayName={setDisplayName}
                authError={authError}
                busy={busy}
                onSubmit={handleAuth}
              />
            ) : (
              <DashboardScreen
                user={user}
                elders={elders}
                caregivers={caregivers}
                reminders={reminders}
                remindersLoading={remindersLoading}
                connectCode={connectCode}
                setConnectCode={setConnectCode}
                linkMsg={linkMsg}
                onLink={handleCaregiverLink}
                onRefreshCode={handleRefreshCode}
                onCopyCode={handleCopyCode}
                isListening={isListening}
                speechAvailable={speechAvailable}
                voiceError={voiceError}
                emergencyStatus={emergencyStatus}
                emergencySending={emergencySending}
                onEmergencyButton={handleEmergencyButton}
                emergencyAlerts={emergencyAlerts}
                onAckEmergency={handleAckEmergency}
                ackBusyId={ackBusyId}
                onLogout={handleLogout}
                onCreateReminder={handleCreateReminder}
                onUpdateReminder={handleUpdateReminder}
                onDeleteReminder={handleDeleteReminder}
                chatOpen={chatOpen}
                setChatOpen={setChatOpen}
                chatMessages={chatMessages}
                chatBusy={chatBusy}
                onChat={handleChat}
                onCreateFromIntent={handleCreateFromIntent}
                chatPrefill={chatPrefill}
                setChatPrefill={setChatPrefill}
              />
            )}
          </div>

          <div className="absolute bottom-2 left-1/2 h-1.5 w-36 -translate-x-1/2 rounded-full bg-black" />
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between px-6 pt-5 text-sm font-semibold text-neutral-900">
      <span>11:41</span>
      <div className="flex items-center gap-1 text-xs">
        <span>◖◗◖</span>
        <span>▂▄▆</span>
        <span className="rounded-sm border border-neutral-900 px-1 py-[1px] text-[10px]">
          87%
        </span>
      </div>
    </div>
  );
}

function LoginScreen({
  authMode,
  setAuthMode,
  setAuthError,
  role,
  setRole,
  email,
  setEmail,
  password,
  setPassword,
  displayName,
  setDisplayName,
  authError,
  busy,
  onSubmit,
}) {
  return (
    <div className="flex flex-1 flex-col justify-center px-5 pb-6 pt-4">
      <div className="mb-6">
        <div className="text-xs uppercase tracking-[0.35em] text-neutral-400">Nora</div>
        <h1 className="mt-2 text-[30px] font-semibold leading-none tracking-tight text-neutral-900">
          {authMode === "login" ? "Login" : "Create account"}
        </h1>
        <p className="mt-3 text-sm text-neutral-500">
          {authMode === "login"
            ? "Sign in with the email and password you registered."
            : "Elder accounts get a connection code; caregivers link with that code after signing in."}
        </p>
      </div>

      <section className="rounded-[2rem] border border-neutral-200 bg-white p-4 shadow-sm">
        {authMode === "register" && (
          <>
            <div className="mb-4">
              <div className="mb-2 text-sm font-medium text-neutral-700">Account type</div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setRole("elder")}
                  className={`rounded-2xl px-4 py-3 text-sm font-medium shadow-sm ${
                    role === "elder"
                      ? "bg-violet-600 text-white"
                      : "bg-neutral-100 text-neutral-700"
                  }`}
                >
                  Elder
                </button>
                <button
                  type="button"
                  onClick={() => setRole("caregiver")}
                  className={`rounded-2xl px-4 py-3 text-sm font-medium shadow-sm ${
                    role === "caregiver"
                      ? "bg-violet-600 text-white"
                      : "bg-neutral-100 text-neutral-700"
                  }`}
                >
                  Son / Daughter
                </button>
              </div>
            </div>

            <input
              type="text"
              placeholder="Display name (e.g. Mom)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mb-3 w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm outline-none"
            />
          </>
        )}

        <div className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm outline-none"
          />

          <input
            type="password"
            placeholder="Password (min 8 characters)"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm outline-none"
          />
        </div>

        {authError && (
          <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {authError}
          </div>
        )}

        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="mt-4 w-full rounded-2xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
        >
          {busy ? "Please wait…" : authMode === "login" ? "Sign In" : "Register"}
        </button>

        <button
          type="button"
          onClick={() => {
            setAuthMode((m) => (m === "login" ? "register" : "login"));
            setAuthError("");
          }}
          className="mt-4 w-full text-center text-sm font-medium text-violet-700"
        >
          {authMode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      </section>
    </div>
  );
}

function DashboardScreen({
  user,
  elders,
  caregivers,
  reminders,
  remindersLoading,
  connectCode,
  setConnectCode,
  linkMsg,
  onLink,
  onRefreshCode,
  onCopyCode,
  isListening,
  speechAvailable,
  voiceError,
  emergencyStatus,
  emergencySending,
  onEmergencyButton,
  emergencyAlerts,
  onAckEmergency,
  ackBusyId,
  onLogout,
  onCreateReminder,
  onUpdateReminder,
  onDeleteReminder,
  chatOpen,
  setChatOpen,
  chatMessages,
  chatBusy,
  onChat,
  onCreateFromIntent,
  chatPrefill,
  setChatPrefill,
}) {
  const isElder = user.role === "elder";
  const primaryElder = elders[0];
  const canCreateEvents = isElder || elders.length > 0;

  return (
    <>
      <div className="flex items-start justify-between px-5 pt-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.35em] text-neutral-400">Nora</div>

          {isElder ? (
            <h1 className="mt-1 truncate text-[22px] font-semibold tracking-tight text-violet-700">
              {user.connectionCode ?? "—"}
            </h1>
          ) : (
            <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-neutral-900">
              {primaryElder?.displayName ?? "My Parent"}
            </h1>
          )}

          <p className="mt-1 text-xs text-neutral-500">
            {isElder
              ? "Share this code with your son or daughter"
              : primaryElder
                ? "Viewing reminders for this linked elder"
                : "Link with a code from your parent’s account"}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-neutral-400">{user.email}</p>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={onLogout}
            className="rounded-2xl border border-neutral-300 bg-white px-3 py-2 text-right shadow-sm"
          >
            <div className="text-[11px] font-medium leading-tight text-violet-700">
              {isElder ? "Elder User" : "Son / Daughter"}
            </div>
            <div className="text-xs text-neutral-500">Logout</div>
          </button>
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="flex items-center gap-1.5 rounded-2xl border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 shadow-sm"
          >
            <span>💬</span> Ask Nora
          </button>
        </div>
      </div>

      {chatOpen && (
        <NoraChatModal
          messages={chatMessages}
          busy={chatBusy}
          onSend={onChat}
          onClose={() => { setChatOpen(false); }}
          onCreateFromIntent={onCreateFromIntent}
          onVoiceStart={() => {
            listeningActiveRef.current = false;
            try { recognitionRef.current?.stop(); } catch { /* noop */ }
          }}
          onVoiceEnd={() => {
            if (user?.role === "elder") {
              listeningActiveRef.current = true;
              setTimeout(() => tryStartListeningRef.current(), 300);
            }
          }}
        />
      )}

      <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
        {isElder && (
          <section className="mb-3 rounded-[1.7rem] border border-emerald-200 bg-emerald-50/80 p-3 text-sm shadow-sm">
            <div className="font-medium text-neutral-800">Family connections</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onCopyCode}
                className="rounded-xl border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-900"
              >
                Copy code
              </button>
              <button
                type="button"
                onClick={onRefreshCode}
                className="rounded-xl border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700"
              >
                New code
              </button>
            </div>

            {linkMsg && <p className="mt-2 text-xs text-emerald-900">{linkMsg}</p>}

            {caregivers.length > 0 && (
              <ul className="mt-2 border-t border-emerald-100 pt-2 text-xs text-neutral-700">
                {caregivers.map((c) => (
                  <li key={c.id}>
                    Linked: <span className="font-medium">{c.displayName}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {!isElder && (
          <section className="mb-3 rounded-[1.7rem] border border-sky-200 bg-sky-50/80 p-3 text-sm shadow-sm">
            <div className="font-medium text-neutral-800">Connect to an elder</div>
            <p className="mt-1 text-xs text-neutral-600">
              Enter the code shown on your parent’s Nora app, then Link.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                placeholder="Code"
                value={connectCode}
                onChange={(e) => setConnectCode(e.target.value.toUpperCase())}
                className="min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-white px-3 py-2 font-mono text-sm tracking-wider outline-none"
              />
              <button
                type="button"
                onClick={onLink}
                className="rounded-2xl bg-sky-600 px-4 py-2 text-xs font-semibold text-white"
              >
                Link
              </button>
            </div>

            {linkMsg && <p className="mt-2 text-xs text-sky-900">{linkMsg}</p>}

            {elders.length > 0 && (
              <p className="mt-2 text-xs text-neutral-600">
                Connected to {elders.map((e) => e.displayName).join(", ")}
              </p>
            )}
          </section>
        )}

        {!isElder && (
          <EmergencyCaregiverBanner
            alerts={emergencyAlerts}
            onAcknowledge={onAckEmergency}
            busyId={ackBusyId}
          />
        )}

        <SummaryCard reminders={reminders} loading={remindersLoading} />

        <ReminderSection
          reminders={reminders}
          loading={remindersLoading}
          canCreateEvents={canCreateEvents}
          caregiverNeedsLink={!isElder && elders.length === 0}
          onCreateReminder={onCreateReminder}
          onUpdateReminder={onUpdateReminder}
          onDeleteReminder={onDeleteReminder}
          chatPrefill={chatPrefill}
          onChatPrefillConsumed={() => setChatPrefill(null)}
        />

        {isElder && (
          <EmergencyElderSection
            hasLinkedCaregivers={caregivers.length > 0}
            busy={emergencySending}
            status={emergencyStatus}
            voiceError={voiceError}
            isListening={isListening}
            speechAvailable={speechAvailable}
            onEmergencyButton={onEmergencyButton}
          />
        )}
      </main>
    </>
  );
}

function SummaryCard({ reminders, loading }) {
  return (
    <section className="mb-3 rounded-[1.7rem] border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-3 shadow-sm">
      <div className="text-base font-semibold text-neutral-900">Things in the next 7 days</div>
      <div className="mt-1 text-xs text-neutral-500">
        {loading ? "Loading reminders…" : "From your Nora backend"}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-[1.2rem] bg-white px-3 py-2 shadow-sm">
          <div className="text-[11px] leading-tight text-neutral-500">Total reminders</div>
          <div className="mt-1 text-lg font-semibold text-neutral-900">{reminders.length}</div>
        </div>

        <div className="rounded-[1.2rem] bg-white px-3 py-2 shadow-sm">
          <div className="text-[11px] leading-tight text-neutral-500">Next event</div>
          <div className="mt-1 text-sm font-semibold leading-tight text-neutral-900">
            {reminders[0]?.title || "No events"}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReminderSection({
  reminders,
  loading,
  canCreateEvents,
  caregiverNeedsLink,
  onCreateReminder,
  onUpdateReminder,
  onDeleteReminder,
  chatPrefill,
  onChatPrefillConsumed,
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [prepItem, setPrepItem] = useState(null);

  useEffect(() => {
    if (chatPrefill) {
      setShowCreateModal(true);
      onChatPrefillConsumed();
    }
  }, [chatPrefill, onChatPrefillConsumed]);

  return (
    <section className="relative mb-3 rounded-[1.7rem] border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-neutral-900">Upcoming events</div>
          <div className="text-xs text-neutral-500">
            {loading ? "Loading…" : "Tap or click an event to edit or delete"}
          </div>
        </div>

        {canCreateEvents && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMenu((prev) => !prev)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 bg-neutral-50 text-lg text-neutral-700"
            >
              ⋯
            </button>

            {showMenu && (
              <div className="absolute right-0 top-11 z-20 w-44 rounded-2xl border border-neutral-200 bg-white p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(true);
                    setShowMenu(false);
                  }}
                  className="w-full rounded-xl px-3 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-100"
                >
                  Create new event
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {caregiverNeedsLink && (
        <p className="mb-3 rounded-2xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Link with your parent’s code above to add and view their events here.
        </p>
      )}

      <div className="max-h-[220px] space-y-0.5 overflow-y-auto pr-1">
        {!loading && reminders.length === 0 && (
          <div className="rounded-2xl bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
            {canCreateEvents ? "No events yet. Tap the 3 dots to create one." : "No events yet."}
          </div>
        )}

        {reminders.map((item) => (
          <ReminderCard
            key={item.id}
            item={item}
            onEdit={() => setEditingItem(item)}
            onDelete={() => onDeleteReminder(item.id)}
            onPrepare={() => setPrepItem(item)}
          />
        ))}
      </div>

      {showCreateModal && (
        <ReminderModal
          title="Create event"
          submitLabel="Save event"
          initialValues={chatPrefill ?? {
            title: "",
            category: "personal",
            description: "",
            dueLocal: defaultDueDatetimeLocal(),
          }}
          onClose={() => setShowCreateModal(false)}
          onSubmit={async (values) => {
            await onCreateReminder(values);
            setShowCreateModal(false);
          }}
        />
      )}

      {prepItem && (
        <TaskPrepModal
          item={prepItem}
          onClose={() => setPrepItem(null)}
        />
      )}

      {editingItem && (
        <ReminderModal
          title="Update event"
          submitLabel="Update event"
          initialValues={{
            title: editingItem.title,
            category: editingItem.type || "personal",
            description: editingItem.description || "",
            dueLocal: editingItem.dueLocal || defaultDueDatetimeLocal(),
            repeatType: editingItem.repeatType ?? null,
          }}
          onClose={() => setEditingItem(null)}
          onSubmit={async (values) => {
            await onUpdateReminder(editingItem.id, values);
            setEditingItem(null);
          }}
        />
      )}
    </section>
  );
}

function ReminderCard({ item, onEdit, onDelete, onPrepare }) {
  const [revealed, setRevealed] = useState(false);
  const startXRef = useRef(null);
  const movedRef = useRef(false);
  const swipeConsumedClickRef = useRef(false);

  const handleTouchStart = (e) => {
    movedRef.current = false;
    startXRef.current = e.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchMove = (e) => {
    const t = e.changedTouches[0];
    if (t && startXRef.current != null && Math.abs(t.clientX - startXRef.current) > 10) {
      movedRef.current = true;
    }
  };

  const handleTouchEnd = (e) => {
    if (startXRef.current == null) return;
    const endX = e.changedTouches[0]?.clientX ?? startXRef.current;
    const diff = endX - startXRef.current;

    if (diff > 55) {
      setRevealed(true);
      swipeConsumedClickRef.current = true;
    } else if (diff < -35) {
      setRevealed(false);
      swipeConsumedClickRef.current = true;
    }

    startXRef.current = null;
  };

  const handleRowClick = () => {
    if (swipeConsumedClickRef.current) {
      swipeConsumedClickRef.current = false;
      return;
    }
    if (movedRef.current) return;
    setRevealed((r) => !r);
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    onEdit();
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    onDelete();
  };

  return (
    <div className="overflow-hidden rounded-2xl">
      <div className="relative">
        <div
          className={`absolute inset-y-0 right-0 z-10 flex items-center gap-1.5 pr-2 transition-all ${
            revealed ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPrepare(); }}
            className="rounded-xl bg-violet-500 px-2.5 py-2 text-xs font-semibold text-white"
          >
            Prep
          </button>
          <button
            type="button"
            onClick={handleEdit}
            className="rounded-xl bg-sky-600 px-2.5 py-2 text-xs font-semibold text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="rounded-xl bg-red-500 px-2.5 py-2 text-xs font-semibold text-white"
          >
            Del
          </button>
        </div>

        <button
          type="button"
          onClick={handleRowClick}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className={`flex w-full cursor-pointer items-center justify-between rounded-2xl bg-neutral-50 px-3 py-2 text-left shadow-sm transition-transform duration-200 ${
            revealed ? "-translate-x-[152px]" : "translate-x-0"
          }`}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-neutral-900">{item.title}</div>
            <div className="text-xs text-neutral-500">
              {item.day} • {item.time}
            </div>
          </div>

          <div className="ml-3 flex items-center gap-1.5 shrink-0">
            {item.repeatType && (
              <span className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                ↻ {item.repeatType}
              </span>
            )}
            <span className="whitespace-nowrap rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-medium capitalize text-violet-700">
              {item.type}
            </span>
          </div>
        </button>
      </div>
    </div>
  );
}

function ReminderModal({ title, submitLabel, initialValues, onClose, onSubmit }) {
  const [form, setForm] = useState(() => ({
    title: initialValues.title ?? "",
    category: initialValues.category ?? "personal",
    description: initialValues.description ?? "",
    dueLocal: initialValues.dueLocal ?? defaultDueDatetimeLocal(),
    repeatType: initialValues.repeatType ?? null,
  }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!form.title.trim()) {
      setError("Add a title for the event.");
      return;
    }

    setBusy(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err.message ?? "Could not save event.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center rounded-[1.7rem] bg-black/30 p-3">
      <div className="w-full rounded-[1.5rem] border border-neutral-200 bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-base font-semibold text-neutral-900">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-sm text-neutral-500"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            value={form.title}
            onChange={(e) => updateField("title", e.target.value)}
            placeholder="Title"
            className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm outline-none"
          />

          <div className="flex gap-2">
            <select
              value={form.category}
              onChange={(e) => updateField("category", e.target.value)}
              className="min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm outline-none"
            >
              <option value="personal">Personal</option>
              <option value="medical">Medical</option>
              <option value="social">Social</option>
              <option value="other">Other</option>
            </select>

            <input
              type="datetime-local"
              value={form.dueLocal}
              onChange={(e) => updateField("dueLocal", e.target.value)}
              className="min-w-0 flex-[1.35] rounded-2xl border border-neutral-200 bg-neutral-50 px-2 py-2.5 text-xs outline-none"
            />
          </div>

          <select
            value={form.repeatType ?? ""}
            onChange={(e) => updateField("repeatType", e.target.value || null)}
            className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm outline-none"
          >
            <option value="">Does not repeat</option>
            <option value="daily">Repeats daily</option>
            <option value="weekly">Repeats weekly</option>
            <option value="monthly">Repeats monthly</option>
          </select>

          <input
            type="text"
            value={form.description}
            onChange={(e) => updateField("description", e.target.value)}
            placeholder="Notes (optional)"
            className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm outline-none"
          />

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-2xl border border-neutral-200 bg-white py-2.5 text-sm font-medium text-neutral-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-2xl bg-violet-600 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
            >
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EmergencyCaregiverBanner({ alerts, onAcknowledge, busyId }) {
  const unacked = alerts.filter((a) => !a.acknowledged);
  if (unacked.length === 0) return null;

  return (
    <section className="mb-3 space-y-2 rounded-[1.7rem] border-2 border-red-600 bg-red-50 p-3 shadow-lg">
      <div className="text-center text-sm font-bold uppercase tracking-wide text-red-800">
        Emergency alert
      </div>
      {unacked.map((a) => (
        <div
          key={a.id}
          className="rounded-2xl border border-red-200 bg-white p-3 text-sm shadow-sm"
        >
          <div className="font-semibold text-neutral-900">{a.elderDisplayName}</div>
          <div className="mt-1 text-xs text-neutral-600">
            {new Date(a.createdAt).toLocaleString()} ·{" "}
            {a.source === "voice" ? "Voice phrase" : "Emergency button"}
            {a.phrase ? ` · “${a.phrase}”` : ""}
          </div>
          <button
            type="button"
            disabled={busyId === a.id}
            onClick={() => onAcknowledge(a.id)}
            className="mt-2 w-full rounded-xl bg-red-600 py-2.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            {busyId === a.id ? "Saving…" : "I’m responding — dismiss alert"}
          </button>
        </div>
      ))}
    </section>
  );
}

function NoraChatModal({ messages, busy, onSend, onClose, onCreateFromIntent, onVoiceStart, onVoiceEnd }) {
  const [input, setInput] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState("");
  const bottomRef = useRef(null);
  const chatRecogRef = useRef(null);
  const onSendRef = useRef(onSend);
  const onVoiceEndRef = useRef(onVoiceEnd);
  const finalRef = useRef("");

  useEffect(() => { onSendRef.current = onSend; }, [onSend]);
  useEffect(() => { onVoiceEndRef.current = onVoiceEnd; }, [onVoiceEnd]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, voiceInterim]);

  // Create the recognizer once on mount only
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = "en-US";

    r.onresult = (e) => {
      let interim = "";
      let final = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      finalRef.current = final || interim;
      setVoiceInterim(final || interim);
    };

    r.onend = () => {
      setVoiceListening(false);
      onVoiceEndRef.current?.();
      const text = finalRef.current.trim();
      finalRef.current = "";
      setVoiceInterim("");
      if (text) onSendRef.current(text);
    };

    r.onerror = () => {
      setVoiceListening(false);
      onVoiceEndRef.current?.();
      finalRef.current = "";
      setVoiceInterim("");
    };

    chatRecogRef.current = r;
    return () => { try { r.abort(); } catch { /* noop */ } };
  }, []); // empty deps — create once

  const toggleVoice = () => {
    const r = chatRecogRef.current;
    if (!r) return;
    if (voiceListening) {
      r.stop();
    } else {
      onVoiceStart?.();
      finalRef.current = "";
      setVoiceInterim("");
      setVoiceListening(true);
      try {
        r.start();
      } catch {
        setVoiceListening(false);
        onVoiceEnd?.();
      }
    }
  };

  const submit = () => {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput("");
    onSend(msg);
  };

  const speechAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  return (
    <div className="absolute inset-0 z-40 flex flex-col rounded-[2.6rem] bg-[#f7f5f1]">
      <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-neutral-200">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-neutral-400">Nova AI</div>
          <div className="text-base font-semibold text-neutral-900">Ask Nora</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-500"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 && !voiceListening && (
          <div className="mt-6 text-center text-sm text-neutral-400">
            {speechAvailable
              ? <>Tap the mic and speak, or type below.<br /><span className="font-medium text-neutral-600">"Remind me Tuesday I have a doctor appointment"</span></>
              : <>Type your message below.<br /><span className="font-medium text-neutral-600">"Remind me Tuesday I have a doctor appointment"</span></>}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug ${
                m.role === "user"
                  ? "bg-violet-600 text-white"
                  : "bg-white border border-neutral-200 text-neutral-900 shadow-sm"
              }`}
            >
              {m.text}
            </div>
            {m.intent?.type === "create_reminder" && (
              <button
                type="button"
                onClick={() => onCreateFromIntent(m.intent)}
                className="flex items-center gap-1.5 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 shadow-sm"
              >
                ＋ Add "{m.intent.title}" as reminder
              </button>
            )}
          </div>
        ))}

        {voiceListening && (
          <div className="flex flex-col items-center gap-2 py-4">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 animate-pulse rounded-full bg-violet-500" />
              <span className="text-sm font-medium text-violet-700">Listening…</span>
            </div>
            {voiceInterim && (
              <div className="max-w-[85%] rounded-2xl border border-violet-100 bg-violet-50 px-3 py-2 text-sm italic text-violet-700">
                {voiceInterim}
              </div>
            )}
          </div>
        )}

        {busy && (
          <div className="flex items-start">
            <div className="rounded-2xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-400 shadow-sm">
              Nora is thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 border-t border-neutral-200 bg-white px-4 py-3">
        {speechAvailable && (
          <button
            type="button"
            onClick={toggleVoice}
            disabled={busy}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg shadow-sm transition-colors ${
              voiceListening
                ? "animate-pulse bg-violet-600 text-white"
                : "border border-neutral-200 bg-neutral-50 text-neutral-600"
            }`}
          >
            🎤
          </button>
        )}
        <input
          type="text"
          value={voiceListening ? voiceInterim : input}
          onChange={(e) => !voiceListening && setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={voiceListening ? "Listening…" : "Ask Nora anything…"}
          readOnly={voiceListening}
          className="min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || voiceListening || !input.trim()}
          className="rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function TaskPrepModal({ item, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    prepareTask(item.id)
      .then(({ content: c }) => setContent(c))
      .catch((e) => setError(e.message ?? "Could not load preparation guide."))
      .finally(() => setLoading(false));
  }, [item.id]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center rounded-[1.7rem] bg-black/30 p-3">
      <div className="w-full rounded-[1.5rem] border border-neutral-200 bg-white p-4 shadow-xl max-h-[90%] flex flex-col">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-violet-500">Preparation Guide</div>
            <div className="text-sm font-semibold text-neutral-900 mt-0.5">{item.title}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-sm text-neutral-500 shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="py-6 text-center text-sm text-neutral-400">Nova is preparing your guide…</div>
          )}
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
          )}
          {!loading && !error && (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">{content}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmergencyElderSection({
  hasLinkedCaregivers,
  busy,
  status,
  voiceError,
  isListening,
  speechAvailable,
  onEmergencyButton,
}) {
  return (
    <section className="rounded-[1.7rem] border border-red-200 bg-gradient-to-b from-red-50 to-white p-4 shadow-lg">
      <div className="text-[11px] uppercase tracking-[0.3em] text-red-700">Safety</div>
      <p className="mt-1 text-sm leading-snug text-neutral-700">
        Tap <span className="font-semibold">Emergency</span> or say help words out loud — we listen
        continuously so you don’t have to press anything first. Linked family gets an alert in
        their app.
      </p>
      <button
        type="button"
        disabled={busy || !hasLinkedCaregivers}
        onClick={onEmergencyButton}
        className="mt-4 w-full rounded-[1.5rem] bg-red-600 py-4 text-lg font-bold text-white shadow-lg disabled:opacity-50"
      >
        {busy ? "Sending…" : "Emergency"}
      </button>
      {!hasLinkedCaregivers && (
        <p className="mt-2 text-center text-xs text-amber-800">
          Link a family member with your code above before alerts can be sent.
        </p>
      )}
      {status && (
        <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-xs text-emerald-900">
          {status}
        </p>
      )}
      <div className="mt-4 rounded-[1.5rem] border border-neutral-200 bg-neutral-50 px-4 py-3">
        {!speechAvailable ? (
          <p className="text-center text-xs text-neutral-600">
            Voice listening isn’t available in this browser — use the Emergency button.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  isListening ? "animate-pulse bg-red-600" : "bg-neutral-400"
                }`}
                aria-hidden
              />
              <span className="text-xs font-medium text-neutral-800">
                {isListening ? "Listening for help words…" : "Starting microphone…"}
              </span>
            </div>
            <p className="mt-2 text-center text-[11px] text-neutral-500">
              Try: “emergency”, “help me”, “I’ve fallen” — works as soon as you speak.
            </p>
          </>
        )}
        {voiceError && (
          <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-2 py-2 text-center text-xs text-red-800">
            {voiceError}
          </div>
        )}
      </div>
    </section>
  );
}