"""Run on Contabo: python3 select-harness.py status|cmd|hermes.

Checks cmdc quota before routing WhatsApp to it. Secrets stay inside this process.
"""
import base64
import json
import subprocess
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def kubectl(*args):
    return subprocess.check_output(['kubectl', '-n', 'agent-stack', *args], text=True)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if target not in {'status', 'cmd', 'hermes'}:
        raise SystemExit('Use status, cmd or hermes')
    if target == 'cmd':
        # No tools or extra/pay-as-you-go flags: a quota failure leaves Hermes live.
        result = subprocess.run([
            'kubectl', '-n', 'agent-stack', 'exec', 'deployment/agent-bridge', '--',
            'cmdc', '-p', 'Reply with exactly BRIDGE_OK. Do not use tools.',
            '--model', 'moonshotai/Kimi-K3', '--max-turns', '1',
            '--output-format', 'json', '--skip-onboarding', '--trust',
        ], capture_output=True, text=True, timeout=90)
        frames = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        terminal = next((f for f in reversed(frames) if f.get('type') == 'result'), {})
        if result.returncode or terminal.get('finalText', '').strip() != 'BRIDGE_OK':
            raise SystemExit(terminal.get('error') or 'cmdc readiness check failed; webhook routing unchanged')

    data = json.loads(kubectl('get', 'secret', 'agent-bridge-env', '-o', 'json'))['data']
    env = {k: base64.b64decode(v).decode() for k, v in data.items()}
    ip = json.loads(kubectl('get', 'service', 'openwa', '-o', 'json'))['spec']['clusterIP']
    base = f"http://{ip}:2785/api/sessions/{env['OPENWA_SESSION_ID']}/webhooks"

    def request(path='', body=None):
        req = Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'x-api-key': env['OPENWA_API_KEY'], 'content-type': 'application/json'},
                      method='PUT' if body is not None else 'GET')
        with urlopen(req, timeout=20) as response:
            return json.load(response)

    hooks = request()
    managed = [h for h in hooks if urlparse(h['url']).hostname in
               {'hermes', 'agent-bridge.agent-stack.svc.cluster.local'}]
    if target != 'status':
        wanted = 'hermes' if target == 'hermes' else 'agent-bridge.agent-stack.svc.cluster.local'
        if len(managed) != 2 or sum(urlparse(h['url']).hostname == wanted for h in managed) != 1:
            raise SystemExit('Expected one Hermes and one bridge webhook; routing unchanged')
        try:
            for h in managed:
                request('/' + h['id'], {'active': False})
            selected = next(h for h in managed if urlparse(h['url']).hostname == wanted)
            request('/' + selected['id'], {'active': True})
        except Exception:
            for h in managed:
                request('/' + h['id'], {'active': h['active']})
            raise
        managed = request()
    for h in managed:
        print(f"{'active' if h['active'] else 'inactive'}: {h['url']}")


if __name__ == '__main__':
    main()
