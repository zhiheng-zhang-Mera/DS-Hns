# Real Windows reboot acceptance

Status: `NOT_RUN`

No real Windows reboot was performed. Automatic resumption of this qualification after host startup has not yet been verified. No explicit host-policy prohibition has been established; the earlier policy attribution was unsupported. Process restart, Electron relaunch, chaos injection, and virtual-time tests are not substitutes and are not reported as a real reboot.

The executable next step is to run the reboot ceremony from a host-controlled persistent runner that can record the pre-reboot task/checkpoint, resume automatically after Windows startup, and verify exactly-once continuation.
