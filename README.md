# Felix Chat — Turso + Render upgrade

This upgrade keeps the existing Felix Chat UI/features and adds a persistent Turso database plus Snapchat-style social features.

## Existing features kept
- Accounts/login
- Friend requests
- 1-to-1 realtime messaging
- Image/video sending
- Voice messages
- Message deletion
- WebSocket reconnect
- 50 MB media uploads

## Added
- Turso/libSQL persistence for accounts, sessions, friends, messages and social data
- Persistent login sessions
- Profile display name, bio and avatar URL
- User search
- Block/unblock
- Read receipts
- Message editing
- Message reactions
- Reply metadata
- Disappearing messages (24h)
- Typing indicators
- 24-hour Stories with views
- Story uploads and deletion
- Basic group-chat database/API foundation
- Online presence based on WebSocket connections

## Run locally
```bash
npm install
npm start
```

Without Turso environment variables, the app uses a local SQLite file through libSQL.

## Turso + Render
Create a Turso database and add these Render environment variables:

- `TURSO_DATABASE_URL` = your Turso database URL, normally `libsql://...`
- `TURSO_AUTH_TOKEN` = your Turso auth token

Then deploy as a Render Node web service. Build command: `npm install`. Start command: `npm start`.

### Important media note
Turso stores the database records, not large uploaded video/image files in this version. Render's local filesystem can be ephemeral, so for production-grade Snapchat-style media persistence you should add object storage (for example Cloudflare R2/S3-compatible storage) next. The database-backed messages and account data will remain in Turso.

## Security note
For a public production deployment, replace the simple SHA-256 password hashing with a password KDF such as scrypt/Argon2, add rate limiting, CSRF/origin protections, secure cookie sessions, upload MIME/content validation, and moderation/reporting tools.

## Mobile UI
The interface is responsive and uses the full phone screen on mobile devices. Desktop remains the normal chat layout; no phone-frame effect is used.
