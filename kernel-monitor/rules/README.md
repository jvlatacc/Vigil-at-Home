# kernel-monitor rules

Alert rules are data, loaded from JSON at daemon start; the daemon ships a
fixed evaluator — no rule ever changes evaluator behavior by itself, and no
AI decides enforcement (repo invariant: observability only, the user releases
everything).

This directory is intentionally empty in the core PR: the six initial rules
(exec-from-writable, exec-after-escalation, protected-path-mutation,
foreign-listen, capability-grant, module-load) and the evaluator land with
the rules PR, wired to the same index records the core emits.
