# FQ-SERVICE-ACTION-001: real UI refusal exposed broken boundary contracts

Immutable candidate491c4fd32b2e03f1eecc3b4b46a065c5ede45819 was launched
normally from a fresh Standard install in D:/Hns-Cleanroom-Qualification-16.
Actual Settings > Mega > Health Scheduler > enable left the service disabled;
the visible feedback said only `操作被拒绝 · refused`. Original screenshot:
D:/Hns-Cleanroom-Qualification-16/visual-journey-491c4fd/16-health-enable-refused.png.

Root causes and surgical repairs:

- Desktop passed positional arguments to object-input host methods for
  enable/disable, health and reload. This lost the plugin id or checked all
  plugins instead of the named plugin. Pass the host's documented object.
- Advanced writes and restart-control resolution referenced undefined host().
  Use the existing pluginRuntime accessor. Advanced readback also referenced
  nonexistent runtime.config; use existing public describe({id}).config.
- Official action route dropped confirm/key/value. Forward only these named
  fields, with strict boolean confirmation. Unconfirmed writes remain refused.
- Host errors and nested bridge result reasons were discarded. Preserve the
  concrete reason while retaining the raw result; no synthetic success.

Real-host/real-bridge tests first reproduced each failure. Focused46/46PASS.
Full declared unit command on the final repair tree:1955tests,1953PASS,0FAIL,
2existing missing-external-sample skips,564855.1919ms. Post-unit owned-process
and named C-drive audit PASS. Raw logs are D:/Hns-Final-Qualification/
service-adapter-red.log,action-route-red.log,service-reason-red.log,
service-accessor-red.log,service-readback-red.log,
service-actions-focused-green-final3.log,service-actions-full-unit-final.log,
service-actions-post-unit-audit.json. Failed intermediate test setup log is
preserved too; its attempted non-public config read was corrected to assert
the actual written owner file, not by loosening the expected persisted value.

These results are construction regressions, NOT immutable-candidate machine
qualification or repaired visual acceptance. Fresh16 remains on491; no UI
result from it certifies this new tree. Nine new behavior regressions use real
host state/config and actual shipped adapter expressions, not source matching.

Additional actual491 observations: original response/marker and font15 survive
native close/reopen, with Runtime/Harness PID+creation identities unchanged.
Native System Orb is sole visible owner, but click plus one refreshed retry
were rejected by target-window guard over Explorer FolderView. Native expansion
and feedback remain unverified. No input guard bypass, second agent, main merge
or production tag. Full fresh qualification/Journeys/repetitions/real24h remain
required. This negative result supports boundary-test motivation, not a broad
reliability or research-superiority claim.
