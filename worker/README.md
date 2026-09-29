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

## Add the song catalogue (strongly recommended, 3 minutes)

Without it every visitor looks up every song again, which runs into
Apple's and Deezer's limits as soon as the site gets busy. With it, each
song is looked up once and then shared with everyone.

1. In the Cloudflare dashboard, open **Storage & databases** → **D1 SQL database** → **Create**.
2. Name it `radioflow` and click **Create**. You don't need to add any tables:
   the Worker creates them itself.
3. Open your Worker **radioflow-api** → **Bindings** (or **Settings** → **Bindings**) → **Add binding** → **D1 database**.
4. Variable name: `DB` (capitals, exactly). Database: `radioflow`. Click **Add Binding** / **Deploy**.
5. Check it: open `https://radioflow-api.yourname.workers.dev/stats`.
   You should see `"catalogue": true`. As people listen, the song counts grow.

Free plan: 5 million reads and 100,000 writes per day.

## Endpoints

| Path | Returns |
| --- | --- |
| `/search?q=jazz` | Up to 30 stations: `id`, `name`, `country`, `city`, `genres`, `logo` |
| `/playlist?id=nl/kink` | Up to 80 `{ artist, title }` from today and yesterday |
| `/songs?k=key&k=key` | Catalogue entries (preview, cover, source) for up to 25 song keys |
| `POST /songs` | A browser reports a found / missing song (validated) |
| `/lookup?artist=…&title=…` | Server-side lookup (last resort), stored in the catalogue |
| `/stats` | Songs in the catalogue, by status and source |
| `/health` | `{ ok: true }` |

## If search or playlists come back empty

OnlineRadioBox may have changed its page layout. Open
`/playlist?id=de/fluxfm1006` and `/search?q=jazz` in your browser and share
what you see; the two parse functions (`parseSearch`, `parsePlaylist`) are the
only parts that depend on their HTML.
