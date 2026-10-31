(() => {
  const status = document.getElementById('workspaceStatus');
  const message = document.getElementById('workspaceMessage');
  const retry = document.getElementById('workspaceRetry');
  const frame = document.getElementById('styleWorkspaceFrame');
  let connecting = false;
  async function connect() {
    if (connecting) return;
    connecting = true;
    retry.hidden = true;
    message.textContent = '그림체 관리에 연결하고 있습니다…';
    try {
      const response = await fetch('/api/style-workspace/connect', {
        method: 'POST', headers: {'X-NAIM-Workspace': '1'},
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '연결하지 못했습니다.');
      const url = new URL(data.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('연결 주소를 확인해 주세요.');
      frame.onload = () => { status.hidden = true; frame.hidden = false; };
      frame.src = url.href;
    } catch (error) {
      message.textContent = error.message || '연결하지 못했습니다. 다시 시도해 주세요.';
      retry.hidden = false;
    } finally { connecting = false; }
  }
  retry.addEventListener('click', connect);
  connect();
})();
