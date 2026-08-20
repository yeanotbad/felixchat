const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const UPLOADS = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// Turso is the persistent database. For local development without Turso,
// the app falls back to a local SQLite database when TURSO_DATABASE_URL is absent.
const db = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: 'file:felix-local.db' });

const sockets = new Map();
const id = () => crypto.randomBytes(16).toString('hex');
const clean = s => String(s ?? '').trim().slice(0, 32);
const hash = (password, salt) => crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
const now = () => Date.now();
const chatKey = (a, b) => [a, b].sort().join(':');

async function init() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, display_name TEXT, bio TEXT DEFAULT '', avatar TEXT DEFAULT '', role TEXT DEFAULT 'member', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, streak INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(uid) REFERENCES users(uid))`,
    `CREATE TABLE IF NOT EXISTS friendships (user_id TEXT NOT NULL, friend_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, friend_id))`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', created_at INTEGER NOT NULL, read_at INTEGER, expires_at INTEGER, reply_to TEXT, edited INTEGER DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_key, created_at)`,
    `CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL, uid TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id, uid))`,
    `CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, uid TEXT NOT NULL, media_url TEXT NOT NULL, kind TEXT NOT NULL, caption TEXT DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS story_views (story_id TEXT NOT NULL, uid TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(story_id, uid))`,
    `CREATE TABLE IF NOT EXISTS blocks (uid TEXT NOT NULL, blocked_uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(uid, blocked_uid))`,
    `CREATE TABLE IF NOT EXISTS groups (gid TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS group_members (gid TEXT NOT NULL, uid TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(gid, uid))`,
    `CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', audience TEXT DEFAULT 'all', targets_json TEXT DEFAULT '[]', created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS announcement_views (announcement_id TEXT NOT NULL, uid TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(announcement_id, uid))`,
    `CREATE TABLE IF NOT EXISTS group_messages (id TEXT PRIMARY KEY, gid TEXT NOT NULL, sender_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', created_at INTEGER NOT NULL, edited INTEGER DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_group_messages_time ON group_messages(gid, created_at)`,
    `CREATE TABLE IF NOT EXISTS pinned_messages (message_id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, pinned_by TEXT NOT NULL, pinned_at INTEGER NOT NULL)`
  ], 'write');
  for (const sql of [
    `ALTER TABLE announcements ADD COLUMN audience TEXT DEFAULT 'all'`,
    `ALTER TABLE announcements ADD COLUMN targets_json TEXT DEFAULT '[]'`,
    `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member'`,
    `ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN banned_at INTEGER`,
    `ALTER TABLE users ADD COLUMN banned_by TEXT`,
    `ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN banner TEXT DEFAULT ''`
  ]) { try { await db.execute(sql); } catch (e) {} }
  // The @felixchat account is the sole owner of the admin powers.
  // This does not change any other account's role.
  try { await db.execute({sql:`UPDATE users SET role='admin' WHERE username='felixchat'`,args:[]}); } catch (e) {}
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function getUser(uid) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE uid=?', args: [uid] });
  return r.rows[0] || null;
}
async function getUidFromToken(token) {
  if (!token) return null;
  const r = await db.execute({ sql: 'SELECT uid FROM sessions WHERE token=?', args: [token] });
  return r.rows[0]?.uid || null;
}
async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const uid = await getUidFromToken(token);
    if (!uid) return res.status(401).json({ error: 'Not logged in' });
    const user = await getUser(uid);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (Number(user.banned || 0) === 1) return res.status(403).json({ error: 'This account has been banned.' });
    req.uid = uid;
    await db.execute({ sql: 'UPDATE users SET last_seen=? WHERE uid=?', args: [now(), uid] });
    next();
  } catch (e) { res.status(500).json({ error: 'Database error' }); }
}
async function areFriends(a, b) {
  const r = await db.execute({ sql: `SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'`, args: [a, b] });
  return r.rows.length > 0;
}
async function blocked(a, b) {
  const r = await db.execute({ sql: 'SELECT 1 FROM blocks WHERE uid=? AND blocked_uid=?', args: [a, b] });
  return r.rows.length > 0;
}
function broadcast(uid, payload) {
  const set = sockets.get(uid);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function pair(a,b,payload){ broadcast(a,payload); broadcast(b,payload); }
function publicUser(u, online=false){
  return { uid:u.uid, username:u.username, displayName:u.display_name || u.username, bio:u.bio || '', avatar:u.avatar || '', banner:u.banner || '', statusText:u.status_text || '', role:u.role || 'member', online, lastSeen:u.last_seen || 0, streak:u.streak || 0 };
}

app.get('/api/health', async (_req,res)=>res.json({ok:true, database:process.env.TURSO_DATABASE_URL?'turso':'local'}));
app.get('/api/cloudinary-config', auth, async (_req,res)=>{
  const cloudName=String(process.env.CLOUDINARY_CLOUD_NAME||'').trim();
  const uploadPreset=String(process.env.CLOUDINARY_UPLOAD_PRESET||'').trim();
  if(!cloudName||!uploadPreset) return res.status(503).json({error:'Cloudinary is not configured on the server.'});
  res.json({cloudName,uploadPreset});
});

app.post('/api/register', async (req,res)=>{
  try {
    const username=clean(req.body.username).toLowerCase();
    const password=String(req.body.password||'');
    if(!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:'Username must be 3-20 letters, numbers or _'});
    if(password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
    const exists=await db.execute({sql:'SELECT uid FROM users WHERE username=?',args:[username]});
    if(exists.rows.length) return res.status(409).json({error:'Username already exists'});
    const uid=id(),salt=id(),token=id(),t=now();
    await db.batch([
      {sql:'INSERT INTO users(uid,username,password_hash,salt,display_name,created_at,last_seen) VALUES(?,?,?,?,?,?,?)',args:[uid,username,hash(password,salt),salt,username,t,t]},
      {sql:'INSERT INTO sessions(token,uid,created_at) VALUES(?,?,?)',args:[token,uid,t]}
    ]);
    res.json({token,username});
  } catch(e){console.error(e);res.status(500).json({error:'Registration failed'});}
});

app.post('/api/login', async (req,res)=>{
  try {
    const username=clean(req.body.username).toLowerCase(), password=String(req.body.password||'');
    const r=await db.execute({sql:'SELECT * FROM users WHERE username=?',args:[username]});
    const u=r.rows[0];
    if(!u || u.password_hash!==hash(password,u.salt)) return res.status(401).json({error:'Wrong username or password'});
    if(Number(u.banned || 0) === 1) return res.status(403).json({error:'This account has been banned.'});
    const token=id(); await db.execute({sql:'INSERT INTO sessions(token,uid,created_at) VALUES(?,?,?)',args:[token,u.uid,now()]});
    await db.execute({sql:'UPDATE users SET last_seen=? WHERE uid=?',args:[now(),u.uid]});
    res.json({token,username});
  } catch(e){res.status(500).json({error:'Login failed'});}
});

app.post('/api/logout',auth,async(req,res)=>{const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');await db.execute({sql:'DELETE FROM sessions WHERE token=?',args:[token]});res.json({ok:true});});

app.get('/api/me',auth,async(req,res)=>{
  const u=await getUser(req.uid);
  const fr=await db.execute({sql:`SELECT u.* FROM users u JOIN friendships f ON f.friend_id=u.uid WHERE f.user_id=? AND f.status='accepted' ORDER BY u.username`,args:[req.uid]});
  const incoming=await db.execute({sql:`SELECT u.uid,u.username,u.display_name,u.avatar FROM users u JOIN friendships f ON f.user_id=u.uid WHERE f.friend_id=? AND f.status='pending'`,args:[req.uid]});
  res.json({uid:u.uid,username:u.username,displayName:u.display_name||u.username,bio:u.bio||'',avatar:u.avatar||'',role:u.role||'member',streak:u.streak||0,friends:fr.rows.map(x=>publicUser(x,(sockets.get(x.uid)?.size||0)>0)),requests:incoming.rows.map(x=>publicUser(x))});
});

const upload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,UPLOADS),filename:(_r,file,cb)=>cb(null,id()+path.extname(file.originalname||'').toLowerCase().slice(0,10))}),limits:{fileSize:50*1024*1024}});

