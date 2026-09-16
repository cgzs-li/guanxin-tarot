"""Local-only activation trial. Do not expose this server directly to the Internet."""
import argparse, hashlib, hmac, json, mimetypes, os, secrets, sqlite3, time, threading
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('GUANXIN_DATA_DIR', str(ROOT / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / 'licenses.sqlite3'
ADMIN_FILE = DATA / 'admin-password.txt'
if not ADMIN_FILE.exists():
    ADMIN_FILE.write_text(secrets.token_urlsafe(24), encoding='utf-8')
ADMIN_HASH = hashlib.sha256(ADMIN_FILE.read_text(encoding='utf-8').strip().encode()).hexdigest()
ADMIN_SESSIONS, ATTEMPTS = {}, {}

def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def connect():
    c = sqlite3.connect(DB, timeout=10)
    c.row_factory = sqlite3.Row
    return c
with connect() as c:
    c.execute("""CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY, order_ref TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL UNIQUE,
      created INTEGER NOT NULL, device_hash TEXT, activated INTEGER, enabled INTEGER NOT NULL DEFAULT 1)""")

# Additive migration preserves previously issued codes and browser bindings.
with connect() as c:
    columns={row['name'] for row in c.execute('PRAGMA table_info(licenses)')}
    for name in ['last_seen','visits','readings']:
        if name not in columns:c.execute(f'ALTER TABLE licenses ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0')
    c.execute('CREATE TABLE IF NOT EXISTS usage_events (license_id INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(license_id,event_id))')

with connect() as c:
    columns={row['name'] for row in c.execute('PRAGMA table_info(licenses)')}
    for name in ['device_label','last_device']:
        if name not in columns:c.execute(f"ALTER TABLE licenses ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
    if 'denied_bindings' not in columns:c.execute('ALTER TABLE licenses ADD COLUMN denied_bindings INTEGER NOT NULL DEFAULT 0')
    c.execute('CREATE TABLE IF NOT EXISTS issued_codes (code_hash TEXT PRIMARY KEY)')
    c.execute('INSERT OR IGNORE INTO issued_codes SELECT code_hash FROM licenses')

with connect() as c:
    columns={row['name'] for row in c.execute('PRAGMA table_info(licenses)')}
    if 'code_text' not in columns:c.execute("ALTER TABLE licenses ADD COLUMN code_text TEXT NOT NULL DEFAULT ''")
    if 'issued_at' not in columns:
        c.execute('ALTER TABLE licenses ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0')
        c.execute('UPDATE licenses SET issued_at=created')
    c.execute("CREATE TABLE IF NOT EXISTS code_history (id INTEGER PRIMARY KEY, license_id INTEGER NOT NULL, code_text TEXT NOT NULL, issued_at INTEGER NOT NULL, retired_at INTEGER NOT NULL)")

with connect() as c:
    columns={row['name'] for row in c.execute('PRAGMA table_info(licenses)')}
    if 'expires_at' not in columns:
        c.execute('ALTER TABLE licenses ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0')
        c.execute('UPDATE licenses SET expires_at=activated+2592000 WHERE activated IS NOT NULL')

def new_code(c):
    # Retired and disabled codes are never reused. Preserve leading zeroes.
    for _ in range(100):
        code=f'{secrets.randbelow(1000000):06d}'
        try:c.execute('INSERT INTO issued_codes VALUES(?)',(digest(code),));return code
        except sqlite3.IntegrityError:pass
    raise RuntimeError('可用激活码不足，请联系管理员')

def device_label(ua):
    os_name=next((label for word,label in [('Android','Android'),('iPhone','iPhone / iOS'),('iPad','iPad / iPadOS'),('Windows','Windows'),('Macintosh','macOS / iPadOS'),('Linux','Linux')] if word in ua),'未知系统')
    browser=next((label for word,label in [('MicroMessenger','微信内置浏览器'),('Edg/','Edge'),('EdgiOS','Edge'),('OPR/','Opera'),('CriOS','Chrome'),('Chrome/','Chrome'),('FxiOS','Firefox'),('Firefox/','Firefox'),('Safari/','Safari')] if word in ua),'未知浏览器')
    return os_name+' · '+browser

def cookie_value(headers, name):
    try:
        c = SimpleCookie(); c.load(headers.get('Cookie', ''))
        return c[name].value if name in c else ''
    except Exception: return ''

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass  # Do not log codes, passwords or buyer inputs.
    def reply(self, status, body, mime='application/json; charset=utf-8', cookie=None):
        if isinstance(body, dict): body=json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str): body=body.encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        if cookie: self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def error(self, status, text): self.reply(status, {'error': text})
    def host_ok(self):
        return self.headers.get('Host') in [f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}']
    def is_admin(self):
        token=cookie_value(self.headers,'gx_admin')
        return ADMIN_SESSIONS.get(digest(token),0)>time.time()
    def license(self):
        token=cookie_value(self.headers,'gx_device')
        if not token: return None
        with connect() as c:
            return c.execute('SELECT * FROM licenses WHERE device_hash=? AND enabled=1 AND (expires_at=0 OR expires_at>?)',(digest(token),int(time.time()))).fetchone()
    def set_cookie(self, name, token, age):
        return f'{name}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}'
    def do_GET(self):
        if not self.host_ok(): return self.error(403,'本地测试服务不接受此地址')
        path=urlsplit(self.path).path
        if self.server.role=='buyer' and (path in ['/admin','/records','/activations'] or path.startswith('/api/admin/')):return self.error(404,'页面不存在')
        if self.server.role=='admin' and path not in ['/','/admin','/records','/activations','/api/admin/licenses']:return self.error(404,'页面不存在')
        if path=='/': return self.reply(200,(ROOT/('admin.html' if self.server.role=='admin' else 'login.html')).read_bytes(),'text/html; charset=utf-8')
        if path in ['/admin','/records','/activations']: return self.reply(200,(ROOT/'admin.html').read_bytes(),'text/html; charset=utf-8')
        if path=='/api/session': return self.reply(200,{'active':bool(self.license())})
        if path=='/api/admin/licenses':
            if not self.is_admin(): return self.error(401,'请先登录管理页')
            with connect() as c:
                rows=c.execute('SELECT id,order_ref,created,issued_at,code_text,activated,expires_at,enabled,last_seen,visits,readings,device_label,last_device,denied_bindings,device_hash IS NOT NULL AS bound FROM licenses ORDER BY id DESC').fetchall()
            with connect() as c:history=[dict(r) for r in c.execute('SELECT h.*,l.order_ref FROM code_history h JOIN licenses l ON l.id=h.license_id ORDER BY h.id DESC')]
            return self.reply(200,{'history':history,'licenses':[dict(r) for r in rows],'buyer_url':f'http://127.0.0.1:{self.server.buyer_port}/'})
        if path=='/app' or path.startswith('/assets/'):
            license=self.license()
            if not license: return self.error(401,'请先使用激活码登录')
            if path=='/app':
                with connect() as c:c.execute('UPDATE licenses SET visits=visits+1,last_seen=? WHERE id=?',(int(time.time()),license['id']))
                file=ROOT/'private/app.html'
            else:
                base=(ROOT/'private/assets').resolve()
                file=(base/unquote(path[len('/assets/'):])).resolve()
                if not file.is_relative_to(base): return self.error(403,'不允许访问')
            if not file.is_file(): return self.error(404,'文件不存在')
            mime='text/html; charset=utf-8' if path=='/app' else mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
            return self.reply(200,file.read_bytes(),mime)
        return self.error(404,'页面不存在')
    def do_POST(self):
        if not self.host_ok(): return self.error(403,'地址不匹配')
        if self.headers.get('Origin')!='http://'+self.headers.get('Host',''): return self.error(403,'请求来源不匹配')
        if self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.error(415,'请使用JSON请求')
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=4096: return self.error(413,'请求长度不正确')
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict): raise ValueError()
        except (ValueError,TypeError): return self.error(400,'请求内容不正确')
        path=urlsplit(self.path).path
        if (self.server.role=='buyer' and path.startswith('/api/admin/')) or (self.server.role=='admin' and not path.startswith('/api/admin/')):return self.error(404,'接口不存在')
        if path=='/api/usage':
            license=self.license()
            if not license:return self.error(401,'授权已失效，请重新激活或联系卖家')
            if set(data)-{'event','event_id'}:return self.error(400,'不接受问题或其他内容')
            event=data.get('event');event_id=data.get('event_id','')
            if event not in ['heartbeat','reading']:return self.error(400,'事件类型不正确')
            if event=='reading' and (not isinstance(event_id,str) or len(event_id)!=32 or any(ch not in '0123456789abcdef' for ch in event_id)):
                return self.error(400,'事件编号不正确')
            with connect() as c:
                c.execute('UPDATE licenses SET last_seen=?,last_device=? WHERE id=?',(int(time.time()),device_label(self.headers.get('User-Agent','')),license['id']))
                if event=='reading':
                    cur=c.execute('INSERT OR IGNORE INTO usage_events VALUES(?,?)',(license['id'],event_id))
                    if cur.rowcount:c.execute('UPDATE licenses SET readings=readings+1 WHERE id=?',(license['id'],))
            return self.reply(200,{'ok':True})
        if path in ['/api/activate','/api/admin/login']:

            key=(self.client_address[0],path); now=time.time()
            ATTEMPTS[key]=[t for t in ATTEMPTS.get(key,[]) if now-t<60]
            if len(ATTEMPTS[key])>=10: return self.error(429,'尝试过于频繁，请一分钟后重试')
            ATTEMPTS[key].append(now)
        if path=='/api/admin/login':
            if not hmac.compare_digest(digest(str(data.get('password',''))),ADMIN_HASH): return self.error(401,'管理员口令错误')
            token=secrets.token_urlsafe(32); ADMIN_SESSIONS[digest(token)]=time.time()+3600
            return self.reply(200,{'ok':True},cookie=self.set_cookie('gx_admin',token,3600))
        if path=='/api/admin/logout':
            ADMIN_SESSIONS.pop(digest(cookie_value(self.headers,'gx_admin')),None)
            return self.reply(200,{'ok':True},cookie=self.set_cookie('gx_admin','',0))
        if path=='/api/activate':
            code=str(data.get('code','')).strip().upper().replace(' ','')
            token=cookie_value(self.headers,'gx_device')
            with connect() as c:
                c.execute('BEGIN IMMEDIATE')
                row=c.execute('SELECT * FROM licenses WHERE code_hash=?',(digest(code),)).fetchone()
                if not row or not row['enabled']: return self.error(401,'激活码无效或已停用')
                if row['expires_at'] and row['expires_at']<=int(time.time()):return self.error(403,'激活码已到期，使用期为首次激活后30天')
                if row['device_hash']:
                    if not token or not hmac.compare_digest(row['device_hash'],digest(token)):
                        c.execute('UPDATE licenses SET denied_bindings=denied_bindings+1 WHERE id=?',(row['id'],))
                        c.commit()
                        return self.error(409,'此码已绑定其他浏览器。换设备或清除数据后，请联系卖家重置。')
                else:
                    if self.license(): return self.error(409,'此浏览器已有可用激活码，无需再次激活')
                    token=secrets.token_urlsafe(32)
                    c.execute('UPDATE licenses SET device_hash=?,activated=COALESCE(activated,?),expires_at=CASE WHEN expires_at=0 THEN ? ELSE expires_at END,device_label=?,last_device=?,last_seen=? WHERE id=?',(digest(token),int(time.time()),int(time.time())+2592000,device_label(self.headers.get('User-Agent','')),device_label(self.headers.get('User-Agent','')),int(time.time()),row['id']))
            return self.reply(200,{'ok':True},cookie=self.set_cookie('gx_device',token,31536000))
        if path.startswith('/api/admin/'):
            if not self.is_admin(): return self.error(401,'请先登录管理页')
            if path=='/api/admin/create':
                ref=str(data.get('order_ref','')).strip()
                if not ref or len(ref)>100 or data.get('paid') is not True: return self.error(400,'填写订单标记，并确认已收到9.9元')
                with connect() as c:
                    c.execute('BEGIN IMMEDIATE')
                    if c.execute('SELECT id FROM licenses WHERE order_ref=?',(ref,)).fetchone():return self.error(409,'此订单已生成激活码，请勿重复发码')
                    code=new_code(c)
                    c.execute('INSERT INTO licenses(order_ref,code_hash,created,issued_at,code_text) VALUES(?,?,?,?,?)',(ref,digest(code),int(time.time()),int(time.time()),code))
                return self.reply(200,{'code':code,'price':'9.9'})
            if path in ['/api/admin/reset','/api/admin/disable']:
                try: ident=int(data.get('id'))
                except (ValueError,TypeError):return self.error(400,'请选择有效记录')
                with connect() as c:
                    c.execute('BEGIN IMMEDIATE')
                    row=c.execute('SELECT * FROM licenses WHERE id=?',(ident,)).fetchone()
                    if not row:return self.error(404,'记录不存在')
                    if path.endswith('reset'):
                        code=new_code(c)
                        c.execute('INSERT INTO code_history(license_id,code_text,issued_at,retired_at) VALUES(?,?,?,?)',(ident,row['code_text'],row['issued_at'],int(time.time())))
                        c.execute("UPDATE licenses SET code_hash=?,code_text=?,issued_at=?,device_hash=NULL,enabled=1,device_label='',last_device='' WHERE id=?",(digest(code),code,int(time.time()),ident))
                    else:c.execute('UPDATE licenses SET enabled=0 WHERE id=?',(ident,))
                return self.reply(200,{'ok':True,**({'code':code} if path.endswith('reset') else {})})
        return self.error(404,'接口不存在')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8771);parser.add_argument('--admin-port',type=int,default=8772);args=parser.parse_args()
    buyer=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);buyer.role='buyer';buyer.buyer_port=args.port
    admin=ThreadingHTTPServer(('127.0.0.1',args.admin_port),Handler);admin.role='admin';admin.buyer_port=args.port
    print(f'Buyer: http://127.0.0.1:{args.port}/\nAdmin: http://127.0.0.1:{args.admin_port}/\nAdmin password file: {ADMIN_FILE}',flush=True)
    threading.Thread(target=admin.serve_forever,daemon=True).start()
    buyer.serve_forever()
