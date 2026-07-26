# Failure State Desynchronization

Date: 2026-07-27

## Impact

After a failure pose completed, the Animator correctly transitioned to
`think`, but the state controller still believed `failure` was visible.
Ordinary later events such as `read`, `write`, and `tool` were then suppressed
indefinitely.

## Root cause

The controller duplicated the Animator's current state in a private
`visibleState` value. It updated that copy only for transitions initiated by
the controller. Timed transitions initiated inside the Animator were invisible
to it.

## Fix

The Animator port now exposes `getCurrentState()`. Before applying priority
rules or reporting visible state, the controller synchronizes from that
authoritative value. It still owns no timer.

## Regression coverage

Unit and integration tests now:

1. enter `failure`;
2. advance the real or fake failure hold to `think`;
3. send a normal `read` reaction;
4. require `read` to become visible.

## Prevention

If a downstream component owns timed state changes, do not maintain an
unsynchronized shadow of that state. Either subscribe to transitions or query
the authoritative owner at decision boundaries.

