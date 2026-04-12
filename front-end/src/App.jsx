import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createReminder,
  deleteReminder,
  fetchLinkedCaregivers,
  fetchLinkedElders,
  fetchMe,
  fetchUserReminders,
  getToken,
  linkWithCode,
  login,
  logout,
  refreshConnectionCode,
  register,
  sendChatMessage,
  setToken,
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
  const [voiceError, setVoiceError] = useState("");
  const [noraSpeaking, setNoraSpeaking] = useState(false);

  const [voiceText, setVoiceText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [chatResponse, setChatResponse] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  const [reminders, setReminders] = useState([]);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const [elders, setElders] = useState([]);
  const [caregivers, setCaregivers] = useState([]);

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

  const loadLinksAndReminders = useCallback(async (u) => {
    if (!u) return;

    setRemindersLoading(true);
    try {
      if (u.role === "caregiver") {
        const list = await fetchLinkedElders();
        setElders(list);

        const targetId = list[0]?.id;
        if (targetId) {
          const raw = await fetchUserReminders(targetId);
          setReminders(raw.map(mapReminderFromApi));
        } else {
          setReminders([]);
        }
      } else {
        setCaregivers(await fetchLinkedCaregivers());
        const raw = await fetchUserReminders(u.id);
        setReminders(raw.map(mapReminderFromApi));
      }
    } catch {
      setReminders([]);
    } finally {
      setRemindersLoading(false);
    }
  }, []);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ");
      setVoiceText((prev) => `${prev} ${transcript}`.trim());
    };

    recognition.onerror = (event) => {
      setVoiceError(`Speech recognition error: ${event.error}`);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
  }, []);

  useEffect(() => {
    if (user && screen === "dashboard") {
      loadLinksAndReminders(user);
    }
  }, [user, screen, loadLinksAndReminders]);

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

  const handleVoiceButton = () => {
    setVoiceError("");
    if (!recognitionRef.current) {
      setVoiceError("Voice recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (error) {
      setVoiceError("Cannot start voice recognition.");
      setIsListening(false);
    }
  };

  const speakText = (text) => {
    if (!window.speechSynthesis) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.onstart = () => setNoraSpeaking(true);
    utterance.onend = () => setNoraSpeaking(false);
    utterance.onerror = () => setNoraSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  const handleSendPrompt = async () => {
    if (!voiceText.trim()) return;
    if (!user) return;

    setChatBusy(true);
    setChatResponse("");
    setVoiceError("");

    try {
      const targetOwnerId = user.role === "elder" ? user.id : elders[0]?.id;
      if (user.role === "caregiver" && !targetOwnerId) {
        throw new Error("Link with an elder first so Nora can answer about their reminders.");
      }

      const result = await sendChatMessage({
        message: voiceText.trim(),
        ownerUserId: targetOwnerId,
      });
      const reply = result.reply ?? "No response received.";
      setChatResponse(reply);
      setVoiceText("");
      speakText(reply);
    } catch (error) {
      setChatResponse(error.message ?? "Could not send message to Nora.");
    } finally {
      setChatBusy(false);
    }
  };

  const handleCreateReminder = async ({ title, category, description, dueLocal }) => {
    if (!user) return;

    const ownerId = user.role === "elder" ? user.id : elders[0]?.id;
    if (!ownerId) {
      throw new Error("Link with an elder first so events can be saved for them.");
    }

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
    });

    await loadLinksAndReminders(user);
  };

  const handleUpdateReminder = async (reminderId, { title, category, description, dueLocal }) => {
    const due = new Date(dueLocal);
    if (Number.isNaN(due.getTime())) throw new Error("Invalid date or time.");
    if (due <= new Date()) throw new Error("Pick a date and time in the future.");

    await updateReminder(reminderId, {
      title: title.trim(),
      description: description?.trim() ? description.trim() : null,
      category,
      dueDateTime: due.toISOString(),
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
                voiceText={voiceText}
                setVoiceText={setVoiceText}
                isListening={isListening}
                onVoiceButton={handleVoiceButton}
                onSendPrompt={handleSendPrompt}
                chatResponse={chatResponse}
                chatBusy={chatBusy}
                onLogout={handleLogout}
                onCreateReminder={handleCreateReminder}
                onUpdateReminder={handleUpdateReminder}
                onDeleteReminder={handleDeleteReminder}
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
  voiceText,
  setVoiceText,
  isListening,
  onVoiceButton,
  onSendPrompt,
  onLogout,
  onCreateReminder,
  onUpdateReminder,
  onDeleteReminder,
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
      </div>

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

        <SummaryCard reminders={reminders} loading={remindersLoading} />

        <ReminderSection
          reminders={reminders}
          loading={remindersLoading}
          canCreateEvents={canCreateEvents}
          caregiverNeedsLink={!isElder && elders.length === 0}
          onCreateReminder={onCreateReminder}
          onUpdateReminder={onUpdateReminder}
          onDeleteReminder={onDeleteReminder}
        />

        <AssistantSection
          voiceText={voiceText}
          setVoiceText={setVoiceText}
          isListening={isListening}
          onVoiceButton={onVoiceButton}
          onSendPrompt={onSendPrompt}
          chatResponse={chatResponse}
          chatBusy={chatBusy}
          voiceError={voiceError}
          noraSpeaking={noraSpeaking}
        />
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
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingItem, setEditingItem] = useState(null);

  return (
    <section className="relative mb-3 rounded-[1.7rem] border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-neutral-900">Upcoming events</div>
          <div className="text-xs text-neutral-500">
            {loading ? "Loading…" : "Swipe right on an event to edit or delete"}
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
          />
        ))}
      </div>

      {showCreateModal && (
        <ReminderModal
          title="Create event"
          submitLabel="Save event"
          initialValues={{
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

      {editingItem && (
        <ReminderModal
          title="Update event"
          submitLabel="Update event"
          initialValues={{
            title: editingItem.title,
            category: editingItem.type || "personal",
            description: editingItem.description || "",
            dueLocal: editingItem.dueLocal || defaultDueDatetimeLocal(),
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

function ReminderCard({ item, onEdit, onDelete }) {
  const [revealed, setRevealed] = useState(false);
  const startXRef = useRef(null);

  const handleTouchStart = (e) => {
    startXRef.current = e.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (e) => {
    if (startXRef.current == null) return;
    const endX = e.changedTouches[0]?.clientX ?? startXRef.current;
    const diff = endX - startXRef.current;

    if (diff > 55) {
      setRevealed(true);
    } else if (diff < -35) {
      setRevealed(false);
    }

    startXRef.current = null;
  };

  return (
    <div className="overflow-hidden rounded-2xl">
      <div className="relative">
        <div
          className={`absolute inset-y-0 right-0 flex items-center gap-2 pr-3 transition-all ${
            revealed ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={onEdit}
            className="rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-xl bg-red-500 px-3 py-2 text-xs font-semibold text-white"
          >
            Delete
          </button>
        </div>

        <div
          className={`flex items-center justify-between rounded-2xl bg-neutral-50 px-3 py-2 shadow-sm transition-transform duration-200 ${
            revealed ? "-translate-x-[120px]" : "translate-x-0"
          }`}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-neutral-900">{item.title}</div>
            <div className="text-xs text-neutral-500">
              {item.day} • {item.time}
            </div>
          </div>

          <div className="ml-3 flex items-center gap-2">
            <span className="whitespace-nowrap rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-medium capitalize text-violet-700">
              {item.type}
            </span>
          </div>
        </div>
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

function AssistantSection({ voiceText, setVoiceText, isListening, onVoiceButton, onSendPrompt, chatResponse, chatBusy, voiceError, noraSpeaking }) {
  return (
    <section className="rounded-[1.7rem] bg-[#16151b] p-4 text-white shadow-lg">
      <div className="text-[11px] uppercase tracking-[0.3em] text-violet-300">Nora</div>
      <div className="mt-1 text-lg font-semibold">How can I help you?</div>

      <div className="mt-3 rounded-[1.5rem] bg-white/10 p-3">
        <textarea
          value={voiceText}
          onChange={(e) => setVoiceText(e.target.value)}
          placeholder="Type a message (voice can plug in here)…"
          className="h-20 w-full resize-none rounded-xl border border-white/10 bg-white/10 p-3 text-sm text-white placeholder:text-white/50 outline-none"
        />
        <button
          type="button"
          onClick={onSendPrompt}
          disabled={chatBusy}
          className="mt-2 w-full rounded-2xl bg-white py-2 text-sm font-medium text-neutral-900 disabled:opacity-60"
        >
          {chatBusy ? "Sending…" : "Send to Nora"}
        </button>

        {voiceError && (
          <div className="mt-3 rounded-2xl border border-red-300 bg-red-100 px-3 py-2 text-sm text-red-900">
            {voiceError}
          </div>
        )}

        {chatResponse && (
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/10 p-3 text-sm text-white/90">
            {chatResponse}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-col items-center justify-center rounded-[1.5rem] bg-white/10 px-4 py-4">
        <button
          type="button"
          onClick={onVoiceButton}
          className={`flex h-16 w-16 items-center justify-center rounded-full text-xl text-white shadow-lg transition ${
            isListening ? "scale-105 bg-violet-700" : "bg-violet-500"
          }`}
        >
          ●
        </button>

        <div className="mt-3 text-xs text-white/80">
          {isListening ? "Listening..." : noraSpeaking ? "Speaking..." : "Tap to speak"}
        </div>
      </div>
    </section>
  );
}