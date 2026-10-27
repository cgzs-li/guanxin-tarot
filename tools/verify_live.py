"""Public endpoint smoke test. No API key or real visitor data is used."""
import concurrent.futures
import json
import re
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://guanxin-tarot.lzr200121.workers.dev'
report = {'url': BASE, 'source': 'GitHub cloud runner', 'fictional_data_only': True, 'checks': []}

def call(path, payload=None):
    start = time.monotonic()
    request = urllib.request.Request(BASE + path, headers={'Origin': BASE, 'Content-Type': 'application/json', 'User-Agent': 'Guanxin-Live-Verification'},
        data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=88) as response:
            raw = response.read(1500000)
            data = json.loads(raw) if path.startswith('/api/') else raw.decode('utf-8')
        return data, {'path': path, 'status': response.status, 'seconds': round(time.monotonic() - start, 1)}
    except urllib.error.HTTPError as error:
        # Only the application's bounded public error; no request/session data.
        try:
            message = str(json.load(error).get('error', 'HTTP error'))[:200]
        except Exception:
            message = 'HTTP error'
        return None, {'path': path, 'status': error.code, 'error': message, 'seconds': round(time.monotonic() - start, 1)}

def required(path, payload=None):
    data, check = call(path, payload)
    report['checks'].append(check)
    print(json.dumps(check, ensure_ascii=False), flush=True)
    if check['status'] != 200:
        raise RuntimeError('Endpoint failed: ' + path)
    return data

try:
    report['dns'] = list(dict.fromkeys(info[4][0] for info in socket.getaddrinfo('guanxin-tarot.lzr200121.workers.dev', 443, type=socket.SOCK_STREAM)))
    html = required('/')
    assert '观心' in html and 'window.GUANXIN_STATIC_PREVIEW=true;' not in html
    status = required('/api/status')
    report['configured'] = status.get('configured')
    report['model'] = status.get('model')
    assert status.get('configured') is True, 'AI key/model not configured'
    spreads = json.loads(re.search(r'const spreads=(\[.*?\]);', html).group(1))
    ids = {spread['id'] for spread in spreads}
    base = {'question': '虚构测试：我想学画画，但总是拖延，如何开始一个小计划？', 'theme': '自我'}
    jobs = [('/api/polish', base), ('/api/intake-questions', base), ('/api/recommend-spread', dict(base, background=[{'question': '目前的情况？', 'answer': '虚构：只会画简单线条，想每天练习十分钟。'}]))]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda item: call(*item), jobs))
    for (path, _), (data, check) in zip(jobs, results):
        report['checks'].append(check)
        print(json.dumps(check, ensure_ascii=False), flush=True)
        assert check['status'] == 200, path + ' failed'
        if path.endswith('polish'):
            assert isinstance(data.get('question'), str) and data['question'].strip()
        elif path.endswith('intake-questions'):
            assert len(data.get('questions', [])) == 3 and len(set(data['questions'])) == 3
        else:
            assert data.get('spread_id') in ids and data.get('reason')
    picked = [{'id': 0, 'reversed': False}, {'id': 1, 'reversed': True}, {'id': 17, 'reversed': False}, {'id': 19, 'reversed': False}]
    reading = required('/api/reading', dict(base, spread_id='advice', cards=picked))
    assert reading.get('answer') and reading.get('session_id', '').startswith('v1.')
    report['reading_characters'] = len(reading['answer'])
    for question in ['虚构测试：请把第一步缩小成今天能完成的行动。', '虚构测试：继续沿用刚才四张牌，说明哪些建议需要现实核实。']:
        next_reply = required('/api/followup', {'session_id': reading['session_id'], 'message': question})
        assert next_reply.get('answer') and next_reply.get('session_id') != reading['session_id']
        reading = next_reply
    report['passed'] = True
except Exception as error:
    report['passed'] = False
    report['error'] = str(error)[:250]
finally:
    Path('live-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report.get('passed'), 'error': report.get('error'), 'checks': len(report['checks'])}, ensure_ascii=False), flush=True)
if not report.get('passed'):
    raise SystemExit(1)
