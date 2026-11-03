#!/bin/sh
# Start the gateway with a heap sized from the container's memory limit (75% of it) unless NODE_OPTIONS already sets one. Node cannot change its heap limit once running,
# so this has to happen before it starts. Without a container limit Node's own default (a share of the machine's memory) applies.
case "$NODE_OPTIONS" in
  *max-old-space-size*) ;;
  *)
    lim=""
    for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
      if [ -r "$f" ]; then
        v=$(cat "$f")
        case "$v" in ''|*[!0-9]*) ;; *) if [ "$v" -lt 1125899906842624 ]; then lim=$v; fi ;; esac
      fi
    done
    if [ -n "$lim" ]; then
      mb=$(( lim / 1048576 * 75 / 100 ))
      export NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=$mb"
      echo "[entry] container memory $((lim / 1048576)) MB: heap limit set to $mb MB"
    fi
    ;;
esac
exec npx tsx src/index.ts
