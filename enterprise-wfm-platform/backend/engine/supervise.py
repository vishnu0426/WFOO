"""Keeps the engine running: if server.py dies (for example a native crash inside a solver library) it is started again after a short pause.
Run this instead of server.py in production:  python supervise.py
A process that keeps dying within seconds is retried with a growing pause (up to one minute)."""
import subprocess
import sys
import time
from pathlib import Path

SERVER = str(Path(__file__).with_name("server.py"))


def main():
    pause = 1.0
    while True:
        started = time.time()
        code = subprocess.call([sys.executable, SERVER])
        ran = time.time() - started
        print(f"supervisor: engine exited with code {code} after {ran:.0f}s; restarting in {pause:.0f}s", flush=True)
        time.sleep(pause)
        pause = 1.0 if ran > 120 else min(60.0, pause * 2)


if __name__ == "__main__":
    main()
