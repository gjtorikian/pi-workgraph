## [0.3.1](https://github.com/gjtorikian/pi-workgraph/compare/v0.3.0...v0.3.1) (2026-09-02)

### Bug Fixes

* **subagents:** Probe pi's package store for the upstream version ([e942914](https://github.com/gjtorikian/pi-workgraph/commit/e9429140f77afb5a203115d23ad990612c0f68b8))


## [0.3.0](https://github.com/gjtorikian/pi-workgraph/compare/v0.2.1...v0.3.0) (2026-09-02)

### Features

* Add lease-convention git push guard ([5786cb1](https://github.com/gjtorikian/pi-workgraph/commit/5786cb1c95dadf27dc9eb5e35c2c64d47039ef0f))
* **subagents:** Bridge any installed version by default ([ea28d4f](https://github.com/gjtorikian/pi-workgraph/commit/ea28d4f1e0e5376fc17819fc1e9c607ffd325754))


## [0.2.1](https://github.com/gjtorikian/pi-workgraph/compare/v0.2.0...v0.2.1) (2026-09-02)

### Bug Fixes

* **coordinator:** reset phase before lease release ([7bab621](https://github.com/gjtorikian/pi-workgraph/commit/7bab6212b04dc0816ca000487a501aff81555846))
* **in-session:** wake via followUp — nextTurn never triggers a turn in promptless RPC sessions ([7e3dde9](https://github.com/gjtorikian/pi-workgraph/commit/7e3dde9ea8d9107f7397943583f3f81e488cf1ba))


## [0.2.0](https://github.com/gjtorikian/pi-workgraph/compare/v0.1.0...v0.2.0) (2026-08-18)

### Features

* **subagents:** Route profiles by workflow class ([a64778d](https://github.com/gjtorikian/pi-workgraph/commit/a64778d73d7e9a9529b64b3efe73eb7fe0a14f50))
* Add per-issue workflow classes ([dd8e246](https://github.com/gjtorikian/pi-workgraph/commit/dd8e246f27f468a04970b6b9e71d9eac4aee7cc8))

### Bug Fixes

* **policy:** Require independence on every axis ([21f3514](https://github.com/gjtorikian/pi-workgraph/commit/21f3514174661d3718790abb06a4b0d56bc0ef94))

### Miscellaneous Chores

* release on push instead of pull_request_target ([0a0a182](https://github.com/gjtorikian/pi-workgraph/commit/0a0a182f40090c83122b7a3ac1021b6f096cae19))


## [0.1.0](https://github.com/gjtorikian/pi-workgraph/compare/v0.0.1...v0.1.0) (2026-08-12)

### Features

* Add a planner tier ahead of implementation ([#1](https://github.com/gjtorikian/pi-workgraph/pull/1))

### Bug Fixes

* Drop null-valued headers before compaction ([#1](https://github.com/gjtorikian/pi-workgraph/pull/1))

### Miscellaneous Chores

* add release and publish workflow ([14b8cb9](https://github.com/gjtorikian/pi-workgraph/commit/14b8cb918b9246f36265ba8ca94e76c526018fe5))
* Gate shutdown assertion on the durable write ([#1](https://github.com/gjtorikian/pi-workgraph/pull/1))

