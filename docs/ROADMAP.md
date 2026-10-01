# Lean roadmap

The alpha prioritizes safe recording state, traceable context and explicit data boundaries.

1. **Native recording validation:** test supported desktops/backends with specific user consent; verify visible REC, pause future automation versus stop current capture, interruption recovery, and bounded dependencies. Done when real tests pass with private recordings retained locally.
2. **Reviewable summaries:** source jumps per claim, original versus approximate timestamps, uncertainty and provider/destination displayed. Done when a seeded unsupported claim is visibly flagged and a reviewer can reach its source; evaluate model quality separately from scripted fixtures.
3. **Visual context in the UI:** expose the existing opt-in transcript-first adapter with requests tied to validated timestamps, persistent frame/inference/byte budgets, cancellation, hash/cache, TTL and explicit cleanup. Done when a synthetic selection reaches its source, exhausted/expired/error states fall back transparently, and no provider receives media without explicit configuration.
4. **Provider / privacy onboarding:** show local/external destination, dependencies, retention and deletion scope before processing. Done when new users can explain where their data goes and existing config remains intact.
5. **Portable release:** reproducible source install, cold download, runtime/license notices, native accessibility and desktop validation. Done before shipping binaries or broader-platform claims. Source-only Linux alpha stays explicit until then.

No chat/API entitlement is bundled. Costs and latency depend on configured providers; retries/cancellation do not retract data already accepted by them. Remote unified deletion and complete multi-file transactional publication remain future work.
