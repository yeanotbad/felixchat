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
    `CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, display_name TEXT, bio TEXT DEFAULT '', avatar TEXT DEFAULT '', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, streak INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(uid) REFERENCES users(uid))`,
    `CREATE TABLE IF NOT EXISTS friendships (user_id TEXT NOT NULL, friend_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, friend_id))`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL, text TEXT DEFAULT '', kind TEXT DEFAULT 'text', url TEXT DEFAULT '', name TEXT DEFAULT '', mime TEXT DEFAULT '', created_at INTEGER NOT NULL, read_at INTEGER, expires_at INTEGER, reply_to TEXT, edited INTEGER DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_key, created_at)`,
    `CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL, uid TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id, uid))`,
    `CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, uid TEXT NOT NULL, media_url TEXT NOT NULL, kind TEXT NOT NULL, caption TEXT DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS story_views (story_id TEXT NOT NULL, uid TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(story_id, uid))`,
    `CREATE TABLE IF NOT EXISTS blocks (uid TEXT NOT NULL, blocked_uid TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(uid, blocked_uid))`,
    `CREATE TABLE IF NOT EXISTS groups (gid TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS group_members (gid TEXT NOT NULL, uid TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(gid, uid))`
  ], 'write');
  for (const sql of [
    `ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN banned_at INTEGER`,
    `ALTER TABLE users ADD COLUMN banned_by TEXT`
  ]) { try { await db.execute(sql); } catch (e) {} }
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
  return { uid:u.uid, username:u.username, displayName:u.display_name || u.username, bio:u.bio || '', avatar:u.avatar || '', online, streak:u.streak || 0 };
}

app.get('/api/health', async (_req,res)=>res.json({ok:true, database:process.env.TURSO_DATABASE_URL?'turso':'local'}));

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
  res.json({uid:u.uid,username:u.username,displayName:u.display_name||u.username,bio:u.bio||'',avatar:u.avatar||'',streak:u.streak||0,friends:fr.rows.map(x=>publicUser(x,(sockets.get(x.uid)?.size||0)>0)),requests:incoming.rows.map(x=>publicUser(x))});
});

const upload=multer({storage:multer.diskStorage({destination:(_r,_f,cb)=>cb(null,UPLOADS),filename:(_r,file,cb)=>cb(null,id()+path.extname(file.originalname||'').toLowerCase().slice(0,10))}),limits:{fileSize:50*1024*1024}});

app.patch('/api/profile',auth,async(req,res)=>{
  const display=clean(req.body.displayName||'').slice(0,30),bio=String(req.body.bio||'').slice(0,160),avatar=String(req.body.avatar||'').slice(0,500);
  await db.execute({sql:'UPDATE users SET display_name=?, bio=?, avatar=? WHERE uid=?',args:[display||null,bio,avatar,req.uid]});
  res.json({ok:true});
});

// Profile-picture uploads are stored on the Render server and the resulting URL is saved in Turso.
app.post('/api/profile/avatar',auth,upload.single('file'),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({error:'No image selected'});
    const mime=req.file.mimetype||'';
    if(!mime.startsWith('image/')){
      fs.unlink(req.file.path,()=>{});
      return res.status(400).json({error:'Profile picture must be an image'});
    }

    // IMPORTANT: Render's local filesystem is not permanent.
    // Store the actual image in Turso so the profile picture survives
    // restarts, redeploys and moving between devices.
    const stat=fs.statSync(req.file.path);
    if(stat.size>3*1024*1024){
      fs.unlink(req.file.path,()=>{});
      return res.status(400).json({error:'Profile picture must be 3 MB or smaller'});
    }
    const base64=fs.readFileSync(req.file.path).toString('base64');
    const avatar=`data:${mime};base64,${base64}`;

    await db.execute({
      sql:'UPDATE users SET avatar=? WHERE uid=?',
      args:[avatar,req.uid]
    });

    fs.unlink(req.file.path,()=>{});
    res.json({ok:true,avatar});
  }catch(e){
    if(req.file)fs.unlink(req.file.path,()=>{});
    console.error('Profile picture upload failed:',e);
    res.status(500).json({error:'Profile picture upload failed'});
  }
});

app.get('/api/users/search',auth,async(req,res)=>{const q=clean(req.query.q).toLowerCase(); if(!q) return res.json([]); const r=await db.execute({sql:`SELECT * FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 20`,args:[`%${q}%`,`%${q}%`]});res.json(r.rows.filter(x=>x.uid!==req.uid).map(x=>publicUser(x,(sockets.get(x.uid)?.size||0)>0)));});

app.post('/api/friends/request',auth,async(req,res)=>{
  const username=clean(req.body.username).toLowerCase(); const r=await db.execute({sql:'SELECT * FROM users WHERE username=?',args:[username]}); const target=r.rows[0];
  if(!target)return res.status(404).json({error:'User not found'}); if(target.uid===req.uid)return res.status(400).json({error:"You can't add yourself"}); if(await blocked(req.uid,target.uid)||await blocked(target.uid,req.uid))return res.status(403).json({error:'Friend request unavailable'});
  const f=await db.execute({sql:'SELECT status FROM friendships WHERE user_id=? AND friend_id=?',args:[req.uid,target.uid]}); if(f.rows[0]?.status==='accepted')return res.json({ok:true,message:'Already friends'});
  await db.batch([
    {sql:`INSERT INTO friendships(user_id,friend_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO UPDATE SET status='pending'`,args:[req.uid,target.uid,'pending',now()]},
    {sql:`INSERT INTO friendships(user_id,friend_id,status,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,friend_id) DO NOTHING`,args:[target.uid,req.uid,'none',now()]}
  ]); broadcast(target.uid,{type:'friend_request',from:(await getUser(req.uid)).username});res.json({ok:true});
});

app.post('/api/friends/accept',auth,async(req,res)=>{const other=req.body.uid; if(!await getUser(other))return res.status(404).json({error:'User not found'}); await db.batch([{sql:`UPDATE friendships SET status='accepted' WHERE user_id=? AND friend_id=?`,args:[other,req.uid]},{sql:`UPDATE friendships SET status='accepted' WHERE user_id=? AND friend_id=?`,args:[req.uid,other]}]); pair(req.uid,other,{type:'friend_accepted'});res.json({ok:true});});
app.post('/api/friends/decline',auth,async(req,res)=>{await db.execute({sql:`UPDATE friendships SET status='declined' WHERE user_id=? AND friend_id=?`,args:[req.body.uid,req.uid]});res.json({ok:true});});
app.delete('/api/friends/:uid',auth,async(req,res)=>{await db.batch([{sql:'DELETE FROM friendships WHERE user_id=? AND friend_id=?',args:[req.uid,req.params.uid]},{sql:'DELETE FROM friendships WHERE user_id=? AND friend_id=?',args:[req.params.uid,req.uid]}]);res.json({ok:true});});
app.post('/api/block/:uid',auth,async(req,res)=>{await db.execute({sql:'INSERT OR IGNORE INTO blocks(uid,blocked_uid,created_at) VALUES(?,?,?)',args:[req.uid,req.params.uid,now()]});res.json({ok:true});});
app.delete('/api/block/:uid',auth,async(req,res)=>{await db.execute({sql:'DELETE FROM blocks WHERE uid=? AND blocked_uid=?',args:[req.uid,req.params.uid]});res.json({ok:true});});

function messageRow(x){return {id:x.id,from:x.sender_id,to:x.receiver_id,text:x.text||'',kind:x.kind,url:x.url||'',name:x.name||'',mime:x.mime||'',time:x.created_at,readAt:x.read_at,expiresAt:x.expires_at,replyTo:x.reply_to,edited:!!x.edited};}
app.get('/api/messages/:uid',auth,async(req,res)=>{if(!await areFriends(req.uid,req.params.uid))return res.status(403).json({error:'Not friends'});const r=await db.execute({sql:`SELECT * FROM messages WHERE chat_key=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at`,args:[chatKey(req.uid,req.params.uid),now()]});res.json(r.rows.map(messageRow));});
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
app.delete('/api/messages/:uid/:messageId',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM messages WHERE id=? AND sender_id=?',args:[req.params.messageId,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Message not found'});await db.execute({sql:'DELETE FROM messages WHERE id=?',args:[req.params.messageId]});pair(req.uid,r.rows[0].receiver_id,{type:'message_deleted',messageId:req.params.messageId});if(r.rows[0].url?.startsWith('/uploads/'))fs.unlink(path.join(UPLOADS,path.basename(r.rows[0].url)),()=>{});res.json({ok:true});});


app.post('/api/upload/:uid',auth,upload.single('file'),async(req,res)=>{const other=req.params.uid;if(!await areFriends(req.uid,other)){if(req.file)fs.unlink(req.file.path,()=>{});return res.status(403).json({error:'Not friends'});}if(!req.file)return res.status(400).json({error:'No file'});const mime=req.file.mimetype||'application/octet-stream';const kind=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'voice':'file';const m={id:id(),from:req.uid,to:other,text:'',kind,url:'/uploads/'+path.basename(req.file.path),name:String(req.file.originalname||'file').slice(0,120),mime,time:now(),readAt:null,expiresAt:null,replyTo:null,edited:false};await db.execute({sql:`INSERT INTO messages(id,chat_key,sender_id,receiver_id,text,kind,url,name,mime,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[m.id,chatKey(req.uid,other),req.uid,other,'',kind,m.url,m.name,mime,m.time]});broadcast(other,{type:'message',message:m});res.json(m);});

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
app.post('/api/stories',auth,upload.single('file'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'Story file required'});const mime=req.file.mimetype||'';const kind=mime.startsWith('video/')?'video':'image';const story={id:id(),uid:req.uid,url:'/uploads/'+path.basename(req.file.path),kind,caption:String(req.body.caption||'').slice(0,180),time:now(),expiresAt:now()+86400000};await db.execute({sql:'INSERT INTO stories(id,uid,media_url,kind,caption,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',args:[story.id,story.uid,story.url,story.kind,story.caption,story.time,story.expiresAt]});broadcast(req.uid,{type:'story_added',story});res.json(story);});
app.post('/api/stories/:id/view',auth,async(req,res)=>{await db.execute({sql:'INSERT OR REPLACE INTO story_views(story_id,uid,viewed_at) VALUES(?,?,?)',args:[req.params.id,req.uid,now()]});res.json({ok:true});});
app.delete('/api/stories/:id',auth,async(req,res)=>{const r=await db.execute({sql:'SELECT * FROM stories WHERE id=? AND uid=?',args:[req.params.id,req.uid]});if(!r.rows[0])return res.status(404).json({error:'Story not found'});await db.execute({sql:'DELETE FROM stories WHERE id=?',args:[req.params.id]});if(r.rows[0].media_url.startsWith('/uploads/'))fs.unlink(path.join(UPLOADS,path.basename(r.rows[0].media_url)),()=>{});res.json({ok:true});});

