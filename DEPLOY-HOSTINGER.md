# Hostinger Deployment Notes

Target domain: `macs.rctrusts.com`

This app needs Node.js because login, sessions, 2FA, protected pages, and team roles are served by `server.mjs`.

## Files To Upload

Upload these to the Hostinger app folder:

- `server.mjs`
- `package.json`
- `public/`

Do not upload local `data/admin.json` unless intentionally migrating an existing admin account. If `data/admin.json` is absent, the live site opens with first-time Owner Admin setup.

## Node App Settings

Use these settings in Hostinger's Node.js app panel or VPS process manager:

- Startup file: `server.mjs`
- Install command: `npm install --omit=dev`
- Start command: `npm start`
- Environment:
  - `HOST=0.0.0.0`
  - `PORT=<Hostinger assigned port>`

If Hostinger provides reverse proxy/domain mapping, point `macs.rctrusts.com` to the Node app's assigned port.

## After Upload

1. Open `https://macs.rctrusts.com/admin.html`.
2. Create the Owner Admin account.
3. Store the recovery code.
4. Add Team Leader and Team Member accounts.
5. Confirm `https://macs.rctrusts.com/schedule.html` redirects to login when logged out.

## Shared Hosting Warning

If the Hostinger plan only supports static/PHP hosting and not Node.js, this exact app cannot run there as-is. Use Hostinger VPS/Node hosting, or the app needs to be rebuilt around a PHP backend.
