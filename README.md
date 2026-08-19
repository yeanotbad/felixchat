# Felix Chat — upgraded realtime version

This version keeps the existing Felix Chat design and adds faster realtime messaging plus media features.

## Run
npm install
npm start

## Features added
- Instant WebSocket message delivery without reloading the whole conversation.
- Instant local message rendering after send.
- Multiple tabs/devices can stay connected to the same account.
- Message deletion with realtime deletion on both sides.
- Image sending.
- Video sending.
- Voice recording and voice-message sending.
- Media uploads up to 50 MB.
- Automatic WebSocket reconnect.

For Render, deploy the project as a Node service using `npm start`. The frontend is served from `public/index.html`.

Note: uploaded media is stored on the server filesystem. On hosts where the filesystem is ephemeral, use persistent storage or object storage for production media.
