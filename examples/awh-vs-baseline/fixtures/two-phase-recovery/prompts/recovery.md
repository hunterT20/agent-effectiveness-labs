<!-- ael-fake-mode: success -->

Phase 2 (resume this session): auditors need a soft delete. void(id) must
keep the entry in items() with voided: true while totalCents still excludes
it. A hard splice fails the audit.
