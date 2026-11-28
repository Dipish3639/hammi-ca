# Hammi guest book (API)

The page is static, at https://hammi.ca/guestbook/ (in the hammi-ca repo). This server stores the
notes and answers the page from **https://guestbook.hammi.ca**. No dependencies; Node 18 or newer.

## Run it on ikelene
    cd /root/guestbook
    PORT=3200 ADMIN_KEY=pick-a-long-secret pm2 start server.js --name guestbook
    pm2 save

Cloudflare: Networking > Tunnels > ikelene > Routes > Add route > Published application:
`guestbook.hammi.ca` -> `http://localhost:3200`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3200 | Listens on 127.0.0.1 only. |
| `DATA_DIR` | ./data | Notes are saved in `guestbook.json` here. Back it up. |
| `PAGE_URL` | https://hammi.ca/guestbook/ | The page. Its origin is the only one allowed to post, and Nookara returns there after sign-in. |
| `EXTRA_ORIGINS` | none | More page origins allowed to call the API, comma separated. |
| `OWNER` | Dipish | Nookara user who can reply to, hide, approve and delete notes from the page. |
| `NOOKARA_APP_ID` | off | Turns on "Sign in with Nookara". The app's authorized URLs must include https://hammi.ca. |
| `HOLD` | off | `all` keeps every anonymous note hidden until the owner approves it on the page. |
| `ADMIN_KEY` | off | Turns on the curl commands below. |
| `COOKIE_SECURE` | on | `0` only for local http tests. |

## Spam protection
- Posts must come from the page's origin (scripts without a browser Origin header are refused).
- A hidden honeypot field, and a form token that must be at least 3 seconds old.
- Per address: 1 note a minute, 5 an hour, 10 a day. Everyone together: 60 an hour.
- No links in anonymous notes. Exact repeats of a recent note are refused.
- Plain text only; control and bidi characters are removed. The page never renders HTML from notes.
- Blocked words list (owner or admin key, see below).

## Moderation
Sign in on the page with Nookara as the OWNER and every note gets reply / hide / delete keys
(and approve, with HOLD=all). Or with the admin key:

    K='x-admin-key: YOUR_KEY'; J='Content-Type: application/json'; U=http://127.0.0.1:3200
    curl -s -H "$K" $U/api/admin/list                                   # last 200, hidden ones too
    curl -s -H "$K" -H "$J" $U/api/admin/reply  -d '{"id":12,"text":"thanks!"}'
    curl -s -H "$K" -H "$J" $U/api/admin/hide   -d '{"id":12}'          # {"id":12,"hidden":false} shows it again
    curl -s -H "$K" -H "$J" $U/api/admin/delete -d '{"id":12}'
    curl -s -H "$K" -H "$J" $U/api/admin/block  -d '{"word":"casino"}'  # {"word":"casino","remove":true} unblocks
