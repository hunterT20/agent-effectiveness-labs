# ADR 0001: Vertical slice roadmap

## Status

Accepted

## Context

Agent Effectiveness Labs (`ael`) is a multi-package benchmark harness with strict safety,
auditability, and statistical rigor requirements. We need a delivery sequence that ships
trustworthy foundations before higher-risk runtime features.

## Decision

Deliver the product as **vertical slices** grouped into milestones:

| Milestone | Scope                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------- |
| **M0**    | Platform hardening: atomic artifacts, path containment, config validation, encryption, CI, governance |
| **M1**    | Trial runtime boundary: workspace isolation, agent adapters, grader invocation                        |
| **M2**    | Statistics and verdict gates from normalized evidence                                                 |
| **M3**    | Reporter views and CLI orchestration for preregistered experiments                                    |

Each milestone must pass `pnpm verify` and land through reviewed pull requests. Later milestones
must not rewrite M0 contracts without a new ADR.

## Consequences

- Task ordering follows milestone boundaries; M1 work does not start until M0 is complete.
- Cross-cutting fixes (paths, validation, atomic I/O) are resolved in M0 rather than deferred.
- Feature work that depends on artifact stores or config loading waits for M0.1–M0.5.
