# Threat model

Labs assumes agent output and augmentation code may be adversarial.

## Defenses

| Threat | Mitigation |
| ------ | ---------- |
| Read hidden grader | Grader copied only after agent exit; not in candidate namespace |
| Path escape | Containment checks, forbidden paths, no shell strings |
| Overlay tampering | Immutable overlays; integrity gate |
| False green tests | Hidden deterministic graders; visible tests not trusted |
| Secret leakage | Redaction in logs/reports |
| HTML injection | Escaped report rendering |
| Config drift on resume | Fingerprint seals for suite, arms, pricing |

## Capability limitations

When isolation or telemetry cannot be proven, Labs reports `INSUFFICIENT_DATA` rather than
downgrading silently.

## Blinded human rubric

Rating packets omit arm identity and use deterministic presentation order. Missing raters or low
inter-rater agreement (kappa) yields `INSUFFICIENT_DATA`.
