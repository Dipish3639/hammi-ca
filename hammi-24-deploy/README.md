# Hammi 24 (race.hammi.ca)

A 24-hour endurance race that runs in real time. Every team has one car on track. Each car's AI
reads its team's strategy, makes its own calls, and says what it's thinking. No dependencies.
Needs Node 18 or newer.

## How a race works
- A race lasts 24 real hours. When it ends there is a 1-hour break, then the next race starts.
- During the break, signed-in players enter their team. Teams that are not entered sit that race out.
- The grid has 30 cars (Le Mans runs about 60 on a track twice as long). Empty places are filled
  with bot teams that roll a random, sensible strategy each race.
- Free to play. Velora sign-in only asks for the Profile permission, never Spend Credits.

## What the strategy controls
Driver swap interval, tyre wear before a stop, double stinting, dry compound, fuel reserve and
fuel load, aggression (day and night), rain call, defending in traffic, pitting under yellow,
final-hour push, and the AI's personality. Owners can change it any time, including mid-race,
and can call the car in with "Box this lap".

What the sim models: tyre compounds and wear, fuel burn and weight, driver tiredness (rises while
driving, faster at night and when pushing; recovers while resting), rain showers and a drying
track, a wet-tyre crossover, night, traffic and overtaking, spins, damage, crashes, full course
yellows, punctures, mechanical failures and repairs.

## The 3D view
The race is shown in 3D with three.js: sculpted Le Mans hypercars in each team's colours with
number boards, the circuit with kerbs, gravel traps, barriers, grandstand, pit building and woods,
a sky that follows the race clock (sunset, night with floodlights and headlights, sunrise), rain
with a shiny wet track, and TV, chase, onboard, helicopter and free cameras. Click a car to follow
it. Browsers without WebGL 2 get the flat track map instead.

`public/view3d.js` is built from `client3d/view3d.js`. Only rebuild it if you change the 3D code:

    npm install three@0.180.0 esbuild
    ./build.sh

The server doesn't need any of that; it just serves the built file.

## Commentary

Two commentators call the race: Mick calls the action, Sasha explains the strategy. `booth.js` writes
the lines from race control and the timing. `tts-worker.js` voices them with the Kokoro neural
text-to-speech model in a separate process, and every viewer who turns on COMMENTARY hears the same
clips (`/api/voice/:id`, the last 24 are kept in memory). Lines are only voiced while someone is
watching.

- Install the voices once: `npm install kokoro-js@1.2.1` in this folder. The model (about 90 MB)
  downloads from Hugging Face on the first start.
- `BOOTH_VOICES` picks the two Kokoro voices, Mick first (default `bm_george,af_heart`).
- `TTS=0` turns the neural voices off. Without them, browsers read the lines with their own voices.

## Run it (on ikelene)
    OWNER=Dipish ADMIN_KEY=pick-a-long-secret PORT=3200 node server.js

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3200 | Listens on 127.0.0.1 only. |
| `RACE_HOURS` | 24 | Race length. |
| `BREAK_MINUTES` | 60 | Sign-up break between races. The very first break starts when the server first runs. |
| `GRID` | 30 | Cars per race. |
| `OWNER` | none | Velora username that sees "Start the race now" during a break. |
| `ADMIN_KEY` | off | Turns on the admin commands below. |
| `DATA_DIR` | ./data | Teams, results and the running race. Saved every 30 s and on shutdown. Back it up. |
| `COOKIE_SECURE` | on | Set `0` only for local http testing. |
| `TIME_SCALE` | 1 | Testing only: 60 makes a minute pass every second. Leave at 1 live. |

If the server restarts mid-race, the race carries on from where it was saved.

Publish it through the **ikelene** Cloudflare tunnel: Networking -> Tunnels -> ikelene -> add a
public hostname `race.hammi.ca` -> `HTTP` `localhost:3200`. Live updates use Server-Sent Events
over the normal HTTPS connection.

## Admin
    # start the race now (during a break)
    curl -X POST https://race.hammi.ca/api/admin/start -H "x-admin-key: KEY" -H "Content-Type: application/json" -d '{}'
    # rename a team that picked a bad name
    curl -X POST https://race.hammi.ca/api/admin/rename -H "x-admin-key: KEY" -H "Content-Type: application/json" -d '{"id":"TEAM_ID","name":"New Name"}'
