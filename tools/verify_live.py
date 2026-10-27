"""Read-only public smoke test; no credentials, accounts or model calls."""
import concurrent.futures
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://tarot.ruichi0201.cn'
report = {'url': BASE, 'mode': 'paid-manual', 'checks': []}

def check(path, expected=200, payload=None):
    request = urllib.request.Request(BASE + path,
        headers={'Origin': BASE, 'Content-Type': 'application/json', 'User-Agent': 'Guanxin-Public-Verification'},
        data=json.dumps(payload).encode() if payload is not None else None)
    try:
        response = urllib.request.urlopen(request, timeout=40)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(2500000)
        status = response.code
    report['checks'].append({'path': path, 'status': status, 'expected': expected})
    assert status == expected, path + ': unexpected status ' + str(status)
    return json.loads(raw) if path.startswith('/api/') else raw.decode('utf-8')

try:
    html = check('/')
    assert 'assets/commerce.js' in html and '免费本地解读' in html
    assert len(json.loads(re.search(r'const spreads=(\[.*?\]);', html).group(1))) == 26
    assert len(json.loads(re.search(r'const cardLibrary=(\[.*?\]);', html).group(1))) == 78
    status = check('/api/status')
    assert status['mode'] == 'paid' and status['configured'] is True and status['real_ai_available'] is True and status['payment_mode'] == 'manual'
    catalog = check('/api/catalog')
    prices = {p['id']: p['price'] for p in catalog['products']}
    assert all(prices[k] == v for k, v in {'single-1': 190, 'triple-1': 390, 'complex-1': 990, 'monthly': 2990}.items())
    assert check('/api/account/me')['user'] is None
    jobs = [(p, 402, {}) for p in ['/api/polish', '/api/intake-questions', '/api/recommend-spread', '/api/reading', '/api/followup']]
    jobs += [(p, 401, {}) for p in ['/api/free/reading', '/api/paid/reading', '/api/paid/followup', '/api/order']]
    jobs += [(p, 410, {}) for p in ['/api/demo/checkout', '/api/demo/reading']]
    jobs += [(p, 403, {}) for p in ['/api/admin/order', '/api/admin/confirm']]
    jobs += [(p, 404, None) for p in ['/config.local.json', '/llm-backend/config.local.json', '/.dev.vars', '/worker/commerce.js']]
    jobs += [(p, 200, None) for p in ['/assets/commerce.js', '/assets/commerce.css', '/assets/admin.html', '/assets/admin.js']]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda job: check(*job), jobs))
    report['passed'] = True
except Exception as error:
    report.update(passed=False, error=str(error)[:250])
finally:
    Path('live-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
if not report['passed']:
    raise SystemExit(1)
