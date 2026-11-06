# Review workflow (single responsibility: orchestrate a code review)

This command does not implement search itself. It declares a dependency on the
`search.web` capability, which the composition resolves to a provider unit at
lock time. Swapping the provider does not change this unit.
