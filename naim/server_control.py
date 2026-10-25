"""Private local control channel used only for a launcher's own child."""
import json
import urllib.request


def request_job_shutdown(token, pid, timeout=10):
    if not token:
        return False
    request = urllib.request.Request(
        'http://127.0.0.1:5000/api/internal/shutdown_jobs',
        data=json.dumps({'pid': pid}).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-NAIM-Control': token},
        method='POST',
    )
    # Local control tokens must never be sent through an environment proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return bool(json.load(response).get('stopped'))
    except (OSError, ValueError):
        return False
