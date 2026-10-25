const applications = [
  {name: "NAI Image Manager", endpoint: "http://127.0.0.1:5000/api/arca-styles/browser-session/extension", statusId: "managerStatus"},
  {name: "NAImakeArtistGroup", endpoint: "http://127.0.0.1:5001/api/arca-styles/browser-session/extension", statusId: "artistStatus"},
];
const connectButton = document.getElementById("connectSession");
const statusElement = document.getElementById("status");
let revision = 0;

function setStatus(message, state = "") {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function transferableCookies(cookies) {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    ...(cookie.expirationDate == null ? {} : { expirationDate: cookie.expirationDate }),
  }));
}

function setApplicationStatus(application, message, state = "") {
  const element = document.getElementById(application.statusId);
  element.textContent = message;
  element.dataset.state = state;
}

async function requestApplication(application, payload, token) {
  const checking = payload === undefined;
  const current = () => revision === token;
  setApplicationStatus(application, checking ? "연결 상태 확인 중…" : "로그인 연결 중…");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(checking ? application.endpoint.replace(/\/extension$/, "") : application.endpoint, {
      method: checking ? "GET" : "POST",
      headers: {"X-Arca-Session-Bridge": "1", ...(checking ? {} : {"Content-Type": "application/json"})},
      ...(checking ? {} : {body: payload}),
      signal: controller.signal,
      credentials: "omit",
      redirect: "error",
    });
    const result = await response.json().catch(() => ({}));
    if (!current()) return;
    if (response.ok && result?.connected === true) {
      setApplicationStatus(application, "로그인 연결됨", "success");
      return "connected";
    }
    if (checking && response.ok && result?.connected === false) {
      setApplicationStatus(application, "로그인 연결 안 됨 · ‘현재 로그인 연결’을 눌러 주세요.");
      return "disconnected";
    }
    const message = response.status === 404
      ? "연결 API가 없습니다. 이 앱을 최신 버전으로 실행해 주세요."
      : result?.message || result?.error || `로그인을 확인하지 못했습니다. (HTTP ${response.status})`;
    if (!checking && result?.connected === true) {
      setApplicationStatus(application, `새 로그인 연결을 확인하지 못했습니다. 기존 연결은 유지됩니다. ${message}`, "error");
      return "retained";
    }
    setApplicationStatus(application, checking ? `연결 상태 확인 불가 · ${message}` : message, "error");
    return result?.connected === false ? "disconnected" : "unavailable";
  } catch (error) {
    if (!current()) return;
    setApplicationStatus(application, controller.signal.aborted
      ? "연결 상태 확인 불가 · 응답 시간이 초과되었습니다. 앱에서 연결 상태를 확인해 주세요."
      : "연결 상태 확인 불가 · 앱의 실행 여부와 확장 프로그램의 사이트 접근 권한을 확인해 주세요.", "error");
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(results, checking = false) {
  const connected = applications.filter((application, index) => ["connected", "retained"].includes(results[index]));
  if (connected.length) {
    const names = connected.map(application => application.name).join(" · ");
    setStatus(results.includes("retained") ? `${names} 연결 유지 중 · 로그인 갱신 결과는 앱별 안내를 확인해 주세요.`
      : `${names} ${checking ? "연결됨" : "연결 완료"}`, "success");
  } else {
    setStatus(results.includes("unavailable") ? "앱 연결 상태를 확인하지 못했습니다. 아래 앱별 안내를 확인해 주세요."
      : "연결된 앱이 없습니다. 아래 앱별 안내를 확인해 주세요.", "error");
  }
}

async function checkConnections() {
  const token = ++revision;
  setStatus("앱별 연결 상태 확인 중…");
  const results = await Promise.all(applications.map(application => requestApplication(application, undefined, token)));
  if (revision === token) summarize(results, true);
}

connectButton.addEventListener("click", async () => {
  if (connectButton.disabled) return;
  const token = ++revision;
  connectButton.disabled = true;
  setStatus("Chrome 로그인 확인 중…");
  applications.forEach(application => setApplicationStatus(application, "연결 대기 중"));
  try {
    const cookies = await chrome.cookies.getAll({ domain: "arca.live" });
    if (!cookies.length) {
      applications.forEach(application => setApplicationStatus(application, "Chrome 로그인 정보 없음", "error"));
      setStatus("이 Chrome에서 아카라이브 로그인을 찾지 못했습니다.", "error");
      return;
    }
    const payload = JSON.stringify({ cookies: transferableCookies(cookies), user_agent: navigator.userAgent });
    const results = await Promise.all(applications.map(application => requestApplication(application, payload, token)));
    if (revision === token) summarize(results);
  } catch (_error) {
    applications.forEach(application => setApplicationStatus(application, "Chrome 로그인 정보를 읽지 못했습니다.", "error"));
    setStatus("Chrome의 아카라이브 로그인과 확장 프로그램 쿠키 권한을 확인해 주세요.", "error");
  } finally {
    connectButton.disabled = false;
  }
});

checkConnections();
