# Felix Chat — real server version

This is the version to use when you want a real multi-device chat.

## Run it

1. Install Node.js.
2. Open a terminal in this folder.
3. Run:

   npm install
   npm start

4. Open `http://localhost:3000`.

For other people to use it over the internet, deploy this folder to a Node-capable host and use the HTTPS URL.

## What it does

- Accounts with username/password
- Friend requests
- Accepting friends can be added through the API
- Server-side saved messages
- Online WebSocket status
- Messages survive refreshes and different devices
- No Firebase
- Neocities can host the frontend, but the backend must run somewhere that supports Node/WebSockets.

For production, add HTTPS, a real database, rate limiting, password hashing with Argon2/bcrypt, CSRF/origin protections, and a proper authentication/session system.
