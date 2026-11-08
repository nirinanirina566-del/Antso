const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const RATE = +process.env.RATE_PER_MIN || 1000;      // Ar par minute
const TICK = 6;                                      // facturation toutes les 6 s
const COST = Math.round(RATE * TICK / 60);           // 100 Ar / 6 s
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const db = new DatabaseSync(process.env.DB_PATH || 'antso.db');
const tx = (f) => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
process.on('uncaughtException', (e) => console.error('Erreur:', e));
db.exec(`
create table if not exists users(id integer primary key, email text unique, phone text unique, name text,
  pass text, bio text default '', photo text default '', balance integer default 0, verified integer default 0,
  code text, code_exp integer);
create table if not exists sessions(token text primary key, user_id integer);
create table if not exists msgs(id integer primary key, from_id integer, to_id integer, body text, ts integer);
create table if not exists tx(id integer primary key, user_id integer, type text, amount integer, method text,
  ref text, status text, ts integer);`);

const hash = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const check = (p, h) => { const [s] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(hash(p, s)), Buffer.from(h)); };
const normPhone = (p) => { p = String(p || '').replace(/[^\d+]/g, ''); return /^\+\d{9,15}$/.test(p) ? p : null; };
const pub = (u) => ({ id: u.id, name: u.name, phone: u.phone, bio: u.bio, photo: u.photo });
const newSession = (uid) => { const t = crypto.randomBytes(32).toString('hex'); db.prepare('insert into sessions values(?,?)').run(t, uid); return t; };
const userByToken = (t) => db.prepare('select u.* from sessions s join users u on u.id=s.user_id where s.token=?').get(t || '');

async function sendWhatsApp(phone, code) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM } = process.env;
  const text = `Antso Video: kaody fanamarinana = ${code}`;
  if (!TWILIO_SID) return console.log(`[DEV] WhatsApp ho an'ny ${phone}: ${text}`);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64'),
               'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: 'whatsapp:' + phone, From: 'whatsapp:' + TWILIO_WA_FROM, Body: text })
  });
  if (!r.ok) throw new Error('WhatsApp failed');
}
async function issueCode(u) {
  const code = String(crypto.randomInt(100000, 999999));
  db.prepare('update users set code=?, code_exp=? where id=?').run(hash(code), Date.now() + 10 * 60000, u.id);
  await sendWhatsApp(u.phone, code);
}

const app = express(), server = http.createServer(app), io = new Server(server, { maxHttpBufferSize: 1e6 });
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));
const wrap = (f) => async (req, res) => { try { await f(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Hadisoana tamin\'ny serveur' }); } };
const auth = (req, res, next) => { const u = userByToken(req.headers.authorization); if (!u) return res.status(401).json({ error: 'Midira aloha' }); req.u = u; next(); };
const adminOnly = (req, res, next) => (ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY) ? next() : res.status(403).json({ error: 'Tsy navela' });

