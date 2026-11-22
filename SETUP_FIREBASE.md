# Free online multiplayer with Firebase (Spark plan, no credit card)

1. Go to https://console.firebase.google.com -> **Add project** (any name; turn Analytics off).
2. **Build -> Realtime Database -> Create Database** (pick the closest region, start in *locked mode*).
3. **Rules** tab -> paste this and **Publish**:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": true,
        ".validate": "$code.matches(/^[A-Z0-9]{3,8}$/)",
        "msgs": { "$id": { "p": { ".validate": "newData.isString() && newData.val().length < 60000" } } }
      }
    }
  }
}
```
   (Anyone who knows a room code can read/write that room only. Fine for a friendly game.)
4. **Project settings (gear) -> General -> Your apps -> Web (`</>`)** -> register an app -> copy the `firebaseConfig`
   values into `firebase-config.js`. Make sure `databaseURL` is filled in
   (Realtime Database page shows it, e.g. `https://xxxx-default-rtdb.firebaseio.com`).
5. Upload the whole folder to GitHub Pages / Cloudflare Pages / Netlify.
6. Both players open the same site -> **Online Room Code** -> one creates a room, the other joins with the code.

If `databaseURL` is empty the game falls back to the PeerJS version automatically.

Free-plan limits (Spark): 100 simultaneous connections (about 50 matches at once), 1 GB stored, 10 GB/month download.
A match uses a few KB, so this is plenty for friends.

## Match resume (Firebase mode)
- The host's browser saves the match to `rooms/CODE/state` after every turn and shield use.
- **Guest refreshes / loses connection:** re-open the site, choose *Online Room Code*, enter the same code, click *Join*.
  The host automatically re-sends the full match and the guest lands back in the arena (even if they had already locked a move).
- **Host refreshes / crashes:** re-open the site **in the same browser**, enter the same code, click *Create Room*,
  and choose OK on the "saved match found" prompt.
- Resume is tied to the browser that created the room (stored id in localStorage), so other people can't hijack it.
- Saved matches expire after 24 hours and are deleted when the match ends.
- Note: the move log (history panel) restarts empty after a resume; HP, shields, used cards, tier and the 5-round stat rule are all restored.

## Tests
`node combatTests.js && node matchTests.js && node roomFirebaseTests.js && node resumeTests.js`
