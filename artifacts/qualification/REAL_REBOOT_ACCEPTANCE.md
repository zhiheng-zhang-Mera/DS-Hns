# Real Windows reboot acceptance

Status: `NOT_RUN`

No real Windows reboot was performed. Automatic resumption of this qualification after host startup has not yet been verified. No explicit host-policy prohibition has been established; the earlier policy attribution was unsupported. Process restart, Electron relaunch, chaos injection, and virtual-time tests are not substitutes and are not reported as a real reboot.

The executable next step is to run the reboot ceremony from a host-controlled persistent runner that can record the pre-reboot task/checkpoint, resume automatically after Windows startup, and verify exactly-once continuation.

Read-only prerequisite inspection found the shipped `app/reboot/platform.cjs` bootstrap writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `DSHnsRebootResume`; its alternative Startup location is in the C-drive user profile. This conflicts with the owner's fail-closed rule for controllable project C writes, and is not a verified automatic resumption of this qualification. No registry or Startup-folder mutation was made. Limitation: `D_ONLY_AUTOMATIC_RESUMPTION_PREREQUISITE_UNMET`, not an invented global reboot prohibition. A compliant host-managed mechanism or an explicit exception for that exact autostart write is needed before the ceremony.