app.post('/api/register', wrap(async (req, res) => {
  const { email, name, password } = req.body, phone = normPhone(req.body.phone);
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.json({ error: 'E-mail diso' });
  if (!phone) return res.json({ error: 'Laharana finday diso (ohatra +261341234567)' });
  if (!name || !password || password.length < 8) return res.json({ error: 'Anarana ilaina, ary teny miafina 8 farafahakeliny' });
  let u = db.prepare('select * from users where email=? or phone=?').get(email.toLowerCase(), phone);
  if (u && u.verified) return res.json({ error: 'Efa misy kaonty mampiasa izany e-mail na laharana izany' });
  if (!u) { const r = db.prepare('insert into users(email,phone,name,pass) values(?,?,?,?)').run(email.toLowerCase(), phone, name, hash(password)); u = { id: r.lastInsertRowid, phone }; }
  else db.prepare('update users set email=?, phone=?, name=?, pass=? where id=?').run(email.toLowerCase(), phone, name, hash(password), u.id);
  await issueCode(u);
  res.json({ ok: true, phone });
}));
app.post('/api/verify', wrap((req, res) => {
  const u = db.prepare('select * from users where phone=?').get(normPhone(req.body.phone) || '');
  if (!u || !u.code || u.code_exp < Date.now() || !check(String(req.body.code), u.code)) return res.json({ error: 'Kaody diso na lany daty' });
  db.prepare('update users set verified=1, code=null where id=?').run(u.id);
  res.json({ token: newSession(u.id) });
}));
app.post('/api/login', wrap((req, res) => {
  const u = db.prepare('select * from users where email=?').get(String(req.body.email || '').toLowerCase());
  if (!u || !check(String(req.body.password || ''), u.pass)) return res.json({ error: 'E-mail na teny miafina diso' });
  if (!u.verified) return res.json({ error: 'Mbola tsy voamarina ny laharana', needVerify: u.phone });
  res.json({ token: newSession(u.id) });
}));
app.get('/api/me', auth, (req, res) => res.json({ ...pub(req.u), email: req.u.email, balance: req.u.balance, rate: RATE }));
app.post('/api/profile', auth, (req, res) => {
  const { name, bio, photo } = req.body;
  if (photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 400000)) return res.json({ error: 'Sary tsy mety' });
  db.prepare('update users set name=coalesce(?,name), bio=coalesce(?,bio), photo=coalesce(?,photo) where id=?').run(name || null, bio ?? null, photo || null, req.u.id);
  res.json({ ok: true });
});
app.get('/api/user/:phone', auth, (req, res) => {
  const u = db.prepare('select * from users where phone=? and verified=1').get(normPhone(req.params.phone) || '');
  res.json(u ? pub(u) : { error: 'Tsy hita ilay olona' });
});
app.get('/api/msgs/:id', auth, (req, res) => res.json(db.prepare(
  'select * from msgs where (from_id=? and to_id=?) or (from_id=? and to_id=?) order by id desc limit 100').all(req.u.id, req.params.id, req.params.id, req.u.id).reverse()));

// ---- Vola (Mobile Money: fanamarinana amin'ny admin) ----
const METHODS = ['MVola', 'Orange Money', 'Airtel Money'];
app.get('/api/tx', auth, (req, res) => res.json(db.prepare('select * from tx where user_id=? order by id desc limit 50').all(req.u.id)));
app.post('/api/deposit', auth, (req, res) => {
  const a = Math.floor(+req.body.amount);
  if (!(a >= 1000) || !METHODS.includes(req.body.method) || !req.body.ref) return res.json({ error: 'Fenoy ny sehatra rehetra (farafahakeliny 1000 Ar)' });
  db.prepare('insert into tx(user_id,type,amount,method,ref,status,ts) values(?,?,?,?,?,?,?)').run(req.u.id, 'deposit', a, req.body.method, String(req.body.ref).slice(0, 60), 'pending', Date.now());
  res.json({ ok: true });
});
app.post('/api/withdraw', auth, (req, res) => {
  const a = Math.floor(+req.body.amount), num = normPhone(req.body.number);
  if (!(a >= 5000) || !METHODS.includes(req.body.method) || !num) return res.json({ error: 'Farafahakeliny 5000 Ar, ary laharana Mobile Money marina' });
  const ok = tx(() => {
    if (db.prepare('update users set balance=balance-? where id=? and balance>=?').run(a, req.u.id, a).changes === 0) return false;
    db.prepare('insert into tx(user_id,type,amount,method,ref,status,ts) values(?,?,?,?,?,?,?)').run(req.u.id, 'withdraw', a, req.body.method, num, 'pending', Date.now());
    return true;
  });
  res.json(ok ? { ok: true } : { error: 'Tsy ampy ny solde' });
});
app.get('/api/admin/pending', adminOnly, (req, res) => res.json(db.prepare(
  "select t.*, u.phone as uphone, u.name from tx t join users u on u.id=t.user_id where t.status='pending' order by t.id").all()));