// Moderation: only the account named exactly @felixchat is an admin.
async function requireAdmin(req,res){
  const u=await getUser(req.uid);
  if(!u || u.username!=='felixchat'){res.status(403).json({error:'Admin access required'});return false;}
  return true;
}
app.get('/api/admin/status',auth,async(req,res)=>{const u=await getUser(req.uid);res.json({admin:u?.username==='felixchat'});});
app.get('/api/admin/users',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  const q=clean(req.query.q||'').toLowerCase();
  const r=await db.execute({sql:`SELECT uid,username,display_name,bio,avatar,banned,created_at,last_seen FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 100`,args:[`%${q}%`,`%${q}%`]});
  res.json(r.rows.map(u=>({uid:u.uid,username:u.username,displayName:u.display_name||u.username,bio:u.bio||'',avatar:u.avatar||'',banned:Number(u.banned||0)===1,createdAt:u.created_at,lastSeen:u.last_seen})));
});
app.post('/api/admin/ban/:uid',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  if(req.params.uid===req.uid)return res.status(400).json({error:'You cannot ban the admin account.'});
  const target=await getUser(req.params.uid);if(!target)return res.status(404).json({error:'User not found'});
  await db.batch([{sql:'UPDATE users SET banned=1,banned_at=?,banned_by=? WHERE uid=?',args:[now(),req.uid,req.params.uid]},{sql:'DELETE FROM sessions WHERE uid=?',args:[req.params.uid]}]);
  broadcast(req.params.uid,{type:'banned'});res.json({ok:true});
});
app.post('/api/admin/unban/:uid',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  if(!await getUser(req.params.uid))return res.status(404).json({error:'User not found'});
  await db.execute({sql:'UPDATE users SET banned=0,banned_at=NULL,banned_by=NULL WHERE uid=?',args:[req.params.uid]});res.json({ok:true});
});

