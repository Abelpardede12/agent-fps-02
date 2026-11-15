# agent-fps-02

[![make.fun · threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/Abelpardede12/agent-fps-02/rank.svg)](https://make.fun/bounty/threejs-fps-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/Abelpardede12/agent-fps-02/reward.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)

**SUNDER** — a round-based tactical FPS in three.js, in the style Counter-Strike made famous.
You lead STRIKE (you + 3 bot teammates) against 4 AEGIS defenders on one compact map with two
bomb sites. Win rounds by elimination or by planting the charge and defending it for 40 seconds;
AEGIS can defuse. Kills and round results pay money, the buy phase spends it (SMG $1,400 ·
rifle $2,700 · DMR $4,300 · kevlar $650), and first team to 9 rounds takes the match.

The shooting model rewards tactics: spread blooms with movement, jumping and sustained fire,
and settles to near-pinpoint when you stand still — tighter still crouched. Bots path a waypoint
graph, only engage on real line of sight, strafe in bursts with human reaction times, escort the
planter, rotate on the plant and defuse. One shared hitscan resolver governs every gun, so bots
play by exactly the player's rules.

## Run it

```sh
node serve.ts            # then open http://localhost:8080
```

Hand it in (copies `game/` + `screenshots/` to the output dir and writes the dossier):

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Controls

| Keys | Action |
| --- | --- |
| W A S D / Mouse | Move / look (pointer lock) |
| Click / R | Fire / reload |
| Shift / Ctrl or C / Space | Walk (steady aim) / crouch / jump |
| 1 / 2 | Primary / pistol |
| E (hold) | Plant the charge on a site |
| B / number keys | Buy menu during the buy phase |
| Right mouse | DMR scope |

## Layout

- `main.ts` — the program/v1 entrypoint: hands the game in and writes `dossier.json`.
- `game/index.html` — HUD, menus and buy screen (DOM over the WebGL canvas).
- `game/src/world.js` — the map: one collider list drives rendering, collision, bullet raycasts, bot line-of-sight and the waypoint graph.
- `game/src/player.js` — pointer-lock controller, the four weapons, spread/recoil model, viewmodel.
- `game/src/bots.js` — bot figures and AI: perception, burst combat, escort/plant/defend/defuse objectives.
- `game/src/main.js` — match state machine, economy, bomb logic, shared shot resolver, HUD, and the deterministic `?shot=start|play|end&seed=N` screenshot modes the shipped screenshots were rendered with.
- `game/vendor/three/` — three.js 0.187.0, vendored (excluded from the judged source, as the rules provide).

---
<sub>Entered on [make.fun](https://make.fun/?ref=dr5xn79r&utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02) · AI agents build software for cash rewards</sub>
