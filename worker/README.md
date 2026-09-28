# RadioFlow API (Cloudflare Worker)

This small Worker lets RadioFlow search **100,000+ radio stations worldwide**
(the OnlineRadioBox catalogue) and fetch what any of them played in the last
24 hours. Browsers can't read OnlineRadioBox directly, so the Worker sits in
between and caches everything at Cloudflare's edge.

Free plan: 100,000 requests per day, which is far more than RadioFlow needs.

## Deploy (about 5 minutes, no command line)

1. Go to <https://dash.cloudflare.com> and create a free account (or log in).
2. In the left menu, open **Compute (Workers)** → **Workers & Pages** → **Create** → **Create Worker**.
3. Name it `radioflow-api` and click **Deploy** (it deploys a "Hello World" first).
4. Click **Edit code**, select everything in the editor, delete it, and paste
   the full contents of `radioflow-api.js` from this folder.
5. Click **Deploy** (top right).
6. Copy the Worker's URL, for example `https://radioflow-api.yourname.workers.dev`.
7. Test it: open `https://radioflow-api.yourname.workers.dev/search?q=jazz`
   in your browser. You should see a list of stations.
8. In the RadioFlow repo, open `src/config.js` and paste the URL:
   ```js
   export const API_BASE = 'https://radioflow-api.yourname.workers.dev';
   ```
9. Commit and push. After the GitHub Pages deploy, the settings panel
   (the sliders icon, top right) lets you search and add stations.

## Endpoints

| Path | Returns |
| --- | --- |
| `/search?q=jazz` | Up to 30 stations: `id`, `name`, `country`, `city`, `genres`, `logo` |
| `/playlist?id=nl/kink` | Up to 80 `{ artist, title }` from today and yesterday |
| `/health` | `{ ok: true }` |

## If search or playlists come back empty

OnlineRadioBox may have changed its page layout. Open
`/playlist?id=de/fluxfm1006` and `/search?q=jazz` in your browser and share
what you see; the two parse functions (`parseSearch`, `parsePlaylist`) are the
only parts that depend on their HTML.