app.post('/api/admin/command',auth,async(req,res)=>{
  if(!await requireAdmin(req,res))return;
  const command=String(req.body.command||'').trim().toLowerCase();
  const username=clean(req.body.username||'').toLowerCase();
  if(!['ban','unban'].includes(command))return res.status(400).json({error:'Use /ban username or /unban username'});
  if(!username)return res.status(400).json({error:'Enter a username'});
  const r=await db.execute({sql:'SELECT uid,username FROM users WHERE username=?',args:[username]});
  const target=r.rows[0];
  if(!target)return res.status(404).json({error:'User not found'});
  if(target.username==='felixchat')return res.status(400).json({error:'You cannot moderate the admin account.'});
  if(command==='ban'){
    await db.batch([{sql:'UPDATE users SET banned=1,banned_at=?,banned_by=? WHERE uid=?',args:[now(),req.uid,target.uid]},{sql:'DELETE FROM sessions WHERE uid=?',args:[target.uid]}]);
    broadcast(target.uid,{type:'banned'});
    return res.json({ok:true,action:'ban',username:target.username});
  }
  await db.execute({sql:'UPDATE users SET banned=0,banned_at=NULL,banned_by=NULL WHERE uid=?',args:[target.uid]});
  res.json({ok:true,action:'unban',username:target.username});
});