app.patch('/api/profile',auth,async(req,res)=>{
  const display=clean(req.body.displayName||'').slice(0,40),bio=String(req.body.bio||'').slice(0,300),statusText=String(req.body.statusText||'').slice(0,80),banner=String(req.body.banner||'').trim();
  if(banner && !/^https:\/\/res\.cloudinary\.com\//i.test(banner)) return res.status(400).json({error:'Banner must be a Cloudinary URL'});
  const hasAvatar=Object.prototype.hasOwnProperty.call(req.body,'avatar');
  if(hasAvatar){const avatar=String(req.body.avatar||'').slice(0,1200000);await db.execute({sql:'UPDATE users SET display_name=?, bio=?, avatar=?, status_text=?, banner=? WHERE uid=?',args:[display||null,bio,avatar,statusText,banner,req.uid]});}
  else await db.execute({sql:'UPDATE users SET display_name=?, bio=?, status_text=?, banner=? WHERE uid=?',args:[display||null,bio,statusText,banner,req.uid]});
  res.json(publicUser(await getUser(req.uid),(sockets.get(req.uid)?.size||0)>0));
});

// Profile pictures are stored as permanent Cloudinary URLs in Turso.
app.get('/api/users/search',auth,async(req,res)=>{
  const q=String(req.query.q||'').trim().toLowerCase();
  const r=await db.execute({sql:`SELECT * FROM users WHERE lower(username) LIKE ? OR lower(COALESCE(display_name,'')) LIKE ? ORDER BY username LIMIT 30`,args:[`%${q}%`,`%${q}%`]});
  const out=[]; for(const u of r.rows){ if(u.uid===req.uid) continue; if(await blocked(req.uid,u.uid)||await blocked(u.uid,req.uid)) continue; out.push(publicUser(u,(sockets.get(u.uid)?.size||0)>0)); } res.json(out);
});
app.post('/api/account/change-password',auth,async(req,res)=>{const current=String(req.body.currentPassword||''), next=String(req.body.newPassword||'');if(next.length<6)return res.status(400).json({error:'New password must be at least 6 characters.'});const u=await getUser(req.uid);if(!u||hash(current,u.salt)!==u.password_hash)return res.status(400).json({error:'Current password is incorrect.'});const salt=crypto.randomBytes(16).toString('hex');await db.execute({sql:'UPDATE users SET salt=?,password_hash=? WHERE uid=?',args:[salt,hash(next,salt),req.uid]});res.json({ok:true});});
app.post('/api/account/logout-other-sessions',auth,async(req,res)=>{const current=req.headers.authorization?.replace(/^Bearer\s+/i,'');await db.execute({sql:'DELETE FROM sessions WHERE uid=? AND token<>?',args:[req.uid,current]});res.json({ok:true});});

app.post('/api/profile/avatar',auth,async(req,res)=>{
  try{
    const avatar=String(req.body?.avatar||'').trim().slice(0,2000);
    if(!/^https:\/\/res\.cloudinary\.com\//i.test(avatar)) return res.status(400).json({error:'Invalid Cloudinary image URL'});
    await db.execute({sql:'UPDATE users SET avatar=? WHERE uid=?',args:[avatar,req.uid]});
    res.json({ok:true,avatar});
  }catch(e){console.error(e);res.status(500).json({error:'Profile picture upload failed'});}
});

app.post('/api/friends/request',auth,async(req,res)=>{
  const username=clean(req.body.username).toLowerCase(); const r=await db.execute({sql:'SELECT * FROM users WHERE username=?',args:[username]}); const target=r.rows[0];
  if(!target)return res.status(404).json({error:'User not found'}); if(target.uid===req.uid)return res.status(400).json({error:"You can't add yourself"}); if(await blocked(req.uid,target.uid)||await blocked(target.uid,req.uid))return res.status(403).json({error:'Friend request unavailable'});
  const f=await db.execute({sql:'SELECT status FROM friendships WHERE user_id=? AND friend_id=?',args:[req.uid,target.uid]}); if(f.rows[0]?.status==='accepted')return res.json({ok:true,message:'Already friends'});
  await db.batch([
    {sql:`INSERT INTO friendships(user_id,friend_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO UPDATE SET status='pending'`,args:[req.uid,target.uid,'pending',now()]},
    {sql:`INSERT INTO friendships(user_id,friend_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO NOTHING`,args:[target.uid,req.uid,'none',now()]}
  ]); broadcast(target.uid,{type:'friend_request',from:(await getUser(req.uid)).username,uid:req.uid});res.json({ok:true});
});

app.post('/api/friends/accept',auth,async(req,res)=>{const other=req.body.uid; if(!await getUser(other))return res.status(404).json({error:'User not found'}); await db.batch([{sql:`UPDATE friendships SET status='accepted' WHERE user_id=? AND friend_id=?`,args:[other,req.uid]},{sql:`UPDATE friendships SET status='accepted' WHERE user_id=? AND friend_id=?`,args:[req.uid,other]}]); pair(req.uid,other,{type:'friend_accepted'});res.json({ok:true});});
app.post('/api/friends/decline',auth,async(req,res)=>{await db.execute({sql:`UPDATE friendships SET status='declined' WHERE user_id=? AND friend_id=?`,args:[req.body.uid,req.uid]});res.json({ok:true});});
app.delete('/api/friends/:uid',auth,async(req,res)=>{await db.batch([{sql:'DELETE FROM friendships WHERE user_id=? AND friend_id=?',args:[req.uid,req.params.uid]},{sql:'DELETE FROM friendships WHERE user_id=? AND friend_id=?',args:[req.params.uid,req.uid]}]);res.json({ok:true});});
app.post('/api/block/:uid',auth,async(req,res)=>{await db.execute({sql:'INSERT OR IGNORE INTO blocks(uid,blocked_uid,created_at) VALUES(?,?,?)',args:[req.uid,req.params.uid,now()]});res.json({ok:true});});
app.delete('/api/block/:uid',auth,async(req,res)=>{await db.execute({sql:'DELETE FROM blocks WHERE uid=? AND blocked_uid=?',args:[req.uid,req.params.uid]});res.json({ok:true});});

function messageRow(x){return {id:x.id,from:x.sender_id,to:x.receiver_id,text:x.text||'',kind:x.kind,url:x.url||'',name:x.name||'',mime:x.mime||'',time:x.created_at,readAt:x.read_at,expiresAt:x.expires_at,replyTo:x.reply_to,edited:!!x.edited};}
app.get('/api/messages/:uid',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:`SELECT * FROM messages WHERE chat_key=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at`,args:[chatKey(req.uid,req.params.uid),now()]});const out=[];for(const row of r.rows){const m=messageRow(row);const rr=await db.execute({sql:'SELECT uid,emoji FROM reactions WHERE message_id=? ORDER BY created_at',args:[m.id]});m.reactions=rr.rows;out.push(m)}res.json(out);});
app.post('/api/messages/:uid',auth,async(req,res)=>{
  const other=req.params.uid;if(!await areFriends(req.uid,other))return res.status(403).json({error:'Not friends'});if(await blocked(req.uid,other)||await blocked(other,req.uid))return res.status(403).json({error:'Messaging unavailable'});
  const text=String(req.body.text||'').trim().slice(0,4000);if(!text)return res.status(400).json({error:'Empty message'});
  const m={id:id(),from:req.uid,to:other,text,kind:'text',url:'',name:'',mime:'',time:now(),readAt:null,expiresAt:req.body.disappearing?now()+86400000:null,replyTo:req.body.replyTo||null,edited:false};
  await db.execute({sql:`INSERT INTO messages(id,chat_key,sender_id,receiver_id,text,kind,created_at,expires_at,reply_to) VALUES(?,?,?,?,?,?,?,?,?)`,args:[m.id,chatKey(req.uid,other),req.uid,other,m.text,'text',m.time,m.expiresAt,m.replyTo]});
  broadcast(other,{type:'message',message:m});res.json(m);
});
app.patch('/api/messages/:uid/:messageId',auth,async(req,res)=>{const text=String(req.body.text||'').trim().slice(0,4000);const r=await db.execute({sql:'SELECT * FROM messages WHERE id=? AND sender_id=?',args:[req.params.messageId,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'UPDATE messages SET text=?, edited=1 WHERE id=?',args:[text,req.params.messageId]});const m=messageRow({...r.rows[0],text,edited:1});pair(req.uid,r.rows[0].receiver_id,{type:'message_edited',message:m});res.json(m);});
app.post('/api/messages/:uid/:messageId/read',auth,async(req,res)=>{await db.execute({sql:'UPDATE messages SET read_at=? WHERE id=? AND receiver_id=?',args:[now(),req.params.messageId,req.uid]});const r=await db.execute({sql:'SELECT sender_id FROM messages WHERE id=?',args:[req.params.messageId]});if(r.rows[0])broadcast(r.rows[0].sender_id,{type:'message_read',messageId:req.params.messageId,at:now()});res.json({ok:true});});
app.post('/api/messages/:uid/:messageId/react',auth,async(req,res)=>{const emoji=String(req.body.emoji||'❤️').slice(0,8);await db.execute({sql:'INSERT INTO reactions(message_id,uid,emoji,created_at) VALUES(?,?,?,?) ON CONFLICT(message_id,uid) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at',args:[req.params.messageId,req.uid,emoji,now()]});const r=await db.execute({sql:'SELECT * FROM reactions WHERE message_id=?',args:[req.params.messageId]});const mr=await db.execute({sql:'SELECT sender_id,receiver_id FROM messages WHERE id=?',args:[req.params.messageId]});if(mr.rows[0])pair(mr.rows[0].sender_id,mr.rows[0].receiver_id,{type:'reaction',messageId:req.params.messageId,reactions:r.rows});res.json(r.rows);});
app.get('/api/messages/:uid/pinned',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:`SELECT p.*,m.text,m.kind,m.url,m.name,m.mime,m.sender_id,m.receiver_id,m.created_at FROM pinned_messages p JOIN messages m ON m.id=p.message_id WHERE p.chat_key=? ORDER BY p.pinned_at DESC`,args:[chatKey(req.uid,req.params.uid)]});res.json(r.rows.map(x=>({...messageRow(x),pinnedAt:x.pinned_at,pinnedBy:x.pinned_by})));});
app.post('/api/messages/:uid/:messageId/pin',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:'SELECT id FROM messages WHERE id=? AND chat_key=?',args:[req.params.messageId,chatKey(req.uid,req.params.uid)]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'INSERT OR REPLACE INTO pinned_messages(message_id,chat_key,pinned_by,pinned_at) VALUES(?,?,?,?)',args:[req.params.messageId,chatKey(req.uid,req.params.uid),req.uid,now()]});res.json({ok:true});});
app.delete('/api/messages/:uid/:messageId/pin',auth,async(req,res)=>{await db.execute({sql:'DELETE FROM pinned_messages WHERE message_id=? AND chat_key=?',args:[req.params.messageId,chatKey(req.uid,req.params.uid)]});res.json({ok:true});});
app.delete('/api/messages/:uid/:messageId',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM messages WHERE id=? AND sender_id=?',args:[req.params.messageId,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'DELETE FROM messages WHERE id=?',args:[req.params.messageId]});pair(req.uid,r.rows[0].receiver_id,{type:'message_deleted',messageId:req.params.messageId});if(r.rows[0].url?.startsWith('/uploads/'))fs.unlink(path.join(UPLOADS,path.basename(r.rows[0].url)),()=>{});res.json({ok:true});});


app.post('/api/upload/:uid',auth,async(req,res)=>{const other=req.params.uid;if(!await areFriends(req.uid,other))return res.status(403).json({error:'Not friends'});const url=String(req.body?.url||'').trim();if(!/^https:\/\/res\.cloudinary\.com\//i.test(url))return res.status(400).json({error:'Cloudinary media URL required'});const mime=String(req.body?.mime||'application/octet-stream');const kind=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'voice':'file';const m={id:id(),from:req.uid,to:other,text:'',kind,url,name:String(req.body?.name||'file').slice(0,120),mime,time:now(),readAt:null,expiresAt:null,replyTo:null,edited:false};await db.execute({sql:`INSERT INTO messages(id,chat_key,sender_id,receiver_id,text,kind,url,name,mime,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[m.id,chatKey(req.uid,other),req.uid,other,'',kind,m.url,m.name,mime,m.time]});broadcast(other,{type:'message',message:m});res.json(m);});

app.post('/api/typing/:uid',auth,async(req,res)=>{broadcast(req.params.uid,{type:'typing',uid:req.uid,typing:!!req.body.typing});res.json({ok:true});});

// Snapchat-style 24-hour stories.
app.get('/api/stories',auth,async(req,res)=>{const f=await db.execute({sql:`SELECT u.* FROM users u JOIN friendships f ON f.friend_id=u.uid WHERE f.user_id=? AND f.status='accepted'`,args:[req.uid]});const ids=[req.uid,...f.rows.map(x=>x.uid)];const placeholders=ids.map(()=>'?').join(',');const r=await db.execute({sql:`SELECT s.*,u.username,u.display_name,u.avatar,(SELECT COUNT(*) FROM story_views v WHERE v.story_id=s.id) AS views FROM stories s JOIN users u ON u.uid=s.uid WHERE s.uid IN (${placeholders}) AND s.expires_at>? ORDER BY s.created_at DESC`,args:[...ids,now()]});res.json(r.rows.map(x=>({id:x.id,uid:x.uid,username:x.username,displayName:x.display_name||x.username,avatar:x.avatar||'',url:x.media_url,kind:x.kind,caption:x.caption,time:x.created_at,expiresAt:x.expires_at,views:Number(x.views||0)})));});
app.get('/api/stories/mine',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT s.*,(SELECT COUNT(*) FROM story_views v WHERE v.story_id=s.id) AS views FROM stories s WHERE s.uid=? AND s.expires_at>? ORDER BY s.created_at DESC`,args:[req.uid,now()]});
  const out=[];
  for(const s of r.rows){
    const vr=await db.execute({sql:`SELECT v.uid,v.viewed_at,u.username,u.display_name,u.avatar FROM story_views v JOIN users u ON u.uid=v.uid WHERE v.story_id=? ORDER BY v.viewed_at DESC`,args:[s.id]});
    out.push({id:s.id,uid:s.uid,url:s.media_url,kind:s.kind,caption:s.caption||'',time:s.created_at,expiresAt:s.expires_at,views:Number(s.views||0),viewers:vr.rows.map(v=>({uid:v.uid,username:v.username,displayName:v.display_name||v.username,avatar:v.avatar||'',viewedAt:v.viewed_at}))});
  }
  res.json(out);
});
app.post('/api/stories',auth,async(req,res)=>{const url=String(req.body?.url||'').trim();if(!/^https:\/\/res\.cloudinary\.com\//i.test(url))return res.status(400).json({error:'Cloudinary story URL required'});const mime=String(req.body?.mime||'image/*');const kind=mime.startsWith('video/')?'video':'image';const story={id:id(),uid:req.uid,url,kind,caption:String(req.body?.caption||'').slice(0,180),time:now(),expiresAt:now()+86400000};await db.execute({sql:'INSERT INTO stories(id,uid,media_url,kind,caption,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',args:[story.id,story.uid,story.url,story.kind,story.caption,story.time,story.expiresAt]});broadcast(req.uid,{type:'story_added',story});res.json(story);});
app.post('/api/stories/:id/view',auth,async(req,res)=>{await db.execute({sql:'INSERT OR REPLACE INTO story_views(story_id,uid,viewed_at) VALUES(?,?,?)',args:[req.params.id,req.uid,now()]});res.json({ok:true});});
app.delete('/api/stories/:id',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM stories WHERE id=? AND uid=?',args:[req.params.id,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Story not found'});await db.execute({sql:'DELETE FROM stories WHERE id=?',args:[req.params.id]});if(r.rows[0].media_url.startsWith('/uploads/'))fs.unlink(path.join(UPLOADS,path.basename(r.rows[0].media_url)),()=>{});res.json({ok:true});});

// Moderation and roles.
// Only @felixchat can grant/revoke roles. Moderators can ban/unban users,
// but can never grant powers or moderate the @felixchat account.
async function getRole(uid){
  const u=await getUser(uid);
  return String(u?.role||'member').toLowerCase();
}
async function requireAdmin(req,res){
  const u=await getUser(req.uid);
  if(!u || u.username!=='felixchat' || String(u.role||'')!=='admin'){
    res.status(403).json({error:'Admin access required'}); return false;
  }
  return true;
}
async function requireModerator(req,res){
  const u=await getUser(req.uid);
  const role=String(u?.role||'member').toLowerCase();
  if(!u || !['admin','mod'].includes(role)){
    res.status(403).json({error:'Moderator access required'}); return false;
  }
  return true;
}
app.get('/api/admin/status',auth,async(req,res)=>{
  const u=await getUser(req.uid);
  res.json({admin:u?.username==='felixchat' && String(u.role||'')==='admin', moderator:['admin','mod'].includes(String(u?.role||'').toLowerCase()), role:u?.role||'member'});
});
app.get('/api/admin/users',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const q=clean(req.query.q||'').toLowerCase();
  const r=await db.execute({sql:`SELECT uid,username,display_name,bio,avatar,role,banned,created_at,last_seen FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 100`,args:[`%${q}%`,`%${q}%`]});
  res.json(r.rows.map(u=>({uid:u.uid,username:u.username,displayName:u.display_name||u.username,bio:u.bio||'',avatar:u.avatar||'',role:u.role||'member',banned:Number(u.banned||0)===1,createdAt:u.created_at,lastSeen:u.last_seen})));
});
app.post('/api/admin/ban/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'The FelixChat admin account cannot be banned.'});
  await db.batch([{sql:'UPDATE users SET banned=1,banned_at=?,banned_by=? WHERE uid=?',args:[now(),req.uid,req.params.uid]},{sql:'DELETE FROM sessions WHERE uid=?',args:[req.params.uid]}]);
  broadcast(req.params.uid,{type:'banned'});
  res.json({ok:true});
});
app.post('/api/admin/unban/:uid',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'The FelixChat admin account cannot be changed.'});
  await db.execute({sql:'UPDATE users SET banned=0,banned_at=NULL,banned_by=NULL WHERE uid=?',args:[req.params.uid]});
  res.json({ok:true});
});
app.post('/api/admin/role/:uid',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  const target=await getUser(req.params.uid);
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'The FelixChat admin account always remains admin.'});
  const role=String(req.body.role||'member').toLowerCase();
  if(!['member','vip','mod'].includes(role))return res.status(400).json({error:'Role must be member, vip, or mod.'});
  await db.execute({sql:'UPDATE users SET role=? WHERE uid=?',args:[role,req.params.uid]});
  broadcast(req.params.uid,{type:'role_changed',role});
  res.json({ok:true,role});
});
app.post('/api/admin/command',auth,async(req,res)=>{
  const isMod=await getRole(req.uid);
  if(!['admin','mod'].includes(isMod))return res.status(403).json({error:'Moderator access required'});
  const command=String(req.body.command||'').trim().toLowerCase();
  const username=clean(req.body.username||'').toLowerCase();
  if(!['ban','unban'].includes(command))return res.status(400).json({error:'Use /ban username or /unban username'});
  const r=await db.execute({sql:'SELECT uid,username FROM users WHERE username=?',args:[username]});
  const target=r.rows[0];
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'You cannot moderate the FelixChat admin account.'});
  if(command==='ban'){
    await db.batch([{sql:'UPDATE users SET banned=1,banned_at=?,banned_by=? WHERE uid=?',args:[now(),req.uid,target.uid]},{sql:'DELETE FROM sessions WHERE uid=?',args:[target.uid]}]);
    broadcast(target.uid,{type:'banned'});
    return res.json({ok:true,action:'ban',username:target.username});
  }
  await db.execute({sql:'UPDATE users SET banned=0,banned_at=NULL,banned_by=NULL WHERE uid=?',args:[target.uid]});
  res.json({ok:true,action:'unban',username:target.username});
});


// Group chat features.
async function groupMember(gid,uid){const r=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[gid,uid]});return r.rows.length>0;}
async function broadcastGroup(gid,payload){const r=await db.execute({sql:'SELECT uid FROM group_members WHERE gid=?',args:[gid]});for(const x of r.rows)broadcast(x.uid,payload);}
app.get('/api/groups/:gid/messages',auth,async(req,res)=>{if(!await groupMember(req.params.gid,req.uid))return res.status(403).json({error:'Not a group member'});const r=await db.execute({sql:'SELECT m.*,u.username,u.display_name,u.avatar FROM group_messages m JOIN users u ON u.uid=m.sender_id WHERE m.gid=? ORDER BY m.created_at LIMIT 1000',args:[req.params.gid]});res.json(r.rows.map(x=>({id:x.id,gid:x.gid,from:x.sender_id,text:x.text||'',kind:x.kind||'text',url:x.url||'',name:x.name||'',mime:x.mime||'',time:x.created_at,edited:!!x.edited,senderUsername:x.username,senderDisplayName:x.display_name||x.username,avatar:x.avatar||''})));});
app.post('/api/groups/:gid/messages',auth,async(req,res)=>{const gid=req.params.gid;if(!await groupMember(gid,req.uid))return res.status(403).json({error:'Not a group member'});const text=String(req.body.text||'').trim().slice(0,4000);if(!text)return res.status(400).json({error:'Empty message'});const m={id:id(),gid,from:req.uid,text,kind:'text',url:'',name:'',mime:'',time:now(),edited:false};await db.execute({sql:'INSERT INTO group_messages(id,gid,sender_id,text,kind,created_at) VALUES(?,?,?,?,?,?)',args:[m.id,gid,req.uid,text,'text',m.time]});await broadcastGroup(gid,{type:'group_message',message:m});res.json(m);});
app.post('/api/groups/:gid/members/remove',auth,async(req,res)=>{const gid=req.params.gid,other=req.body.uid;const g=await db.execute({sql:'SELECT owner_id FROM groups WHERE gid=?',args:[gid]});if(!g.rows[0]||g.rows[0].owner_id!==req.uid)return res.status(403).json({error:'Only the group owner can remove members'});await db.execute({sql:'DELETE FROM group_members WHERE gid=? AND uid=?',args:[gid,other]});res.json({ok:true});});

// Announcements: owners and moderators can send a full-screen announcement
// either to everybody or to a selected list of accounts.
app.get('/api/announcements/recent',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT a.*,u.username AS sender_username,u.display_name AS sender_display_name FROM announcements a JOIN users u ON u.uid=a.sender_id ORDER BY a.created_at DESC LIMIT 20`,args:[]});
  const out=[];
  for(const a of r.rows){
    let targets=[];try{targets=JSON.parse(a.targets_json||'[]');}catch{}
    if(a.audience==='all'||targets.includes(req.uid)){
      const seen=await db.execute({sql:'SELECT 1 FROM announcement_views WHERE announcement_id=? AND uid=?',args:[a.id,req.uid]});
      if(!seen.rows.length) out.push({id:a.id,text:a.text||'',kind:a.kind||'text',url:a.url||'',name:a.name||'',mime:a.mime||'',time:a.created_at,senderUsername:a.sender_username,senderDisplayName:a.sender_display_name||a.sender_username});
    }
  }
  res.json(out.slice(0,3));
});

app.get('/api/announcement/users',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  const q=clean(req.query.q||'').toLowerCase();
  const r=await db.execute({sql:`SELECT uid,username,display_name,avatar,role FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 100`,args:[`%${q}%`,`%${q}%`]});
  res.json(r.rows.map(u=>({uid:u.uid,username:u.username,displayName:u.display_name||u.username,avatar:u.avatar||'',role:u.role||'member'})));
});
app.post('/api/announcements',auth,async(req,res)=>{
  if(!await requireModerator(req,res))return;
  try{
    const text=String(req.body?.text||'').trim().slice(0,5000);
    const targetMode=String(req.body?.targetMode||'all').toLowerCase();
    let targets=[];
    if(targetMode==='selected'){
      try{targets=JSON.parse(String(req.body?.targets||'[]'));}catch{targets=[];}
      targets=[...new Set(targets.map(x=>String(x)).filter(Boolean))];
      if(!targets.length)return res.status(400).json({error:'Select at least one person.'});
    }else if(targetMode!=='all')return res.status(400).json({error:'Invalid announcement audience.'});
    const url=String(req.body?.url||'').trim();
    const mime=String(req.body?.mime||'');
    const name=String(req.body?.name||'announcement').slice(0,120);
    if(!text&&!url)return res.status(400).json({error:'Add text or attach an image, video, or audio file.'});
    if(url&&!/^https:\/\/res\.cloudinary\.com\//i.test(url))return res.status(400).json({error:'Invalid Cloudinary media URL'});
    let kind='text';
    if(url)kind=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'file';
    const a={id:id(),senderId:req.uid,text,kind,url,name,mime,time:now()};
    await db.execute({sql:'INSERT INTO announcements(id,sender_id,text,kind,url,name,mime,audience,targets_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',args:[a.id,a.senderId,a.text,a.kind,a.url,a.name,a.mime,targetMode,JSON.stringify(targets),a.time]});
    const sender=await getUser(req.uid);
    const payload={type:'announcement',announcement:{...a,senderUsername:sender?.username||'Moderator',senderDisplayName:sender?.display_name||sender?.username||'Moderator'}};
    if(targetMode==='all'){for(const [uid] of sockets)broadcast(uid,payload);}else{const valid=await db.execute({sql:`SELECT uid FROM users WHERE uid IN (${targets.map(()=>'?').join(',')})`,args:targets});for(const row of valid.rows)broadcast(row.uid,payload);}
    res.json({ok:true,announcement:a,targetMode,targetCount:targetMode==='all'?null:targets.length});
  }catch(e){console.error(e);res.status(500).json({error:'Announcement failed'});}
});

app.get('/api/notifications/unread',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT m.id,m.sender_id,m.text,m.kind,m.created_at,u.username,u.display_name FROM messages m JOIN users u ON u.uid=m.sender_id WHERE m.receiver_id=? AND m.read_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.created_at DESC LIMIT 50`,args:[req.uid,now()]});
  res.json(r.rows.map(m=>({id:m.id,uid:m.sender_id,username:m.username,displayName:m.display_name||m.username,text:m.text||'',kind:m.kind,time:m.created_at})));
});

// Simple group-chat backend.
app.post('/api/groups',auth,async(req,res)=>{const name=String(req.body.name||'New Group').trim().slice(0,40);const gid=id();await db.batch([{sql:'INSERT INTO groups(gid,name,owner_id,created_at) VALUES(?,?,?,?)',args:[gid,name,req.uid,now()]},{sql:'INSERT INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[gid,req.uid,now()]}]);res.json({gid,name});});
app.get('/api/groups',auth,async(req,res)=>{const r=await db.execute({sql:`SELECT g.* FROM groups g JOIN group_members m ON m.gid=g.gid WHERE m.uid=? ORDER BY g.created_at DESC`,args:[req.uid]});const out=[];for(const g of r.rows){const m=await db.execute({sql:`SELECT u.uid,u.username,u.display_name,u.avatar FROM users u JOIN group_members gm ON gm.uid=u.uid WHERE gm.gid=?`,args:[g.gid]});out.push({...g,members:m.rows.map(u=>publicUser(u,(sockets.get(u.uid)?.size||0)>0))});}res.json(out);});
app.post('/api/groups/:gid/members',auth,async(req,res)=>{const other=req.body.uid;const member=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[req.params.gid,req.uid]});if(!member.rows.length)return res.status(403).json({error:'Not a group member'});await db.execute({sql:'INSERT OR IGNORE INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[req.params.gid,other,now()]});res.json({ok:true});});

wss.on('connection',ws=>{let uid=null;ws.on('message',async raw=>{try{const m=JSON.parse(raw);if(m.type==='auth'){uid=await getUidFromToken(m.token);if(!uid)return ws.close(1008,'Unauthorized');if(!sockets.has(uid))sockets.set(uid,new Set());sockets.get(uid).add(ws);ws.send(JSON.stringify({type:'ready'}));
        try{const r=await db.execute({sql:`SELECT a.*,u.username AS sender_username,u.display_name AS sender_display_name FROM announcements a JOIN users u ON u.uid=a.sender_id ORDER BY a.created_at DESC LIMIT 20`,args:[]});for(const a of r.rows){let ts=[];try{ts=JSON.parse(a.targets_json||'[]')}catch{}if(!(a.audience==='all'||ts.includes(uid)))continue;const seen=await db.execute({sql:'SELECT 1 FROM announcement_views WHERE announcement_id=? AND uid=?',args:[a.id,uid]});if(seen.rows.length)continue;const announcement={id:a.id,text:a.text||'',kind:a.kind||'text',url:a.url||'',name:a.name||'',mime:a.mime||'',time:a.created_at,senderUsername:a.sender_username,senderDisplayName:a.sender_display_name||a.sender_username};ws.send(JSON.stringify({type:'announcement',announcement}));await db.execute({sql:'INSERT OR IGNORE INTO announcement_views(announcement_id,uid,viewed_at) VALUES(?,?,?)',args:[a.id,uid,now()]});break;}}catch(e){}
        return;}if(uid&&m.type==='typing'&&m.to)broadcast(m.to,{type:'typing',uid,typing:!!m.typing});if(uid&&m.type==='group_typing'&&m.gid&&await groupMember(m.gid,uid))await broadcastGroup(m.gid,{type:'group_typing',uid,typing:!!m.typing});if(uid&&['call_invite','call_accept','call_reject','call_signal','call_end'].includes(m.type)&&m.to&&await areFriends(uid,m.to)){broadcast(m.to,{type:m.type,from:uid,payload:m.payload||null,callType:m.callType||'audio'});}}catch(e){}});ws.on('close',()=>{if(!uid)return;const set=sockets.get(uid);if(!set)return;set.delete(ws);if(!set.size)sockets.delete(uid);});});

setInterval(async()=>{try{await db.execute({sql:'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?',args:[now()]});await db.execute({sql:'DELETE FROM stories WHERE expires_at<=?',args:[now()]});}catch(e){}},60000);

init().then(()=>server.listen(PORT,()=>console.log('Felix Chat running on '+PORT))).catch(e=>{console.error('DB init failed',e);process.exit(1);});
