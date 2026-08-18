const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data.json");

let db = { users: {}, messages: {} };

try {
  if (fs.existsSync(DATA)) {
    db = JSON.parse(fs.readFileSync(DATA, "utf8"));
  }
} catch {}

const save = () =>
  fs.writeFileSync(DATA, JSON.stringify(db, null, 2));

const id = () =>
  crypto.randomBytes(16).toString("hex");

const clean = s =>
  String(s || "").trim().slice(0, 32);

const hash = (password, salt) =>
  crypto
    .createHash("sha256")
    .update(salt + ":" + password)
    .digest("hex");

const sockets = new Map();

const app = express();

app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");

  const uid = Object.keys(db.users).find(
    id => db.users[id].token === token
  );

  if (!uid) {
    return res.status(401).json({
      error: "Not logged in"
    });
  }

  req.uid = uid;
  next();
}

/* CREATE ACCOUNT */

app.post("/api/register", (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || "");

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({
      error: "Username must be 3-20 letters, numbers or _"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "Password must be at least 6 characters"
    });
  }

  if (
    Object.values(db.users).some(
      user => user.username === username
    )
  ) {
    return res.status(409).json({
      error: "Username already exists"
    });
  }

  const uid = id();
  const salt = id();
  const token = id();

  db.users[uid] = {
    username,
    hash: hash(password, salt),
    salt,
    token,
    friends: [],
    incoming: []
  };

  save();

  res.json({
    token,
    username
  });
});

/* LOGIN */

app.post("/api/login", (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = String(req.body.password || "");

  const entry = Object.entries(db.users).find(
    ([_, user]) => user.username === username
  );

  if (
    !entry ||
    entry[1].hash !== hash(password, entry[1].salt)
  ) {
    return res.status(401).json({
      error: "Wrong username or password"
    });
  }

  entry[1].token = id();

  save();

  res.json({
    token: entry[1].token,
    username
  });
});

/* USER INFO + FRIEND REQUESTS */

app.get("/api/me", auth, (req, res) => {
  const user = db.users[req.uid];

  res.json({
    uid: req.uid,
    username: user.username,

    friends: user.friends.map(friendId => ({
      uid: friendId,
      username: db.users[friendId]?.username || "Unknown",
      online: sockets.has(friendId)
    })),

    requests: (user.incoming || [])
      .map(id => ({
        uid: id,
        username: db.users[id]?.username
      }))
      .filter(x => x.username)
  });
});

/* SEND FRIEND REQUEST */

app.post("/api/friends/request", auth, (req, res) => {
  const username =
    clean(req.body.username).toLowerCase();

  const entry = Object.entries(db.users).find(
    ([_, user]) => user.username === username
  );

  if (!entry) {
    return res.status(404).json({
      error: "User not found"
    });
  }

  const [targetId, target] = entry;
  const user = db.users[req.uid];

  if (targetId === req.uid) {
    return res.status(400).json({
      error: "You can't add yourself"
    });
  }

  if (user.friends.includes(targetId)) {
    return res.json({
      ok: true,
      message: "Already friends"
    });
  }

  target.incoming = target.incoming || [];

  if (!target.incoming.includes(req.uid)) {
    target.incoming.push(req.uid);
  }

  save();

  push(targetId, {
    type: "friend_request",
    from: user.username
  });

  res.json({
    ok: true
  });
});

/* ACCEPT FRIEND REQUEST */

app.post("/api/friends/accept", auth, (req, res) => {
  const otherId = req.body.uid;

  const user = db.users[req.uid];
  const other = db.users[otherId];

  if (!other) {
    return res.status(404).json({
      error: "User not found"
    });
  }

  user.incoming =
    (user.incoming || []).filter(
      id => id !== otherId
    );

  if (!user.friends.includes(otherId)) {
    user.friends.push(otherId);
  }

  if (!other.friends.includes(req.uid)) {
    other.friends.push(req.uid);
  }

  save();

  push(otherId, {
    type: "friend_accepted",
    username: user.username
  });

  res.json({
    ok: true
  });
});

/* DECLINE FRIEND REQUEST */

app.post("/api/friends/decline", auth, (req, res) => {
  const user = db.users[req.uid];

  user.incoming =
    (user.incoming || []).filter(
      id => id !== req.body.uid
    );

  save();

  res.json({
    ok: true
  });
});

/* GET MESSAGES */

app.get("/api/messages/:uid", auth, (req, res) => {
  const otherId = req.params.uid;

  if (
    !db.users[otherId] ||
    !db.users[req.uid].friends.includes(otherId)
  ) {
    return res.status(403).json({
      error: "Not friends"
    });
  }

  const key = [req.uid, otherId]
    .sort()
    .join(":");

  res.json(db.messages[key] || []);
});

/* SEND MESSAGE */

app.post("/api/messages/:uid", auth, (req, res) => {
  const otherId = req.params.uid;
  const user = db.users[req.uid];

  if (!user.friends.includes(otherId)) {
    return res.status(403).json({
      error: "Not friends"
    });
  }

  const text =
    String(req.body.text || "")
      .trim()
      .slice(0, 4000);

  if (!text) {
    return res.status(400).json({
      error: "Empty message"
    });
  }

  const key = [req.uid, otherId]
    .sort()
    .join(":");

  const message = {
    id: id(),
    from: req.uid,
    text,
    time: Date.now()
  };

  db.messages[key] =
    db.messages[key] || [];

  db.messages[key].push(message);

  db.messages[key] =
    db.messages[key].slice(-1000);

  save();

  push(otherId, {
    type: "message",
    message
  });

  res.json(message);
});

/* WEBSOCKET */

const server = http.createServer(app);

const wss =
  new WebSocket.Server({
    server,
    path: "/ws"
  });

wss.on("connection", ws => {

  let uid = null;

  ws.on("message", raw => {

    try {

      const message =
        JSON.parse(raw);

      if (message.type === "auth") {

        uid = Object.keys(db.users).find(
          id =>
            db.users[id].token ===
            message.token
        );

        if (uid) {

          sockets.set(uid, ws);

          ws.send(
            JSON.stringify({
              type: "ready"
            })
          );
        }
      }

    } catch {}
  });

  ws.on("close", () => {

    if (
      uid &&
      sockets.get(uid) === ws
    ) {
      sockets.delete(uid);
    }

  });

});

/* SEND REAL-TIME EVENT */

function push(uid, message) {

  const ws = sockets.get(uid);

  if (
    ws &&
    ws.readyState === 1
  ) {
    ws.send(
      JSON.stringify(message)
    );
  }

}

server.listen(PORT, () => {
  console.log(
    "Felix Chat running on " + PORT
  );
});
