## [0.4.0](https://github.com/gjtorikian/pi-workgraph/compare/v0.3.1...v0.4.0) (2026-09-15)

### Features

* **workflow:** Support human run supervision ([48bfbaf](https://github.com/gjtorikian/pi-workgraph/commit/48bfbaf924058474e45ab1447d2b503ed5ae0a16))
* Add caller-defined finalization stage ([d9bb5c0](https://github.com/gjtorikian/pi-workgraph/commit/d9bb5c07921904d618f7ad9f8863c20c6404b767))
* **policy:** Require only model independence by default ([955d015](https://github.com/gjtorikian/pi-workgraph/commit/955d0150597957aa6b0ad5f680c3f3c15b488e41))

### Bug Fixes

* **workflow:** Pause for human decisions ([1a72a67](https://github.com/gjtorikian/pi-workgraph/commit/1a72a6742a4c0055daf8a3fc45d97ba3cd399dd8))
* **workspace:** Allow worktrees from dirty sources ([1e2f3cd](https://github.com/gjtorikian/pi-workgraph/commit/1e2f3cd2b88e4eee35d9a716de3a79a7e1855477))
* **workflow:** Recover from failed worker steps ([64a8de0](https://github.com/gjtorikian/pi-workgraph/commit/64a8de0d15c693d6d4cc2e5aa812eeda17067512))
* **subagents:** Wait for the child and honor its exit status ([8b9d97d](https://github.com/gjtorikian/pi-workgraph/commit/8b9d97d3d1ece11528b20b18f63815a4fd4e6a51))


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

