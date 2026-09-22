# Architecture evolution

| Phase | Prior limitation | Architectural change | Tests/evidence | Remaining limitation |
|---|---|---|---|---|
| Alien rebuild | mixed inherited shell and Mega ownership | official shell retained; Mega made optional | architecture verifier | single Windows/Electron lineage |
| Pluginization | feature code directly coupled to host | plugin manager, lockfile, host/client package | plugin manager and installed-bundle tests | no ecosystem-scale sample |
| Adapter framework | manager knew plugin formats | ordered detector/adapter registry | adapter unit suite | priorities are project-defined |
| Cordis/DSH bridge | foreign plugin expected host services | isolated host process and allow-listed HTTP/service bridge | real route request, teardown acceptance | browser half not served by bridge |
| Managed process | background programs lacked lifecycle contract | JSONL protocol, handshake, health, bounded restart | process adapter acceptance | watched application is a stand-in |
| Native HNS | shipped plugins used special paths | native manifest and common manager lifecycle | native adapter tests | only repository-native samples |
| Health Scheduler | telemetry and restart could share authority | scheduler emits decisions; `restart-control` remains external | authority tests | policy not validated on field traces |
| Restart companion | main process could not recover itself | out-of-process supervisor with budget and safe mode | chaos/recovery experiments | real OS reboot is `NOT_RUN` |
| One install pipeline | repository, native, and process installs diverged | detect → plan → risk → confirm → install → lifecycle | 39-check install acceptance | network registries remain external dependencies |
| Long-host continuity | restart could lose/duplicate task state | durable checkpoint, exactly-once resume validation, work admission | continuity and false-success cases | no real 24h wall clock |
| Runtime/UI separation | Electron owned long-lived runtime state | named-pipe Runtime Host; desktop is client; per-instance identity | lifecycle and collision tests | Windows-specific transport evidence |
| Direct official page | sibling views could obstruct official UI | official renderer moved to BrowserWindow page; wallpaper isolated and click-through | real input/UI acceptance | no accessibility certification |
| Qualification | artifacts from different runs could conflict | one run ID/SHA/tree, raw streams, child reports, consistency audit | evidence-consistency tests | external fixture availability can block a run |

The evolution is not monotonic feature growth. Several changes removed earlier surfaces or claims: the Daily frontend, themed dock, legacy official overlay, and uncontrolled restart authority were deliberately narrowed.
