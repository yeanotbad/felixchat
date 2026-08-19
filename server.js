const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data.json");
const UPLOADS = path.join(__dirname, "public", "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

let db = { users: {}, messages: {} };
try { if (fs.existsSync(DATA)) db = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}

const save = () => fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
const id = () => crypto.randomBytes(16).toString("hex");
const clean = s => String(s || "").trim().slice(0, 32);
const hash = (password, salt) => crypto.createHash("sha256").update(salt + ":" + password).digest("hex");

// One user can have several tabs/devices connected at once.
const sockets = new Map();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const uid = Object.keys(db.users).find(id => db.users[id].token === token);
  if (!uid) return res.status(401).json({ error: "Not logged in" });
  req.uid = uid;
  next();
}

function areFriends(a, b) {
  return !!db.users[a] && !!db.users[b] && db.users[a].friends.includes(b);
}

function chatKey(a, b) {
  return [a, b].sort().join(":");
}

function broadcast(uid, message) {
  const set = sockets.get(uid);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastPair(a, b, message) {
  broadcast(a, message);
  broadcast(b, message);
}

app.post("/api/register", (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "Username must be 3-20 letters, numbers or _" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (Object.values(db.users).some(user => user.username === username))
    return res.status(409).json({ error: "Username already exists" });

  const uid = id(), salt = id(), token = id();
  db.users[uid] = { username, hash: hash(password, salt), salt, token, friends: [], incoming: [] };
  save();
  res.json({ token, username });
});

app.post("/api/login", (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || "");
  const entry = Object.entries(db.users).find(([_, user]) => user.username === username);
  if (!entry || entry[1].hash !== hash(password, entry[1].salt))
    return res.status(401).json({ error: "Wrong username or password" });

  entry[1].token = id();
  save();
  res.json({ token: entry[1].token, username });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.users[req.uid];
  res.json({
    uid: req.uid,
    username: user.username,
    friends: user.friends.map(friendId => ({
      uid: friendId,
      username: db.users[friendId]?.username || "Unknown",
      online: sockets.has(friendId) && sockets.get(friendId).size > 0
    })),
    requests: (user.incoming || [])
      .map(x => ({ uid: x, username: db.users[x]?.username }))
      .filter(x => x.username)
  });
});

app.post("/api/friends/request", auth, (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const entry = Object.entries(db.users).find(([_, user]) => user.username === username);
  if (!entry) return res.status(404).json({ error: "User not found" });

  const [targetId, target] = entry;
  const user = db.users[req.uid];
  if (targetId === req.uid) return res.status(400).json({ error: "You can't add yourself" });
  if (user.friends.includes(targetId)) return res.json({ ok: true, message: "Already friends" });

  target.incoming = target.incoming || [];
  if (!target.incoming.includes(req.uid)) target.incoming.push(req.uid);
  save();
  broadcast(targetId, { type: "friend_request", from: user.username });
  res.json({ ok: true });
});

app.get("/api/friends/requests", auth, (req, res) => {
  const user = db.users[req.uid];
  res.json((user.incoming || []).map(x => ({ uid: x, username: db.users[x]?.username })).filter(x => x.username));
});

app.post("/api/friends/accept", auth, (req, res) => {
  const otherId = req.body.uid;
  const user = db.users[req.uid], other = db.users[otherId];
  if (!other) return res.status(404).json({ error: "User not found" });

  user.incoming = (user.incoming || []).filter(id => id !== otherId);
  if (!user.friends.includes(otherId)) user.friends.push(otherId);
  if (!other.friends.includes(req.uid)) other.friends.push(req.uid);
  save();
  broadcastPair(req.uid, otherId, { type: "friend_accepted", username: user.username });
  res.json({ ok: true });
});

app.post("/api/friends/decline", auth, (req, res) => {
  const user = db.users[req.uid];
  user.incoming = (user.incoming || []).filter(id => id !== req.body.uid);
  save();
  res.json({ ok: true });
});

app.get("/api/messages/:uid", auth, (req, res) => {
  const otherId = req.params.uid;
  if (!areFriends(req.uid, otherId)) return res.status(403).json({ error: "Not friends" });
  res.json(db.messages[chatKey(req.uid, otherId)] || []);
});

app.post("/api/messages/:uid", auth, (req, res) => {
  const otherId = req.params.uid;
  if (!areFriends(req.uid, otherId)) return res.status(403).json({ error: "Not friends" });

  const text = String(req.body.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "Empty message" });

  const key = chatKey(req.uid, otherId);
  const message = { id: id(), from: req.uid, text, time: Date.now(), kind: "text" };
  db.messages[key] = db.messages[key] || [];
  db.messages[key].push(message);
  db.messages[key] = db.messages[key].slice(-1000);
  save();

  // Push the exact new message. The client does NOT need to download the
  // entire conversation again, which fixes the slow/delayed feeling.
  broadcast(otherId, { type: "message", message });
  res.json(message);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().slice(0, 10);
      cb(null, id() + ext);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post("/api/upload/:uid", auth, upload.single("file"), (req, res) => {
  const otherId = req.params.uid;
  if (!areFriends(req.uid, otherId)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: "Not friends" });
  }
  if (!req.file) return res.status(400).json({ error: "No file" });

  const mime = req.file.mimetype || "application/octet-stream";
  let kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "voice" : "file";
  const url = "/uploads/" + path.basename(req.file.path);
  const key = chatKey(req.uid, otherId);
  const message = {
    id: id(), from: req.uid, time: Date.now(), kind, url,
    name: String(req.file.originalname || "file").slice(0, 120),
    mime
  };

  db.messages[key] = db.messages[key] || [];
  db.messages[key].push(message);
  db.messages[key] = db.messages[key].slice(-1000);
  save();
  broadcast(otherId, { type: "message", message });
  res.json(message);
});

app.delete("/api/messages/:uid/:messageId", auth, (req, res) => {
  const otherId = req.params.uid;
  if (!areFriends(req.uid, otherId)) return res.status(403).json({ error: "Not friends" });

  const key = chatKey(req.uid, otherId);
  const list = db.messages[key] || [];
  const index = list.findIndex(m => m.id === req.params.messageId);
  if (index < 0) return res.status(404).json({ error: "Message not found" });

  const message = list[index];
  if (message.from !== req.uid) return res.status(403).json({ error: "You can only delete your own messages" });

  list.splice(index, 1);
  db.messages[key] = list;
  save();

  // Tell both sides to remove the exact bubble immediately.
  broadcastPair(req.uid, otherId, { type: "message_deleted", messageId: message.id });
  if (message.url && message.url.startsWith("/uploads/")) {
    const filePath = path.join(UPLOADS, path.basename(message.url));
    fs.unlink(filePath, () => {});
  }
  res.json({ ok: true, messageId: message.id });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", ws => {
  let uid = null;

  ws.on("message", raw => {
    try {
      const message = JSON.parse(raw);
      if (message.type !== "auth") return;

      uid = Object.keys(db.users).find(id => db.users[id].token === message.token);
      if (!uid) {
        ws.close(1008, "Unauthorized");
        return;
      }

      if (!sockets.has(uid)) sockets.set(uid, new Set());
      sockets.get(uid).add(ws);
      ws.send(JSON.stringify({ type: "ready" }));
    } catch {}
  });

  ws.on("close", () => {
    if (!uid) return;
    const set = sockets.get(uid);
    if (!set) return;
    set.delete(ws);
    if (!set.size) sockets.delete(uid);
  });
});

server.listen(PORT, () => console.log("Felix Chat running on " + PORT));
