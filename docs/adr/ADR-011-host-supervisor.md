# ADR-011: A host supervisor for detached sessions on any OS

Date: 2026-10-29.

## Context

Detached work runs as sessions that outlive the session that starts them: Level B workers, the program coordinator, the e2e author and the daemon. Until now each one went through `systemd-run --user`, so this work ran only on Linux with a systemd user session. Monty wants cstack to support any host, including the Codex desktop app on macOS and Windows.

## Decision

All detached sessions go through one layer, `gates/lib/supervisor.mjs`. Skills use its CLI, `gates/supervise.mjs`, with these commands: `backend`, `status`, `start`, `wait`, `stop`, `daemon-file` and `daemon-run`.

| Backend | Picked when | Start | Liveness and stop | Daemon |
|---|---|---|---|---|
| `systemd` | Linux, when `systemctl --user show-environment` works | `systemd-run --user`, unchanged; `worker.mjs exit` runs as `ExecStopPost` | `systemctl --user is-active` / `stop` | the user unit `cstack-daemon@.service` |
| `launchd` | macOS | a plist next to the spec, loaded with `launchctl bootstrap gui/<uid>` | runner pid / `launchctl bootout` | `daemon-file` writes a LaunchAgent with `KeepAlive` and `ThrottleInterval` 600 for the human to install |
| `taskscheduler` | Windows | a one-shot task `cstack\<name>` that runs a `.cmd` wrapper | runner pid / `schtasks /End`, then `taskkill /T` | `daemon-file` prints a `schtasks /Create /SC MINUTE /MO 10` task for the human to install |
| `detached` | any other host, or by choice | a detached child process | runner pid / SIGTERM | not available: it cannot survive a reboot |

The choice order is `CSTACK_SUPERVISOR`, then config `host.supervisor`, then the platform.

- **The runner.** Every backend but systemd starts `gates/runner.mjs <spec.json>`, not the harness CLI directly. The runner:
  - starts the command;
  - appends its output to the spec's files (`workers/<unit>.jsonl` and `.stderr.log` for workers);
  - forwards SIGTERM, SIGINT and SIGHUP;
  - records itself in the session registry, `~/.local/state/cstack/sessions/<name>.json`;
  - runs the spec's `onExit` command when the command ends, with systemd's exit variables (`SERVICE_RESULT`, `EXIT_CODE`, `EXIT_STATUS`). For workers that command is `worker.mjs exit`, so `exit` classifies runs the same way under every backend.
- **Liveness.** `sessionState(name)` reads the registry: an exit record, then the runner's pid, and a 60 s grace period while a start is pending. A name with no entry falls back to `systemctl --user is-active`, so existing systemd sessions read as before. A failed start is recorded as exited, so it never blocks a relaunch.
- **Windows commands.** `claude` and `codex` are `.cmd` shims there. The runner finds them through `PATH` and `PATHEXT`, and wraps them in `cmd.exe /d /s /c` with every argument quoted.
- **Permissions.** The plugin-script rule already allows `node <plugin>/gates/supervise.mjs`. Every role but coordinator now also denies its `start`, `stop` and `daemon-run` commands, next to the existing `systemd-run` deny.
- **Daemon installs are the human's step.** `daemon-file` writes the service file under `<repo>/.cstack/daemon/` and prints the install command. cstack never puts a file in `~/Library/LaunchAgents` or registers a logon task itself.

## Consequences

- The systemd path is unchanged, so the Linux scenarios and fixtures keep working. The other backends are covered by unit tests with fake `launchctl`, `schtasks` and `taskkill`, and the detached backend was run live on Linux, with a real worker. They have not run on a real Mac or Windows machine yet; that is the any-host live check in phase C6.
- A LaunchAgent runs only while the user is logged in. A LaunchDaemon would need root, which cstack does not use.
- A Task Scheduler task runs for a logged-out user only with a stored password, which the user sets up themselves. A Windows task may also flash a console window.
- If the runner itself is killed outright, nothing runs `onExit`. Liveness then reads the dead pid as `failed`, and the orphan path in `cstack:resume-run` settles the unit. The command it started may keep running until it ends.
- The e2e author's launch script is POSIX `sh`. It runs on Linux and macOS. On Windows without Git Bash, `cstack:e2e-plan` uses its in-session fallback.
- doctor does not check `host.supervisor` yet. It lands with the doctor port to Node. Until then, use `CSTACK_SUPERVISOR` to choose a backend.