app.post('/api/admin/decide', adminOnly, (req, res) => {
  tx(() => {
    const t = db.prepare("select * from tx where id=? and status='pending'").get(req.body.id);
    if (!t) return;
    const ok = !!req.body.ok;
    if (t.type === 'deposit' && ok) db.prepare('update users set balance=balance+? where id=?').run(t.amount, t.user_id);
    if (t.type === 'withdraw' && !ok) db.prepare('update users set balance=balance+? where id=?').run(t.amount, t.user_id);
    db.prepare('update tx set status=? where id=?').run(ok ? 'done' : 'rejected', t.id);
  });
  res.json({ ok: true });
});

// ---- Socket: chat, antso, fanaovana faktiora isaky ny 6 s ----
const online = new Map(), userCall = new Map();
const emitTo = (id, ev, d) => online.get(id)?.emit(ev, d);
function endCall(call, reason) {
  if (!call || call.over) return;
  call.over = true; clearInterval(call.timer);
  userCall.delete(call.a); userCall.delete(call.b);
  if (call.charged) db.prepare('insert into tx(user_id,type,amount,method,ref,status,ts) values(?,?,?,?,?,?,?)').run(call.a, 'call', call.charged, '', `${call.secs}s`, 'done', Date.now());
  [call.a, call.b].forEach((id) => emitTo(id, 'call:ended', { reason }));
}
function charge(call) {
  const ok = db.prepare('update users set balance=balance-? where id=? and balance>=?').run(COST, call.a, COST).changes;
  if (!ok) return endCall(call, 'solde');
  call.charged += COST; call.secs += TICK;
  emitTo(call.a, 'balance', db.prepare('select balance from users where id=?').get(call.a).balance);
}
io.use((s, next) => { const u = userByToken(s.handshake.auth.token); if (!u) return next(new Error('auth')); s.user = u; next(); });
io.on('connection', (s) => {
  const me = s.user.id; online.set(me, s);
  s.on('msg', ({ to, body }) => {
    body = String(body || '').trim().slice(0, 1000); if (!body || !db.prepare('select 1 from users where id=?').get(to)) return;
    const m = { from_id: me, to_id: to, body, ts: Date.now() };
    db.prepare('insert into msgs(from_id,to_id,body,ts) values(?,?,?,?)').run(me, to, body, m.ts);
    emitTo(to, 'msg', m); s.emit('msg', m);
  });
  s.on('call:invite', ({ to }) => {
    const bal = db.prepare('select balance from users where id=?').get(me).balance;
    if (bal < RATE) return s.emit('call:ended', { reason: 'solde' });
    if (!online.has(to) || userCall.has(to) || userCall.has(me) || to === me) return s.emit('call:ended', { reason: 'indisponible' });
    const call = { a: me, b: to, charged: 0, secs: 0 }; userCall.set(me, call); userCall.set(to, call);
    emitTo(to, 'call:incoming', { from: pub(s.user) });
  });
  s.on('call:accept', () => {
    const c = userCall.get(me); if (!c || c.b !== me || c.active) return;
    c.active = true; charge(c); if (c.over) return;
    c.timer = setInterval(() => charge(c), TICK * 1000);
    emitTo(c.a, 'call:start', { peer: c.b }); emitTo(c.b, 'call:start', { peer: c.a });
  });
  s.on('call:end', () => endCall(userCall.get(me), 'ended'));
  s.on('signal', ({ to, data }) => { const c = userCall.get(me); if (c && (c.a === to || c.b === to)) emitTo(to, 'signal', { from: me, data }); });
  s.on('disconnect', () => { if (online.get(me) === s) online.delete(me); endCall(userCall.get(me), 'ended'); });
});
server.listen(process.env.PORT || 3000, () => console.log('Mandeha. Tarif:', RATE, 'Ar/min'));
