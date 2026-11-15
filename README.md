# SUNDER — a three.js tactical FPS

A round-based tactical shooter in the style Counter-Strike made famous, built for the
make.fun `threejs-fps-02` competition. Two teams, short rounds, money between rounds,
and gunfire where accuracy counts more than speed.

**STRIKE** (you + 3 bots) vs **AEGIS** (4 bots), first to 9 rounds, 100-second rounds
with a 12-second buy phase. Win by elimination — or plant the charge on site A or B:
3 seconds to plant, a 40-second fuse, 5 seconds to defuse. A kill pays $300, a round
$3,250, a detonation $3,500.

Weapons: P9 pistol, VK-9 SMG ($1,400), AR-7 rifle ($2,700), LONGSHOT DMR ($4,300,
right-click to scope), kevlar ($650) and flash grenades ($200). Spread blooms with
movement, jumping and sustained fire; standing still and crouching pay.

The map is original: a 64×48 m yard with a mid wall and centre gap, long north/south
corridors, two walled sites with door gaps, and crates for cover. Bots run a waypoint
graph with BFS pathing, engage only on real line-of-sight inside their field of view,
react in 300–520 ms, strafe in bursts, escort the carrier, hold posts, rotate on a
plant and defuse.

## Play

```sh
node serve.ts   # http://localhost:8080
```

WASD + mouse (pointer lock), click fire, R reload, Shift walk, Ctrl/C crouch, Space
jump, 1/2 weapons, E hold to plant, B buy menu, G flash, right-click scope.

## Layout

- `game/index.html` — HUD, menu, buy menu, end screen
- `game/src/world.js` — map, colliders, raycast, line-of-sight, waypoint graph + BFS
- `game/src/player.js` — movement, weapons, spread/recoil, viewmodel
- `game/src/bots.js` — bot figures and AI
- `game/src/main.js` — match state machine, economy, bomb logic, the shared hitscan
  resolver, synth SFX, deterministic `?shot=start|play|end&seed=N` render modes
- `main.ts` — entrypoint: copies `game/` + `screenshots/` to the output and writes
  `dossier.json` via the kit's vendored `vendor/makefun-threejs.ts`
- `screenshots/` — three real renders of the game (menu, live round, victory screen)

MIT licensed. Built for make.fun competition `threejs-fps-02`.