app.get('/api/notifications/unread',auth,async(req,res)=>{
  const r=await db.execute({sql:`SELECT m.id,m.sender_id,m.text,m.kind,m.created_at,u.username,u.display_name FROM messages m JOIN users u ON u.uid=m.sender_id WHERE m.receiver_id=? AND m.read_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.created_at DESC LIMIT 50`,args:[req.uid,now()]});
  res.json(r.rows.map(m=>({id:m.id,uid:m.sender_id,username:m.username,displayName:m.display_name||m.username,text:m.text||'',kind:m.kind,time:m.created_at})));
});

// Simple group-chat backend.
app.post('/api/groups',auth,async(req,res)=>{const name=String(req.body.name||'New Group').trim().slice(0,40);const gid=id();await db.batch([{sql:'INSERT INTO groups(gid,name,owner_id,created_at) VALUES(?,?,?,?)',args:[gid,name,req.uid,now()]},{sql:'INSERT INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[gid,req.uid,now()]}]);res.json({gid,name});});
app.get('/api/groups',auth,async(req,res)=>{const r=await db.execute({sql:`SELECT g.* FROM groups g JOIN group_members m ON m.gid=g.gid WHERE m.uid=? ORDER BY g.created_at DESC`,args:[req.uid]});res.json(r.rows);});
app.post('/api/groups/:gid/members',auth,async(req,res)=>{const other=req.body.uid;const member=await db.execute({sql:'SELECT 1 FROM group_members WHERE gid=? AND uid=?',args:[req.params.gid,req.uid]});if(!member.rows.length)return res.status(403).json({error:'Not a group member'});await db.execute({sql:'INSERT OR IGNORE INTO group_members(gid,uid,joined_at) VALUES(?,?,?)',args:[req.params.gid,other,now()]});res.json({ok:true});});

wss.on('connection',ws=>{let uid=null;ws.on('message',async raw=>{try{const m=JSON.parse(raw);if(m.type==='auth'){uid=await getUidFromToken(m.token);if(!uid)return ws.close(1008,'Unauthorized');if(!sockets.has(uid))sockets.set(uid,new Set());sockets.get(uid).add(ws);ws.send(JSON.stringify({type:'ready'}));}else if(uid&&m.type==='typing'&&m.to)broadcast(m.to,{type:'typing',uid,typing:!!m.typing});else if(uid&&['call_invite','call_accept','call_reject','call_signal','call_end'].includes(m.type)&&m.to)broadcast(m.to,{type:m.type,from:uid,payload:m.payload||null,callType:m.callType||'audio'});}catch{}});ws.on('close',()=>{if(!uid)return;const set=sockets.get(uid);if(!set)return;set.delete(ws);if(!set.size)sockets.delete(uid);});});

setInterval(async()=>{try{await db.execute({sql:'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?',args:[now()]});await db.execute({sql:'DELETE FROM stories WHERE expires_at<=?',args:[now()]});}catch(e){}},60000);

init().then(()=>server.listen(PORT,()=>console.log('Felix Chat running on '+PORT))).catch(e=>{console.error('DB init failed',e);process.exit(1);});
