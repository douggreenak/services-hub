# Services Hub tests

End-to-end tests for the hub's single sign-on. They start a throwaway stack on test ports
(18090 hub, 18420 TV Manager, 18080 Jellyfin Fleet, 18097/18096 mock services), drive it with a real
headless Chromium, and clean everything up afterwards. Production ports and data are never touched.

```
node --test --test-reporter=spec tests/e2e.test.js
```

Needs: `docker` (images `jellyfin-management-server` and `jellyfin-admin` built), `python3` with the
`tv-adb-manager` checkout at `~/tv-adb-manager`, and `playwright-core` (set `PW_CORE` to its path;
default `~/pwtest/node_modules/playwright-core`). A full run takes about 3.5 minutes.

## What is covered (every combination of)

- **Host name:** `localhost` and `127.0.0.1` (cookies are per host, so both must work)
- **Service:** the real TV Manager (session cookie), the real Fleet (token handoff), a mock cookie service
- **Entry:** direct visit to the service, hub card "Open"
- **Hub state:** signed out, signed in
- **Saved login:** correct, wrong, none saved
- **Service state:** signed out, already signed in, stale/expired session
- **Sign out** from the service (also signs out of the hub), then coming back
- Redirect-loop guard, service down, plain service with no login
- **Hub itself:** first-run setup and password rules, API needs a session, lockout after 5 bad tries,
  `?next=` open-redirect protection, saved passwords encrypted at rest (0600, never returned by the API),
  logins that last forever (survive restarts; only sign-out ends them), the QR-code button, HTML escaping,
  sign-out, the Edit dialog

Test-only hooks in the services' `sso.js`: `window.__HUB_ORIGIN__` (hub URL) and
`window.__HUB_GUARD_MS__` (loop-guard window). Production uses the defaults.
