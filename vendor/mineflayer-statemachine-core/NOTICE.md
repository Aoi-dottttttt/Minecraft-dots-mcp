# Mineflayer-StateMachine core, 1.7.0

Upstream: https://github.com/PrismarineJS/mineflayer-statemachine
Source artifact: https://registry.npmjs.org/mineflayer-statemachine/-/mineflayer-statemachine-1.7.0.tgz
Original file: `lib/statemachine.js`; MIT license retained in LICENSE.
Artifact SHA-512: `a095f1d80995d87dacf6f4244735cfec3616bf3ff579b1661bd6920b35e43fecdab267b03f8171c0655a5aa4809d0a517a962b9e6f8ff132b16e5be4ec6f6bf2`.

This directory vendors that single compiled core file instead of installing the
whole 1.7.0 package, which depends on the `node` 19 package with an installation
script, plus Express/Socket.IO and unrelated behavior modules.

Local changes:
- Rename the file to `.cjs` for this ESM repository
- Replace its circular `require('.')` (only used for `globalSettings.debugMode`)
  with a local false debug setting; never load upstream behaviors or webserver
- Add minimal declarations for the two core classes the adapter uses

The original `BotStateMachine` definition remains for source fidelity, but this
project never instantiates it. Only `NestedStateMachine` and `StateTransition`
are used, manually advanced while holding the existing action lane. No listener,
server, bot, scheduler, or background action is started by importing this file.
