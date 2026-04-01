# EphemePlay

EphemePlay is the umbrella for ephemeral shared play spaces built on Epheme principles. The first game is **EphemeDeck**, a manual shared card table with no login and no game rules.

## Current status

This initial implementation includes:
- Room creation with invite token
- Room join validation
- Auto-expiring room lifecycle
- Realtime shared card state (drag, flip, shuffle, deal)
- Basic desktop/tablet-friendly UI

## Run locally

```powershell
cd ephemeplay
npm run install:all
npm run dev
```

Then open:
- http://localhost:8787

## V1 constraints

- No account system
- No chat
- No scoring or game rules
- No persistence beyond active room lifetime
