#!/usr/bin/env python3
"""Spawn a decoy abandoned process so the scrubber has something to find.

The scrubber only acts on things that are genuinely abandoned, so this does not
fake telemetry: it digs a real grave (a scratchpad directory named after a
session UUID that no agent will ever claim) and leaves a real process working in
it, holding real resident memory and a real listening port.

Two demonstrations, because the killer has two different acts:

  --die N     the decoy exits on its own after N seconds. Nobody killed it, so
              the memory it handed back is SALVAGE -- free currency, harvested
              with quiet inward rings. Keep N well under the strike time or the
              killer takes it first and you see the wrong animation.

  --linger    the decoy stays up until the killer is sure enough to strike it.
              That is a RECLAIM: a kill, an outward amber ring, gold motes.

    python3 scripts/scrub-demo.py --die 20
    python3 scripts/scrub-demo.py --linger
"""
import argparse
import os
import subprocess
import sys
import time
import uuid

BRIDGE = "http://127.0.0.1:8091"

# Mirrors scrubber.go: evidence weights, the ramp, and the strike threshold.
WEIGHT_WORKING, WEIGHT_REPARENTED, WEIGHT_PORT, WEIGHT_OUTLIVED = 0.30, 0.15, 0.20, 0.35
OUTLIVED_FULL_SECONDS = 120
KILL_CONFIDENCE = 0.85


def seconds_to_strike():
    """How long a fully-evidenced decoy takes to cross the strike threshold."""
    standing = WEIGHT_WORKING + WEIGHT_REPARENTED + WEIGHT_PORT
    needed = (KILL_CONFIDENCE - standing) / WEIGHT_OUTLIVED
    return needed * OUTLIVED_FULL_SECONDS


def grave():
    """A scratchpad for a session that never existed, so nothing can claim it."""
    path = f"/tmp/claude-{os.getuid()}/-home-quartermeat/{uuid.uuid4()}/scratchpad"
    os.makedirs(path, exist_ok=True)
    return path


# The decoy outlives this script deliberately. A leftover is defined partly by
# having been adopted by a reaper, so as long as the spawner sticks around as
# its parent the decoy is missing a signal a real orphan would carry, and takes
# far longer to reach the strike threshold than the real thing would.
DECOY = """
import os, shutil, socket, sys, time
workdir = sys.argv[1]
ballast = b'A' * ({megabytes} * 1024 * 1024)
marker = open(workdir + '/decoy.marker', 'w')
marker.write('working in a session that ended')
marker.flush()
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(1)
time.sleep({lifetime})
# The grave is this demo's litter, not the machine's.
shutil.rmtree(os.path.dirname(workdir), ignore_errors=True)
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--die", type=int, metavar="N",
                       help="exit on its own after N seconds (demonstrates salvage)")
    group.add_argument("--linger", action="store_true",
                       help="stay up until the killer strikes (demonstrates a reclaim)")
    parser.add_argument("--megabytes", type=int, default=192,
                        help="resident memory to hold, and so motes to be worth (default: 192)")
    args = parser.parse_args()

    strike_at = seconds_to_strike()
    lifetime = args.die if args.die else int(strike_at) + 120
    if args.die and args.die >= strike_at:
        print(f"warning: --die {args.die} is at or past the ~{strike_at:.0f}s strike time, "
              f"so the killer may reclaim it before it dies on its own", file=sys.stderr)

    workdir = grave()
    session = workdir.split("/")[-2]
    decoy = subprocess.Popen(
        [sys.executable, "-c", DECOY.format(megabytes=args.megabytes, lifetime=lifetime), workdir],
        start_new_session=True,  # reparented to a reaper, like a real leftover
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print(f"grave    {workdir}")
    print(f"session  {session}  (no agent will ever claim it)")
    print(f"decoy    pid {decoy.pid}, {args.megabytes} MiB, holding a port and a descriptor in the grave")
    if args.die:
        print(f"\nIt will exit on its own in {args.die}s, before the killer is sure enough to")
        print(f"strike it (~{strike_at:.0f}s). Watch for the quiet inward rings: SALVAGE.")
    else:
        print(f"\nIt will outlive the ~{strike_at:.0f}s strike time. Watch the killer close in as")
        print("confidence climbs, then the outward amber ring: RECLAIM.")

    # Exit rather than wait, so the decoy is orphaned onto a reaper exactly as a
    # real leftover is. It clears its own grave when it goes.
    print("\nSpawner exiting so the decoy is properly orphaned; it cleans up after itself.")


if __name__ == "__main__":
    main()
